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

## Verified UI/UX findings — all fixed

The adversarial pass over every screen (20 raised, 18 confirmed) is fully worked
through. Escape killing the turn, the Watch pane blanking, phantom classes, the
composer swallowing a draft, the metric contradictions, Live's untrue notes, and
the Edit workflow's unreproducible seeds are all done, each with its own commit.

## The grounding, in Adam's words

> Seamless, frictionless ways to interact with my local AI without having to
> think too much about how to steer. Image generation, conversations and coding
> are all distinctly different functions.

Use it to prioritise: anything that makes him think about MECHANICS rather than
INTENT is the bug worth fixing. A workflow whose tools say one thing while its
skills say another puts the steering straight back on him — which is what
`WorkflowDefinition.skills` now prevents.

## Where end-to-end verification got to

Driven against the real server with `LH_SHOT_DRIVE`: **Chat**, **Research**,
**Docs**, **Code** (agentic write + read-back, file landed on disk, Watch pane
and activity ticker correct), **Data** (describe + query, arithmetic right,
Tables panel populated), **Live** (call starts, orb reaches Listening, mic
opens; speech round trip recovers 9/9 words).

**Image/Edit/Audio are still unverified past the first turn.** ComfyUI was down;
it is running now, started by hand from
`/Users/adam/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python main.py`.

Note for whoever drives Image next: **it does not render on the first turn.** It
refines the prompt and asks the user to choose a quality level (draft ~1m50s
through max 1536px), and renders only after that answer. A driver that sends one
message and waits will always time out — that cost two four-minute runs here.
Whether a five-way quality menu is the right amount of steering for "make me a
picture" is a live question; the review-before-render step itself is intended
and was in Adam's original request.

A spoken Live turn cannot be driven at all: mic audio cannot be synthesised into
the renderer's capture graph.

## The next humanising moves (Adam's reframe, 2026-08-17)

> A very capable, lightweight harness for a novice learning to interface with
> locally hosted LLMs without thinking about the abstractions or how to steer a
> model — while still learning to measure and maximise performance. The main
> focus is the content of the chat itself, and making it feel human: as if
> talking to a coder, a digital image artist, a musician, a general assistant.
> Humanise it, but let me dig into the numbers and watch them as things happen.

Done: personas per workflow, blurbs that introduce a person, skills scoped so a
workflow's tools and its self-description agree.

Still mechanism-forward, in rough priority:

1. **The sidebar leads with "MCP SERVERS" and token counts.** That is the first
   thing a novice meets and it is an implementation detail. Consider a human
   header ("What it can do") with the server ids kept underneath — the ids must
   stay, since finding "playwright" by name already cost one fix.
2. **Progressive disclosure of the numbers.** They should stay glanceable and
   stay honest, but a first-run user does not need payload tokens before their
   first message. A "show me the numbers" affordance would let the HUD earn its
   place rather than assume it.
3. **Teach through the numbers, not beside them.** The HUD says `prefill 469
   tok/s`; nothing says what good looks like on this hardware. A tooltip
   comparing against the model's own measured history would turn the readout
   into a lesson.
4. **The confirm-before-render step is a FEATURE. Do not streamline it.**
   I proposed defaulting the quality and dropping the review. Adam corrected
   that, and the correction is the more interesting product insight:

   > The model can confirm things before generating image or audio. That helps
   > me learn how it's converting my prompt into a usable format for the video
   > or language models. It's part of the growth I'm trying to achieve —
   > learning how to transform a request to an LLM into something useable for
   > other models to pick up and run with.

   So the pause is where the teaching happens. The LLM is a TRANSLATOR between
   a human sentence and a diffusion or audio model's input language, and making
   that translation visible is the point of the workflow, not a tax on it.
   Work to make it teach harder, never to make it shorter: name what was added
   and why, in terms he can reuse in his next prompt.

## ComfyUI: start it through the MCP, never by hand

Starting `main.py` yourself without `--extra-model-paths-config` makes ComfyUI
see ZERO checkpoints, and the failure surfaces as
`ckpt_name: 'ace_step_1.5_turbo_aio.safetensors' not in []` — which reads like a
missing model file when the model is present and simply unlisted. The MCP's own
`start_comfy()` passes the output dir, input dir and the shared paths yaml at
`~/Library/Application Support/Comfy Desktop/shared_model_paths.yaml`.

Worse, `pkill -f ComfyUI/main.py` did NOT free port 8188, so a corrected restart
silently lost the bind and the broken instance kept serving. Use
`lsof -ti :8188 | xargs kill -9` and confirm the port is free before restarting.

Measured once it was healthy: a 30-second ACE-Step song renders in **124
seconds**. Budget roughly four seconds of render per second of music, and note
that a shell timeout of two minutes is not enough to wait on one.

## Open, from the regression audit (20 raised, 18 confirmed, 4 fixed)

Full detail in the workflow output; these are the ones still standing, roughly
in the product owner's order.

1. **Edit lost its teaching step and should get it back properly.** The
   "show your working" block was removed because Edit has NO chat view — its
   system prompt has one consumer, the single-shot refiner, whose whole reply
   becomes the img2img instruction (sent `confirm: true`, i.e. verbatim). The
   narration was landing in the text encoder as image content. But per Adam the
   confirm step exists precisely so he can watch the translation, so Edit needs
   it back as a SECOND field: a short second call after the refine succeeds,
   stored on a new optional `EditJob.protectedNote`, rendered under the textarea
   in EditCard. Do NOT bodge it into `cleanPrompt` — heuristically stripping
   prose from a free-text reply will eat real sentences of the description.
2. **Numbers that disagree.** The empty-state cost line attributes MCP-only
   tokens to a count that includes native tools; the HUD PAYLOAD omits the
   `use_skill` schema that genuinely ships every message; Chat's empty state
   says "nothing but your words goes to the server" while its own system prompt
   is counted as context. All three are the house honesty rule.
3. **`lastAudioTake` chains a sound effect onto a song.** `stampAudioTake`
   matches `generate_(music|sound)` and keys lineage by conversation alone, so
   a foley clip becomes "Take 2" of the track before it. Key by tool name too.
4. **`conv.trimmedMessages` only ever increases.** Nothing resets it, so a
   conversation permanently claims messages are missing after a single trim,
   even once a bigger model makes it fit again.
5. **The Live transcript rail goes blank during a tool call** — `pending` in
   TranscriptPanel lists transcribing/thinking/speaking and never got 'tool'.
6. **`.orb-scan` pulse transform-origin** is fighting `transform-box: fill-box`
   from `.orb-svg circle`, so the scanning reticle pulses off-centre.
7. **The empty-state swap warning can be wrong.** It compares
   `workflow.preferredModel` against the resident model, but the main process
   resolves `conv.modelId ?? settings.defaultModelId` FIRST and only falls
   through to `preferredModel` — so it can promise a swap that will not happen.

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
