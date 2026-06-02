# pi-business

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that adds
productivity-focused features for professional development workflows.

## Features

### 1. Model Aliases

Map short, memorable names to full provider/model strings. Use `alias/light`
instead of remembering `openrouter/deepseek/deepseek-v4-flash`.
Especially useful for collaboration. Every developer can specify their own models for the given aliases 
in a config file in their user folder. 

**Configuration files** (JSON):

| Location | Scope |
|---|---|
| `~/.pi/agent/alias.json` | User-level (lower priority) |
| `.pi/alias.json` | Project-level (overrides user) |

**Format:**

```json
{
  "large": "anthropic/claude-opus-4-5",
  "medium": "anthropic/claude-sonnet-4",
  "light": "openrouter/deepseek/deepseek-v4-flash"
}
```

**Usage:**

```
/model alias/light    # Select via /model command
PI_MODEL=alias/medium  # Set via environment variable
```

The extension registers a virtual `alias` provider. When you select an alias,
it automatically translates to the real model before any API call is made.

**Important — OpenRouter routing:**

The alias target determines which **provider** (API gateway) handles the
request. If you map an alias directly to a provider like `deepseek`, pi will
look for a DeepSeek API key. If you don't have one configured, you'll get an
API key error.

→ **Route through OpenRouter instead** by prefixing the target with `openrouter/`:

```json
// ❌ Direct provider — requires a DeepSeek API key
"light": "deepseek/deepseek-v4-flash"

// ✅ Routed through OpenRouter — uses your OpenRouter API key
"light": "openrouter/deepseek/deepseek-v4-flash"
```

This applies to any provider/model available on OpenRouter. The pattern is
`openrouter/<provider>/<model>`.

**How it works:** The extension splits the alias target on the first `/` to
extract the provider name. Everything after that first `/` becomes the model
identifier passed to that provider. So `openrouter/deepseek/deepseek-v4-flash`
becomes `provider=openrouter`, `model=deepseek/deepseek-v4-flash`.

### 2. Permission Gate

Prompts for confirmation before running potentially dangerous bash commands.
Protects against accidental destructive operations.

By default every command is intercepted. Custom patterns to always allow certain commands can be set in the configuration file.

```
Bash command requested:

  rm -rf /important/directory

Allow?
  [Yes]  [No]
```

The dialog times out after 5 minutes (blocking the command). Concurrent
permission requests are queued and processed sequentially to avoid UI races.

### 3. Subagent Tool

Delegate tasks to specialized subagents with isolated context windows.
Subagents are configured as Markdown files with YAML frontmatter.

**Agent locations:**

| Location | Scope |
|---|---|
| `<ext>/default-agents/*.md` | Builtin (lowest, can be disabled) |
| `~/.pi/agent/agents/*.md` | User-level |
| `.pi/agents/*.md` | Project-level (highest priority) |

Precedence: project > user > builtin.

Builtin agents can be disabled in pi-business.json:
```json
{ "defaultAgents": false }
```

**Usage from within pi:**

```typescript
subagent({ agent: "reviewer", task: "Review the auth module for errors" })
```

Supports single, parallel, chain, async/background, and forked-context
execution modes. See the built-in skill file (`skills/subagent.md`) for
complete documentation.

## Installation

Add to `.pi/extensions/pi-business/` with the following structure:

```
.pi/extensions/pi-business/
├── index.ts
├── package.json
├── skills/subagent.md
└── src/
    ├── model-aliases.ts
    ├── permission-gate.ts
    ├── subagent-config.ts
    ├── subagent-tool.ts
    ├── types.ts
    ├── ui.ts
    └── utils.ts
```

pi automatically discovers and loads extensions from `.pi/extensions/`.

## Example: Setting Up Aliases with OpenRouter

1. Create `~/.pi/agentalias.json`:

```json
{
  "large": "openrouter/anthropic/claude-opus-4-5",
  "medium": "openrouter/anthropic/claude-sonnet-4",
  "light": "openrouter/deepseek/deepseek-v4-flash"
}
```

2. Ensure OpenRouter is configured as a provider in pi (typically set up via
   `~/.pi/agent/models.json` or pi's built-in OpenRouter provider).

3. Start a session and select an alias:

```
pi
/model alias/light
```

4. The extension translates `alias/light` → `openrouter/deepseek/deepseek-v4-flash`
   and pi routes the request through OpenRouter using your configured API key.

## Development

The extension is built in TypeScript and uses the pi SDK (`@earendil-works/pi-coding-agent`).
Entry point is `index.ts`, which wires up all three features via pi lifecycle hooks.
