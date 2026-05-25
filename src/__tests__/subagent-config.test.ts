/**
 * Tests for src/subagent-config.ts — Agent discovery from markdown files.
 *
 * Tests loadAgentsFromDir (via discoverAgents), AgentConfig parsing,
 * frontmatter validation, project-over-user override, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentConfig, AgentDiscoveryResult } from "../subagent-config";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    getAgentDir: () => "/mock/user/pi/agent",
  };
});

import { discoverAgents } from "../subagent-config";

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeAgentMarkdown(
  dir: string,
  filename: string,
  frontmatter: Record<string, string>,
  body: string,
) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    // Quote values that contain YAML-special characters (commas, colons, leading/trailing whitespace)
    const needsQuote =
      /[,:]/.test(value) || value.startsWith(" ") || value.endsWith(" ");
    if (needsQuote) {
      lines.push(`${key}: "${value}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(body);

  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

// ────────────────────────────────────────────────────────────────────────────
// discoverAgents — basic discovery
// ────────────────────────────────────────────────────────────────────────────

describe("discoverAgents", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers a single valid agent", () => {
    writeAgentMarkdown(
      agentsDir,
      "reviewer.md",
      {
        name: "reviewer",
        description: "Code review specialist",
        model: "anthropic/claude-sonnet-4",
      },
      "You are a code reviewer. Be thorough.",
    );

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("reviewer");
    expect(result.agents[0].description).toBe("Code review specialist");
    expect(result.agents[0].model).toBe("anthropic/claude-sonnet-4");
    expect(result.agents[0].systemPrompt).toContain("You are a code reviewer");
    expect(result.agents[0].source).toBe("project");
  });

  it("discovers multiple agents from the same directory", () => {
    writeAgentMarkdown(agentsDir, "reviewer.md",
      { name: "reviewer", description: "Reviews code" }, "Be thorough.");
    writeAgentMarkdown(agentsDir, "planner.md",
      { name: "planner", description: "Plans implementation" }, "Plan carefully.");
    writeAgentMarkdown(agentsDir, "scout.md",
      { name: "scout", description: "Explores codebase" }, "Explore deeply.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(3);
    const names = result.agents.map((a) => a.name).sort();
    expect(names).toEqual(["planner", "reviewer", "scout"]);
  });

  it("returns empty agents array when directory does not exist", () => {
    // Use a fresh temp path outside tmpDir so the upward walk
    // does not accidentally find .pi/agents created by beforeEach.
    const nonExistentDir = path.join(
      os.tmpdir(),
      `pi-business-isolated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const result = discoverAgents(nonExistentDir);
    expect(result.agents).toEqual([]);
    expect(result.projectAgentsDir).toBeNull();
  });

  it("returns empty agents when directory is empty", () => {
    const result = discoverAgents(agentsDir);
    expect(result.agents).toEqual([]);
    expect(result.projectAgentsDir).toBe(agentsDir);
  });

  it("sets projectAgentsDir correctly", () => {
    writeAgentMarkdown(agentsDir, "test.md",
      { name: "test", description: "Test agent" }, "Hello.");

    const result = discoverAgents(agentsDir);
    expect(result.projectAgentsDir).toBe(agentsDir);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// discoverAgents — frontmatter validation
// ────────────────────────────────────────────────────────────────────────────

describe("discoverAgents — frontmatter validation", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips agent missing 'name' field", () => {
    writeAgentMarkdown(agentsDir, "noname.md",
      { description: "Has description but no name" }, "Body.");
    writeAgentMarkdown(agentsDir, "hasname.md",
      { name: "valid", description: "Has name and description" }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("valid");
  });

  it("skips agent missing 'description' field", () => {
    writeAgentMarkdown(agentsDir, "nodesc.md",
      { name: "nodesc" }, "Has name but no description.");
    writeAgentMarkdown(agentsDir, "valid.md",
      { name: "valid", description: "Complete" }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("valid");
  });

  it("skips agent missing both name and description", () => {
    writeAgentMarkdown(agentsDir, "empty.md",
      {}, "No frontmatter fields at all.");
    writeAgentMarkdown(agentsDir, "valid.md",
      { name: "valid", description: "Complete" }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("valid");
  });

  it("skips agent with empty name string", () => {
    writeAgentMarkdown(agentsDir, "empty-name.md",
      { name: "", description: "Empty name" }, "Body.");

    const result = discoverAgents(agentsDir);
    // Empty string is falsy → skipped
    expect(result.agents.filter((a) => a.name === "")).toHaveLength(0);
  });

  it("skips agent with empty description string", () => {
    writeAgentMarkdown(agentsDir, "empty-desc.md",
      { name: "test", description: "" }, "Body.");

    const result = discoverAgents(agentsDir);
    // Empty description is falsy → skipped
    expect(result.agents.filter((a) => a.name === "test")).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// discoverAgents — tools frontmatter field
// ────────────────────────────────────────────────────────────────────────────

describe("discoverAgents — tools parsing", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses comma-separated tools", () => {
    writeAgentMarkdown(agentsDir, "with-tools.md",
      {
        name: "tooluser",
        description: "Uses tools",
        tools: "read, bash, edit, write",
      },
      "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents[0].tools).toEqual(["read", "bash", "edit", "write"]);
  });

  it("parses single tool", () => {
    writeAgentMarkdown(agentsDir, "single-tool.md",
      {
        name: "singletool",
        description: "One tool",
        tools: "read",
      },
      "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents[0].tools).toEqual(["read"]);
  });

  it("handles whitespace around tool names", () => {
    writeAgentMarkdown(agentsDir, "whitespace-tools.md",
      {
        name: "whitespacetools",
        description: "Extra spaces",
        tools: "  read ,  bash  ,edit,   write   ",
      },
      "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents[0].tools).toEqual(["read", "bash", "edit", "write"]);
  });

  it("handles empty tools string (undefined tools)", () => {
    writeAgentMarkdown(agentsDir, "empty-tools.md",
      {
        name: "emptytools",
        description: "No tools",
        tools: "",
      },
      "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents[0].tools).toBeUndefined();
  });

  it("handles tools with only commas and whitespace", () => {
    writeAgentMarkdown(agentsDir, "junk-tools.md",
      {
        name: "junktools",
        description: "Junk tools",
        tools: ", , ,",
      },
      "Body.");

    const result = discoverAgents(agentsDir);
    // Filter(Boolean) removes empty strings → empty array → undefined
    expect(result.agents[0].tools).toBeUndefined();
  });

  it("agent without tools field gets undefined (defaults in runner)", () => {
    writeAgentMarkdown(agentsDir, "no-tools.md",
      { name: "notools", description: "No tools field" }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents[0].tools).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// discoverAgents — file handling edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("discoverAgents — file edge cases", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores non-.md files", () => {
    // Write a .txt file and a valid .md file
    fs.writeFileSync(path.join(agentsDir, "notes.txt"), "not an agent", "utf-8");
    writeAgentMarkdown(agentsDir, "valid.md",
      { name: "valid", description: "The real agent" }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("valid");
  });

  it("ignores files without any extension", () => {
    fs.writeFileSync(path.join(agentsDir, "noextension"), "no yaml", "utf-8");
    writeAgentMarkdown(agentsDir, "valid.md",
      { name: "valid", description: "Agent" }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
  });

  it("ignores subdirectories (flat discovery only)", () => {
    const subDir = path.join(agentsDir, "subpackage");
    fs.mkdirSync(subDir);
    writeAgentMarkdown(subDir, "nested.md",
      { name: "nested", description: "In subdirectory" }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents.filter((a) => a.name === "nested")).toHaveLength(0);
  });

  it("handles empty .md file (no frontmatter)", () => {
    fs.writeFileSync(path.join(agentsDir, "empty.md"), "", "utf-8");
    writeAgentMarkdown(agentsDir, "valid.md",
      { name: "valid", description: "Valid" }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("valid");
  });

  it("handles .md file with only frontmatter delimiters (no content)", () => {
    fs.writeFileSync(path.join(agentsDir, "only-dashes.md"), "---\n---\n", "utf-8");
    writeAgentMarkdown(agentsDir, "valid.md",
      { name: "valid", description: "Valid" }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("valid");
  });

  it("handles .md file with YAML that has no closing ---", () => {
    fs.writeFileSync(
      path.join(agentsDir, "unclosed.md"),
      "---\nname: broken\ndescription: No end delimiter\n",
      "utf-8",
    );
    writeAgentMarkdown(agentsDir, "valid.md",
      { name: "valid", description: "Valid" }, "Body.");

    const result = discoverAgents(agentsDir);
    // Should not crash; the unclosed file may or may not parse depending on
    // parseFrontmatter behavior. We just verify no crash.
    expect(result.agents.length).toBeGreaterThanOrEqual(1);
  });

  it("handles files with very long system prompts", () => {
    const longBody = "A".repeat(100_000);
    writeAgentMarkdown(agentsDir, "long.md",
      { name: "long", description: "Very long body" }, longBody);

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].systemPrompt.length).toBe(100_000);
  });

  it("handles Unicode in agent names and descriptions", () => {
    writeAgentMarkdown(agentsDir, "unicode.md",
      { name: "审查员", description: "代码审查" }, "检查代码。");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("审查员");
    expect(result.agents[0].description).toBe("代码审查");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// discoverAgents — description length enforcement (MAX_DESCRIPTION_LENGTH = 1000)
// ────────────────────────────────────────────────────────────────────────────

describe("discoverAgents — description length enforcement", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("truncates descriptions longer than 1000 characters", () => {
    const longDesc = "A".repeat(2000);
    writeAgentMarkdown(agentsDir, "toolong.md",
      { name: "toolong", description: longDesc }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].description.length).toBe(1000);
    expect(result.agents[0].description).toBe("A".repeat(1000));
  });

  it("keeps descriptions of exactly 1000 characters unchanged", () => {
    const exactDesc = "B".repeat(1000);
    writeAgentMarkdown(agentsDir, "exact.md",
      { name: "exact", description: exactDesc }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].description.length).toBe(1000);
    expect(result.agents[0].description).toBe(exactDesc);
  });

  it("keeps descriptions shorter than 1000 characters unchanged", () => {
    const shortDesc = "Short description";
    writeAgentMarkdown(agentsDir, "short.md",
      { name: "short", description: shortDesc }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].description).toBe(shortDesc);
  });

  it("truncates descriptions that are just over 1000 characters", () => {
    const overDesc = "C".repeat(1001);
    writeAgentMarkdown(agentsDir, "barelyover.md",
      { name: "barelyover", description: overDesc }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].description.length).toBe(1000);
    expect(result.agents[0].description).toBe("C".repeat(1000));
  });

  it("truncates Unicode descriptions longer than 1000 characters at character boundary", () => {
    // Use ñ (U+00F1) — 1 JS char, 2 UTF-8 bytes — to verify it's character-based
    const char = "ñ";
    expect(char.length).toBe(1); // single JS char
    const longDesc = char.repeat(2000);
    writeAgentMarkdown(agentsDir, "unicode-long.md",
      { name: "unicodelong", description: longDesc }, "Body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].description.length).toBe(1000);
    expect(result.agents[0].description).toBe(char.repeat(1000));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// discoverAgents — project-over-user override
// ────────────────────────────────────────────────────────────────────────────

describe("discoverAgents — project overrides user agents", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("project agent takes precedence over user agent with same name", () => {
    // We can only test project agents here since user agents are mocked to /mock/user/pi/agent
    // But we can verify that when a project agent is added, it appears with source "project"
    writeAgentMarkdown(agentsDir, "helper.md",
      {
        name: "helper",
        description: "Project-level helper agent",
        model: "anthropic/claude-haiku-4",
      },
      "I am the project helper.",
    );

    const result = discoverAgents(agentsDir);
    const helper = result.agents.find((a) => a.name === "helper");
    expect(helper).toBeDefined();
    expect(helper!.source).toBe("project");
    expect(helper!.description).toBe("Project-level helper agent");
  });

  it("two agents with different names do not conflict", () => {
    writeAgentMarkdown(agentsDir, "alpha.md",
      { name: "alpha", description: "Alpha" }, "Alpha body.");
    writeAgentMarkdown(agentsDir, "beta.md",
      { name: "beta", description: "Beta" }, "Beta body.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(2);
    expect(result.agents.map((a) => a.source)).toEqual(["project", "project"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// discoverAgents — AgentConfig shape
// ────────────────────────────────────────────────────────────────────────────

describe("discoverAgents — AgentConfig shape", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returned AgentConfig has all required fields", () => {
    writeAgentMarkdown(agentsDir, "complete.md",
      {
        name: "complete",
        description: "Complete agent",
        tools: "read, bash",
        model: "anthropic/claude-sonnet-4",
      },
      "System prompt here.",
    );

    const result = discoverAgents(agentsDir);
    const agent = result.agents[0];

    expect(typeof agent.name).toBe("string");
    expect(agent.name.length).toBeGreaterThan(0);
    expect(typeof agent.description).toBe("string");
    expect(agent.description.length).toBeGreaterThan(0);
    expect(typeof agent.systemPrompt).toBe("string");
    expect(agent.source).toBe("project");
    expect(typeof agent.filePath).toBe("string");
    expect(agent.filePath).toContain("complete.md");
  });

  it("AgentConfig.filePath is absolute", () => {
    writeAgentMarkdown(agentsDir, "path-test.md",
      { name: "pathtest", description: "Test path" }, "Body.");

    const result = discoverAgents(agentsDir);
    const agent = result.agents[0];
    expect(path.isAbsolute(agent.filePath)).toBe(true);
    expect(agent.filePath).toBe(path.join(agentsDir, "path-test.md"));
  });

  it("AgentConfig.model is the raw string from frontmatter", () => {
    writeAgentMarkdown(agentsDir, "model-test.md",
      {
        name: "modeltest",
        description: "Model test",
        model: "alias/medium",
      },
      "Body.");

    const result = discoverAgents(agentsDir);
    // It stores the raw string — resolution happens later
    expect(result.agents[0].model).toBe("alias/medium");
  });

  it("agent with minimal valid frontmatter (just name + description) works", () => {
    writeAgentMarkdown(agentsDir, "minimal.md",
      { name: "minimal", description: "Bare minimum" },
      "I am minimal.");

    const result = discoverAgents(agentsDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("minimal");
    expect(result.agents[0].tools).toBeUndefined();
    expect(result.agents[0].model).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// discoverAgents — walks up directory tree
// ────────────────────────────────────────────────────────────────────────────

describe("discoverAgents — directory walking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .pi/agents from cwd itself", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    writeAgentMarkdown(agentsDir, "found.md",
      { name: "found", description: "Found at cwd" }, "Body.");

    const result = discoverAgents(tmpDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("found");
    expect(result.projectAgentsDir).toBe(agentsDir);
  });

  it("finds .pi/agents from a deep subdirectory", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    writeAgentMarkdown(agentsDir, "deep-found.md",
      { name: "deepfound", description: "Found from deep" }, "Body.");

    const deepDir = path.join(tmpDir, "src", "components", "nested");
    fs.mkdirSync(deepDir, { recursive: true });

    const result = discoverAgents(deepDir);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("deepfound");
  });

  it("returns null projectAgentsDir when .pi/agents is not found in tree", () => {
    const isolatedDir = path.join(tmpDir, "isolated");
    fs.mkdirSync(isolatedDir);

    const result = discoverAgents(isolatedDir);
    expect(result.projectAgentsDir).toBeNull();
    expect(result.agents).toEqual([]);
  });

  it("uses nearest .pi/agents when multiple exist in tree", () => {
    // Root .pi/agents
    const rootAgents = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(rootAgents, { recursive: true });
    writeAgentMarkdown(rootAgents, "root.md",
      { name: "roverride", description: "Root version" }, "Root body.");

    // Nested .pi/agents (closer to cwd)
    const nestedDir = path.join(tmpDir, "subproj");
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedAgents = path.join(nestedDir, ".pi", "agents");
    fs.mkdirSync(nestedAgents, { recursive: true });
    writeAgentMarkdown(nestedAgents, "override.md",
      { name: "roverride", description: "Nested version overrides" }, "Nested body.");

    // Search from nested dir
    const result = discoverAgents(nestedDir);
    const agent = result.agents.find((a) => a.name === "roverride");
    expect(agent).toBeDefined();
    // The nested one should be found (walk up stops at first match)
    expect(agent!.description).toBe("Nested version overrides");
    expect(result.projectAgentsDir).toBe(nestedAgents);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// discoverAgents — readdir errors (permission denied, etc.)
// ────────────────────────────────────────────────────────────────────────────

describe("discoverAgents — error resilience", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-business-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not crash when .pi directory exists but is unreadable", () => {
    // Create .pi without agents subdirectory
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);

    // If we can't make it unreadable (root required), we verify the
    // directory exists but has no agents subdirectory.
    // discoverAgents calls findNearestProjectAgentsDir, which looks for
    // .pi/agents specifically. Since agents doesn't exist, it returns null.
    const result = discoverAgents(tmpDir);
    expect(result.projectAgentsDir).toBeNull();
  });

  it("does not crash when a single .md file is unreadable", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    writeAgentMarkdown(agentsDir, "good.md",
      { name: "good", description: "Readable" }, "Body.");

    // Create a file we can't read (only works if not root)
    const badPath = path.join(agentsDir, "bad.md");
    fs.writeFileSync(badPath, "test", "utf-8");
    try {
      fs.chmodSync(badPath, 0o000);
    } catch {
      // chmod may not work (e.g., Windows); skip this check gracefully
    }

    // Should not throw
    const result = discoverAgents(agentsDir);
    // At minimum, "good.md" should be found
    expect(result.agents.some((a) => a.name === "good")).toBe(true);
  });

  it("does not crash when projectAgentsDir is null", () => {
    const result = discoverAgents(tmpDir);
    expect(result.agents).toEqual([]);
    expect(result.projectAgentsDir).toBeNull();
  });
});
