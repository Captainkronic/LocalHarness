# CaptainLlama — state and next steps

Written 2026-08-17 so work survives a context reset. If you are picking this up
cold: read this, then `docs/ARCHITECTURE.md` for why decisions were forced, then
`docs/INTERNAL_API.md` for the module contract.

The app is **CaptainLlama** in the launcher (`/Applications/CaptainLlama.app`);
the repo, directory and npm package stay **LocalHarness**.

---

## Where it is

Nine workflows, all working: Chat, Live, Code, Image, Edit, Audio, Docs,
Research, Data. Private repo `Captainkronic/LocalHarness`, linear history on
`main`, everything pushed.

Verified working end to end by Adam's own use: a full Angular 22 Snake game
built through the Code workflow in ~54 messages, with `run_shell`, `playwright`,
`write_file` and `edit_file` all firing and 10 files touched.

### Build and install

```bash
npm run dev                 # hot reload, full shell PATH
npm run package && rm -rf /Applications/CaptainLlama.app \
  && cp -R release/mac-arm64/CaptainLlama.app /Applications/
npm test                    # typecheck + sandbox + calibration + activity
npm run verify              # the above plus the live smoke test
```

Test suites, all green, none of which need the app running:
`scripts/{sandbox,calibration,activity,approval,voice,smoke,control}-test.mjs`.
`control-test.mjs` and `voice-test.mjs` really load models and speech models, so
they are deliberately out of `npm test`.

### Screenshots — the only way to see the UI

`screencapture(1)` HANGS rather than failing without the Screen Recording grant,
so it is useless here. The app photographs itself instead:

```bash
node scripts/shoot.mjs <workflow> <outfile>      # LH_CODE_MODE=watch to pick the Code half
```

Cmd+Shift+S saves to ~/Pictures. **Looking at the UI has found bugs nothing else
did** — a 15x metric disagreement, truncated labels, two never-rendered
components, an unclickable dialog. Do it after every UI change.

---

## Adam's hardware and models

Mac Studio over Tailscale, `adams-mac-studio.tailc7bb1e.ts.net`.
**One large model at a time** — a second load fails with "insufficient system
resources", so swapping means unloading first, which the app does itself.

| Model | Use |
|---|---|
| `qwen/qwen3.8-27b` | Code, Docs, Data — his best coding model |
| `google/gemma-4-26b-a4b-qat` | Chat, Image, Edit, Audio, Research — speed/intelligence sweet spot |
| `google/gemma-4-e4b` | was Live; see below |

**Live moved off e4b.** Given mail access it repeatedly skipped the search and
spoke invented messages aloud — confident names, subjects and counts with no
tool call behind them. It recited a worked example out of the system prompt as
fact; removing the example and naming the tool explicitly did not stop it. 26b
called both tools correctly on every run and is what Adam keeps resident, so
Live no longer forces a swap on the way in. Adam is testing an 8-bit e4b — see
open work.

Each workflow carries `preferredModel` and swaps to it on the first turn.

---

## Open work, in priority order

### 1. Live's model is settled — do not re-litigate without the battery
Both e4b quants were measured against `scripts/live-probe.mjs` and both fell
short, differently. Live stays on `google/gemma-4-26b-a4b-qat`, which scored
**70/70**.

| | result |
|---|---|
| e4b 4-bit (MLX) | skipped the mail search, spoke **invented** messages aloud |
| e4b 8-bit (GGUF) | fabrication fixed; **zero-argument calls** break — `get_weather{}` as literal text |
| 26b-a4b-qat (MLX) | 70/70: every zero-arg call, both refusals, no tool for small talk |

```bash
node scripts/live-probe.mjs <model> 5      # 14 cases; grades the CALL, not the prose
node scripts/live-tools-test.mjs <model>   # payload measurement + 2 quick turns
```

**Use 5 repeats, not 3.** e4b's rate swings between 30% and 90% on identical
input, and two prompt edits were made chasing what turned out to be noise.
Bisecting the prompt block by block (`scripts/prompt-bisect.mjs`) found no
culprit block, because there isn't one.

### 2. Finish the overnight UI review### 2. Finish the overnight UI review — STARTED, NOT FINISHED
Drive real scenarios per workflow against the testbed at
`~/Documents/AI/CaptainLlama-testbed`, screenshot every state, fix what is
found, commit separately. Only Code and Live have had real use.

Live's own states can now be photographed one at a time:

```bash
LH_LIVE_STATE=tool node scripts/shoot.mjs live shots/live-tool.png
```

States: `off starting listening capturing transcribing thinking tool speaking
error`. Photographing them is what found the contradictory "say something"
prompt and the uncoloured tool state.

### 3. Live's empty middle
Before the first turn there is a lot of nothing between the core and the
controls. After a turn the timings register fills it, so this is really a
first-run state rather than a layout fault — worth an idle readout (model,
voice, what it can look up) rather than a redesign.

Constraints that must survive anything done here: reduced-motion support, and
never animating a number that is not measured.

## Traps that have already cost time — do not rediscover

- **A raw NUL byte in a TS string literal** compiles, but makes the file binary
  to `grep`, which then silently matches NOTHING in it. Hit twice. Scan with
  Python for `b'\0'`, never trust grep alone.
- **A Finder-launched app gets launchd's PATH**, without `/opt/homebrew/bin`.
  `augmentedPath()` in `store/paths.ts` repairs it for every spawned child;
  without it `ffmpeg`, `rg`, `git` and `npm` are all "not found" while
  `npm run dev` works perfectly.
- **`reasoning_effort: 'none'`** takes the first spoken word from 3,946ms to
  312ms on gemma-4-e4b. `chat_template_kwargs {reasoning:'off'}` does NOT work.
- **Speech models load lazily**: first synthesize 4,378ms vs 394ms warm, first
  transcribe 3,116ms vs 1,322ms. `SpeechServices.prewarm()` covers it.
- **MLX ignores a requested context length**; GGUF honours it exactly. Setting
  `llm.load.mlx.autoFit: false` does not help.
- **Model control is websocket-only** and must address LM Studio's own port
  directly — the relay in front of it cannot do a websocket upgrade. `listLoaded`
  rejects `parameter: {}`; it must be omitted.
- **Barge-in on speakers is a feedback loop.** Default is off; it is for
  headphones.
- **An unknown CSS class fails silently and looks like a design choice.** Hit
  three times in `SkillsPanel.tsx` alone — `mcp-row-main`, `mcp-switch`,
  `mcp-knob`, then `mcp-foot-figures`, `-tok`, `-note`. Rows lost their layout
  and stacked vertically at 88px each with no visible toggle, and it read as
  intentional. When copying markup between panels, copy the class names from the
  CSS, not from the other component's JSX.
- **A failing test is a claim about the code, not a fact.** A skill-sandbox test
  reported that reading outside every root SUCCEEDED — a serious hole, and
  entirely the test's fault: `ToolResult` is `{ text, artifacts, isError }` and
  it was reading `.content`, so every refusal stringified to an object and
  scored as a pass. Check the harness before believing the alarm.
- **A python `str.replace` that does not match fails silently.** Assert every
  anchor, or a change looks applied and is not.
- **Never put the forbidden literal INSIDE a prohibition.** "Never type
  get_news() into your reply" made the model type `get_news()` more often, not
  less. Third instance of the same failure. Describe the shape, never exhibit it.
- **Judge tool use on whether the tool was CALLED**, never on whether the answer
  reads well. The dangerous failure is fluent and confident and completely
  invented, and it looks like a pass to anyone reading the prose.
- **A model copies the example instead of reading the instruction.** Asked for
  the weather with no city named, it passed `"Austin, Texas"` — the literal
  example in `get_weather`'s schema. Pushed to omit the field it sent
  `"current_location"`, then `""`. `dropEmptyArgs()` in `live/session.ts`
  strips empty strings at the call site. The same failure is why the system
  prompt must not contain a plausible worked example: e4b spoke one back as
  fact.
- **MCP overrides are absolute lists, so they go stale.** A workflow that gains
  a server keeps it switched off for anyone with an override, showing "0 tools"
  and no reason why. `settings.ts` drops empty overrides for workflows that
  ship servers; a non-empty stale override would still shadow a new addition.
- **A workflow may be handed part of a server** (`WorkflowDefinition.mcpTools`),
  so a server's cost is not what the workflow pays. All payload arithmetic goes
  through `renderer/lib/payload.ts` — three components each doing their own is
  what put "3.8k tokens, 15.2s" on a screen that was really sending 746.
- **The MCP manager's option is `onStates`, not `onState`.** Passing the wrong
  name leaves every server stuck in `starting` for good, with no log line —
  the throw happens inside a transition that `allSettled` swallows.

---

## Conventions

- `src/shared/*` is the contract; the IPC handler map is typed so a declared
  channel with no implementation is a compile error.
- Design tokens only, from `src/renderer/styles/theme.css`.
- Honesty rules the UI must keep: never substitute `max_context_length` for the
  real loaded window; label the prefill estimate as an estimate; show tool
  failures verbatim.
- Commit each fix separately, push to `main`.
