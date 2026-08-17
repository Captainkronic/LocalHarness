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
| `google/gemma-4-e4b` | Live — smallest and fastest, real-time speech |

Each workflow carries `preferredModel` and swaps to it on the first turn.

---

## Open work, in priority order

### 1. Live workflow needs MCP access  ← NEXT
Adam wants JARVIS to read his email and check news and weather aloud. Today
`live` has `mcpServers: []` and `nativeTools: []`, so it cannot do anything but
talk.

- Add `gmail` and `fastfacts` to the `live` workflow in `src/shared/workflows.ts`.
  `gmail` is already in `src/shared/mcp-registry.ts`? **CHECK — it is in
  `~/.config/mcp-profiles/registry.json` and LM Studio's config but may not be in
  ours.** Command is `/opt/homebrew/bin/gmail-mcp`, no args.
- **The catch:** `LiveSession.runTurn` calls `streamChat` directly and does NOT
  run a tool loop. Tool calls in a spoken turn need handling — either route the
  Live turn through the Orchestrator, or give LiveSession its own small loop.
  Prefer the second: the Orchestrator's loop is text-shaped and would break
  sentence-wise TTS.
- Spoken tool results need summarising, not reading verbatim. An email list read
  literally is unbearable; JARVIS should say "three new messages, the newest from
  X about Y".
- Watch the payload: fastfacts is 516 tokens and gmail is unmeasured. Live is
  latency-critical, so measure before adding.

### 2. Make Live look like a JARVIS assistant
Voice and persona are done (`bm_daniel`, chosen by ear; the persona is in the
`live` system prompt). The **visual** is still a generic orb. Wanted: an
instrument-panel feel — concentric arcs, a HUD register, readouts around the orb
rather than a chat transcript underneath.
Constraints that must survive: reduced-motion support, and never animating a
number that is not measured.

### 3. Overnight UI review — STARTED, NOT FINISHED
Drive real scenarios per workflow against the testbed at
`~/Documents/AI/CaptainLlama-testbed`, screenshot every state, fix what is found,
commit separately. Only the Code and Live workflows have had real use.

---

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
- **A python `str.replace` that does not match fails silently.** Assert every
  anchor, or a change looks applied and is not.

---

## Conventions

- `src/shared/*` is the contract; the IPC handler map is typed so a declared
  channel with no implementation is a compile error.
- Design tokens only, from `src/renderer/styles/theme.css`.
- Honesty rules the UI must keep: never substitute `max_context_length` for the
  real loaded window; label the prefill estimate as an estimate; show tool
  failures verbatim.
- Commit each fix separately, push to `main`.
