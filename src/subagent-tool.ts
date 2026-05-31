/**
 * Subagent Tool — Delegates tasks to specialized agents using the pi SDK.
 *
 * Unlike the official subagent example (which spawns a separate `pi` process),
 * this implementation uses `createAgentSession` from the SDK to run agents
 * in-process with isolated context windows.
 *
 * Modes:
 *   - Single: { agent: "name", task: "..." }
 */

import type { AgentToolResult, EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import { type AgentConfig, discoverAgents } from "./subagent-config";
import { resolveAliasTarget } from "./model-aliases";
import { findNearestAncestorPath } from "./utils.js";
import {
  BASH_PERMISSION_REQUESTED,
  BASH_PERMISSION_RESPONSE,
  QUESTION_REQUESTED,
  QUESTION_RESPONSE,
} from "./types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: any[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentDetails {
  mode: "single" | "parallel";
  projectAgentsDir: string | null;
  results: SingleResult[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getFinalOutput(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function formatTokens(count: number): string {
  const abs = Math.abs(count);
  const sign = count < 0 ? "-" : "";
  if (abs < 1000) return count.toString();
  if (abs < 10000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  if (abs < 1000000) return `${sign}${Math.round(abs / 1000)}k`;
  return `${sign}${(abs / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

// ── Parallel Execution Helpers ──────────────────────────────────────────────

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

function loadConcurrencyConfig(cwd: string): number {
  const DEFAULT = 4;

  // Read user config
  const userConfigPath = path.join(getAgentDir(), "pi-business.json");
  let userConcurrency: number | undefined;
  try {
    const raw = fs.readFileSync(userConfigPath, "utf-8");
    userConcurrency = JSON.parse(raw).maxConcurrency;
  } catch { /* ignore */ }

  // Read project config (overrides user)
  const projectConfigDir = findNearestAncestorPath(cwd, ".pi", "pi-business.json");
  let projectConcurrency: number | undefined;
  if (projectConfigDir) {
    try {
      const raw = fs.readFileSync(projectConfigDir, "utf-8");
      projectConcurrency = JSON.parse(raw).maxConcurrency;
    } catch { /* ignore */ }
  }

  const resolved = projectConcurrency ?? userConcurrency ?? DEFAULT;
  return Math.max(1, resolved);
}

function aggregateUsage(results: SingleResult[]): UsageStats {
  const total: UsageStats = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0,
  };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
  }
  return total;
}

function resolveModel(
  modelRegistry: ModelRegistry,
  modelName: string | undefined,
  _visited: Set<string> = new Set(),
): Model<Api> | undefined {
  if (!modelName) return undefined;

  // Guard against circular aliases
  if (_visited.has(modelName)) return undefined;
  _visited.add(modelName);

  // Resolve alias references (alias/large → anthropic/claude-opus-4-5)
  const resolved = resolveAliasTarget(modelName);
  if (resolved) {
    return resolveModel(modelRegistry, resolved, _visited);
  }

  // ModelRegistry.find has strict literal types for provider/id.
  // Cast to string to support arbitrary agent model configs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyModelRegistry = { find(provider: string, id: string): Model<Api> | undefined };
  const reg = modelRegistry as unknown as AnyModelRegistry;

  // Try to parse as provider/model
  const slashIdx = modelName.indexOf("/");
  if (slashIdx > 0) {
    const provider = modelName.slice(0, slashIdx);
    const id = modelName.slice(slashIdx + 1);
    const model = reg.find(provider, id);
    if (model) return model;
  }

  return undefined;
}

// ── Agent Runner ────────────────────────────────────────────────────────────

async function runSingleAgent(
  ctx : ExtensionContext,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  signal: AbortSignal | undefined,
  hostEvents?: EventBus | null,
  onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available =
      agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
    };
  }

  // ── Set up isolated session ─────────────────────────────────────────────

  const model = resolveModel(ctx.modelRegistry, agent.model) ?? ctx.model;

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });
  
  const effectiveCwd = ctx.cwd;

  // Create a bridging event bus that forwards UI-bound events from the
  // subagent to the host's event bus, and forwards responses back.
  // The subagent's extensions (pi-business) use this bus as pi.events.
  // This way, when the subagent's permission-gate.ts or question-tool.ts
  // emit a request, it reaches the host's ui.ts for user interaction.
  const subagentBus = createEventBus();
  const bridgeCleanups: (() => void)[] = [];

  if (hostEvents) {
    // Forward requests from subagent to host
    bridgeCleanups.push(
      subagentBus.on(BASH_PERMISSION_REQUESTED, (data) => {
        hostEvents.emit(BASH_PERMISSION_REQUESTED, data);
      }),
      subagentBus.on(QUESTION_REQUESTED, (data) => {
        hostEvents.emit(QUESTION_REQUESTED, data);
      }),
      // Forward responses from host to subagent
      hostEvents.on(BASH_PERMISSION_RESPONSE, (data) => {
        subagentBus.emit(BASH_PERMISSION_RESPONSE, data);
      }),
      hostEvents.on(QUESTION_RESPONSE, (data) => {
        subagentBus.emit(QUESTION_RESPONSE, data);
      }),
    );
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir: getAgentDir(),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: agent.systemPrompt,
    eventBus: subagentBus,
  });
  await resourceLoader.reload();

  const toolNames: string[] = agent.tools ?? [
    "read",
    "bash",
    "edit",
    "write",
    "question",
  ];

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  const sessionManager = parentSessionFile
    ? SessionManager.create(effectiveCwd, parentSessionFile.replace(/\.jsonl$/, ""))
    : SessionManager.inMemory();

  const { session } = await createAgentSession({
    cwd: effectiveCwd,
    model,
    thinkingLevel: "off",
    resourceLoader,
    tools: toolNames,
    sessionManager,
    settingsManager,
  });

  const result: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    model: agent.model,
  };

  let wasAborted = false;
  let abortHandler: (() => void) | undefined;

  try {
    // Wire up abort signal
    if (signal) {
      abortHandler = () => {
        wasAborted = true;
        session.abort();
      };
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    // Collect messages and usage from events
    const emitUpdate = () => {
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
          details: {
            mode: "single",
            projectAgentsDir: null,
            results: [result],
          },
        });
      }
    };

    const unsub = session.subscribe((event) => {
      if (event.type === "message_end" && event.message) {
        const msg = event.message;
        result.messages.push(msg);

        if (msg.role === "assistant") {
          result.usage.turns++;
          if (msg.usage) {
            result.usage.input += msg.usage.input || 0;
            result.usage.output += msg.usage.output || 0;
            result.usage.cacheRead += msg.usage.cacheRead || 0;
            result.usage.cacheWrite += msg.usage.cacheWrite || 0;
            result.usage.cost += msg.usage.cost?.total || 0;
          }
          if (!result.model && msg.model) result.model = msg.model;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          emitUpdate();
        }
      }
    });

    try {
      await session.prompt(task);
    } finally {
      unsub();
    }

    if (wasAborted) {
      result.exitCode = 1;
      result.stopReason = "aborted";
      return result;
    }

    // Determine if there was an error from the messages
    return result;
  } catch (err: unknown) {
    result.exitCode = 1;
    result.stderr = err instanceof Error ? err.message : String(err);
    return result;
  } finally {
    // Cleanup abort listener
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    // Tear down the event bus bridge
    for (const cleanup of bridgeCleanups) cleanup();
    // Dispose session
    try {
      session.dispose();
    } catch {
      // Ignore disposal errors
    }
  }
}

// ── List Subagents Types ─────────────────────────────────────────────────

export interface ListedAgent {
  name: string;
  description: string;
  source: "user" | "project";
  model?: string;
}

export interface ListedAgentsDetails {
  agents: ListedAgent[];
  projectAgentsDir: string | null;
}

// ── Parameter Schema ───────────────────────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Name of the agent to invoke",
  })),
  task: Type.Optional(Type.String({
    description: "Task to delegate to the agent",
  })),
  tasks: Type.Optional(Type.Array(TaskItem, {
    description: "Array of {agent, task} for parallel execution",
  })),
});

// ── Tool Registration ──────────────────────────────────────────────────────

export function initSubagentTool(pi: ExtensionAPI) {

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a specialized subagent with an isolated context window. " +
      "Subagents are configured via markdown files in ~/.pi/agent/agents/ or .pi/agents/.",
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const discovery = discoverAgents(ctx.cwd);
      const agents = discovery.agents;

      const makeDetails = (mode: "single" | "parallel") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

      // Mode detection & mutual exclusivity
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasTasks) + Number(hasSingle);

      if (modeCount === 0) {
        const available =
          agents.map((a) => `${a.name} (${a.source})`).join(", ") ||
          "none";
        return {
          content: [
            {
              type: "text",
              text: `Please provide either "agent" + "task" for single mode, or "tasks" array for parallel mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      if (modeCount > 1) {
        return {
          content: [
            {
              type: "text",
              text: "Provide exactly one mode: either agent+task (single) OR tasks array (parallel), not both.",
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      // ── Parallel mode ─────────────────────────────────────────────────
      if (hasTasks) {
        if (params.tasks!.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "The 'tasks' array must contain at least one task.",
              },
            ],
            details: makeDetails("parallel")([]),
          };
        }

        const concurrency = loadConcurrencyConfig(ctx.cwd);

        const allResults: SingleResult[] = new Array(params.tasks!.length);
        for (let i = 0; i < params.tasks!.length; i++) {
          allResults[i] = {
            agent: params.tasks![i].agent,
            agentSource: "unknown",
            task: params.tasks![i].task,
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          };
        }

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const running = allResults.filter(r => r.exitCode === -1).length;
            const done = allResults.filter(r => r.exitCode !== -1).length;
            onUpdate({
              content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(params.tasks!, concurrency, async (t, index) => {
          const taskOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
            if (partial.details?.results[0]) {
              allResults[index] = partial.details.results[0];
              emitParallelUpdate();
            }
          };

          const result = await runSingleAgent(
            ctx,
            agents,
            t.agent,
            t.task,
            signal,
            pi.events,
            taskOnUpdate,
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter(r => r.exitCode === 0).length;
        const anyFailed = results.some(r => r.exitCode !== 0);

        const summaries = results.map(r => {
          const output = getFinalOutput(r.messages);
          const preview = output.length > 100
            ? output.slice(0, 100) + "..."
            : output;
          const status = r.exitCode === 0
            ? "completed"
            : `failed: ${r.errorMessage || r.stderr || preview || "(no output)"}`;
          return `[${r.agent}] ${status}`;
        });

        return {
          content: [{
            type: "text",
            text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
          }],
          details: makeDetails("parallel")(results),
          isError: anyFailed ? true : undefined,
        };
      }

      // ── Single mode ──────────────────────────────────────────────────
      const result = await runSingleAgent(
        ctx,
        agents,
        params.agent!,
        params.task!,
        signal,
        pi.events,
        onUpdate,
      );

      const isError =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted";

      if (isError) {
        const errorMsg =
          result.errorMessage ||
          result.stderr ||
          getFinalOutput(result.messages) ||
          "(no output)";
        return {
          content: [
            {
              type: "text",
              text: `Agent "${result.agent}" ${result.stopReason || "failed"}: ${errorMsg}`,
            },
          ],
          details: makeDetails("single")([result]),
          isError: true,
        };
      }

      const output = getFinalOutput(result.messages) || "(no output)";
      const usageStr = formatUsage(result.usage, result.model);

      return {
        content: [
          {
            type: "text",
            text:
              `${output}\n\n───\n` +
              `${result.agent} (${result.agentSource}) · ${usageStr}`,
          },
        ],
        details: makeDetails("single")([result]),
      };
    },

    renderCall(args, theme, _context) {
      // Parallel mode
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3) {
          text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        }
        return new Text(text, 0, 0);
      }

      // Single mode
      const agentName = args.agent || "...";
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";

      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {

      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }

      // ── Parallel mode rendering ────────────────────────────────
      if (details.mode === "parallel") {
        const running = details.results.filter(r => r.exitCode === -1).length;
        const successCount = details.results.filter(r => r.exitCode === 0).length;
        const failCount = details.results.filter(r => r.exitCode > 0).length;
        const isRunning = running > 0;
        const icon = isRunning
          ? theme.fg("warning", "⏳")
          : failCount > 0
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;

        if (expanded && !isRunning) {
          const mdTheme = getMarkdownTheme();
          const container = new Container();
          container.addChild(new Text(
            `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
            0, 0));
          container.addChild(new Spacer(1));

          for (const r of details.results) {
            const rIcon = r.exitCode === 0
              ? theme.fg("success", "✓")
              : theme.fg("error", "✗");
            container.addChild(new Text(
              `${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`,
              0, 0));
            container.addChild(new Text(
              `${theme.fg("muted", "Task: ")}${theme.fg("dim", r.task)}`,
              0, 0));

            const finalOutput = getFinalOutput(r.messages);
            if (r.exitCode !== 0 && r.errorMessage) {
              container.addChild(new Text(
                theme.fg("error", `Error: ${r.errorMessage}`),
                0, 0));
            } else if (r.exitCode !== 0 && r.stderr) {
              container.addChild(new Text(
                theme.fg("error", r.stderr),
                0, 0));
            } else if (finalOutput) {
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            } else {
              container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
            }

            const usageStr = formatUsage(r.usage, r.model);
            if (usageStr) {
              container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
            }
            container.addChild(new Spacer(1));
          }

          const totalUsage = aggregateUsage(details.results);
          const totalStr = formatUsage(totalUsage);
          if (totalStr) {
            container.addChild(new Text(theme.fg("dim", `Total: ${totalStr}`), 0, 0));
          }
          return container;
        }

        // Collapsed parallel
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const r of details.results) {
          const rIcon = r.exitCode === -1
            ? theme.fg("warning", "⏳")
            : r.exitCode === 0
              ? theme.fg("success", "✓")
              : theme.fg("error", "✗");
          const finalOutput = getFinalOutput(r.messages);
          const preview = finalOutput.length > 200
            ? finalOutput.slice(0, 200) + "..."
            : finalOutput;

          text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
          if (r.exitCode !== 0 && r.errorMessage) {
            text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
          } else if (r.exitCode !== 0 && r.stderr) {
            text += `\n${theme.fg("error", r.stderr)}`;
          } else if (preview) {
            text += `\n${theme.fg("toolOutput", preview)}`;
          } else if (r.exitCode === -1) {
            text += `\n${theme.fg("muted", "(running...)")}`;
          } else {
            text += `\n${theme.fg("muted", "(no output)")}`;
          }
        }
        if (!isRunning) {
          const totalUsage = aggregateUsage(details.results);
          const totalStr = formatUsage(totalUsage);
          if (totalStr) text += `\n\n${theme.fg("dim", `Total: ${totalStr}`)}`;
        }
        if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      // ── Single mode rendering ───────────────────────────────────────
      const r = details.results[0];
      const isError =
        r.exitCode !== 0 ||
        r.stopReason === "error" ||
        r.stopReason === "aborted";
      const icon = isError
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");

      if (expanded) {
        const mdTheme = getMarkdownTheme();
        const container = new Container();
        let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason)
          header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        container.addChild(new Text(header, 0, 0));
        if (isError && r.errorMessage)
          container.addChild(
            new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
          );

        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", "─── Task ───"), 0, 0),
        );
        container.addChild(new Text(theme.fg("dim", r.task), 0, 0));

        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", "─── Output ───"), 0, 0),
        );

        const finalOutput = getFinalOutput(r.messages);
        if (finalOutput) {
          container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
        } else {
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        }

        const usageStr = formatUsage(r.usage, r.model);
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      // Collapsed view
      const finalOutput = getFinalOutput(r.messages);
      const preview =
        finalOutput.length > 200
          ? `${finalOutput.slice(0, 200)}...`
          : finalOutput;

      let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
      if (isError && r.stopReason)
        text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
      if (isError && r.errorMessage)
        text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
      else if (preview)
        text += `\n${theme.fg("toolOutput", preview)}`;

      const usageStr = formatUsage(r.usage, r.model);
      if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
      if (finalOutput.length > 200)
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });

  // ── list_subagents Tool ────────────────────────────────────────────

  const ListSubagentsParams = Type.Object({});

  pi.registerTool({
    name: "list_subagents",
    label: "List Subagents",
    description:
      "List all available subagents with their names, descriptions, " +
      "source locations, and configured models.",
    parameters: ListSubagentsParams,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const discovery = discoverAgents(ctx.cwd);
      const agents = discovery.agents;

      const listed = agents.map((a) => ({
        name: a.name,
        description: a.description,
        source: a.source,
        model: a.model,
      } satisfies ListedAgent));

      if (listed.length === 0) {
        return {
          content: [{ type: "text", text: "No subagents found. Create agent markdown files in ~/.pi/agent/agents/ or .pi/agents/." }],
          details: { agents: [], projectAgentsDir: discovery.projectAgentsDir } satisfies ListedAgentsDetails,
        };
      }

      const lines = listed.map(
        (a) =>
          `**${a.name}** (${a.source})${a.model ? ` [${a.model}]` : ""}: ${a.description}`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { agents: listed, projectAgentsDir: discovery.projectAgentsDir } satisfies ListedAgentsDetails,
      };
    },

    renderCall(_args, theme, _context) {
      return new Text(
        theme.fg("toolTitle", theme.bold("list_subagents")),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as ListedAgentsDetails | undefined;
      if (!details) {
        const text = result.content?.[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }

      if (details.agents.length === 0) {
        return new Text(theme.fg("muted", "No subagents found."), 0, 0);
      }

      const icon = theme.fg("success", "✓");
      const countStr = `${details.agents.length} subagent${details.agents.length !== 1 ? "s" : ""}`;

      if (expanded) {
        const container = new Container();
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(countStr))} available`;
        container.addChild(new Text(header, 0, 0));
        container.addChild(new Spacer(1));

        for (const a of details.agents) {
          const sourceLabel = theme.fg("muted", ` (${a.source})`);
          const modelLabel = a.model
            ? ` ${theme.fg("dim", `[${a.model}]`)}`
            : "";
          const line = `  ${theme.fg("accent", theme.bold(a.name))}${sourceLabel}${modelLabel}`;
          container.addChild(new Text(line, 0, 0));
          container.addChild(
            new Text(`    ${theme.fg("dim", a.description)}`, 0, 0),
          );
        }
        return container;
      }

      // Collapsed
      const names = details.agents.map((a) => a.name).join(", ");
      return new Text(
        `${icon} ${theme.fg("toolTitle", theme.bold(countStr))}: ${theme.fg("dim", names)}`,
        0,
        0,
      );
    },
  });
}
