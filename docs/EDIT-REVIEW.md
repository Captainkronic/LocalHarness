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

| path | result |
|---|---|
| sdedit, denoise 0.4 | **taxis still yellow.** And yet the woman's jacket changed from brown to maroon, the food cart changed, buildings changed, sky changed |
| klein reference-latent | every taxi pink; crowd, cart, lamps, skyline, manhole covers all held |

The denoise-0.4 result is the important one: it is the failure Adam is
describing. The change does not happen *and* the things he did not mention
change anyway — the worst of both outcomes, from the setting that is supposed to
be the conservative one.

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

## Open / to verify

- distilled Klein 4B (4 steps, cfg 1) vs base (20 steps, cfg 5) — quality and speed
- whether the instruction-style stage 1 beats the description style for Klein
- the full six-case suite on the winner

## Incidental bugs found on the way

- `EDIT_PHASES` in comfy-mcp still names *"Applying reference latent"* and
  *"Preparing canvas"* — nodes of the deleted Klein graph. Progress labels have
  been describing a workflow that is not running.
- `build_edit_workflow` takes `width`/`height` and never uses them. There is no
  scale node, so a source is encoded and sampled at whatever size it happens to
  be — off-distribution for the model, and slow.
