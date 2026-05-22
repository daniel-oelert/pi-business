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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { type AgentConfig, discoverAgents } from "./subagent-config";
import { resolveAliasTarget } from "./model-aliases";
import { createQuestionToolDef } from "./question-tool";

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
  mode: "single";
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
  customTools?: any[],
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

  const model = resolveModel(ctx.modelRegistry, agent.model);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => agent.systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const toolNames: string[] = agent.tools ?? [
    "read",
    "bash",
    "edit",
    "write",
    "question",
  ];

  const effectiveCwd = ctx.cwd;

  const { session } = await createAgentSession({
    cwd: effectiveCwd,
    model,
    thinkingLevel: "off",
    resourceLoader,
    tools: toolNames,
    customTools: customTools ?? [],
    sessionManager: SessionManager.inMemory(),
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
    // Dispose session
    try {
      session.dispose();
    } catch {
      // Ignore disposal errors
    }
  }
}

// ── Parameter Schema ───────────────────────────────────────────────────────

const SubagentParams = Type.Object({
  agent: Type.String({
    description: "Name of the agent to invoke",
  }),
  task: Type.String({
    description: "Task to delegate to the agent",
  }),
});

// ── Tool Registration ──────────────────────────────────────────────────────

export function initSubagentTool(pi: ExtensionAPI) {
  const questionToolDef = createQuestionToolDef(pi);

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a specialized subagent with an isolated context window. " +
      "Subagents are configured via markdown files in ~/.pi/agent/agents/ or .pi/agents/.",
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const discovery = discoverAgents(ctx.cwd);
      const agents = discovery.agents;

      const makeDetails = (results: SingleResult[]): SubagentDetails => ({
        mode: "single",
        projectAgentsDir: discovery.projectAgentsDir,
        results,
      });

      if (!params.agent || !params.task) {
        const available =
          agents.map((a) => `${a.name} (${a.source})`).join(", ") ||
          "none";
        return {
          content: [
            {
              type: "text",
              text: `Both "agent" and "task" are required.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails([]),
        };
      }

      const result = await runSingleAgent(
        ctx,
        agents,
        params.agent,
        params.task,
        signal,
        [questionToolDef],
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
          details: makeDetails([result]),
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
        details: makeDetails([result]),
      };
    },

    renderCall(args, theme, _context) {
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
}
