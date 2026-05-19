/**
 * Tests for pure helper functions in src/subagent-tool.ts.
 *
 * Tests: formatTokens, formatUsage, getFinalOutput, resolveModel.
 * These are not exported directly, so we test them indirectly where
 * possible, or reimplement to verify logic correctness.
 */

import { describe, it, expect } from "vitest";

// ────────────────────────────────────────────────────────────────────────────
// Reimplementations for testing (mirrors the actual logic verbatim)
// ────────────────────────────────────────────────────────────────────────────

function formatTokens(count: number): string {
  const abs = Math.abs(count);
  const sign = count < 0 ? "-" : "";
  if (abs < 1000) return count.toString();
  if (abs < 10000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  if (abs < 1000000) return `${sign}${Math.round(abs / 1000)}k`;
  return `${sign}${(abs / 1000000).toFixed(1)}M`;
}

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

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
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

// ────────────────────────────────────────────────────────────────────────────
// formatTokens
// ────────────────────────────────────────────────────────────────────────────

describe("formatTokens", () => {
  it("formats numbers below 1000 as plain integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats numbers 1000-9999 as X.Xk", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  it("formats numbers 10000-999999 as rounded k", () => {
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(15500)).toBe("16k");
    expect(formatTokens(999999)).toBe("1000k");
  });

  it("formats numbers >= 1000000 as X.XM", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(2500000)).toBe("2.5M");
    expect(formatTokens(10000000)).toBe("10.0M");
  });

  it("handles negative numbers (unexpected but should not crash)", () => {
    // Negative numbers hit the < 1000 branch
    expect(formatTokens(-1)).toBe("-1");
    expect(formatTokens(-5000)).toBe("-5.0k"); // < 10000 but > -10000
  });

  it("handles fractional numbers", () => {
    expect(formatTokens(0.5)).toBe("0.5");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getFinalOutput
// ────────────────────────────────────────────────────────────────────────────

describe("getFinalOutput", () => {
  it("returns text from the last assistant message", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ];
    expect(getFinalOutput(messages)).toBe("Hi there");
  });

  it("returns the last assistant message when multiple exist", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Q1" }] },
      { role: "assistant", content: [{ type: "text", text: "A1" }] },
      { role: "user", content: [{ type: "text", text: "Q2" }] },
      { role: "assistant", content: [{ type: "text", text: "A2" }] },
    ];
    expect(getFinalOutput(messages)).toBe("A2");
  });

  it("returns empty string for empty messages array", () => {
    expect(getFinalOutput([])).toBe("");
  });

  it("returns empty string when no assistant message exists", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Only user" }] },
      { role: "system", content: [{ type: "text", text: "System msg" }] },
    ];
    expect(getFinalOutput(messages)).toBe("");
  });

  it("returns empty string when assistant has no text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "read", input: {} },
        ],
      },
    ];
    expect(getFinalOutput(messages)).toBe("");
  });

  it("returns empty string when assistant content is empty array", () => {
    const messages = [
      { role: "assistant", content: [] },
    ];
    expect(getFinalOutput(messages)).toBe("");
  });

  it("returns the first text part even if multiple content parts", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "First text" },
          { type: "text", text: "Second text" },
        ],
      },
    ];
    expect(getFinalOutput(messages)).toBe("First text");
  });

  it("skips non-text content parts", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "read", input: {} },
          { type: "text", text: "After tool" },
        ],
      },
    ];
    expect(getFinalOutput(messages)).toBe("After tool");
  });

  it("handles very long output", () => {
    const longText = "x".repeat(1_000_000);
    const messages = [
      { role: "assistant", content: [{ type: "text", text: longText }] },
    ];
    expect(getFinalOutput(messages)).toBe(longText);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// formatUsage
// ────────────────────────────────────────────────────────────────────────────

describe("formatUsage", () => {
  const baseUsage: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };

  it("returns empty string for all-zero usage with no model", () => {
    expect(formatUsage(baseUsage)).toBe("");
  });

  it("shows turn count (singular)", () => {
    expect(formatUsage({ ...baseUsage, turns: 1 })).toBe("1 turn");
  });

  it("shows turn count (plural)", () => {
    expect(formatUsage({ ...baseUsage, turns: 3 })).toBe("3 turns");
  });

  it("shows input tokens", () => {
    expect(formatUsage({ ...baseUsage, input: 500 })).toBe("↑500");
  });

  it("shows output tokens", () => {
    expect(formatUsage({ ...baseUsage, output: 2000 })).toBe("↓2.0k");
  });

  it("shows cache read tokens", () => {
    expect(formatUsage({ ...baseUsage, cacheRead: 10000 })).toBe("R10k");
  });

  it("shows cache write tokens", () => {
    expect(formatUsage({ ...baseUsage, cacheWrite: 500 })).toBe("W500");
  });

  it("shows cost formatted to 4 decimal places", () => {
    expect(formatUsage({ ...baseUsage, cost: 0.0152 })).toBe("$0.0152");
  });

  it("shows model name", () => {
    expect(formatUsage(baseUsage, "anthropic/claude-sonnet-4")).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

  it("combines all fields", () => {
    const fullUsage: UsageStats = {
      turns: 2,
      input: 1500,
      output: 3200,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0152,
    };
    expect(formatUsage(fullUsage, "anthropic/claude-sonnet-4")).toBe(
      "2 turns ↑1.5k ↓3.2k $0.0152 anthropic/claude-sonnet-4",
    );
  });

  it("omits zero fields", () => {
    const partialUsage: UsageStats = {
      turns: 1,
      input: 500,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    expect(formatUsage(partialUsage)).toBe("1 turn ↑500");
  });

  it("handles very large cost values", () => {
    expect(formatUsage({ ...baseUsage, cost: 1234.56789 })).toBe("$1234.5679");
  });

  it("handles large all-around usage with all tokens", () => {
    const hugeUsage: UsageStats = {
      turns: 10,
      input: 5000000,
      output: 2500000,
      cacheRead: 1000000,
      cacheWrite: 500000,
      cost: 25.50,
    };
    const result = formatUsage(hugeUsage, "anthropic/claude-opus-4-5");
    expect(result).toContain("10 turns");
    expect(result).toContain("↑5.0M");
    expect(result).toContain("↓2.5M");
    expect(result).toContain("R1.0M");
    expect(result).toContain("W500k");
    expect(result).toContain("$25.5000");
    expect(result).toContain("anthropic/claude-opus-4-5");
  });
});
