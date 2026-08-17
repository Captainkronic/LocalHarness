# Architecture

The decisions, and what forced them. Most of these come from measurements against
this specific hardware rather than from general principle — where that is the
case, the measurement is stated so a future change can be argued with evidence
rather than taste.

---

## 1. Why an Electron app rather than a terminal harness

Two of the four headline features are not expressible in a terminal:

- A metrics HUD that updates at 4Hz while a request is in flight, alongside the
  conversation, without redrawing the conversation.
- Workflow-contextual panels — an image gallery, an audio player with scrub, a
  diff review surface.

Tauri would produce a smaller binary, but Rust is not installed on this machine
and every stdio MCP spawn would have to cross into Rust-side commands. Electron
gives the main process Node directly, which is exactly what spawning ten Python
MCP servers wants.

---

## 2. The process split

```
renderer (React)  ──IPC──►  main (Node)  ──HTTP──►  Mac Studio
                                          ──stdio──►  MCP servers
                                          ──fs/spawn──►  workspace
```

The renderer has `nodeIntegration: false` and `contextIsolation: true`. It reaches
main through exactly one bridge object, `window.harness`, exposing `invoke` and
`on`. There is no second path.

This matters more than usual here: the renderer displays model output, and model
output is untrusted. Markdown is parsed into React elements rather than through
`dangerouslySetInnerHTML`, and the renderer cannot touch the filesystem even if
something got through.

**IPC is declared once.** `src/shared/ipc.ts` types both directions. `src/main/ipc.ts`
implements a handler map typed as `{[K in keyof IpcApi]: ...}`, so a channel added
to the contract and not implemented is a compile error, not a runtime
"no handler registered".

---

## 3. Workflows are the organising idea

A workflow is not a UI theme. It is a bundle of five decisions:

| decision | why it belongs to the workflow |
|---|---|
| system prompt | image prompting and SQL analysis want different instructions, and a combined prompt is worse at both |
| MCP server set | the only lever that controls per-message payload |
| native tool set | the image workflow has no business holding a shell |
| panel | the contextual surface only makes sense per kind of work |
| sampling | code wants temperature 0.2, image prompts want 0.8 |

Switching workflows calls `mcp:applyWorkflow`, which starts what is needed and
stops what is not, concurrently, with a failure in one server unable to block the
others.

Per-workflow overrides persist in settings, so an ad-hoc server added to the Code
workflow is still there next launch — this is a personal tool, and the defaults
should give way to habit.

---

## 4. Why payload control is a first-class feature

Measured cost of `tools/list` across the ten installed MCP servers, at ~4 chars
per token, and the prefill time that implies at 250 tok/s:

| server | tokens | prefill |
|---|---:|---:|
| comfy-image | 3,007 | 12.0s |
| comfy-audio | 859 | 3.4s |
| playwright | 839 | 3.4s |
| ui-review | 806 | 3.2s |
| docgen | 624 | 2.5s |
| voice | 562 | 2.2s |
| webassets | 547 | 2.2s |
| fastfacts | 516 | 2.1s |
| data | 428 | 1.7s |
| websearch | 258 | 1.0s |
| **all ten** | **8,446** | **33.8s** |

Every one of those tokens is re-sent on **every message**. Loading all ten adds
half a minute of prefill to a one-word question. `comfy-image` alone is 38% of the
total.

Hence: workflows carry the minimum set, `comfy-image` appears only in the Image
workflow, and the HUD shows the standing cost at all times so the tradeoff is
visible rather than discovered later as unexplained slowness.

Per-tool toggles exist because server granularity is sometimes too coarse — a
server with six tools where two are wanted should cost two tools' worth.

---

## 5. The context meter and the number it refuses to invent

LM Studio's `/api/v0/models` reports two different numbers:

- `max_context_length` — architectural ceiling, often 262,144.
- `loaded_context_length` — the real window, present **only while the model is
  resident**.

A client that believes the ceiling packs requests the server rejects. So:

- `ModelRegistry.contextWindow(id)` returns `number | null`, never a fallback.
- `ContextUsage.max` is `number | null` and the meter renders `—` when null.

There is a further wrinkle that forces re-observation: **the same model reports a
different window depending on who loaded it.** A hand-load in the LM Studio UI
came up at 110,080; a JIT load driven by an API request came up at 62,976. Both
stable. So an idle eviction followed by a JIT reload silently changes the real
window, and a learned value is re-checked when the last observation is older than
120 seconds.

The orchestrator calls `models.learn(modelId)` before the first request of a turn,
which closes the cold-start hole where the meter would otherwise be blank until
the next poll.

### Polling discipline

An earlier tool of Adam's polled this same endpoint every 15 seconds, 24/7 —
5,760 requests a day, whether or not anything was open. `ModelRegistry` polls at
`settings.modelPollMs` only while the window is focused or a request is in
flight, and backs off to 120s otherwise.

---

## 6. Prefill progress is an estimate, and says so

This was investigated properly and the answer is negative:

- The OpenAI wire protocol carries no prompt-processing progress. A 9k-token
  prefill was measured at **56.03s TTFB with zero bytes in between**.
- LM Studio exposes no llama.cpp introspection endpoints. `/slots`, `/props`,
  `/metrics`, `/health` all return an error body — and they return it with
  **HTTP 200**, so probing with `-o /dev/null -w %{http_code}` gives a false
  positive on every one. Read the body.
- Real progress exists only on the websocket SDK, per-prediction and per-client.
  A bystander subscribed to `unstable_streamLogs` across another client's full
  56s prefill saw **0 entries**. And the relay chain in front of LM Studio is a
  Python `BaseHTTP` server, which cannot perform a websocket upgrade at all — it
  answers 200 instead of 101.

So `PrefillBar` renders a projection: `elapsed / (promptTokens / calibratedRate)`,
clamped below 100% until the first token actually lands, hatched and labelled
"est.". `RateCalibrator` learns the true rate per model from completed turns
(EMA, weight 0.3). Before any calibration exists it shows an indeterminate
shimmer — no number at all — rather than a plausible lie.

Decode rate is measured over a rolling 2-second window rather than cumulatively,
so it shows the current rate instead of being dragged down by TTFT.

---

## 7. The Lab feed, and why it is optional

`http://adams-mac-studio…:1234` is not LM Studio. It is Adam's own
`lmstudio-lab.py` running `--takeover --upstream http://localhost:1235`, proxying
everything outside `/lab/` straight through. It publishes `/lab/events` as SSE
with a `final` record per completed request carrying `tps`, `ttft`, `prefill_tps`,
token counts and the context maximum — for **every** client on the box, not just
this one.

That is a better source than client-side measurement, because it comes from the
engine. But it is a personal service on one machine, so `LabFeed` treats it as
enrichment: empty URL or failed connection means status `unavailable`, backoff to
a 60s cap, and the app keeps working on its own numbers.

---

## 8. The agent sandbox

The coding workflow can write files and run shell commands, so containment is the
part worth being strict about.

- Every path argument is resolved (tilde expanded, relative resolved against the
  first workspace root) and checked with `isInsideAny(target, workspaceRoots)`
  **before any approval prompt is shown**. Refusal is not a decision the user is
  asked to make.
- Containment is a path-segment check on realpaths, so `/etcfoo` is not inside
  `/etc`, and a symlink out of a root does not escape it.
- `run_shell`'s `cwd` goes through the same check.
- Shell allowlist matching is prefix-with-boundary, so an entry of `git` does not
  authorise `gitleaks`. A command containing `;`, `&&`, `||`, `|`, a backtick or
  `$()` is never auto-allowed even when its prefix matches, because the prefix
  stops describing what the command does.
- `allow_session` is remembered per `(tool, resolved target)` for the process
  lifetime only. Nothing about approval is persisted to disk.

---

## 9. MCP over stdio, implemented directly

No SDK. The protocol needed here is small — `initialize`, the `initialized`
notification, `tools/list`, `tools/call` — and implementing it directly avoids a
dependency and makes the failure modes legible.

Details that were bugs in other harnesses and are handled here on purpose:

- **Partial-line buffering.** One stdout `data` event may carry half a message or
  several. Frames are split on newlines with a carry buffer.
- **stderr is not failure.** Several of these servers log to stderr on startup as
  normal behaviour. Only a non-zero exit before handshake completion fails a
  start.
- **Timeouts are per-server and generous where they must be.** The MCP SDK's
  default request timeout is 60 seconds, which is shorter than a single image
  render — a harness that leaves it at the default sees every image "fail" at 60s
  with the render still running. `comfy-image` is given 960s, `comfy-audio`
  1,860s.
- **Pending requests are cleaned up on timeout**, so a late reply cannot resolve
  a promise whose caller is gone.
- **Schemas are sanitised** on the way to the model — `enum` stripped into the
  description, `anyOf`/`oneOf`/`allOf` collapsed, type-less nodes given a type.
  This mirrors the standalone sanitising proxy and exists because several Gemma 4
  builds ship chat templates that LM Studio's Jinja engine cannot render when
  those keywords are present: `enum` gives `Unknown test: "sequence"`, `anyOf`
  gives `Cannot apply filter "upper" to type: UndefinedValue`. They abort before
  the model runs, so even "hi" fails.

---

## 10. Reasoning models

Two behaviours that are not optional to handle:

- `reasoning_content` arrives as a sibling of `content` in the streaming delta.
  It is routed to a separate channel and rendered in a collapsed disclosure. It
  is never concatenated into the answer.
- With too small a `max_tokens`, these models spend the entire budget on
  reasoning and return **empty content with `finish_reason: 'length'`**. That is
  why sampling defaults are generous (8,192 for code, docs and data) and why the
  orchestrator turns that specific combination into an explicit message rather
  than displaying a blank reply.

---

## 11. Known limits

- One turn at a time per window. The Mac Studio holds one large model in memory;
  asking for a second while one is resident fails outright with "Failed to load
  model … insufficient system resources".
- Vision attachments are sent only to models reporting `type: 'vlm'`; for others
  the image is replaced by a text note naming the file.
- The prompt cache on the server leaks across requests — roughly 2.4 GiB per
  distinct long prompt, ~4.8 GiB retained over three — so a long working day of
  varied deep prompts will page even though any single request fits. Nothing in
  this app can fix that; a periodic unload/reload is the mitigation.
- Conversation history is not summarised or compacted yet. When the context meter
  goes red, start a new conversation.
