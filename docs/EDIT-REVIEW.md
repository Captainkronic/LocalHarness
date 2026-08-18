# The Edit workflow: what is wrong with it, and what fixes it

Written overnight 2026-08-17/18, from measurements. Every claim here has a run
behind it in `.edit-bench/`, reproducible with `scripts/edit-bench.py`.

## The short version

"It doesn't really seem to work" is correct, and there are **two independent
faults**, either of which alone would be enough to ruin the result.

1. **Stage 2 is not an edit.** When FLUX.2 Klein was removed as a generation
   model, the reference-latent *edit* path went with it, leaving plain img2img.
   Img2img has no notion of "change this, keep that" — it re-renders a noised
   copy of the photo against a prompt. The one knob, `denoise`, trades the
   change you asked for against the details you wanted kept, and at the shipped
   default you lose on both counts.
2. **Stage 1 is writing the wrong artefact.** It is asked to describe the entire
   finished photograph in one paragraph. That is a large open-ended task, it
   burns ~1000 reasoning tokens and 13-25s, and — the part that cannot be tuned
   away — a paragraph cannot carry a photograph.

## Evidence

### Fault 1: img2img cannot do this, at any setting

Source: `city_nights.png`. Request: *"turn all the taxi cabs pink while keeping
everything else the same"*. Same seed throughout.

| path | time | did the change happen | did the rest survive |
|---|---|---|---|
| sdedit, denoise 0.4 | 431s | **no** — taxis still yellow | no — jacket brown→maroon, cart changed, buildings and sky changed |
| sdedit, denoise 0.6 *(shipped default)* | 346s | **no** — taxis went red | **no** — a different city: different people, different signage, cart gone |
| sdedit, denoise 0.8 | 399s | yes — taxis pink | **no** — different city, camera moved into the road, crowd erased |
| klein base, reference-latent | 654s | yes — every taxi pink | yes — crowd, cart, lamps, skyline, manhole covers held; sky drifts a little lavender |
| **klein distilled, reference-latent** | **110s** | yes — every taxi pink | yes — and better: the sunset gradient, the lamp glow, the woman's jacket and coffee cup, the pretzel cart and the manhole covers all survive |

Read the sdedit rows as a curve, because that is the whole argument. Turn
denoise down and the edit does not happen but the photo drifts anyway; turn it
up and the edit happens to a photograph that is no longer the one you gave it.
**There is no setting in between that does the job.** That is not a tuning
problem to be solved with a better default — denoise cannot distinguish the
subject of the edit from the rest of the frame, because nothing ever told the
model which was which.

The denoise-0.4 row is the one that matches the complaint most exactly: the
conservative setting, failing at both jobs at once.

That is not a tuning problem. Img2img re-derives every pixel from noise; the
only thing anchoring it to the original is how little noise was added. There is
no setting at which "the taxis" are treated differently from "the woman's
jacket", because the model was never told one is the subject of the edit.

### Fault 2: stage 1 is asked for something it cannot deliver

The shipped brief tells the model to "write a single paragraph describing the
FINISHED image". Measured on the Studio's `gemma-4-26b-a4b-qat`, 8 trials per
cell:

| photo | brief | produced a prompt | length |
|---|---|---|---|
| busy street | shipped (describe) | 8/8 | avg 78 words |
| busy street | instruction | 8/8 | avg 16 words |
| simple dog photo | shipped (describe) | 8/8 | avg 82 words |
| simple dog photo | instruction | 8/8 | avg 18 words |

Both are reliable, so the honest headline is **cost and content, not failure
rate**. The describe brief takes ~1000-2000 reasoning tokens and 13-25s; the
instruction brief takes ~435 and 6s. One attempt in twelve did spend its whole
2048-token budget reasoning and return nothing — the user then sees "The model
spent its whole output budget reasoning and never wrote a prompt" — but that is
an occasional tail, not the main fault.

The main fault is what the paragraphs actually say. They are generic:
*"Pedestrians walk along the sidewalk."*

That last point is the one that cannot be fixed by prompt-tuning. `city_nights`
contains dozens of people, storefronts, vehicles and windows. **No paragraph
re-specifies a photograph.** Everything the description omits is free for the
renderer to reinvent — which is precisely the drift seen above.

The information-theoretic point, and the thing worth learning from this: the
handoff format has to match what the receiving model consumes. Sending a
*description* is right for a renderer that has only text. It is wrong for one
that can be handed the picture itself.

### The brief has to match the renderer — shown, not argued

Same photo, same seed, same Klein reference-latent graph. Only the text differs.

| text sent | did the change happen | did the rest survive |
|---|---|---|
| the raw instruction, *"turn all the taxi cabs pink…"* | yes | yes — still the same photograph, sky a shade more lavender |
| a full description of the finished scene | yes | **no** — pink taxis, but the photograph has become a garish oversaturated illustration: cartoon buildings, invented "HOT" signage, stock-image sunset |

The people and the cart stay roughly in place in both, so this is not the img2img
collapse. It is subtler and just as fatal: the description is a *second account
of the picture*, competing with the picture itself, and the renderer splits the
difference — landing on a generic vivid city street rather than **this** one.

That is why the two briefs are not interchangeable, and why the method has to
decide which one stage 1 is given.

> One caveat on method, stated because it cuts against my own conclusion: the
> "refined" descriptions in the bench were written by me, not by the Studio's
> gemma. They are better than what stage 1 actually produces. That makes the
> img2img rows *generous* — if a good description cannot rescue img2img, the
> real one certainly cannot — but it also means the row above shows a
> description harming Klein at its strongest, which is the fair direction to
> test.

## The fix

Give stage 2 the photo as latent conditioning and let stage 1 carry only the
delta.

```
ImageScaleToTotalPixels -> VAEEncode -> ReferenceLatent -> CFGGuider
                                     (on BOTH the positive and negative branch)
EmptyFlux2LatentImage -> SamplerCustomAdvanced   <- nothing of the original as pixels
```

Preservation stops being a function of leftover noise and becomes a property of
the conditioning, so there is no longer a tradeoff axis to lose on. Stage 1's
job shrinks from "describe everything" to "name the change", which is both far
more reliable and a better lesson.

## Speed, and a dead end worth recording

Klein base is a real edit but a slow one: 20 steps at cfg 5 is 40 forward
passes — 654s measured. The distilled build needs 4 steps at cfg 1, and at cfg
1.0 ComfyUI skips the unconditional pass altogether (`comfy/samplers.py`,
`sampling_function`: `if math.isclose(cond_scale, 1.0) ... uncond_ = None`), so
that is 4 passes, not 8. A tenth of the sampling work, and half of what the
img2img path it replaces does at 8 steps.

Measured, same photo and seed: base **654s**, distilled **110s**. And the sdedit
runs it replaces took **346-431s**, so the img2img path was never even the fast
one — it was slow *and* wrong. The distilled model is three times quicker than
the thing it replaces and six times quicker than Klein base, while giving the
best preservation of the three.

That is the rare case where the right answer is also the cheap one, and it is
worth being suspicious of. The reason it holds up: distillation removes the
guidance pass, not the reference conditioning — the mechanism that does the
preserving is untouched.

**The fp8 distilled build does not run on this Mac.** `flux-2-klein-4b-fp8`
loads happily and then dies in the sampler with `Trying to convert
Float8_e4m3fn to the MPS backend but it does not have support for that dtype`.
Apple Silicon has no fp8 at all. The bf16 build of the same distilled model
(`black-forest-labs/FLUX.2-klein-4B`, 7.75GB) is what to use, and is what
`klein-edit` now points at. Worth knowing before reaching for any other fp8
checkpoint on this machine.

## Open / to verify

- distilled Klein bf16: quality against base, and the real speed
- whether the instruction-style stage 1 beats the description style for Klein
- the full six-case suite on the winner

## What changed in the app

The two methods are a **choice in the composer**, not a hidden default, because
they need different things from you and seeing that is most of the lesson:

- **Instruction edit** — *changes one thing, keeps the rest*. Default.
- **Restyle** — *reworks the whole frame*. Right for "make this a watercolour".

Each carries its own renderer (`klein-edit` / `z-image`), its own step default
(4 / 8), and its own stage-1 brief. `denoise` is sent, and printed on the
finished card, only on restyle — the instruction path never sees a
partially-noised canvas, so quoting a denoise there would be quoting a number
the render never used. Jobs saved before this change have no method and come
back as `restyle`, which is what they always were.

`renderArgs` was pulled out of `apply()` so that rule is testable rather than
buried; `scripts/edit-method-test.mjs` covers it and asserts the shape of both
briefs. `scripts/edit-graph-check.py` validates the comfy-mcp graphs against the
live ComfyUI and asserts every progress label names a node that exists.

## Incidental bugs found on the way — all fixed

- **`EDIT_PHASES` narrated a workflow that was not running.** It still named
  *"Applying reference latent"* and *"Preparing canvas"*, nodes of the deleted
  Klein graph, so the progress bar had been describing the wrong thing since the
  removal. Now one map per graph, and `scripts/edit-graph-check.py` fails if any
  phase names a node its graph does not contain — the joint is node ids in two
  unrelated dicts, and nothing else was holding them together.
- **No resolution clamp on the source.** `build_edit_workflow` took
  `width`/`height` and never used them; there was no scale node, so a photo was
  encoded and sampled at whatever size it happened to arrive at. A phone photo
  is several times these models' training resolution — slow, and prone to
  duplicated detail. Both graphs now normalise to ~1 MP on the latent grid.
- **A missing model would have been silently substituted.** With the Klein
  weights absent, `edit_image` fell back to z-image while the card still said
  "instruction edit" — an image rendered by one method under a caption
  describing the other. A named-but-uninstalled model is now an error. (Found by
  the graph checker on its first run, against my own change.)
- **The bench discarded failed cases.** The error branch set the manifest entry
  and then `continue`d past the write, so a run whose every case failed left
  nothing behind — which is how the fp8 dead end nearly went unrecorded.
