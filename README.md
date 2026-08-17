# LocalHarness

A desktop AI harness for a network-hosted Mac Studio inference server.

One application, several workflows. Each workflow reshapes the UI, swaps the
system prompt, and — the point of the whole thing — decides which MCP servers are
running, so tool schemas that aren't needed never reach the wire.

Built because the existing harnesses each got part of this right and none of them
got all of it: Copilot has a context meter but a fixed tool payload, Bionic has
MCP breadth but no metrics, opencode has both but lives in a terminal.

---

## What it does

**Workflow profiles.** Seven of them — Chat, Code, Image, Audio, Documents,
Research, Data. Switching a workflow starts the MCP servers it needs, stops the
ones it doesn't, changes which native tools the model can call, and swaps the
right-hand panel for something contextual (a gallery for images, an audio player
for audio, a citation list for research, a sandbox view for code).

**Payload control.** Every MCP server carries a measured token cost. The HUD shows
what the currently loaded tools add to *every single message*, in tokens and in
seconds of prefill. Individual tools can be switched off inside a server when a
whole server is more than you need. `comfy-image` alone is ~3k tokens — about
twelve seconds of prefill on this hardware — which is why it is not in the default
set for anything but the Image workflow.

**Live inference telemetry.** Prefill and decode throughput, time to first token,
and context used against the *real* loaded window. Where a number is measured it
is shown plainly; where it is a projection it is marked as one.

**An agentic coding loop.** Native file read/write/edit, glob, grep and shell,
sandboxed to explicit workspace roots, with diff review and per-tool approval
before anything is written or run.

---

## Honesty rules the UI follows

These are deliberate, and they are the difference between a useful instrument and
a decorative one:

- **Context maximum is never guessed.** LM Studio reports `loaded_context_length`
  only while a model is resident; everything else reports the architectural
  ceiling (often 262,144), which the server will not actually accept. When the
  real window is unknown the meter renders `—`, not the ceiling.

- **Prefill progress is labelled as an estimate.** The OpenAI streaming protocol
  carries no prompt-processing progress — between request and first token there
  is literal silence. The bar is a projection from the token count and the
  model's learned prefill rate, and it says so. With no calibration yet, it shows
  an indeterminate shimmer rather than a fabricated percentage.

- **Tool failures are shown, not smoothed over.** A failed MCP call renders its
  real error text.

---

## Topology

```
LocalHarness (this app, MacBook)
   │
   ├── OpenAI API ──► 127.0.0.1:1235   sanitising proxy (strips enum/anyOf)
   │                        └──► Mac Studio :1234   LM Studio Lab relay
   │                                    └──► Mac Studio :1235   LM Studio
   │
   ├── /api/v0/models ──► Mac Studio :1234    real context window, resident model
   │
   ├── /lab/events (SSE) ──► Mac Studio :1234  per-request telemetry (optional)
   │
   └── stdio ──► local MCP servers under ~/.config/*-mcp
```

The Lab feed is optional. If it is unreachable the app is fully functional and
falls back to its own client-side measurement.

---

## Running it

```bash
npm install
npm run dev
```

Build a distributable `.app`:

```bash
npm run dist
```

Typecheck both sides:

```bash
npm run typecheck
```

---

## Configuration

Settings live in `~/Library/Application Support/LocalHarness/settings.json` and
are editable in-app. The ones that matter:

| key | default | note |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:1235/v1` | the sanitising proxy — several Gemma chat templates fail without it |
| `nativeApiUrl` | `http://adams-mac-studio…:1234` | LM Studio native API, for the real context window |
| `labUrl` | same host | `/lab/events` telemetry, optional |
| `approvalMode` | `always_ask` | `auto_read` and `auto_all` loosen it |
| `workspaceRoots` | Documents, Desktop, LocalHarness | the agent's filesystem sandbox — nothing outside these is readable or writable |
| `modelPollMs` | `15000` | backs off to 120s when idle |

---

## Layout

```
src/
  shared/      types, IPC contract, workflow + MCP registries (imported by both sides)
  main/        Electron main process
    mcp/       stdio JSON-RPC client, server manager, schema sanitiser
    llm/       streaming OpenAI client, model registry, prompt assembly
    telemetry/ Lab SSE feed, per-turn meter, rate calibrator
    agent/     native tools, sandboxed executor, approval broker, diff
    store/     settings + conversation persistence
    orchestrator.ts  the turn loop — the only place subsystems compose
  preload/     the single contextBridge surface
  renderer/    React UI
```

`docs/INTERNAL_API.md` is the module contract. `docs/ARCHITECTURE.md` explains
the decisions behind it.
