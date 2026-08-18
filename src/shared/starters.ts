/**
 * Which workflows deal a generated hand of starters instead of a fixed list.
 *
 * A fixed pool is right for a workflow with a handful of characteristic
 * openings. It is wrong for Image and Audio, whose range is "anything you can
 * describe" — seven fixed lines advertise seven ideas and quietly imply that is
 * the extent of it.
 *
 * This lives apart from WorkflowDefinition on purpose. That object is sent to
 * the renderer through structured clone in `app:getBootstrap`, structured clone
 * cannot carry a function, and putting one there throws "An object could not be
 * cloned" — which leaves the app on its splash screen forever with nothing on
 * screen to say why. Typecheck and build both stay clean, because it is a
 * runtime constraint on the shape rather than a type. Keeping the definitions
 * pure data and the behaviour in this lookup keeps that door shut; there is a
 * test asserting every definition still survives structuredClone.
 */

import { randomAudioPrompts } from './audio-prompts'
import { randomImagePrompts } from './image-prompts'

export const STARTER_GENERATORS: Partial<Record<string, (n: number) => string[]>> = {
  image: (n) => randomImagePrompts(n),
  audio: (n) => randomAudioPrompts(n)
}
