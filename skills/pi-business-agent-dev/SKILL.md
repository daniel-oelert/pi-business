---
name: pi-business-agent-dev
description: |
  Develop new features for the pi-business Pi agent extension. Covers the
  permission gate, subagent tool, internal design patterns, and how to add
  new capabilities.
metadata:
  version: "2.0"
---

# Pi-Business Extension Development

Use this skill when adding features to **pi-business** — the project's Pi agent
extension at `.pi/extensions/pi-business/`. It provides:

- **Permission gate** — prompts for confirmation before running dangerous bash
  commands (rm -rf, sudo, chmod/chown 777)
- **Subagent tool** — runs specialized subagents in isolated SDK sessions for
  focused tasks like code review, planning, and research
- **Model aliases** — maps short alias names ("large", "medium", "light") to
  real provider/model strings, making configs and skills portable across
  developers

---

## 1. File Structure

```
.pi/extensions/pi-business/
├── index.ts                   # Entry point — wires all features
├── package.json               # Depends on @earendil-works/pi-coding-agent ^0.75.1
├── skills/
│   └── subagent.md            # Skill: how the parent orchestrator uses subagents
└── src/
    ├── types.ts               # Shared event constants and interfaces
    ├── ui.ts                  # Centralized UI — all dialogs funnel through here
    ├── permission-gate.ts     # Tool_call interceptor for dangerous bash
    ├── question-tool.ts       # Agent-facing question tool for user input
    ├── subagent-tool.ts       # Custom "subagent" tool + agent runner
    ├── subagent-config.ts     # Agent discovery from markdown files
    └── model-aliases.ts       # Model alias resolution (alias/large → real model)
```

The entry point (`index.ts`) is minimal — it calls `init` functions:

```typescript
export default function (pi: ExtensionAPI) {
    initModelAliases(pi);
    permissionGateInit(pi);
    initQuestionTool(pi);
    initSubagentTool(pi);
}
```

New features should follow the same pattern: a dedicated `src/` module with an
`init(pi)` or similar export, called from `index.ts`.

---

## 2. Shared Types (`src/types.ts`)

The extension uses a typed event bus for inter-module communication. Only the
permission gate uses this currently, but the pattern is designed to be extended:

```typescript
export const BASH_PERMISSION_REQUESTED = "pibusiness:bash_permission_requested";
export const BASH_PERMISSION_RESPONSE  = "pibusiness:bash_permission_response";

export const QUESTION_REQUESTED = "pibusiness:question_requested";
export const QUESTION_RESPONSE  = "pibusiness:question_response";

export interface BashPermissionRequestedEvent {
    requestId: string;
    command: string;
}

export interface BashPermissionResponseEvent {
    requestId: string;
    allowed: boolean;
    reason?: string;
}

export interface QuestionRequestedEvent {
    requestId: string;
    question: string;
    options: string[];
    allowCustomAnswer: boolean;
}

export interface QuestionResponseEvent {
    requestId: string;
    answer: string | null;
    cancelled: boolean;
}
```

**Convention:** Event names use a `pibusiness:` prefix. Request/response pairs
share a `requestId` so concurrent requests don't cross wires. 

**To add a new event pair**, define constants and interfaces here following the
same `request/response` pattern, then use `pi.events.emit()` and
`pi.events.on()` in the sender/receiver modules.

---

## 3. Permission Gate (`src/permission-gate.ts`)

### What it does

Intercepts every `bash` tool call. Emits a permission request event, then waits
for a response event (from the UI module). If denied or timed out, blocks the
tool call.

### Event-bus request/response pattern

This is the core design pattern for the extension. Two modules communicate
without importing each other:

```
permission-gate.ts                    ui.ts
─────────────────                    ──────
tool_call handler                     pi.events.on(BASH_PERMISSION_REQUESTED)
  │                                     │
  ├─ emit REQUEST ─────────────────────►│
  │                                     ├─ uiChain.then(...)
  │                                     │  └─ ctx.ui.select("Allow?", ["Yes","No"])
  │                                     │     └─ emit RESPONSE
  │◄────────────────────────────────────┘
  │
  └─ resolve({ block: true } | undefined)
```

### Key implementation details

**Request ID generation** uses timestamp + random suffix:

```typescript
function generateRequestId(): string {
    return `bash-permission-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
```

**Response matching** — the handler filters by `requestId` so parallel requests
don't interfere:

```typescript
const unsub = pi.events.on(BASH_PERMISSION_RESPONSE, (data) => {
    const response = data as BashPermissionResponseEvent;
    if (response.requestId !== requestId) return;  // ignore wrong request
    unsub(); clearTimeout(timer);
    resolve(response.allowed ? undefined : { block: true, reason: response.reason });
});
```

**Timeout guard** — if the UI never responds (e.g., headless mode), the command
is blocked after 5 minutes:

```typescript
const timer = setTimeout(() => {
    unsub();
    resolve({ block: true, reason: "Permission request timed out" });
}, 5 * 60 * 1000);
```

**Blocking return value** — `tool_call` handlers can return `{ block: true,
reason: "..." }` to prevent execution.

### Adding more command patterns to the gate

To add new dangerous patterns, modify the condition in `permission-gate.ts`.
The current implementation checks all bash commands, but there's no pattern
filter in the emit — it gates every bash call. To add pattern-specific gating,
add a check before emitting:

```typescript
const dangerousPatterns = [
    /\brm\s+(-rf?|--recursive)/i,
    /\bsudo\b/i,
    /\b(chmod|chown)\b.*777/i,
    /\bmkfs\b/i,  // new pattern
];

const isDangerous = dangerousPatterns.some(p => p.test(command));
if (!isDangerous) return undefined;  // allow non-dangerous commands through
```

### Adding a new permission check

To gate a different tool (e.g., `write` to protected files), add a new
`tool_call` case to `permission-gate.ts`:

```typescript
pi.on("tool_call", async (event, ctx) => {
    // Existing: bash gate
    if (event.toolName === "bash") { /* ... */ }

    // New: write gate for protected files
    if (event.toolName === "write") {
        const filePath = event.input.path as string;
        if (filePath.includes(".env") || filePath.includes("credentials")) {
            const requestId = generateRequestId();
            pi.events.emit("pibusiness:write_permission_requested", {
                requestId, path: filePath,
            });
            // ... same request/response pattern
        }
    }
});
```

Then add corresponding event constants to `types.ts` and a handler in `ui.ts`.

---

## 4. Centralized UI (`src/ui.ts`)

### Design intent

All user-facing dialogs are managed in one module. Each feature (permission
gate, future additions) emits an event; `ui.ts` listens and handles the dialog.
This keeps dialog logic out of tool-execution code and prevents races.

### activeCtx tracking

The UI module needs `ExtensionContext` to call `ctx.ui.select()`, but
`pi.events.on()` doesn't receive a context. It tracks it by listening to
lifecycle events:

```typescript
let activeCtx: ExtensionContext | null = null;

pi.on("session_start", (_event, ctx) => { activeCtx = ctx; });
pi.on("turn_start",    (_event, ctx) => { activeCtx = ctx; });
```

These fire at the right times to keep the reference current. The context is
only used inside event-bus handlers — never across async gaps where it could
stale.

### UiChain — sequential dialog serialization

Parallel tool calls from the same assistant message run concurrently. Without
serialization, two dialogs would race: one `ui.select()` would overwrite the
other, and the losing request would timeout after 5 minutes.

```typescript
let uiChain: Promise<void> = Promise.resolve();

pi.events.on(BASH_PERMISSION_REQUESTED, (data) => {
    const request = data as BashPermissionRequestedEvent;
    uiChain = uiChain.then(async () => {
        // dialog code — serialized, only one runs at a time
    });
});
```

Each handler chains onto the previous promise, creating a sequential queue.
This pattern must be used for **any** new dialog type that could be triggered
by parallel tool calls.

### hasUI guard

Dialogs only work in interactive mode. In print (`-p`) or RPC mode, `hasUI` is
false. The current UI handler silently skips when there's no UI, and the
permission-gate's timeout eventually blocks the command. For new dialogs,
consider an explicit `else` branch:

```typescript
if (activeCtx && activeCtx.hasUI) {
    const choice = await activeCtx.ui.select(...);
    // emit response
} else {
    // Decide: deny by default, or allow when headless?
    pi.events.emit(MY_RESPONSE, { requestId, allowed: false, reason: "No UI available" });
}
```

### Error handling in dialogs

If `ctx.ui.select()` throws (e.g., the user sends input that crashes the
dialog), the handler catches it and emits a failure response so the request
doesn't hang:

```typescript
try {
    const choice = await activeCtx.ui.select(...);
    pi.events.emit(RESPONSE, { requestId, allowed: choice === "Yes" });
} catch (error) {
    pi.events.emit(RESPONSE, {
        requestId, allowed: false,
        reason: "UI Error: " + ((error as Error).message ?? "Unknown error"),
    });
}
```

### Adding a new dialog handler

1. Add event constants to `types.ts`
2. In `ui.ts`, add a `pi.events.on(NEW_REQUEST, (data) => { ... })` handler
3. Follow the `uiChain` pattern for serialization
4. Always guard with `hasUI` and handle errors with a fallback response

---

## 5. Subagent Tool (`src/subagent-tool.ts`)

### What it does

Registers a custom tool named `subagent` that the LLM can call. It discovers
available agents from markdown files, launches the selected agent in an
isolated SDK session, collects results, and returns formatted output.

### Tool registration

```typescript
pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a specialized subagent with an isolated context window.",
    parameters: SubagentParams,     // { agent: string, task: string }
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => { ... },
    renderCall(args, theme, _context) { ... },     // TUI: how the call appears
    renderResult(result, { expanded }, theme, _context) { ... },  // TUI: expanded/collapsed
});
```

### Execution flow

```
subagent tool called { agent: "reviewer", task: "Review auth.ts" }
  │
  ├─ discoverAgents(ctx.cwd)          → finds all *.md from ~/.pi/agent/agents/ + .pi/agents/
  ├─ agents.find("reviewer")          → look up agent config
  ├─ resolveModel(ctx.modelRegistry, agent.model)
  ├─ createAgentSession({ ... })      → isolated session, inherits host extensions
  │   ├─ SessionManager.inMemory()    → no file I/O, pure in-memory
  │   ├─ SettingsManager.inMemory({ compaction: false })
  │   └─ DefaultResourceLoader: same cwd, host extensions, no skills/prompts/themes
  │
  ├─ session.subscribe(...)           → collect messages and usage
  ├─ await session.prompt(task)        → block until complete
  └─ session.dispose()                → always in finally
```

### Isolated session setup

The subagent gets an isolated session that inherits the host's extensions but
keeps skills, prompts, themes, and context files blocked. Only the agent's
system prompt and the requested tools apply. Extensions are loaded via
`DefaultResourceLoader` with the same working directory as the host and the
default agent directory:

```typescript
const resourceLoader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir: getAgentDir(),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: agent.systemPrompt,
});
await resourceLoader.reload();
```

Extensions (both project-scoped from `.pi/extensions/` and user-scoped from
`~/.pi/agent/extensions/`) are discovered and loaded. Skills, prompts, themes,
and AGENTS.md are kept isolated to prevent the subagent from receiving
orchestration skills like `pi-subagents`.

### Model resolution

Agents can optionally specify a model via frontmatter. The `resolveModel`
function parses `provider/model` strings and looks them up in the parent
session's `ModelRegistry`:

```typescript
function resolveModel(modelRegistry: ModelRegistry, modelName?: string) {
    const slashIdx = modelName.indexOf("/");
    if (slashIdx > 0) {
        const provider = modelName.slice(0, slashIdx);
        const id = modelName.slice(slashIdx + 1);
        return reg.find(provider, id);  // cast to AnyModelRegistry for type compatibility
    }
    return undefined;
}
```

If no model is specified (or resolution fails), `createAgentSession` uses the
default model. The `model` field is passed as `undefined` in that case.

### Abort handling

The subagent session supports the parent session's abort signal:

```typescript
if (signal) {
    abortHandler = () => { wasAborted = true; session.abort(); };
    if (signal.aborted) {
        abortHandler();  // already aborted before we started
    } else {
        signal.addEventListener("abort", abortHandler, { once: true });
    }
}
```

On abort, the result reports `exitCode: 1, stopReason: "aborted"`. The cleanup
path removes the event listener and disposes the session.

### Usage tracking

The runner accumulates token/cost stats from `message_end` events:

```typescript
session.subscribe((event) => {
    if (event.type === "message_end" && event.message) {
        const msg = event.message;
        result.messages.push(msg);
        if (msg.role === "assistant") {
            result.usage.turns++;
            if (msg.usage) {
                result.usage.input     += msg.usage.input || 0;
                result.usage.output    += msg.usage.output || 0;
                result.usage.cacheRead += msg.usage.cacheRead || 0;
                result.usage.cacheWrite+= msg.usage.cacheWrite || 0;
                result.usage.cost      += msg.usage.cost?.total || 0;
            }
            if (!result.model && msg.model) result.model = msg.model;
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
        }
    }
});
```

### Output formatting

The final output includes the agent's last assistant message, a separator, and
usage stats:

```
[agent response text]

───
reviewer (project) · 2 turns ↑1.5k ↓3.2k $0.0152 anthropic/claude-sonnet-4
```

Helpers `formatTokens()` and `formatUsage()` produce the compact stats line.

### Custom TUI rendering

**Call rendering** (`renderCall`) shows a bold "subagent" label with the agent
name in accent color and a dimmed task preview:

```typescript
renderCall(args, theme, _context) {
    let text = theme.fg("toolTitle", theme.bold("subagent ")) +
               theme.fg("accent", args.agent);
    text += `\n  ${theme.fg("dim", taskPreview)}`;
    return new Text(text, 0, 0);
}
```

**Result rendering** (`renderResult`) has two modes:

- **Collapsed** (default): shows agent name, status icon, output preview (first
  200 chars), and usage stats.

- **Expanded** (Ctrl+O): builds a `Container` with sections for header, task,
  output (as `Markdown`), and usage stats.

Theme colors used:
| Token | Usage |
|---|---|
| `"toolTitle"` | Agent name, section headers |
| `"accent"` | Agent name in call rendering |
| `"dim"` | Task preview, usage stats |
| `"muted"` | Source label, "no output" placeholder, expand hint |
| `"error"` | Error icon, stop reason, error message |
| `"success"` | Success icon |
| `"toolOutput"` | Output preview in collapsed view |

---

## 6. Agent Discovery (`src/subagent-config.ts`)

### Discovery locations

Agents are defined as markdown files with YAML frontmatter:

| Location | Priority | Source label |
|---|---|---|
| `~/.pi/agent/agents/*.md` | Lower | `"user"` |
| `.pi/agents/*.md` (walked up from cwd) | Higher | `"project"` |

Project agents override user agents with the same name. The nearest `.pi/agents/`
directory walking up from `cwd` is used.

### File format

```markdown
---
name: reviewer
description: Code review specialist
model: anthropic/claude-sonnet-4
thinking: high
tools: read, grep, find, ls, bash
systemPromptMode: replace
---

You are a code reviewer...
```

Required frontmatter: `name`, `description`. Files missing either are silently
skipped. Optional fields: `tools` (comma-separated), `model` (provider/id
format), `thinking`, `systemPromptMode`.

### AgentConfig interface

```typescript
interface AgentConfig {
    name: string;            // from frontmatter "name"
    description: string;     // from frontmatter "description"
    tools?: string[];        // parsed from comma-separated frontmatter "tools"
    model?: string;          // from frontmatter "model"
    systemPrompt: string;    // markdown body after frontmatter
    source: "user" | "project";
    filePath: string;
}
```

### Adding frontmatter fields

To support additional frontmatter fields (e.g., `maxTokens`):

1. Add the field to `AgentConfig` in `subagent-config.ts`
2. Read it from `frontmatter` in the `loadAgentsFromDir` loop
3. Pass it through in `runSingleAgent` to `createAgentSession` options if needed

### Project agent directory walk

`findNearestProjectAgentsDir(cwd)` walks up from `cwd` looking for
`.pi/agents/`. Stops at filesystem root. Returns `null` if not found.

---

## Model Aliases (`src/model-aliases.ts`)

### Purpose

Maps short alias names ("large", "medium", "light") to real provider/model
strings. This makes shared configurations, skills, and agent definitions
portable — each developer maintains their own alias mapping.

### Alias Resolution

When code references a model with provider `"alias"` (e.g. `"alias/large"`),
the extension translates it to the real model before any API call is made.

```
"alias/large"  →  "anthropic/claude-opus-4-5"
"alias/medium" →  "anthropic/claude-sonnet-4-20250514"
"alias/light"  →  "anthropic/claude-haiku-4-20250514"
```

### alias.json Format

Two locations, merged with project overriding user:

| Location | Priority |
|---|---|
| `<agentDir>/alias.json` | Lower (user-level, all projects) |
| `.pi/alias.json` | Higher (project-level) |

The user-level path is resolved via `getAgentDir()` from
`@earendil-works/pi-coding-agent` (typically `~/.pi/agent/`).

```json
{
  "large": "anthropic/claude-opus-4-5",
  "medium": "anthropic/claude-sonnet-4-20250514",
  "light": "anthropic/claude-haiku-4-20250514"
}
```

Keys are alias names, values are `"provider/model"` strings.

### How It Works

1. **Provider registration** — A virtual `"alias"` provider is registered via
   `pi.registerProvider("alias", {...})` with model entries for each alias.
   This makes models findable via `modelRegistry.find("alias", "large")`.

2. **Model translation** — Hooks intercept at three points to swap alias
   models for real models:
   - `session_start`: Translates if the session restored or default model is
     an alias.
   - `model_select`: Translates when the user switches to an alias via
     `/model` or `Ctrl+P`.
   - `before_agent_start`: Safety net — ensures no alias model ever reaches
     the provider.

3. **Subagent integration** — `resolveModel()` in `subagent-tool.ts` checks
   for `alias/` prefix and resolves via `resolveAliasTarget()` from
   `model-aliases.ts`. Circular alias detection is built in.

### Registration Details

The alias provider registers models with conservative defaults:
- `reasoning: true` (optimistic)
- `input: ["text", "image"]`
- `contextWindow: 200000`
- `maxTokens: 16384`

These are placeholders — actual model properties come from the resolved target.
The dummy `baseUrl` and `apiKey` prevent accidental API calls through the alias
provider.

### Error Handling

- Invalid JSON in alias files → silently ignored (no aliases loaded)
- Target model not found → warning notification, model unchanged
- No API key for target → warning notification
- Circular aliases → detected by `resolveModel()`, returns `undefined`

### Usage Examples

**Agent config referencing an alias:**

```markdown
---
name: reviewer
description: Code review specialist
model: alias/medium
---
```

**Settings referencing an alias:**

```json
{
  "defaultModel": "alias/large"
}
```

**Subagent tool calls:** the LLM may reference alias models when invoking
`subagent`, and they resolve automatically.

### Exports

| Export | Purpose |
|---|---|
| `initModelAliases(pi)` | Main init — called from index.ts |
| `resolveAliasTarget(modelStr)` | Resolve "alias/X" → "provider/model" |
| `getAliasMap()` | Snapshot of current alias mappings |

---

## 7. How to Add a New Feature

### Pattern: New tool registration

Create `src/new-feature.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";

export function initNewTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: "my_feature",
        label: "My Feature",
        description: "What it does",
        parameters: Type.Object({
            input: Type.String({ description: "..." }),
        }),
        async execute(_id, params, signal, _onUpdate, ctx) {
            return {
                content: [{ type: "text", text: `Result: ${params.input}` }],
                details: {},
            };
        },
        renderCall(args, theme, _context) {
            return new Text(theme.fg("toolTitle", theme.bold("my_feature ")) +
                           theme.fg("dim", args.input), 0, 0);
        },
        renderResult(result, { expanded }, theme, _context) {
            const preview = result.content[0]?.text?.slice(0, 200) ?? "";
            return new Text(theme.fg("toolOutput", preview), 0, 0);
        },
    });
}
```

Register it in `index.ts`:

```typescript
import { initNewTool } from "./src/new-feature";

export default function (pi: ExtensionAPI) {
    permissionGateInit(pi);
    initSubagentTool(pi);
    initNewTool(pi);
}
```

### Pattern: New event-bus feature (with UI confirmations)

Create `src/types.ts` additions:

```typescript
export const MY_FEATURE_REQUEST = "pibusiness:my_feature_request";
export const MY_FEATURE_RESPONSE = "pibusiness:my_feature_response";

export interface MyFeatureRequestEvent { requestId: string; ... }
export interface MyFeatureResponseEvent { requestId: string; allowed: boolean; ... }
```

Create `src/my-feature.ts` (the tool/trigger side):

```typescript
import { initUI } from "./ui";
import { MY_FEATURE_REQUEST, MY_FEATURE_RESPONSE } from "./types";

export function initMyFeature(pi: ExtensionAPI) {
    initUI(pi);  // ensures UI module is active
    pi.on("tool_call", async (event) => {
        // emit request, await response — same pattern as permission-gate.ts
    });
}
```

Add the UI handler in `ui.ts`:

```typescript
import { MY_FEATURE_REQUEST, MY_FEATURE_RESPONSE } from "./types";

// Inside initUI():
pi.events.on(MY_FEATURE_REQUEST, (data) => {
    const request = data as MyFeatureRequestEvent;
    uiChain = uiChain.then(async () => {
        if (activeCtx && activeCtx.hasUI) {
            try {
                const choice = await activeCtx.ui.select(...);
                pi.events.emit(MY_FEATURE_RESPONSE, { ... });
            } catch (error) {
                pi.events.emit(MY_FEATURE_RESPONSE, { requestId, allowed: false, reason: "UI Error" });
            }
        }
    });
});
```

### Pattern: New lifecycle-based feature

For features that need to react to session events without user interaction,
create a standalone module:

```typescript
// src/lifecycle-feature.ts
export function initLifecycleFeature(pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.setStatus("my-feature", "Active");
    });

    pi.on("before_agent_start", async (event) => {
        return {
            message: {
                customType: "my-feature",
                content: "Additional context for the agent.",
                display: false,
            },
        };
    });

    pi.on("session_shutdown", async () => {
        // cleanup
    });
}
```

### Pattern: New slash command

```typescript
// src/my-command.ts
export function initMyCommand(pi: ExtensionAPI) {
    pi.registerCommand("mycmd", {
        description: "Does something",
        handler: async (args, ctx) => {
            ctx.ui.notify(`Ran with: ${args}`, "info");
        },
    });
}
```

---

## 8. Question Tool (`src/question-tool.ts`)

### What it does

Registers a custom tool named `question` that lets the agent ask the user a
multiple-choice question with an optional free-text answer. The agent calls it
when it needs user clarification to proceed (e.g., choosing between approaches,
confirming a decision, or providing missing details).

```
question({ question: "Pick an approach", options: ["Option A", "Option B"], allowCustomAnswer: true })
```

The user picks an option or types a custom answer. The tool returns the
selected string, with rich `details` on the result for TUI rendering.

### Architecture — event-bus pattern

The question tool follows the same event-bus request/response pattern as the
permission gate (Section 3). The tool emits a `QUESTION_REQUESTED` event and
waits for `QUESTION_RESPONSE`:

```
question-tool.ts                  ui.ts
────────────────                  ──────
execute()                         pi.events.on(QUESTION_REQUESTED)
  │                                  │
  ├─ emit REQUEST ──────────────────►│
  │                                  ├─ uiChain.then(...)
  │                                  │  └─ ctx.ui.select(options + "Other…")
  │                                  │     └─ if "Other…": ctx.ui.input()
  │                                  │        └─ emit RESPONSE
  │◄─────────────────────────────────┘
  │
  └─ resolve({ content, details })
```

Unlike the permission gate (which blocks tool execution), the question tool
returns its answer as a tool result so the agent can incorporate the user's
input into subsequent turns.

### Key implementation details

**Request ID generation** uses timestamp + random suffix (same pattern as
permission-gate):

```typescript
function generateRequestId(): string {
    return `question-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
```

**Response matching** filters by `requestId` so parallel question calls don't
cross wires:

```typescript
const unsub = pi.events.on(QUESTION_RESPONSE, (data) => {
    const response = data as QuestionResponseEvent;
    if (response.requestId !== requestId) return;
    unsub(); clearTimeout(timer);
    // ... resolve with answer or cancelled state
});
```

**Timeout guard** — rejects after 5 minutes if the UI never responds (e.g.,
headless mode):

```typescript
const timer = setTimeout(() => {
    unsub();
    reject(new Error("Question timed out after 5 minutes."));
}, 5 * 60 * 1000);
```

Note: this rejects (agent sees an error) rather than resolving with a
cancelled result like the permission gate timeout does.

**Custom answer detection** — if the selected answer is not in the original
options array and `allowCustomAnswer` was not false, `details.wasCustom` is
set to `true`:

```typescript
resolve({
    content: [{ type: "text", text: `Answer: ${response.answer}` }],
    details: {
        question: params.question,
        options,
        answer: response.answer,
        cancelled: false,
        wasCustom: !options.includes(response.answer) && allowCustomAnswer,
    } satisfies QuestionToolDetails,
});
```

### QuestionToolDetails

Stored on the tool result for rendering and state tracking:

```typescript
export interface QuestionToolDetails {
    question: string;
    options: string[];
    answer: string | null;
    cancelled: boolean;
    wasCustom?: boolean;
    timedOut?: boolean;
}
```

### TUI rendering

**Call rendering** (`renderCall`) shows a bold "question" label with the
question text (truncated to 60 chars) and the first 4 options:

```typescript
renderCall(args, theme, _context) {
    const a = args as QuestionParamsInput | undefined;
    const q = a?.question || "...";
    const preview = q.length > 60 ? `${q.slice(0, 60)}...` : q;
    let text = theme.fg("toolTitle", theme.bold("question ")) +
               theme.fg("accent", preview);
    const opts = Array.isArray(a?.options) ? a.options : [];
    if (opts.length > 0) {
        const labels = opts.slice(0, 4)
            .map((o, i) => `${i + 1}. ${o}`)
            .join(", ");
        const more = opts.length > 4 ? ` +${opts.length - 4} more` : "";
        text += `\n  ${theme.fg("dim", `Options: ${labels}${more}`)}`;
    }
    return new Text(text, 0, 0);
}
```

**Result rendering** (`renderResult`) shows different states:

| State | Display |
|---|---|
| No details | Falls back to `content[0].text` or `"(no output)"` |
| Timed out | ⏱ Timed out (5 min) in warning color |
| Cancelled / no answer | "Cancelled" in warning color |
| Custom answer | `(wrote) answer` in muted + accent |
| Listed answer | `N. answer` in accent with checkmark |

### Subagent integration

The question tool exports `createQuestionToolDef(pi)` which returns a raw tool
definition suitable for passing to `createAgentSession({ customTools: [...] })`.
The `question` tool is included in the default tool set for subagents:

```typescript
const toolNames = agent.tools ?? ["read", "bash", "edit", "write", "question"];
```

Subagents running in headless or automated contexts should use `question`
sparingly — there is no user to answer. When configuring agents for fully
automated workflows, omit `question` from their `tools` frontmatter.

### Parameter schema

```typescript
const QuestionParams = Type.Object({
    question: Type.String({
        description: "The question to ask the user",
    }),
    options: Type.Array(Type.String(), {
        description:
            "Available options to present to the user. The user can also type " +
            "a custom answer if allowCustomAnswer is true.",
    }),
    allowCustomAnswer: Type.Optional(
        Type.Boolean({
            description:
                "Whether the user can type a custom answer instead of selecting " +
                "an option. Default: true.",
        }),
    ),
});
```

At least one option is required — calling with an empty options array throws.

### UI handler (in ui.ts)

The question dialog handler in `ui.ts` follows the same `uiChain` serialization
pattern as the permission gate (Section 4):

1. Listens for `QUESTION_REQUESTED` events
2. Chains onto `uiChain` for serialization
3. Guards with `activeCtx.hasUI`
4. Calls `activeCtx.ui.select(options.concat("Other…"))` when `allowCustomAnswer`
   is true, or just the options when false
5. If the user picks "Other…", calls `activeCtx.ui.input()` for free-text input
6. Emits `QUESTION_RESPONSE` with the answer or cancelled state
7. Catches errors with a fallback cancelled response

### question vs ui.select

| Aspect | `question` tool | `ui.select` (event-bus) |
|---|---|---|
| Trigger | Agent calls the tool directly | Extension code calls `ctx.ui.select()` |
| Timing | During agent execution (returns answer to agent) | Before/during tool execution (gating) |
| Caller | LLM (via tool call) | Extension module (e.g., permission-gate.ts) |
| Serialization | uiChain in the UI handler | uiChain in the UI handler |
| Flexibility | Multiple-choice + optional free-text | Any TUI dialog type |
| Primary use case | Agent needs user clarification | Extension gates/confirms a tool call |
| Registration | `pi.registerTool({...})` | Event constants in `types.ts` + handler in `ui.ts` |

### Exports

| Export | Purpose |
|---|---|
| `initQuestionTool(pi)` | Register the question tool on the main extension API |
| `createQuestionToolDef(pi)` | Return raw tool definition for subagent `customTools` |
| `QuestionToolDetails` | Interface for result details (TUI rendering + state tracking) |
| `QuestionParamsInput` | Input interface for the tool parameters |


## 9. Internal Design Patterns

### Event bus decoupling

The permission gate and UI module don't import each other. They communicate
through `pi.events` using typed request/response pairs with matching
`requestId`. This pattern should be followed for any new feature that needs
asynchronous coordination between modules.

**Rules:**
- Event constants live in `types.ts` with `pibusiness:` prefix
- Request events carry a unique `requestId`
- Response events include the same `requestId` for matching
- Receivers filter by `requestId` to ignore unrelated responses
- All request/response cycles have a timeout (5 minutes)

### UI centralized in ui.ts

ui.ts owns all `ctx.ui.*` calls. The file comment states: *"All user-facing
prompts, selections, and interactions are managed here so that future additions
to the extension can extend this module."*

New features that need dialogs must add handlers here, not in their own
modules.

### UiChain serialization

All dialog-triggering event handlers must chain onto `uiChain` to prevent
concurrent dialog races. The pattern:

```typescript
uiChain = uiChain.then(async () => {
    // dialog code here
});
```

Failure to use this pattern results in `ui.select()` calls overwriting each
other when parallel tool calls trigger the same dialog type.

### Context tracking

`activeCtx` in `ui.ts` stays fresh via `session_start` and `turn_start`
handlers. These are the right events because:
- `session_start` fires once when the extension loads
- `turn_start` fires before each LLM turn (and thus before any tool calls)

New features that need `ExtensionContext` inside event-bus handlers should use
the same approach: capture it from lifecycle events into a module-level
variable.

### Isolated subagent sessions

Subagents get isolated SDK sessions that inherit host extensions but keep skills, prompts, themes, and context files blocked. The key design decisions:

1. **In-memory only** — `SessionManager.inMemory()`, no file I/O
2. **Host extensions** — subagents load the same extensions as the host via `DefaultResourceLoader`. Skills, prompts, themes, and context files remain isolated to prevent orchestration skills from leaking in
3. **No context files** — subagents don't read AGENTS.md
4. **No skills** — only the agent's own system prompt applies
5. **Parent abort propagation** — `signal.addEventListener("abort", ...)`
6. **Always dispose** — `session.dispose()` in a `finally` block

### Default tools fallback

If an agent configuration doesn't specify `tools`, the runner defaults to:

```typescript
const toolNames = agent.tools ?? ["read", "bash", "edit", "write"];
```

---

## 10. Subagent Skill (`skills/subagent.md`)

The extension ships with a skill at `skills/subagent.md` that teaches the
parent orchestrator agent how to use subagents effectively. This skill is
loaded via Pi's standard skill discovery (`.pi/skills/`).

Key contents of the skill:
- When to use subagents (advisory review, implementation handoff, parallel exploration)
- Tool vs slash commands
- Builtin agent descriptions (scout, planner, worker, reviewer, etc.)
- Workflow recipes (recon → plan → implement, parallel review)
- Prompting techniques for role agents
- Context modes (fresh, fork)
- Parallel execution patterns
- Oracle workflow
- Constraints and best practices

When extending the subagent system, this skill may need updates if:
- New builtin agents are added
- Subagent tool API changes
- New workflow patterns are introduced

---

## 11. Key Pi APIs Used by pi-business

### Extension API

| API | Used by | Purpose |
|---|---|---|
| `pi.on("tool_call", handler)` | permission-gate.ts | Intercept bash calls |
| `pi.on("session_start", handler)` | ui.ts | Track active context |
| `pi.on("turn_start", handler)` | ui.ts | Refresh context before tool calls |
| `pi.registerTool({...})` | subagent-tool.ts | Register "subagent" tool |
| `pi.events.emit(name, data)` | permission-gate.ts, ui.ts | Send events between modules |
| `pi.events.on(name, handler)` | permission-gate.ts, ui.ts | Receive events |

| `pi.on("model_select", ...)` | model-aliases.ts | Translate alias model when user switches |
| `getAgentDir()` | model-aliases.ts | Resolve user-level alias.json path |
| `pi.registerProvider(...)` | model-aliases.ts | Register virtual "alias" provider |
| `pi.setModel(...)` | model-aliases.ts | Swap alias model for real target |

### ExtensionContext

| Method | Used by | Purpose |
|---|---|---|
| `ctx.ui.select(prompt, choices)` | ui.ts | Permission confirmation dialog |
| `ctx.hasUI` | ui.ts | Guard against headless mode |
| `ctx.cwd` | subagent-tool.ts, subagent-config.ts | Working directory for agent discovery |
| `ctx.modelRegistry` | subagent-tool.ts | Resolve agent model strings |

### SDK (createAgentSession)

| Import | Used by | Purpose |
|---|---|---|
| `createAgentSession` | subagent-tool.ts | Create isolated subagent session |
| `SessionManager.inMemory()` | subagent-tool.ts | Ephemeral session (no disk I/O) |
| `SettingsManager.inMemory({...})` | subagent-tool.ts | In-memory settings |
| `DefaultResourceLoader` | subagent-tool.ts | Resource loader with host extensions, isolated skills/prompts/themes |
| `getAgentDir` | subagent-config.ts | User-level agents directory path |
| `parseFrontmatter` | subagent-config.ts | Parse YAML frontmatter from .md files |
| `getMarkdownTheme` | subagent-tool.ts | Theme for Markdown rendering in TUI |

### TUI Components

| Import | Used by | Purpose |
|---|---|---|
| `Text` | subagent-tool.ts | Call and result rendering |
| `Container` | subagent-tool.ts | Expanded result layout |
| `Markdown` | subagent-tool.ts | Render subagent output as markdown |
| `Spacer` | subagent-tool.ts | Vertical spacing in results |

### Schema

| Import | Used by | Purpose |
|---|---|---|
| `Type.Object`, `Type.String` (typebox) | subagent-tool.ts | Tool parameter schema |

---

## 12. Differences from Official Pi Subagent Example

The official Pi subagent example at
`pi/examples/extensions/subagent/` spawns a separate `pi` OS process for each
subagent. pi-business takes a different approach:

| Aspect | Official example | pi-business |
|---|---|---|
| Process model | Separate OS process (`pi` binary) | In-process SDK session |
| Agent config | Complex chain/parallel DSL | Simple single-agent only |
| Context | Reads session JSONL | Fresh, isolated context |
| Dependencies | Requires `pi` on PATH | SDK only |
| Rendering | Basic text | Full TUI (expanded/collapsed, markdown) |

The in-process approach is lighter weight and doesn't need a separate Pi
install, but requires careful session isolation via `ResourceLoader`.

---

## 13. Current Limitations

- **Subagent tool is single-agent only** — no parallel execution, no chains, no
  async mode. These would require extending `SubagentParams`, `runSingleAgent`,
  and the result rendering.

- **All bash commands are gated** — the permission gate currently intercepts
  every bash call, not just dangerous ones. The dangerous pattern checking
  happens in the UI prompt text, but the confirmation dialog fires regardless.

- **No persistent subagent sessions** — all subagents use `inMemory()` sessions
  and are discarded after completion. No ability to resume a subagent.

- **No subagent output files** — all output is returned inline. No support for
  writing subagent results to files.

- **Error handling is basic** — errors from subagent execution return a simple
  text message. No retry logic, no structured error details beyond
  `errorMessage` and `stderr`.

- **One-dimensional discovery** — agent discovery is flat (no subdirectories,
  no package namespacing). The `package` frontmatter field described in the
  official docs isn't supported.

- **No UI alternatives for headless mode** — when `hasUI` is false, the
  permission gate's timeout (5 minutes) is the only resolution path.
