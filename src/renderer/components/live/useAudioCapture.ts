/**
 * Microphone capture and turn detection for the Live workflow.
 *
 * This is a hook of its own because it owns hardware. Everything else in the
 * workflow can re-render freely; the audio graph must not. So the only value
 * that tears the graph down and back up is `enabled` — every other option is
 * read through a ref at frame time, which means changing the VAD threshold or
 * swapping the utterance handler costs nothing and never drops the mic.
 *
 * The pipeline:
 *   getUserMedia -> AudioContext(16kHz) -> AudioWorklet -> RMS frames
 *   -> energy VAD -> Int16 PCM for one utterance
 *
 * Three decisions worth knowing:
 *
 *  - AudioWorklet, registered from a Blob URL. There is no asset pipeline that
 *    would emit a separate worklet file here, and ScriptProcessorNode is
 *    deprecated and drops buffers the moment the main thread is busy — which,
 *    during a live turn, it always is.
 *  - A rolling pre-roll buffer. Speech has already started by the time its
 *    energy crosses the threshold, so an utterance that begins at the crossing
 *    loses its first syllable ("what time is it" arrives as "at time is it").
 *    The last ~300ms are always kept and prepended.
 *  - The reported sample rate is the context's real one. Asking for 16kHz is a
 *    request, not a guarantee, and transcription against the wrong rate returns
 *    confident nonsense rather than an error.
 */

import { useEffect, useRef, useState } from 'react'

export interface CaptureOptions {
  vadThreshold: number
  silenceMs: number
  minUtteranceMs: number
  enabled: boolean
  onUtterance: (pcm: ArrayBuffer, sampleRate: number) => void
  onLevel: (level: number, speaking: boolean) => void
}

/** Samples per analysis frame: 32ms at 16kHz. Long enough that RMS is stable,
 *  short enough that the end of a turn is detected within one frame. */
const FRAME_SAMPLES = 512
/** Audio kept ahead of the threshold crossing, so the first syllable survives. */
const PREROLL_MS = 300
/** Silence kept after the last voiced frame. Whisper transcribes a word ending
 *  at the very last sample worse than one with a little room after it. */
const TAIL_MS = 250
/** A VAD that never closes must not grow a buffer without limit. */
const MAX_UTTERANCE_MS = 30_000
const TARGET_RATE = 16_000
/** RMS is tiny for speech (0.01-0.2). sqrt-and-gain maps that onto a meter
 *  where quiet talking is visible and shouting does not just peg at 1. */
const LEVEL_GAIN = 2.4
const WORKLET_NAME = 'lh-mic-tap'

/**
 * The tap. Accumulates render quanta into fixed frames, computes RMS on the
 * audio thread, and transfers each frame's buffer to the main thread — transfer
 * rather than copy, so a 31Hz stream of frames allocates nothing on the way out.
 */
const WORKLET_SRC = `
class MicTap extends AudioWorkletProcessor {
  constructor(options) {
    const opts = (options && options.processorOptions) || {}
    super()
    this.size = opts.frameSize || 512
    this.buf = new Float32Array(this.size)
    this.n = 0
  }

  process(inputs) {
    const input = inputs[0]
    const ch = input && input[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n < this.size) continue
      let sum = 0
      for (let j = 0; j < this.size; j++) sum += this.buf[j] * this.buf[j]
      const frame = this.buf
      this.buf = new Float32Array(this.size)
      this.n = 0
      this.port.postMessage(
        { rms: Math.sqrt(sum / this.size), samples: frame.buffer },
        [frame.buffer]
      )
    }
    return true
  }
}

registerProcessor('${WORKLET_NAME}', MicTap)
`

export function useAudioCapture(opts: CaptureOptions): {
  active: boolean
  error: string | null
} {
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Written after commit rather than during render: the audio callbacks always
  // want the newest handler, and nothing about them belongs in the setup effect's
  // dependency list.
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })

  const enabled = opts.enabled

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let node: AudioWorkletNode | null = null
    let sink: GainNode | null = null

    /* ---- turn state ------------------------------------------------- */

    let rate = TARGET_RATE
    let frameMs = (FRAME_SAMPLES / TARGET_RATE) * 1000

    /** Rolling window of the last PREROLL_MS, while not capturing. */
    let preroll: Float32Array[] = []
    let prerollSamples = 0

    let capturing = false
    let chunks: Float32Array[] = []
    let captured = 0
    /** Samples of pre-roll prepended to this utterance — excluded from the
     *  length test, or a 300ms cough would clear a 400ms minimum. */
    let lead = 0
    /** Sample offset of the end of the last voiced frame. */
    let voicedEnd = 0
    let silenceRun = 0

    const resetTurn = (): void => {
      capturing = false
      chunks = []
      captured = 0
      lead = 0
      voicedEnd = 0
      silenceRun = 0
    }

    const finish = (): void => {
      const o = optsRef.current
      const speechMs = ((voicedEnd - lead) / rate) * 1000
      if (speechMs >= o.minUtteranceMs) {
        const keep = Math.min(captured, voicedEnd + Math.round((TAIL_MS / 1000) * rate))
        o.onUtterance(toPcm16(chunks, keep), rate)
      }
      resetTurn()
    }

    const onFrame = (rms: number, samples: Float32Array): void => {
      const o = optsRef.current
      const speaking = rms >= o.vadThreshold
      o.onLevel(Math.min(1, Math.sqrt(rms) * LEVEL_GAIN), speaking)

      if (!capturing) {
        preroll.push(samples)
        prerollSamples += samples.length
        const cap = Math.round((PREROLL_MS / 1000) * rate)
        while (preroll.length > 0) {
          const head = preroll[0]
          if (prerollSamples - head.length < cap) break
          preroll.shift()
          prerollSamples -= head.length
        }
        if (!speaking) return

        // The turn starts with the pre-roll, not with the frame that crossed.
        chunks = preroll
        captured = prerollSamples
        lead = prerollSamples
        preroll = []
        prerollSamples = 0
        capturing = true
        silenceRun = 0
      }

      chunks.push(samples)
      captured += samples.length
      if (speaking) {
        silenceRun = 0
        voicedEnd = captured
      } else {
        silenceRun += frameMs
      }

      if (silenceRun >= o.silenceMs || (captured / rate) * 1000 >= MAX_UTTERANCE_MS) {
        finish()
      }
    }

    /* ---- graph ------------------------------------------------------ */

    const teardown = (): void => {
      if (node) {
        node.port.onmessage = null
        node.port.close()
        node.disconnect()
        node = null
      }
      if (sink) {
        sink.disconnect()
        sink = null
      }
      if (source) {
        source.disconnect()
        source = null
      }
      if (stream) {
        // The indicator light on the user's machine goes out here and nowhere
        // else. Every track, unconditionally.
        for (const track of stream.getTracks()) track.stop()
        stream = null
      }
      if (ctx) {
        void ctx.close()
        ctx = null
      }
      preroll = []
      prerollSamples = 0
      resetTurn()
      setActive(false)
    }

    const start = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        })
        // Each await is a place the component can have unmounted underneath us.
        // Tearing down here is what keeps a StrictMode double-mount, or a fast
        // start-then-stop, from leaving a live microphone behind.
        if (cancelled) return teardown()

        ctx = new AudioContext({ sampleRate: TARGET_RATE })
        rate = ctx.sampleRate
        frameMs = (FRAME_SAMPLES / rate) * 1000

        const url = URL.createObjectURL(
          new Blob([WORKLET_SRC], { type: 'application/javascript' })
        )
        try {
          await ctx.audioWorklet.addModule(url)
        } finally {
          URL.revokeObjectURL(url)
        }
        if (cancelled) return teardown()

        await ctx.resume()
        if (cancelled) return teardown()

        source = ctx.createMediaStreamSource(stream)
        node = new AudioWorkletNode(ctx, WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { frameSize: FRAME_SAMPLES }
        })
        node.port.onmessage = (ev: MessageEvent): void => {
          const data = ev.data as { rms: number; samples: ArrayBuffer }
          onFrame(data.rms, new Float32Array(data.samples))
        }

        // A node with no path to the destination is not guaranteed to be pulled
        // by the render graph. The worklet writes nothing, so this gain stage is
        // silent by construction, but it puts the tap on a real path.
        sink = ctx.createGain()
        sink.gain.value = 0
        source.connect(node)
        node.connect(sink)
        sink.connect(ctx.destination)

        setError(null)
        setActive(true)
      } catch (err) {
        if (!cancelled) setError(describeCaptureError(err))
        teardown()
      }
    }

    void start()

    return () => {
      cancelled = true
      teardown()
    }
  }, [enabled])

  return { active, error }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Flatten captured frames into interleaved-free mono Int16, up to `total`. */
function toPcm16(chunks: Float32Array[], total: number): ArrayBuffer {
  const out = new Int16Array(total)
  let i = 0
  for (const chunk of chunks) {
    for (let j = 0; j < chunk.length && i < total; j++, i++) {
      const s = Math.max(-1, Math.min(1, chunk[j]))
      // Asymmetric scaling: -1 maps to -32768 and +1 to 32767, so full-scale
      // audio does not wrap on the negative side.
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
  }
  return out.buffer
}

/** Turn a getUserMedia failure into something that tells the user what to do. */
function describeCaptureError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Allow it for LocalHarness in System Settings › Privacy & Security › Microphone, then start the call again.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one and start the call again.'
    case 'NotReadableError':
      return 'The microphone is already in use by another application.'
    default:
      break
  }
  if (err instanceof Error && err.message.trim() !== '') {
    return `Could not open the microphone: ${err.message}`
  }
  return 'Could not open the microphone.'
}

export default useAudioCapture
