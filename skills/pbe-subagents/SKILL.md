---
name: pbe-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent and parallel
  execution. Use for advisory review, implementation handoffs, and multi-step
  tasks where a single agent should stay in control while other agents
  contribute context, planning, or execution.
---

# Pi Business Subagents

Use this skill when you need to launch a specialized subagent, run multiple
agents in parallel, or create/edit agents on demand.

## When to Use

- **Advisory review**: launch a subagent to review code, plans, or direction
- **Implementation handoff**: delegate focused implementation work
- **Recon and planning**: use a scout subagent for fast codebase exploration
- **Parallel exploration**: run multiple non-conflicting tasks concurrently

## Builtin Agents

Builtin agents ship with the extension in the `default-agents/` directory.
They load at the lowest priority. Project agents override user agents,
and both override builtins with the same name.

Builtin agents are enabled by default. To disable them, add to
`.pi/pi-business.json` or `~/.pi/agent/pi-business.json`:

```json
{
  "defaultAgents": false
}
```

Three builtin agents ship with the extension:

| Agent | Purpose | Model | Notes |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | `alias/light` | Writes handoff context; uses read, grep, find, ls, bash |
| `worker` | General-purpose implementation | `alias/light` | Full tool access |
| `delegate` | Lightweight generic delegate | inherits default | No default tools specified; direct and efficient |

**Subagent types are just prompts written in markdown files.** When you run
multiple subagents in parallel, you can reuse the same type (e.g., three
`scout` agents) because each invocation gets its own isolated session with the
same system prompt. There is no limit on how many times you can use a given
agent type — the only constraint is parallel concurrency (default 4, up to 8
total tasks). The agent file defines a reusable prompt; each invocation creates
a fresh, independent session.

Builtin agents inherit the parent model when no `model` is set in their
frontmatter. To override a builtin agent's model, create a user or project
agent with the same name.

## Discovery and Scope Rules

Agent files can live in:
- `<extension>/default-agents/*.md` — builtin scope (lowest priority, can be disabled)
- `~/.pi/agent/agents/*.md` — user scope (lower priority)
- `.pi/agents/*.md` — project scope (higher priority, overrides user)

Discovery walks up from the current working directory to find the nearest
`.pi/agents/` directory. Project agents automatically override user agents with
the same name.

Precedence:
1. project scope
2. user scope
3. builtin agents

## Agent File Format

A minimal agent file looks like this:

```markdown
---
name: my-agent
description: What this agent does
model: alias/light
tools: read, grep, find, ls, bash
---

Your system prompt here.
```

Required frontmatter:
- `name` — agent identifier (must be unique within a scope)
- `description` — what the agent does (max 1000 chars; longer descriptions are truncated)

Optional frontmatter:
- `model` — provider/model string or `alias/` reference
- `tools` — comma-separated tool names (defaults to `read, bash, edit, write, question`)

## Running Subagents

The `subagent` tool supports two modes: single agent and parallel execution.

### Single agent

```typescript
subagent({
  agent: "scout",
  task: "Explore the auth module"
})
```

### Parallel execution

Run multiple agents concurrently:

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Explore the auth module" },
    { agent: "scout", task: "Explore the API client" },
    { agent: "worker", task: "Implement the login fix" }
  ]
})
```

**Important: subagent types can be used multiple times.** Each task gets its own
isolated session — running three `scout` agents in parallel works because each
instance is independent. There is no shared memory or state between invocations.

**Constraints:**
- Maximum 8 tasks in parallel
- Default concurrency: 4 (configurable via `pi-business.json`)
- All tasks must specify both `agent` and `task`

Configuring concurrency (`.pi/pi-business.json` or `~/.pi/agent/pi-business.json`):

```json
{
  "maxConcurrency": 4
}
```

Project config overrides user config.

### Single vs. Parallel rules

Provide exactly one mode: `agent` + `task` (single) OR `tasks` array (parallel), not both.

## Listing Available Agents

Use the `list_subagents` tool to discover available agents:

```typescript
list_subagents({})
```

Returns each agent with its name, source (`user`, `project`, or `builtin`), description, and model.

## How Subagents Work Internally

### Execution model

Subagents run via the pi SDK's `createAgentSession` in-process (no separate OS
process). Each subagent gets:

- An **isolated, in-memory session** — no disk I/O, no session persistence
- The agent's **system prompt** from its markdown file
- Only the **tools** specified in the agent config (or defaults)
- The **host's extensions** (including pi-business) — but skills, prompts,
  themes, and context files are blocked to keep the subagent focused

### Event bus bridging

When a subagent calls `bash` or `question`, the permission gate and question
tool requests are bridged to the parent session's UI. This means:

- Dangerous bash commands in subagents still prompt the user for confirmation
- Subagent `question()` calls show up in the parent session's UI
- No configuration needed — the bridge is automatic

### Abort handling

If the parent session is aborted (Ctrl+C), the abort signal propagates to all
running subagents. Subagent sessions are always disposed in a `finally` block.

### Usage tracking

Each subagent result includes token usage stats: turns, input/output tokens,
cache read/write, and cost.

## Prompting Subagents

Write task prompts as a compact contract, not a long procedural script. Define
the destination and let the agent choose the efficient path.

A strong subagent prompt usually includes:
- **Goal**: the concrete outcome the child should produce
- **Context/evidence**: relevant file paths, code patterns, decisions, or constraints
- **Success criteria**: what must be true before the child can finish
- **Hard constraints**: true invariants only (e.g., "do not edit files" for review-only tasks)
- **Validation**: targeted checks to run
- **Output**: the expected summary shape or finding format

For implementation handoffs, name the approved scope and success criteria more
clearly than the process. Good prompts say what to change, what not to change,
and how to validate.

## Workflow Patterns

### Recon → Implement

```typescript
// Step 1: Scout the area
subagent({
  agent: "scout",
  task: "Map the auth module: find entry points, key types, and files likely to need changes."
})

// Step 2: Implement based on scout findings
subagent({
  agent: "worker",
  task: "Implement the login fix. Key files: [from scout]. Change: ..."
})
```

### Parallel non-conflicting analysis

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Audit frontend auth flow" },
    { agent: "scout", task: "Audit backend IAM service" }
  ]
})
```

### Parallel review

```typescript
subagent({
  tasks: [
    { agent: "worker", task: "Review the current diff for correctness and regressions. Do not edit files." },
    { agent: "worker", task: "Review the current diff for tests and validation quality. Do not edit files." },
    { agent: "worker", task: "Review the current diff for simplicity and maintainability. Do not edit files." }
  ]
})
```

Note: since there is no builtin `reviewer` agent, use `worker` with explicit
review-only instructions.

## Creating and Editing Agents

### Create an agent by writing a markdown file

Create a `.md` file in `~/.pi/agent/agents/` (user scope) or `.pi/agents/`
(project scope) with YAML frontmatter:

```markdown
---
name: my-reviewer
description: Code review specialist that checks for correctness and style issues
model: alias/light
tools: read, grep, find, ls, bash
---

You are a code reviewer. Inspect the supplied code carefully and report
evidence-backed findings with file paths and line references. Do not make edits
unless explicitly asked.
```

The agent is immediately available — no restart required. Agents are
discovered fresh on each invocation.

### Override a builtin agent

Create a user or project agent with the same name. Project-scoped agents win
over user-scoped agents, and both win over builtins.

### Delete an agent

Remove the markdown file.

## Important Constraints

- **No forked/fresh context modes.** All subagents run in isolated, in-memory
  sessions. They do not inherit the parent's conversation history.
- **No chain mode.** Use the parent agent to sequence multiple single or
  parallel `subagent` calls.
- **No async/background mode.** All subagent calls are synchronous (the parent
  blocks until the child completes).
- **No subagent nesting.** Subagents receive boundary instructions that say
  the parent owns orchestration. Do not ask subagents to launch more subagents.
- **No output files.** All results are returned inline. Subagents cannot write
  results to files.
- **No management actions.** The `subagent` tool only supports execution
  (`agent` + `task` or `tasks` array). No `create`, `update`, `delete`, `status`,
  or `doctor` actions.
- **No worktree isolation.** All subagents share the same filesystem view.
  Keep writes single-threaded — use one writer agent and multiple read-only
  agents when running in parallel.
- **No intercom integration.** Subagents cannot send messages back to the
  parent session. The parent must synthesize results after all tasks complete.

## Best Practices

### Keep writes single-threaded by default

When running parallel subagents, ensure only one agent writes to the filesystem.
Use other agents for read-only tasks like exploration, review, or research.

### Prefer narrow tasks

Give subagents specific tasks rather than vague mandates.
`Review auth.ts for null-check gaps` works better than `Review everything`.

### Synthesize parallel results

After parallel execution, read all results and synthesize before acting.
Do not blindly apply every subagent's suggestions.

### Don't nest subagents

Child subagents receive a boundary instruction that the parent owns
orchestration. Write your tasks so they don't ask the child to launch more
subagents.

## Error Handling

**"Unknown agent"**
```typescript
list_subagents({})
// Check available agents, then use the correct name or create the missing agent.
```

**Subagent returns an error**
```
// Check the error message in the result. Common causes:
// - Unknown agent name
// - Aborted by user (stopReason: "aborted")
// - LLM error (stopReason: "error")
```

**"Must provide agent + task or tasks array"**
```
// You called subagent without required parameters. Provide either:
// { agent: "name", task: "..." } for single mode, or
// { tasks: [{agent: "...", task: "..."}] } for parallel mode.
```

## Differences from the Official Pi Subagent Example

| Aspect | Official example | pi-business |
|---|---|---|
| Process model | Separate OS process (`pi` binary) | In-process SDK session |
| Modes | Single, parallel, chain | Single, parallel |
| Context modes | Fresh, fork | Isolated in-memory only |
| Output | Can write to files | Inline only |
| Agent discovery | Flat, no packages | Flat, no packages |
| Management | Via slash commands | File-based only |
| Intercom | Supported | Not supported |
| Async/background | Supported | Not supported |
