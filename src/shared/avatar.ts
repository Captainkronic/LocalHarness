/**
 * How an avatar is built, and what each frame is for.
 *
 * The avatar is a small set of stills swapped against the audio level, not a
 * video. That choice is forced by the hardware: a real talking-head model
 * (Wav2Lip, SadTalker, LivePortrait) takes minutes per utterance on this
 * machine, which would destroy the only thing Live is for. Stills cost nothing
 * at runtime — the whole animation is opacity on a stack of <img>.
 *
 * It works because the ear leads the eye. Amplitude tells you how loud, never
 * which phoneme, so the mouth cannot form the right letter — but a mouth that
 * moves plausibly IN TIME reads as speech anyway. Four mouth positions is the
 * point past which extra frames are ones nobody can distinguish.
 *
 * ## Why the instructions are worded the way they are
 *
 * Measured, not guessed. "Open her mouth wide, as if she is saying ah" came
 * back with the eyes wide and the brows raised — the model read the whole
 * phrase as SURPRISE, which would have made the avatar look shocked on every
 * loud syllable. Naming the eyes as unchanged fixes it, and that is the general
 * rule here: whenever a change could plausibly bleed into a neighbouring
 * feature, pin the neighbour. It is the one place a longer instruction earns
 * its length on the reference-latent path.
 *
 * Frames are generated with `edit_image` from a single base portrait, so
 * identity comes from the reference latent rather than from repeating a
 * description. Verified on a painted portrait: face, hair, clothing and
 * framing all held across mouth-open, mouth-wide and eyes-closed.
 */

import type { AvatarFrame, AvatarFrameSpec } from './types'

/**
 * Stylised on purpose, and it is worth understanding why before someone
 * "improves" it to photoreal.
 *
 * Frames drift by a percent or two in scale and position between renders. A
 * painted or illustrated face absorbs that; a photographic one does not,
 * because we detect a face changing far more sharply than we detect a mouth
 * moving. Photoreal here does not read as a video call, it reads as two people
 * flickering — which is worse than the orb it replaces.
 *
 * The first version of this hint said "digital painting with visible brush
 * strokes", which was not nearly strong enough: z-image's prior pulls hard
 * toward photography, and a request for a man in a suit came back with
 * individual hair strands and real skin shading. Every one of those fine
 * details differs between renders, and the difference is what shimmers. So the
 * wording now names what must NOT be there — no gradients, no skin texture, no
 * hair strands — because the absence of high-frequency detail is the actual
 * requirement, and asking for a style was not getting it.
 *
 * Note that this reduces flicker rather than removing it. What removes it is
 * confining each animated layer to the region it changes; see REGION in
 * AvatarStage. Style is the belt, masking is the braces.
 */
export const AVATAR_BASE_PROMPT_HINT =
  'Flat vector character illustration, cel shaded with hard-edged colour and no ' +
  'gradients, bold clean outlines, simplified geometric shapes, limited flat palette, ' +
  'no skin texture, no individual hair strands, no photographic detail. ' +
  'Head and shoulders, facing the camera straight on, calm neutral expression with ' +
  'the mouth closed, flat even lighting, plain single-colour background, ' +
  'centred with even margins'

/** The mouth, tied to how loud the speaker currently is. */
export const AVATAR_MOUTH_FRAMES: readonly AvatarFrame[] = [
  'rest',
  'mouthSlight',
  'mouthMid',
  'mouthWide'
]

/**
 * The recipe. `rest` is the base portrait itself, so it has no instruction.
 *
 * Every instruction that touches the mouth pins the eyes, and the one that
 * touches the eyes pins the mouth. See the note above — this is the fix for a
 * measured failure, not caution for its own sake.
 */
export const AVATAR_FRAME_SPECS: readonly AvatarFrameSpec[] = [
  {
    frame: 'mouthSlight',
    label: 'Mouth barely open',
    instruction:
      'Open her mouth very slightly, lips just parted as if beginning to speak. ' +
      'Keep the eyes and eyebrows exactly as they are, calm and neutral. ' +
      'Do not change the expression.'
  },
  {
    frame: 'mouthMid',
    label: 'Mouth half open',
    instruction:
      'Open her mouth halfway, as if speaking a word mid-sentence. ' +
      'Keep the eyes and eyebrows exactly as they are, calm and neutral — ' +
      'she is talking, not surprised. Do not change the expression.'
  },
  {
    frame: 'mouthWide',
    label: 'Mouth wide open',
    instruction:
      'Open her mouth wide, as if speaking a loud open vowel. ' +
      'Keep the eyes and eyebrows exactly as they are, calm and neutral, ' +
      'the same as in the original — she is talking, NOT shocked or surprised. ' +
      'Do not widen the eyes or raise the brows.'
  },
  {
    frame: 'blink',
    label: 'Eyes closed',
    instruction:
      'Close her eyes, as if blinking. Keep the mouth closed and the expression ' +
      'otherwise unchanged.'
  },
  {
    frame: 'smile',
    label: 'Smiling',
    instruction:
      'Give her a warm closed-mouth smile. Keep the eyes open and the mouth closed, ' +
      'and change nothing else.'
  },
  {
    frame: 'listening',
    label: 'Listening',
    instruction:
      'Give her a slightly attentive look, as if listening — head the same, ' +
      'mouth closed, eyes open, eyebrows a little raised in interest. ' +
      'Change nothing else.'
  }
]

/**
 * Which mouth frame a given output level should show.
 *
 * Thresholds are deliberately low. Speech spends most of its time well under
 * half scale, so a linear split across 0..1 leaves the mouth barely moving —
 * the avatar looks like it is mumbling through a closed jaw. These were set by
 * watching the levels the orb actually receives.
 */
export function mouthForLevel(level: number): AvatarFrame {
  if (level < 0.06) return 'rest'
  if (level < 0.16) return 'mouthSlight'
  if (level < 0.32) return 'mouthMid'
  return 'mouthWide'
}
