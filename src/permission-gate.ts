/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 *
 * Reads permission.json from two locations:
 *   ~/.pi/agent/permission.json  — User-level (lower priority)
 *   .pi/permission.json           — Project-level (overrides user)
 *
 * Format:
 *   {
 *     "alwaysAllow": ["^npm\\s", "^git\\s", "^docker\\s"]
 *   }
 *
 * Patterns are regular expressions tested against the full command string.
 * If any pattern matches, the command bypasses the permission gate entirely.
 * Hardcoded defaults are used when no config file is present.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initUI } from "./ui";
import type { BashPermissionRequestedEvent, BashPermissionResponseEvent} from "./types";
import { BASH_PERMISSION_REQUESTED, BASH_PERMISSION_RESPONSE } from "./types";
import { findNearestAncestorPath } from "./utils";

// ── Types ───────────────────────────────────────────────────────────────────

/** Shape of permission.json */
export interface PermissionConfig {
  /** Regex patterns for commands that always bypass the permission gate. */
  alwaysAllow?: string[];
}

// ── State ───────────────────────────────────────────────────────────────────

/** Compiled always-allow regexes (null until loaded). */
let alwaysAllowPatterns: RegExp[] | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadPermissionFile(filePath: string): PermissionConfig | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    // Validate alwaysAllow is an array of strings if present
    if (parsed.alwaysAllow !== undefined) {
      if (!Array.isArray(parsed.alwaysAllow)) return null;
      if (!parsed.alwaysAllow.every((item: unknown) => typeof item === "string")) return null;
    }
    return parsed as PermissionConfig;
  } catch {
    return null;
  }
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns
    .map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

function loadPermissionConfig(cwd?: string): RegExp[] {
  const userPath = join(getAgentDir(), "permission.json");
  const projectPath = cwd
    ? findNearestAncestorPath(cwd, ".pi", "permission.json")
    : null;

  const userConfig = loadPermissionFile(userPath);
  const projectConfig = projectPath ? loadPermissionFile(projectPath) : null;

  // Project overrides user
  const mergedAlwaysAllow =
    projectConfig?.alwaysAllow ??
    userConfig?.alwaysAllow ??
    [];

  return compilePatterns(mergedAlwaysAllow);
}

function isAlwaysAllowed(command: string): boolean {
  if (!alwaysAllowPatterns) return false;
  return alwaysAllowPatterns.some((pattern) => pattern.test(command));
}

// Helper function to generate random IDs
function generateRequestId(): string {
  return `bash-permission-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ── Init ────────────────────────────────────────────────────────────────────

export function init(pi: ExtensionAPI) {
  // Initialize centralized UI handling
  initUI(pi);

  // Load user-level config eagerly (before cwd is known).
  alwaysAllowPatterns = loadPermissionConfig();

  // session_start: reload with project-level config (which may override user),
  // now that cwd is available from the context.
  pi.on("session_start", (_event, ctx) => {
    alwaysAllowPatterns = loadPermissionConfig(ctx.cwd);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    // Allow safe commands (from config or defaults) without prompting
    if (isAlwaysAllowed(command)) {
      return undefined;
    }

    const requestId = generateRequestId();

    // Emit event so other parts of the extension (or subagents) can handle the UI
    pi.events.emit(BASH_PERMISSION_REQUESTED, { requestId, command } satisfies BashPermissionRequestedEvent);

    // Wait for the response event, whichever side emitted it
    return new Promise((resolve) => {
      const unsub = pi.events.on(BASH_PERMISSION_RESPONSE, (data) => {
        const response = data as BashPermissionResponseEvent;
        if (response.requestId !== requestId) return;

        unsub();
        clearTimeout(timer);

        if (response.allowed) {
          resolve(undefined);
        } else {
          resolve({ block: true, reason: response.reason ?? "Blocked by permission system" });
        }
      });

      // Timeout after 5 minutes
      const timer = setTimeout(() => {
        unsub();
        resolve({ block: true, reason: "Permission request timed out" });
      }, 5 * 60 * 1000);
    });
  });

}