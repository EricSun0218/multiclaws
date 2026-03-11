# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

MultiClaws is an OpenClaw plugin that enables multi-instance AI collaboration via the A2A (Agent-to-Agent) protocol. Multiple OpenClaw instances form teams, share agent profiles, and delegate tasks to each other. Cross-network connectivity uses Tailscale auto-detection.

## Commands

```bash
pnpm install          # install dependencies
pnpm run build        # compile TypeScript (tsc → dist/)
pnpm test             # run all tests (vitest)
pnpm test:watch       # run tests in watch mode
pnpm clean            # remove dist/
```

Run a single test file:
```bash
npx vitest run test/agent-registry.test.ts
```

## Architecture

### Plugin System

This is an **OpenClaw plugin**. The host provides `OpenClawPluginApi` (defined in `src/types/openclaw.ts`) with registration methods for services, tools, gateway methods, HTTP routes, and lifecycle hooks. The plugin entry point is `src/index.ts` which exports a default plugin object with a `register(api)` method.

The plugin exposes two parallel interfaces:
- **PluginTools** (13 tools) — AI-facing, invoked by the LLM during conversations
- **GatewayMethods** — internal REST-like API handlers for programmatic access

### Core Layers

```
src/index.ts                     Plugin registration + tool definitions
src/service/multiclaws-service.ts   Central orchestrator (Express server, all subsystems)
src/service/a2a-adapter.ts          Bridge between A2A protocol and OpenClaw sessions
src/gateway/handlers.ts             Gateway method handlers with Zod validation
```

**MulticlawsService** is the orchestration hub. It owns:
- An Express HTTP server (default port 3100) serving A2A endpoints
- Agent registry, team store, task tracker, session store, and profile manager

### Key Data Flow

1. **Inbound tasks**: Remote agent → A2A HTTP endpoint → `OpenClawAgentExecutor` → `sessions_spawn` gateway tool → local OpenClaw session executes task → poll `sessions_history` for result
2. **Outbound delegation**: Local LLM calls `multiclaws_delegate` tool → A2A client sends task to remote agent → tracks via `TaskTracker`
3. **Team sync**: On join, the plugin contacts the seed URL to fetch team members, registers all as agents, and announces itself to existing members

### Persistence

All state is stored as JSON files in a `multiclaws/` subdirectory under the plugin's `stateDir`:
- `agents.json`, `teams.json`, `profile.json`, `tasks.json`, `pending-profile-review.json`
- Uses `proper-lockfile` for multi-process safety and atomic writes (temp file + rename)

### Resilience Patterns

- **Circuit breaker** (`opossum`) wraps gateway tool calls
- **Retry with backoff** (`p-retry`, 2 retries) for transient failures
- **NonRetryableError** skips retry for 4xx responses
- **Rate limiting** on HTTP endpoints (60 req/min per IP)

### Team Invite Codes

Format: `mc:<base64url(JSON{teamId, seedUrl})>` — encoded/decoded in `src/team/team-store.ts`.

## TypeScript Configuration

- Target: ES2022, Module: CommonJS, Strict mode
- Source in `src/`, output to `dist/` with declaration files
- Tests in `test/` using Vitest

## Key Conventions

- The SKILL.md file (`skills/multiclaws/SKILL.md`) is written in Chinese and defines AI behavior rules for the plugin's tools. It is user-facing documentation, not developer documentation.
- Gateway handler inputs are validated with Zod schemas (`src/gateway/handlers.ts`).
- Tool results follow a consistent shape: `{ content: [{ type: "text", text }], details? }`.
- The plugin auto-whitelists `sessions_spawn` and `sessions_history` in the gateway tools allow-list during registration.
- The `before_prompt_build` hook injects onboarding instructions on first install.
