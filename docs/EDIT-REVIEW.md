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
| klein reference-latent | 654s | yes — every taxi pink | yes — crowd, cart, lamps, skyline, manhole covers all held |

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
passes, ~11 minutes here. The distilled build needs 4 steps at cfg 1 — and
because ComfyUI skips the unconditional pass entirely at cfg 1.0, that is 4
passes, not 8. About a tenth of the work, and less than the img2img path it
replaces.

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

## Incidental bugs found on the way

- `EDIT_PHASES` in comfy-mcp still names *"Applying reference latent"* and
  *"Preparing canvas"* — nodes of the deleted Klein graph. Progress labels have
  been describing a workflow that is not running.
- `build_edit_workflow` takes `width`/`height` and never uses them. There is no
  scale node, so a source is encoded and sampled at whatever size it happens to
  be — off-distribution for the model, and slow.
