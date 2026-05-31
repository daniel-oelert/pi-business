/**
 * Subagent configuration and discovery.
 *
 * Reads agent definitions from markdown files with YAML frontmatter.
 * Locations (by priority, highest first):
 *   .pi/agents/*.md             — Project-level agents
 *   ~/.pi/agent/agents/*.md     — User-level agents
 *   <extension>/default-agents/ — Builtin agents (lowest, can be disabled)
 *
 * Builtin agents are loaded from the extension's default-agents/ directory.
 * Users can disable builtin agents in pi-business.json:
 *   { "defaultAgents": false }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { findNearestAncestorPath, findNearestProjectAgentsDir } from "./utils";

/** Maximum allowed length for agent descriptions in characters. */
export const MAX_DESCRIPTION_LENGTH = 1000;

/** Default directory for builtin agents relative to the extension root. */
export const DEFAULT_AGENTS_DIR = "default-agents";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project" | "builtin";
  filePath: string;
}

export interface AgentDiscoveryOptions {
  /** Path to the extension's root directory (for locating default-agents/). */
  extensionDir?: string;
  /** Whether to include builtin (default) agents. Defaults to true. */
  defaultAgents?: boolean;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project" | "builtin",
): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } =
      parseFrontmatter<Record<string, string>>(content);

    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);

    // Enforce maximum description length
    let description = frontmatter.description;
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      description = description.slice(0, MAX_DESCRIPTION_LENGTH);
    }

    agents.push({
      name: frontmatter.name,
      description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

/**
 * Load pi-business.json config from user-level and project-level locations.
 * Project-level overrides user-level.
 * Returns empty object if neither file exists.
 */
function loadExtensionConfig(cwd: string): Record<string, unknown> {
  const userConfigPath = path.join(getAgentDir(), "pi-business.json");
  const projectConfigPath = findNearestAncestorPath(cwd, ".pi", "pi-business.json");

  let userConfig: Record<string, unknown> = {};
  let projectConfig: Record<string, unknown> = {};

  try {
    userConfig = JSON.parse(fs.readFileSync(userConfigPath, "utf-8"));
  } catch { /* ignore */ }

  if (projectConfigPath) {
    try {
      projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, "utf-8"));
    } catch { /* ignore */ }
  }

  // Project overrides user
  return { ...userConfig, ...projectConfig };
}

/**
 * Determine whether builtin (default) agents should be loaded.
 *
 * Checks pi-business.json (user-level and project-level) for the
 * `defaultAgents` field. Defaults to true if not configured.
 */
export function shouldLoadDefaultAgents(cwd: string): boolean {
  const config = loadExtensionConfig(cwd);
  if (config.defaultAgents !== undefined) {
    return Boolean(config.defaultAgents);
  }
  return true;
}

export function discoverAgents(
  cwd: string,
  options?: AgentDiscoveryOptions,
): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const extensionDir = options?.extensionDir;

  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = projectAgentsDir
    ? loadAgentsFromDir(projectAgentsDir, "project")
    : [];

  // Load builtin agents from extension's default-agents/ directory
  const defaultAgentsEnabled = options?.defaultAgents ?? true;
  let builtinAgents: AgentConfig[] = [];
  if (defaultAgentsEnabled && extensionDir) {
    const defaultDir = path.join(extensionDir, DEFAULT_AGENTS_DIR);
    builtinAgents = loadAgentsFromDir(defaultDir, "builtin");
  }

  // Merge with priority: builtin < user < project
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of builtinAgents) agentMap.set(agent.name, agent);
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
