/**
 * Shared utilities for the pi-business extension.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Check whether a path exists and is a directory. */
export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up the directory tree from `cwd` looking for an ancestor that
 * contains the given relative path (expressed as path segments).
 * Returns the first matching absolute path, or null.
 */
export function findNearestAncestorPath(
  cwd: string,
  ...segments: string[]
): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ...segments);
    try {
      fs.statSync(candidate);
      return candidate;
    } catch {
      // doesn't exist at this level, try parent
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/** Convenience: find the nearest .pi/agents directory. */
export function findNearestProjectAgentsDir(cwd: string): string | null {
  return findNearestAncestorPath(cwd, ".pi", "agents");
}
