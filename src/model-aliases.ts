/**
 * Model Aliases — Maps short alias names to real provider/model strings.
 *
 * Reads alias.json from two locations:
 *   ~/.pi/agent/alias.json  — User-level (lower priority)
 *   .pi/alias.json           — Project-level (overrides user)
 *
 * Format:
 *   { "large": "anthropic/claude-opus-4-5", "medium": "anthropic/claude-sonnet-4" }
 *
 * Registers a virtual "alias" provider so models are findable via
 * "alias/<name>" (e.g. "alias/large").  Hooks translate alias models
 * to real models before any API call is made.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findNearestAncestorPath } from "./utils.js";
import { stringify } from "node:querystring";

// ── Types ───────────────────────────────────────────────────────────────────

/** Mapping from alias name to "provider/model" string. */
export interface AliasMap {
  [alias: string]: string;
}

// ── State ───────────────────────────────────────────────────────────────────

let aliasMap: AliasMap = {};

// Guard against recursive model_select events when we call pi.setModel()
let translatingModel = false;

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadAliasFile(filePath: string): AliasMap | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    // Validate values are strings
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") return null;
    }
    return parsed as AliasMap;
  } catch {
    return null;
  }
}

function loadAliases(cwd: string): AliasMap {
  const userPath = join(getAgentDir(), "alias.json");
  const projectPath = findNearestAncestorPath(cwd, ".pi", "alias.json");

  const userAliases = loadAliasFile(userPath) ?? {};
  var projectAliases : AliasMap = {};
  if (projectPath){
    projectAliases = loadAliasFile(projectPath) ?? {};
  }

  // Project overrides user
  return { ...userAliases, ...projectAliases };
}

function registerAliasProvider(pi: ExtensionAPI): void {
  if (Object.keys(aliasMap).length === 0) return;

  const models = Object.entries(aliasMap).map(([aliasName, target]) => ({
    id: aliasName,
    name: `Alias: ${aliasName} → ${target}`,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));

  pi.registerProvider("alias", {
    baseUrl: "http://localhost:1",
    apiKey: "alias-noop",
    api: "openai-completions",
    models,
  });
}

/**
 * Resolve an alias/target string like "alias/large" → "anthropic/claude-opus-4-5".
 * Returns the target string, or undefined if not an alias or no mapping found.
 */
export function resolveAliasTarget(modelStr: string): string | undefined {
  if (typeof modelStr !== "string") return undefined;
  if (!modelStr.startsWith("alias/")) return undefined;
  const aliasName = modelStr.slice("alias/".length);
  return aliasMap[aliasName];
}

/**
 * If the current model is from the "alias" provider, translate it to the
 * actual target model and call pi.setModel().
 */
async function translateAliasModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (translatingModel) return;

  const current = ctx.model;
  if (!current || current.provider !== "alias") return;

  const target = aliasMap[current.id];
  if (!target) return;

  const slashIdx = target.indexOf("/");
  if (slashIdx <= 0) return;

  const targetProvider = target.slice(0, slashIdx);
  const targetModel = target.slice(slashIdx + 1);

  // Type-narrowing: ModelRegistry.find accepts strict literals, but we need
  // dynamic strings.  Cast through unknown.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyModelRegistry = {
    find(provider: string, id: string): any;
  };
  const reg = ctx.modelRegistry as unknown as AnyModelRegistry;

  const resolved = reg.find(targetProvider, targetModel);
  if (!resolved) {
    ctx.ui.notify(
      `Alias "${current.id}" → "${target}" not found. Check alias.json.`,
      "warning",
    );
    return;
  }

  translatingModel = true;
  try {
    const ok = await pi.setModel(resolved);
    if (ok) {
      ctx.ui.notify(`Alias "${current.id}" → ${target}`, "info");
    } else {
      ctx.ui.notify(
        `Alias "${current.id}" → ${target}: no API key available.`,
        "warning",
      );
    }
  } finally {
    translatingModel = false;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Return the current alias map (read-only snapshot). */
export function getAliasMap(): AliasMap {
  return { ...aliasMap };
}

// ── Init ────────────────────────────────────────────────────────────────────

export function initModelAliases(pi: ExtensionAPI): void {
  // Load user-level aliases eagerly (before cwd is known from ctx).
  const userPath = join(getAgentDir(), "alias.json");
  aliasMap = loadAliasFile(userPath) ?? {};
  registerAliasProvider(pi);

  // session_start: load project-level aliases (which may override user),
  // re-register provider with complete map, then translate if needed.
  pi.on("session_start", async (_event, ctx) => {
    aliasMap = loadAliases(ctx.cwd);
    registerAliasProvider(pi);
    await translateAliasModel(pi, ctx);
  });

  // model_select: when the user cycles or /model-selects an alias,
  // swap to the real model immediately.
  pi.on("model_select", async (event, ctx) => {
    await translateAliasModel(pi, ctx);
  });

  // Safety net: ensure no alias model reaches the provider.
  pi.on("before_agent_start", async (_event, ctx) => {
    await translateAliasModel(pi, ctx);
  });
}
