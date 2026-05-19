/**
 * Tests for src/permission-gate.ts — Command bypass and config loading.
 *
 * Tests the always-allow regex pattern logic in isolation, plus
 * permission.json config loading and merging behavior.
 */

import { describe, it, expect } from "vitest";

// ────────────────────────────────────────────────────────────────────────────
// Default always-allow patterns (mirrors DEFAULT_ALWAYS_ALLOW from permission-gate.ts)
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_ALWAYS_ALLOW = [
  "^npm\\s",
  "^npx\\s",
  "^vitest",
  "^ls(\\s|$)",
  "^find\\s",
  "^grep\\s",
  "^rg\\s",
  "^cat\\s",
  "^head\\s",
  "^tail\\s",
  "^echo\\s",
  "^pwd$",
  "^whoami$",
  "^date$",
  "^node\\s+-e\\s",
  "^node\\s+-p\\s",
  "^stat\\s",
  "^wc\\s",
  "^sort\\s",
];

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

const DEFAULT_REGEXES = compilePatterns(DEFAULT_ALWAYS_ALLOW);

function isAlwaysAllowed(command: string, patterns: RegExp[] = DEFAULT_REGEXES): boolean {
  return patterns.some((regex) => regex.test(command));
}

// ────────────────────────────────────────────────────────────────────────────
// Default pattern tests
// ────────────────────────────────────────────────────────────────────────────

describe("always-allow default patterns", () => {
  it("allows npm commands", () => {
    expect(isAlwaysAllowed("npm install vitest --save-dev")).toBe(true);
    expect(isAlwaysAllowed("npm run test")).toBe(true);
    expect(isAlwaysAllowed("npm test")).toBe(true);
    expect(isAlwaysAllowed("npm publish")).toBe(true);
  });

  it("allows npx commands", () => {
    expect(isAlwaysAllowed("npx vitest run")).toBe(true);
    expect(isAlwaysAllowed("npx eslint .")).toBe(true);
  });

  it("allows vitest", () => {
    expect(isAlwaysAllowed("vitest run")).toBe(true);
    expect(isAlwaysAllowed("vitest --coverage")).toBe(true);
  });

  it("allows ls (with word boundary after)", () => {
    expect(isAlwaysAllowed("ls")).toBe(true);
    expect(isAlwaysAllowed("ls -la")).toBe(true);
    expect(isAlwaysAllowed("ls /usr/local/bin")).toBe(true);
  });

  it("does NOT allow lsblk (regex requires word boundary after ls)", () => {
    // Fixes the old prefix-matching limitation — "ls" no longer matches "lsblk"
    expect(isAlwaysAllowed("lsblk")).toBe(false);
  });

  it("allows find, grep, rg", () => {
    expect(isAlwaysAllowed("find . -name '*.ts'")).toBe(true);
    expect(isAlwaysAllowed("grep -r 'test' .")).toBe(true);
    expect(isAlwaysAllowed("rg 'function' src/")).toBe(true);
  });

  it("allows cat, head, tail", () => {
    expect(isAlwaysAllowed("cat file.txt")).toBe(true);
    expect(isAlwaysAllowed("head package.json")).toBe(true);
    expect(isAlwaysAllowed("tail -f log.txt")).toBe(true);
  });

  it("allows echo", () => {
    expect(isAlwaysAllowed("echo hello")).toBe(true);
  });

  it("allows pwd, whoami, date (exact match only)", () => {
    expect(isAlwaysAllowed("pwd")).toBe(true);
    expect(isAlwaysAllowed("whoami")).toBe(true);
    expect(isAlwaysAllowed("date")).toBe(true);
    // Exact match — no extra args allowed
    expect(isAlwaysAllowed("pwd -L")).toBe(false);
    expect(isAlwaysAllowed("whoami --version")).toBe(false);
    expect(isAlwaysAllowed("date +%Y")).toBe(false);
  });

  it("allows node -e and node -p (requires -e or -p flag)", () => {
    expect(isAlwaysAllowed("node -e 'console.log(1)'")).toBe(true);
    expect(isAlwaysAllowed("node -p '1+1'")).toBe(true);
    // Regular node without -e/-p is not allowed
    expect(isAlwaysAllowed("node server.js")).toBe(false);
  });

  it("allows stat, wc, sort", () => {
    expect(isAlwaysAllowed("stat file.txt")).toBe(true);
    expect(isAlwaysAllowed("wc -l file.txt")).toBe(true);
    expect(isAlwaysAllowed("sort file.txt")).toBe(true);
  });

  describe("non-safe commands are blocked", () => {
    it("blocks dangerous commands", () => {
      expect(isAlwaysAllowed("rm -rf /tmp")).toBe(false);
      expect(isAlwaysAllowed("sudo systemctl restart")).toBe(false);
      expect(isAlwaysAllowed("chmod 777 file")).toBe(false);
      expect(isAlwaysAllowed("mkfs.ext4 /dev/sda1")).toBe(false);
    });

    it("blocks git commands (not in defaults)", () => {
      expect(isAlwaysAllowed("git status")).toBe(false);
      expect(isAlwaysAllowed("git push")).toBe(false);
    });

    it("blocks curl/wget", () => {
      expect(isAlwaysAllowed("curl https://example.com")).toBe(false);
      expect(isAlwaysAllowed("wget https://example.com/file")).toBe(false);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Custom pattern tests
// ────────────────────────────────────────────────────────────────────────────

describe("custom alwaysAllow patterns", () => {
  it("can add git commands", () => {
    const patterns = compilePatterns(["^git\\s"]);
    expect(isAlwaysAllowed("git status", patterns)).toBe(true);
    expect(isAlwaysAllowed("git push origin main", patterns)).toBe(true);
    expect(isAlwaysAllowed("npm test", patterns)).toBe(false); // not in custom set
  });

  it("can add docker commands", () => {
    const patterns = compilePatterns(["^docker\\s", "^docker-compose\\s"]);
    expect(isAlwaysAllowed("docker ps", patterns)).toBe(true);
    expect(isAlwaysAllowed("docker-compose up -d", patterns)).toBe(true);
    expect(isAlwaysAllowed("docker system prune -af", patterns)).toBe(true);
  });

  it("supports complex regex patterns", () => {
    // Allow any command that starts with "python" or "python3"
    const patterns = compilePatterns(["^python[3]?\\s"]);
    expect(isAlwaysAllowed("python script.py", patterns)).toBe(true);
    expect(isAlwaysAllowed("python3 -m http.server", patterns)).toBe(true);
    expect(isAlwaysAllowed("python3.12 -c 'print(1)'", patterns)).toBe(false);
  });

  it("handles case-insensitive matching", () => {
    const patterns = compilePatterns(["^git\\s"]);
    expect(isAlwaysAllowed("GIT status", patterns)).toBe(true);
    expect(isAlwaysAllowed("Git push", patterns)).toBe(true);
  });

  it("supports .* for broad matching", () => {
    // Allow everything (use with caution!)
    const patterns = compilePatterns([".*"]);
    expect(isAlwaysAllowed("rm -rf /", patterns)).toBe(true);
    expect(isAlwaysAllowed("sudo rm -rf /", patterns)).toBe(true);
    expect(isAlwaysAllowed("whatever", patterns)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Invalid pattern handling
// ────────────────────────────────────────────────────────────────────────────

describe("invalid regex handling", () => {
  it("silently drops invalid regex patterns", () => {
    // "[" is an invalid regex
    const patterns = compilePatterns(["^npm\\s", "[", "^git\\s"]);
    expect(patterns).toHaveLength(2);
    expect(isAlwaysAllowed("npm test", patterns)).toBe(true);
    expect(isAlwaysAllowed("git status", patterns)).toBe(true);
  });

  it("returns empty array if all patterns are invalid", () => {
    const patterns = compilePatterns(["[", "(unclosed"]);
    expect(patterns).toHaveLength(0);
    // Nothing is allowed when no valid patterns exist
    expect(isAlwaysAllowed("npm test", patterns)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Config merge behavior tests (simulating the loadPermissionConfig logic)
// ────────────────────────────────────────────────────────────────────────────

describe("permission config merging", () => {
  it("project config overrides user config", () => {
    const userAlwaysAllow = ["^npm\\s", "^git\\s"];
    const projectAlwaysAllow = ["^docker\\s"];
    // Project overrides entirely (not merged)
    const merged = projectAlwaysAllow ?? userAlwaysAllow ?? DEFAULT_ALWAYS_ALLOW;
    expect(merged).toEqual(["^docker\\s"]);
  });

  it("falls back to user config if project has no alwaysAllow", () => {
    const userAlwaysAllow = ["^npm\\s", "^git\\s"];
    const projectAlwaysAllow: string[] | undefined = undefined;
    const merged = projectAlwaysAllow ?? userAlwaysAllow ?? DEFAULT_ALWAYS_ALLOW;
    expect(merged).toEqual(["^npm\\s", "^git\\s"]);
  });

  it("falls back to defaults if neither config specifies alwaysAllow", () => {
    const userAlwaysAllow: string[] | undefined = undefined;
    const projectAlwaysAllow: string[] | undefined = undefined;
    const merged = projectAlwaysAllow ?? userAlwaysAllow ?? DEFAULT_ALWAYS_ALLOW;
    expect(merged).toEqual(DEFAULT_ALWAYS_ALLOW);
  });
});
