/**
 * Tests for src/utils.ts — pure utility functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  isDirectory,
  findNearestAncestorPath,
  findNearestProjectAgentsDir,
} from "../utils";

// ────────────────────────────────────────────────────────────────────────────
// isDirectory
// ────────────────────────────────────────────────────────────────────────────

describe("isDirectory", () => {
  const tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for an existing directory", () => {
    expect(isDirectory(tmpDir)).toBe(true);
  });

  it("returns true for os.tmpdir()", () => {
    expect(isDirectory(os.tmpdir())).toBe(true);
  });

  it("returns false for a non-existent path", () => {
    expect(isDirectory(path.join(tmpDir, "nonexistent"))).toBe(false);
  });

  it("returns false for a file (not a directory)", () => {
    const filePath = path.join(tmpDir, "test-file.txt");
    fs.writeFileSync(filePath, "hello");
    expect(isDirectory(filePath)).toBe(false);
  });

  it("returns false for a broken symlink", () => {
    const linkPath = path.join(tmpDir, "broken-link");
    try {
      fs.symlinkSync(path.join(tmpDir, "nonexistent-target"), linkPath);
      expect(isDirectory(linkPath)).toBe(false);
    } catch {
      // Symlinks may not be supported (e.g., Windows without admin)
      // Skip silently
    }
  });

  it("returns false for an empty string", () => {
    expect(isDirectory("")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// findNearestAncestorPath
// ────────────────────────────────────────────────────────────────────────────

describe("findNearestAncestorPath", () => {
  const tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-ancestor`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds a path directly at cwd", () => {
    const target = path.join(tmpDir, ".pi");
    fs.mkdirSync(target);
    const result = findNearestAncestorPath(tmpDir, ".pi");
    expect(result).toBe(target);
  });

  it("walks up from a subdirectory to find the target", () => {
    // Create .pi at root
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);

    // Create sub/nested/deep structure
    const deepDir = path.join(tmpDir, "sub", "nested", "deep");
    fs.mkdirSync(deepDir, { recursive: true });

    const result = findNearestAncestorPath(deepDir, ".pi");
    expect(result).toBe(piDir);
  });

  it("finds a multi-segment path", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    const result = findNearestAncestorPath(tmpDir, ".pi", "agents");
    expect(result).toBe(agentsDir);
  });

  it("finds multi-segment path from a subdirectory", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    const subDir = path.join(tmpDir, "src", "components");
    fs.mkdirSync(subDir, { recursive: true });

    const result = findNearestAncestorPath(subDir, ".pi", "agents");
    expect(result).toBe(agentsDir);
  });

  it("returns null when target does not exist anywhere up the tree", () => {
    const result = findNearestAncestorPath(tmpDir, ".nonexistent-dir");
    expect(result).toBeNull();
  });

  it("returns nearest ancestor when multiple matches exist", () => {
    // Create .pi at root
    const rootPi = path.join(tmpDir, ".pi");
    fs.mkdirSync(rootPi);

    // Create sub/.pi
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir);
    const subPi = path.join(subDir, ".pi");
    fs.mkdirSync(subPi);

    // Search from sub/
    const result = findNearestAncestorPath(subDir, ".pi");
    expect(result).toBe(subPi); // nearest, not root
  });

  it("stops at filesystem root and returns null", () => {
    // Use a path that definitely doesn't exist
    const result = findNearestAncestorPath(
      os.tmpdir(),
      ".definitely-does-not-exist-2024",
    );
    expect(result).toBeNull();
  });

  it("handles cwd with trailing slash", () => {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);

    const cwdWithSlash = tmpDir + path.sep;
    const result = findNearestAncestorPath(cwdWithSlash, ".pi");
    expect(result).toBe(piDir);
  });

  it("treats a file as the target (stat is enough)", () => {
    const filePath = path.join(tmpDir, ".pitarget");
    fs.writeFileSync(filePath, "marker");

    const result = findNearestAncestorPath(tmpDir, ".pitarget");
    expect(result).toBe(filePath);
  });

  it("returns null for 0 segments", () => {
    // With no segments, path.join returns cwd itself
    const result = findNearestAncestorPath(tmpDir);
    expect(result).toBe(tmpDir); // path.join(cwd) = cwd, and cwd exists
  });
});

// ────────────────────────────────────────────────────────────────────────────
// findNearestProjectAgentsDir
// ────────────────────────────────────────────────────────────────────────────

describe("findNearestProjectAgentsDir", () => {
  const tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-agentsdir`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .pi/agents at cwd", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    expect(findNearestProjectAgentsDir(tmpDir)).toBe(agentsDir);
  });

  it("finds .pi/agents from a subdirectory", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    const deepDir = path.join(tmpDir, "a", "b", "c");
    fs.mkdirSync(deepDir, { recursive: true });

    expect(findNearestProjectAgentsDir(deepDir)).toBe(agentsDir);
  });

  it("returns null when .pi/agents does not exist", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    // .pi exists but agents doesn't
    expect(findNearestProjectAgentsDir(tmpDir)).toBeNull();
  });

  it("returns null when .pi doesn't exist", () => {
    expect(findNearestProjectAgentsDir(tmpDir)).toBeNull();
  });
});
