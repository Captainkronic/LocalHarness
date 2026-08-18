/**
 * The Live workflow's centre column: a phone call with a model that can see.
 *
 * The renderer owns everything before the speech stops and everything after the
 * audio comes back; main owns the middle. That split is not arbitrary — the
 * audio graph, the camera and the speaker all live here, and a turn boundary is
 * a property of the microphone, not of the conversation.
 *
 * Two things carry the feel of it:
 *
 *  - Sentence-wise playback. Main synthesises the reply a sentence at a time and
 *    pushes each one as it lands, so the first words are already playing while
 *    the model is still generating. The chunks are scheduled against the audio
 *    clock rather than played on arrival, which is what makes the seam between
 *    two sentences a pause instead of a gap.
 *  - Barge-in. Speech detected while the assistant is talking stops playback in
 *    the same frame and abandons the turn. Anything else — waiting politely for
 *    a paragraph to finish — is not a conversation.
 *
 * The camera is a separate stream from the microphone and only ever contributes
 * one still per turn: LM Studio accepts image parts but rejects audio ones, so a
 * frame goes to the model directly while speech has to be transcribed first.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject
} from 'react'

import type {
  Avatar,
  LiveAudioChunk,
  LiveSessionState,
  LiveSettings,
  LiveTurnTimings
} from '@shared/types'
import { useStore } from '@renderer/state/store'
import { basename, formatMs } from '@renderer/lib/format'
import { VOICE_PRESETS } from '@shared/workflows'
import { useAudioCapture } from './useAudioCapture'
import AvatarStage from './AvatarStage'
import VoiceOrb from './VoiceOrb'
import './live.css'

/** Consecutive over-threshold frames (~32ms each) before speech during playback
 *  counts as barge-in. One frame is a door closing; three is a person. */
const BARGE_FRAMES = 3
/** Long edge of the camera frame sent to the model. Beyond this the vision
 *  encoder gains nothing and prefill pays for every extra tile. */
const FRAME_LONG_EDGE = 768
const FRAME_QUALITY = 0.7
/** Scheduling headroom for the first chunk of a turn, in seconds. */
const SCHEDULE_LEAD = 0.02
/** Level changes smaller than this never reach React. */
const LEVEL_STEP = 0.02
const PLAYBACK_GAIN = 3
const NOTICE_MS = 4000
const SPEED_MIN = 0.6
const SPEED_MAX = 1.6
const SPEED_COMMIT_MS = 180

/**
 * States where "say something" is true.
 *
 * It used to show whenever a call was up and nothing had been transcribed yet,
 * which meant the very first turn told the user to speak while JARVIS was
 * plainly thinking, looking something up, or talking back at them. A prompt
 * that contradicts the state right above it is worse than no prompt.
 */
const WAITING_STATES = new Set<LiveSessionState>(['listening', 'capturing'])

export function LiveWorkspace(): JSX.Element {
  const status = useStore((s) => s.liveStatus)
  const live = useStore((s) => s.liveSettings)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const models = useStore((s) => s.models)
  const health = useStore((s) => s.health)
  const pinnedModelId = useStore((s) => s.settings.defaultModelId)
  const startLive = useStore((s) => s.startLive)
  const stopLive = useStore((s) => s.stopLive)
  const sendUtterance = useStore((s) => s.sendUtterance)
  const interruptLive = useStore((s) => s.interruptLive)
  const updateLiveSettings = useStore((s) => s.updateLiveSettings)

  /** null while the voice server has not been asked; [] means it answered with
   *  nothing, which is how "no speech service" is detected. */
  const [voices, setVoices] = useState<string[] | null>(null)
  /** Holds the slider while it is being dragged. `updateLiveSettings` only
   *  updates the store once main answers, and a controlled range input that
   *  lags the pointer fights whoever is dragging it. */
  const [speedDraft, setSpeedDraft] = useState<number | null>(null)
  const [micOn, setMicOn] = useState(true)
  const [level, setLevel] = useState(0)
  const [avatars, setAvatars] = useState<Avatar[]>([])
  /** How far into the reply the speaker has actually got. */
  const [spokenTo, setSpokenTo] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const statusRef = useRef(status)
  const micLevelRef = useRef(0)
  const speechRunRef = useRef(0)
  const noticeTimer = useRef(0)
  const speedTimer = useRef(0)

  useEffect(() => {
    statusRef.current = status
  })

  // A spoken turn moves through six states in about two seconds, which is not
  // long enough to photograph one. LH_LIVE_STATE pins it so every state can be
  // screenshotted and reviewed — the same escape hatch LH_CODE_MODE gives the
  // Code pane, and for the same reason: looking at a state is how its bugs get
  // found. Ignored unless the variable is set, so it cannot affect a real call.
  const forcedState = document.documentElement.dataset.liveState as LiveSessionState | undefined
  const state = forcedState ?? status.state
  const inCall = state !== 'off'

  /* ---- speech playback -------------------------------------------- */

  // Advancing by searching from the last position keeps the caption honest: if
  // the spoken sentence cannot be found in the reply (main normalised it for
  // TTS), the highlight simply does not move rather than landing in the wrong
  // place.
  const playback = usePlayback((chunk) => {
    setSpokenTo((prev) => {
      const text = statusRef.current.assistantText
      const said = chunk.text.trim()
      if (said === '') return prev
      const at = text.indexOf(said, prev)
      return at === -1 ? prev : at + said.length
    })
  })
  const { push, stop: stopPlayback, readLevel } = playback

  useEffect(() => window.harness.on('event:liveAudio', push), [push])

  useEffect(() => {
    if (inCall) return
    stopPlayback()
    setSpokenTo(0)
    setLevel(0)
    micLevelRef.current = 0
  }, [inCall, stopPlayback])

  // A new turn starts a new reply, so the spoken highlight starts over.
  useEffect(() => {
    if (state === 'transcribing' || state === 'thinking') setSpokenTo(0)
  }, [state])

  /* ---- capture ----------------------------------------------------- */

  const camera = useCamera(inCall && live.video)

  /* Loaded once. The set changes only when the user builds or deletes one, and
     both of those go through a dialog that can refresh this itself. */
  useEffect(() => {
    let alive = true
    void window.harness
      .invoke('avatars:list')
      .then((list) => {
        if (alive) setAvatars(list)
      })
      .catch(() => {
        if (alive) setAvatars([])
      })
    return () => {
      alive = false
    }
  }, [])

  const avatar = useMemo(
    () => avatars.find((a) => a.id === settings.liveAvatarId) ?? null,
    [avatars, settings.liveAvatarId]
  )

  const activeModelId = pinnedModelId ?? health.residentModelId
  const activeModel = useMemo(
    () => models.find((m) => m.id === activeModelId) ?? null,
    [models, activeModelId]
  )
  /** Known-blind model: send nothing rather than have main strip it silently. */
  const visionBlocked = activeModel !== null && !activeModel.supportsVision
  const wantsFrame = live.video && !visionBlocked

  const showNotice = (text: string): void => {
    setNotice(text)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }

  // Deliberately not memoised: useAudioCapture reads its options through a ref,
  // so a fresh closure per render costs nothing and can never go stale.
  const handleUtterance = (pcm: ArrayBuffer, rate: number): void => {
    const phase = statusRef.current.state
    // playback.isPlaying() and not just the session state: main drops out of
    // 'speaking' when the last sentence is synthesised, seconds before it has
    // finished coming out of the speaker.
    const stillTalking = phase === 'speaking' || playback.isPlaying()
    const busy = phase === 'transcribing' || phase === 'thinking' || phase === 'tool' || stillTalking
    if (busy) {
      if (!live.bargeIn) {
        // Speech heard during playback is overwhelmingly the reply itself
        // coming back through the microphone, so that one goes quietly.
        if (!stillTalking) {
          showNotice('That was not sent — the previous turn is still running.')
        }
        return
      }
      // Barge-in covers the whole turn, not just the audio: talking over a
      // reply that is still being generated has to replace it too, or what the
      // user just said is thrown away.
      stopPlayback()
      void interruptLive()
    }
    void sendUtterance(pcm, rate, wantsFrame ? camera.grab() : undefined)
  }

  const handleLevel = (value: number, speaking: boolean): void => {
    micLevelRef.current = value
    if (!speaking) {
      speechRunRef.current = 0
      return
    }
    speechRunRef.current += 1
    if (
      (statusRef.current.state === 'speaking' || playback.isPlaying()) &&
      live.bargeIn &&
      speechRunRef.current >= BARGE_FRAMES
    ) {
      speechRunRef.current = 0
      stopPlayback()
      void interruptLive()
    }
  }

  const capture = useAudioCapture({
    vadThreshold: live.vadThreshold,
    silenceMs: live.silenceMs,
    minUtteranceMs: live.minUtteranceMs,
    enabled: inCall && micOn,
    onUtterance: handleUtterance,
    onLevel: handleLevel
  })

  /* ---- one publish loop for the orb -------------------------------- */

  useEffect(() => {
    if (!inCall) return
    let raf = 0
    const tick = (): void => {
      const source =
        statusRef.current.state === 'speaking' ? readLevel() : micLevelRef.current
      setLevel((prev) => (Math.abs(prev - source) >= LEVEL_STEP ? source : prev))
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [inCall, readLevel])

  /* ---- settings ---------------------------------------------------- */

  // The store carries the settings themselves; only the voice list has to be
  // asked for, and it doubles as the probe for whether the speech server is up.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const available = await window.harness.invoke('live:voices')
        if (alive) setVoices(available)
      } catch {
        // The voice server is optional at the process level; an empty list is
        // what the UI renders "no speech service" from.
        if (alive) setVoices([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(
    () => () => {
      window.clearTimeout(noticeTimer.current)
      window.clearTimeout(speedTimer.current)
    },
    []
  )

  /** The slider moves at pointer rate; main hears about it once it settles. */
  const patchSpeed = (speed: number): void => {
    setSpeedDraft(speed)
    window.clearTimeout(speedTimer.current)
    speedTimer.current = window.setTimeout(() => {
      void updateLiveSettings({ speed }).then(() => setSpeedDraft(null))
    }, SPEED_COMMIT_MS)
  }

  /* ---- leaving the workflow ends the call -------------------------- */

  useEffect(
    () => () => {
      if (statusRef.current.state !== 'off') void stopLive()
    },
    [stopLive]
  )

  /* ---- render ------------------------------------------------------ */

  const reply = status.assistantText
  const karaoke = live.speak && spokenTo > 0 && spokenTo < reply.length
  /** The character's name, not the Kokoro id — "Jarvis", not "bm_george". */
  const voiceLabel =
    VOICE_PRESETS.find((p) => p.id === live.voice)?.label ?? (live.voice || 'Voice')
  const coldStart =
    health.residentModelId === null ||
    (pinnedModelId !== null && pinnedModelId !== health.residentModelId)
  const speechDown = voices !== null && voices.length === 0

  const toggleCall = (): void => {
    if (inCall) {
      stopPlayback()
      void stopLive()
      return
    }
    // A start that fails leaves the session 'off' and emits no status, so the
    // reason has to be surfaced here or the button just does nothing.
    void startLive().then((result) => {
      if (!result.ok) showNotice(result.error ?? 'The session did not start.')
    })
  }

  return (
    <div className="lv" data-state={state}>
      <div className="lv-stage">
        {/* The orb and the avatar are the same object in two costumes — one
            reads level as a glow, the other as a mouth. An avatar that was
            deleted or whose frames have gone falls back to the orb rather than
            leaving an empty stage. */}
        {avatar !== null ? (
          <AvatarStage avatar={avatar} readLevel={readLevel} state={state} />
        ) : (
          <VoiceOrb state={state} level={level} />
        )}

        {/* Only during a call. The setting persists, so a preview tied to the
            toggle alone would open the camera the moment this workflow was
            opened — indicator light and all — with no call in progress. */}
        {inCall && live.video ? (
          <figure className="lv-cam" data-active={camera.active}>
            <video ref={camera.videoRef} className="lv-cam-video" autoPlay muted playsInline />
            <figcaption className="lv-cam-tag">
              {camera.error !== null
                ? 'camera unavailable'
                : !camera.active
                  ? 'starting'
                  : visionBlocked
                    ? 'not sent'
                    : 'one frame per turn'}
            </figcaption>
          </figure>
        ) : null}

        <div className="lv-caption">
          {status.lastUserText.trim() !== '' ? (
            <p className="lv-heard">
              <span className="lv-heard-label">heard</span>
              {status.lastUserText}
            </p>
          ) : null}

          {/* Name him while he talks. "Speaking" is a state; "JARVIS" is who is
              answering, and that is most of the character. */}
          {reply.trim() !== '' && (state === 'speaking' || playback.isPlaying()) ? (
            <p className="lv-speaker">
              <span className="lv-voice-tag">{voiceLabel}</span>
              <span className="lv-speaker-note">speaking</span>
            </p>
          ) : null}

          {reply.trim() !== '' ? (
            <p className="lv-reply" data-karaoke={karaoke}>
              <span className="lv-said">{reply.slice(0, spokenTo)}</span>
              <span className="lv-rest">{reply.slice(spokenTo)}</span>
            </p>
          ) : WAITING_STATES.has(state) && status.lastUserText.trim() === '' ? (
            <p className="lv-prompt">
              Say something. The turn ends when you stop talking.
            </p>
          ) : null}

          {state === 'speaking' || playback.isPlaying() ? (
            <button
              type="button"
              className="btn btn-sm lv-hush"
              onClick={() => {
                stopPlayback()
                void interruptLive()
              }}
            >
              <StopIcon />
              <span>Stop speaking</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="lv-notes">
        {status.error !== undefined && status.error.trim() !== '' ? (
          <Note kind="error" title="The turn failed">
            {status.error}
          </Note>
        ) : null}

        {capture.error !== null ? (
          <Note kind="error" title="No microphone">
            {capture.error}
          </Note>
        ) : null}

        {speechDown ? (
          <Note kind="warn" title="No speech service">
            The local voice server did not answer, so nothing can be heard or
            spoken — and this workflow has no way to type, so there is nothing
            it can do until that server is up. Start voice-mcp and reopen Live,
            or use Chat in the meantime.
          </Note>
        ) : null}

        {inCall && coldStart ? (
          <Note kind="warn" title="Model not resident">
            {activeModelId === null
              ? 'Nothing is loaded on the server, so the first turn waits for a model to load — about twenty seconds.'
              : `${basename(activeModelId)} is not loaded yet. The first turn waits for it — about twenty seconds — and every turn after that is warm.`}
          </Note>
        ) : null}

        {live.video && visionBlocked && activeModelId !== null ? (
          <Note kind="warn" title="This model cannot see">
            {basename(activeModelId)} has no vision capability, so no camera frame
            goes with a turn. Load a vision model to be seen.
          </Note>
        ) : null}

        {camera.error !== null && live.video ? (
          <Note kind="warn" title="No camera">
            {camera.error}
          </Note>
        ) : null}

        {notice !== null ? <Note kind="info">{notice}</Note> : null}
      </div>

      {status.timings !== null ? <Timings timings={status.timings} /> : null}

      <div className="lv-dock">
        <Controls
          settings={live}
          speed={speedDraft ?? live.speed}
          voices={voices ?? []}
          micOn={micOn}
          onMic={() => setMicOn((v) => !v)}
          avatars={avatars}
          avatarId={settings.liveAvatarId}
          onPatch={updateLiveSettings}
          onSpeed={patchSpeed}
          onAvatar={(id) => void updateSettings({ liveAvatarId: id })}
        />

        <div className="lv-call-wrap">
          <button
            type="button"
            className={inCall ? 'btn lv-call is-live' : 'btn btn-primary lv-call'}
            onClick={toggleCall}
          >
            {inCall ? <EndIcon /> : <CallIcon />}
            {/* Never disabled, including while starting — a start that hangs
                has to be escapable without leaving the workflow. */}
            <span>{inCall ? 'End call' : 'Start call'}</span>
          </button>
          {!inCall ? (
            <p className="lv-call-note">
              Opens your microphone and listens until you stop talking.
            </p>
          ) : (
            <p className="lv-call-note tnum">
              {status.turns} turn{status.turns === 1 ? '' : 's'} · microphone{' '}
              {capture.active ? 'open' : micOn ? 'opening' : 'muted'}
            </p>
          )}
        </div>
      </div>

      {/* Frame grabs draw here. Never displayed; sized per capture. */}
      <canvas ref={camera.canvasRef} className="lv-canvas" aria-hidden="true" />
    </div>
  )
}

export default LiveWorkspace

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

interface Playback {
  /** Queue a chunk. Out-of-order arrivals wait for their predecessor. */
  push: (chunk: LiveAudioChunk) => void
  /** Stop immediately and abandon the current turn's remaining chunks. */
  stop: () => void
  /** Output level, 0..1, for the orb while the assistant is speaking. */
  readLevel: () => number
  /**
   * True while audio is still scheduled to come out of the speaker.
   *
   * This is NOT the same as main's 'speaking' state and must not be replaced by
   * it. Main leaves 'speaking' when the last sentence has been SYNTHESISED, and
   * Kokoro synthesises far faster than realtime — about 394ms per sentence warm.
   * So for a three-sentence reply main reports 'listening' after roughly a
   * second while some seven seconds of audio is still queued against the
   * AudioContext clock. Anything that means "the assistant is still talking" —
   * barge-in, the stop control — has to ask the audio clock, not the session.
   */
  isPlaying: () => boolean
}

/**
 * A one-turn audio queue scheduled against the AudioContext clock.
 *
 * Playing each chunk on arrival would put a variable gap at every sentence
 * boundary — the decode plus a message hop, right where a listener hears a
 * hesitation. Instead each buffer is started at an explicit time equal to the
 * end of the previous one, which is sample-accurate as long as the next chunk
 * decodes before the current one finishes. Kokoro is far faster than real time,
 * so it always does.
 */
function usePlayback(onChunkStart: (chunk: LiveAudioChunk) => void): Playback {
  const startedRef = useRef(onChunkStart)
  useEffect(() => {
    startedRef.current = onChunkStart
  })

  const ctxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const scratchRef = useRef<Float32Array<ArrayBuffer> | null>(null)

  const turnRef = useRef<string | null>(null)
  const nextSeqRef = useRef(0)
  /** Audio-clock time at which the queue currently runs dry. */
  const cursorRef = useRef(0)
  const pendingRef = useRef(new Map<number, { buffer: AudioBuffer; chunk: LiveAudioChunk }>())
  const sourcesRef = useRef(new Set<AudioBufferSourceNode>())
  const timersRef = useRef(new Set<number>())
  /** Turns abandoned by an interrupt. Chunks already in flight arrive after the
   *  stop and must not be played into the silence behind it. */
  const deadRef = useRef(new Set<string>())

  const api = useRef<Playback | null>(null)

  const build = (): Playback => {
    const ensureCtx = (): AudioContext => {
      const existing = ctxRef.current
      if (existing !== null && existing.state !== 'closed') {
        if (existing.state === 'suspended') void existing.resume()
        return existing
      }
      const ctx = new AudioContext()
      const gain = ctx.createGain()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      gain.connect(analyser)
      analyser.connect(ctx.destination)
      ctxRef.current = ctx
      gainRef.current = gain
      analyserRef.current = analyser
      scratchRef.current = new Float32Array(analyser.fftSize)
      return ctx
    }

    const halt = (): void => {
      for (const source of sourcesRef.current) {
        source.onended = null
        try {
          source.stop()
        } catch {
          // Already ended; stop() on a finished source throws.
        }
        source.disconnect()
      }
      sourcesRef.current.clear()
      for (const timer of timersRef.current) window.clearTimeout(timer)
      timersRef.current.clear()
      pendingRef.current.clear()
      cursorRef.current = 0
    }

    const drain = (): void => {
      const ctx = ctxRef.current
      const gain = gainRef.current
      if (ctx === null || gain === null) return
      for (;;) {
        const entry = pendingRef.current.get(nextSeqRef.current)
        if (entry === undefined) break
        pendingRef.current.delete(nextSeqRef.current)
        nextSeqRef.current += 1

        const at = Math.max(ctx.currentTime + SCHEDULE_LEAD, cursorRef.current)
        const source = ctx.createBufferSource()
        source.buffer = entry.buffer
        source.connect(gain)
        source.onended = (): void => {
          sourcesRef.current.delete(source)
          source.disconnect()
        }
        source.start(at)
        sourcesRef.current.add(source)
        cursorRef.current = at + entry.buffer.duration

        const chunk = entry.chunk
        const timer = window.setTimeout(
          () => {
            timersRef.current.delete(timer)
            startedRef.current(chunk)
          },
          Math.max(0, (at - ctx.currentTime) * 1000)
        )
        timersRef.current.add(timer)
      }
    }

    return {
      isPlaying: () => {
        const ctx = ctxRef.current
        return ctx !== null && ctx.state !== 'closed' && cursorRef.current > ctx.currentTime
      },
      push: (chunk) => {
        if (deadRef.current.has(chunk.turnId)) return
        if (turnRef.current !== chunk.turnId) {
          // A different turn is speaking now: the user has moved on.
          halt()
          turnRef.current = chunk.turnId
          // seq is main's counter and need not start at zero, so anchor on the
          // first chunk that actually arrives.
          nextSeqRef.current = chunk.seq
        }
        const bytes = decodeDataUrl(chunk.dataUrl)
        if (bytes === null) return
        const ctx = ensureCtx()
        void ctx.decodeAudioData(bytes).then(
          (buffer) => {
            if (turnRef.current !== chunk.turnId || deadRef.current.has(chunk.turnId)) return
            pendingRef.current.set(chunk.seq, { buffer, chunk })
            drain()
          },
          () => {
            // One sentence that will not decode must not strand the rest of the
            // reply behind it.
            if (turnRef.current !== chunk.turnId) return
            if (nextSeqRef.current === chunk.seq) nextSeqRef.current += 1
            drain()
          }
        )
      },

      stop: () => {
        const turn = turnRef.current
        if (turn !== null) {
          deadRef.current.add(turn)
          // Bounded: only the ids that could still have chunks in flight matter.
          if (deadRef.current.size > 16) {
            const oldest = deadRef.current.values().next().value
            if (oldest !== undefined) deadRef.current.delete(oldest)
          }
        }
        turnRef.current = null
        halt()
      },

      readLevel: () => {
        const analyser = analyserRef.current
        const scratch = scratchRef.current
        if (analyser === null || scratch === null) return 0
        analyser.getFloatTimeDomainData(scratch)
        let sum = 0
        for (let i = 0; i < scratch.length; i++) sum += scratch[i] * scratch[i]
        return Math.min(1, Math.sqrt(sum / scratch.length) * PLAYBACK_GAIN)
      }
    }
  }

  // Built once and held for the component's life: the queue, the clock cursor
  // and the audio graph all have to outlive every render.
  const playback = api.current ?? (api.current = build())

  useEffect(
    () => () => {
      playback.stop()
      const ctx = ctxRef.current
      ctxRef.current = null
      if (ctx !== null) void ctx.close()
    },
    [playback]
  )

  return playback
}

/** data: URL to bytes without a fetch — the audio arrives base64 already, and a
 *  round trip through the network stack for a local string is wasted latency in
 *  the one place latency is the product. */
function decodeDataUrl(url: string): ArrayBuffer | null {
  const comma = url.indexOf(',')
  if (comma === -1 || !url.slice(0, comma).includes(';base64')) return null
  try {
    const binary = atob(url.slice(comma + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

interface Camera {
  videoRef: RefObject<HTMLVideoElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  /** The newest frame as a JPEG data: URL, or undefined if there isn't one. */
  grab: () => string | undefined
  active: boolean
  error: string | null
}

function useCamera(enabled: boolean): Camera {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stream: MediaStream | null = null

    const teardown = (): void => {
      const video = videoRef.current
      if (video !== null) video.srcObject = null
      if (stream !== null) {
        for (const track of stream.getTracks()) track.stop()
        stream = null
      }
      setActive(false)
    }

    const open = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
        })
        if (cancelled) return teardown()
        const video = videoRef.current
        if (video !== null) {
          video.srcObject = stream
          // Rejects when the element is torn down mid-play; nothing to do about
          // it and nothing worth reporting.
          void video.play().catch(() => undefined)
        }
        setError(null)
        setActive(true)
      } catch (err) {
        if (!cancelled) setError(describeCameraError(err))
        teardown()
      }
    }

    void open()
    return () => {
      cancelled = true
      teardown()
    }
  }, [enabled])

  const grab = (): string | undefined => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (video === null || canvas === null) return undefined
    const w = video.videoWidth
    const h = video.videoHeight
    if (w === 0 || h === 0) return undefined
    const scale = Math.min(1, FRAME_LONG_EDGE / Math.max(w, h))
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return undefined
    // Drawn unmirrored on purpose. The preview is flipped because a mirror is
    // what people expect of themselves; the model should be shown the room the
    // right way round, or every label and page in shot arrives reversed.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', FRAME_QUALITY)
  }

  return { videoRef, canvasRef, grab, active, error }
}

function describeCameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was denied. Allow it in System Settings › Privacy & Security › Camera.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found.'
  }
  if (name === 'NotReadableError') {
    return 'The camera is already in use by another application.'
  }
  return err instanceof Error && err.message.trim() !== ''
    ? `Could not open the camera: ${err.message}`
    : 'Could not open the camera.'
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

interface ControlsProps {
  settings: LiveSettings
  /** The slider's live position, which leads `settings.speed` while dragging. */
  speed: number
  voices: string[]
  micOn: boolean
  avatars: Avatar[]
  /** Which avatar is showing, or null for the orb. */
  avatarId: string | null
  onMic: () => void
  onPatch: (patch: Partial<LiveSettings>) => void
  onSpeed: (speed: number) => void
  onAvatar: (id: string | null) => void
}

function Controls({
  settings,
  speed,
  voices,
  micOn,
  avatars,
  avatarId,
  onMic,
  onPatch,
  onSpeed,
  onAvatar
}: ControlsProps): JSX.Element {
  // A voice main is using that the server did not list still has to be
  // selectable, or opening the menu would silently change it.
  const options = useMemo(() => {
    if (settings.voice === '' || voices.includes(settings.voice)) return voices
    return [settings.voice, ...voices]
  }, [voices, settings.voice])

  return (
    <div className="lv-controls">
      {/* Labelled by state, not by action: these are pressed-toggles, and a lit
          button reading "Mute" is ambiguous about which of the two it means. */}
      <Toggle
        on={micOn}
        onClick={onMic}
        label={micOn ? 'Mic on' : 'Muted'}
        title={
          micOn
            ? 'Mute. This closes the microphone completely — the indicator light goes out.'
            : 'Unmute and reopen the microphone.'
        }
      >
        {micOn ? <MicIcon /> : <MicOffIcon />}
      </Toggle>

      <Toggle
        on={settings.video}
        onClick={() => onPatch({ video: !settings.video })}
        label="Camera"
        title={
          settings.video
            ? 'Stop the camera. No more frames go with your turns.'
            : 'Show the camera and send one frame with each turn, if the model can see.'
        }
      >
        {settings.video ? <CamIcon /> : <CamOffIcon />}
      </Toggle>

      <Toggle
        on={settings.bargeIn}
        onClick={() => onPatch({ bargeIn: !settings.bargeIn })}
        label="Barge-in"
        title={
          settings.bargeIn
            ? 'Speaking over the reply stops it. Off means you wait for it to finish.'
            : 'Interrupting is off — the reply plays to the end before you are heard.'
        }
      >
        <BargeIcon />
      </Toggle>

      <Toggle
        on={settings.speak}
        onClick={() => onPatch({ speak: !settings.speak })}
        label="Speak"
        title={
          settings.speak
            ? 'Replies are spoken aloud.'
            : 'Replies are text only — this is a dictation loop.'
        }
      >
        {settings.speak ? <SpeakerIcon /> : <SpeakerOffIcon />}
      </Toggle>

      {/* Only offered once there is something to choose. A picker whose only
          option is the thing already on screen is a control that does nothing. */}
      {avatars.length > 0 ? (
        <label className="lv-field">
          <span className="lv-field-label">Face</span>
          <select
            className="lv-select"
            value={avatarId ?? ''}
            onChange={(e) => onAvatar(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">Orb</option>
            {avatars.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="lv-field">
        <span className="lv-field-label">Voice</span>
        <select
          className="lv-select"
          value={settings.voice}
          disabled={options.length === 0}
          onChange={(e) => {
            const next = e.target.value
            const preset = VOICE_PRESETS.find((p) => p.id === next)
            // Pace is part of a character, not a separate setting to rediscover.
            onPatch(preset ? { voice: next, speed: preset.speed } : { voice: next })
          }}
        >
          {settings.voice === '' ? <option value="">Server default</option> : null}
          {/* Named characters first, so the picker reads as "Jarvis" rather
              than "bm_george". Everything else Kokoro offers stays reachable
              underneath, since which British male actually sounds like Jarvis
              is a matter of ear. */}
          <optgroup label="Characters">
            {VOICE_PRESETS.filter((p) => options.includes(p.id)).map((p) => (
              <option key={p.id} value={p.id} title={p.note}>
                {p.label} · {p.id}
              </option>
            ))}
          </optgroup>
          <optgroup label="All voices">
            {options
              .filter((v) => !VOICE_PRESETS.some((p) => p.id === v))
              .map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
          </optgroup>
        </select>
      </label>

      <label className="lv-field lv-field-speed">
        <span className="lv-field-label">Speed</span>
        <input
          className="lv-range"
          type="range"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
          value={speed}
          onChange={(e) => onSpeed(Number(e.target.value))}
        />
        <span className="lv-range-value tnum">{speed.toFixed(2)}×</span>
      </label>
    </div>
  )
}

function Toggle({
  on,
  onClick,
  label,
  title,
  children
}: {
  on: boolean
  onClick: () => void
  label: string
  title: string
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      className={on ? 'btn lv-toggle is-on' : 'btn lv-toggle'}
      onClick={onClick}
      aria-pressed={on}
      title={title}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}

function Timings({ timings }: { timings: LiveTurnTimings }): JSX.Element {
  // Audio was actually produced. Both are zero only when nothing was spoken.
  const spoke = timings.firstAudioMs > 0 || timings.ttsMs > 0
  return (
    <div className="lv-timing">
      {/* With Speak switched off no audio is ever queued, so firstAudioMs and
          ttsMs stay 0 — and "0ms to first audio" headlined as the number that
          decides whether this feels like a conversation is a lie by omission.
          The turn still has real timings; they just do not include speech. */}
      <div className="lv-t-hero">
        <span className="lv-t-value tnum">
          {spoke ? formatMs(timings.firstAudioMs) : formatMs(timings.ttftMs)}
        </span>
        <span className="lv-t-label">
          {spoke
            ? 'to first audio — from you stopping speaking to hearing anything'
            : 'to first token — nothing was spoken this turn, so there is no audio to time'}
        </span>
      </div>
      <dl className="lv-t-rest">
        <Cell name="transcribe" value={timings.sttMs} />
        <Cell name="first token" value={timings.ttftMs} />
        {spoke ? <Cell name="synthesise" value={timings.ttsMs} /> : null}
        <Cell name="whole turn" value={timings.totalMs} />
      </dl>
    </div>
  )
}

function Cell({ name, value }: { name: string; value: number }): JSX.Element {
  return (
    <div className="lv-t-item">
      <dt className="lv-t-k">{name}</dt>
      <dd className="lv-t-v tnum">{formatMs(value)}</dd>
    </div>
  )
}

function Note({
  kind,
  title,
  children
}: {
  kind: 'error' | 'warn' | 'info'
  title?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`lv-note is-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <AlertIcon />
      <div className="lv-note-body">
        {title !== undefined ? <span className="lv-note-title">{title}</span> : null}
        <span className="lv-note-text">{children}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      className="lv-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function MicIcon(): JSX.Element {
  return (
    <Svg>
      <rect x="6" y="1.6" width="4" height="7.6" rx="2" />
      <path d="M3.6 7.4a4.4 4.4 0 008.8 0M8 11.8V14.2" />
    </Svg>
  )
}

function MicOffIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M6 3.6a2 2 0 014 0v3.2M6 6.6v2.6a2 2 0 002.9 1.8" />
      <path d="M3.6 7.4a4.4 4.4 0 006.5 3.8M12.4 7.4v.4M8 11.8V14.2" />
      <path d="M2 2l12 12" />
    </Svg>
  )
}

function CamIcon(): JSX.Element {
  return (
    <Svg>
      <rect x="1.6" y="4" width="9" height="8" rx="1.6" />
      <path d="M10.6 7.6l3.8-2.2v5.2l-3.8-2.2z" />
    </Svg>
  )
}

function CamOffIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M6.4 4h2.6a1.6 1.6 0 011.6 1.6v1.9M10.6 10.4a1.6 1.6 0 01-1.6 1.6H3.2a1.6 1.6 0 01-1.6-1.6V5.6c0-.5.3-1 .7-1.3" />
      <path d="M10.6 7.6l3.8-2.2v5.2l-1.6-.9" />
      <path d="M2 2l12 12" />
    </Svg>
  )
}

/** Two arrows meeting: one voice cutting across the other. */
function BargeIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M1.8 5.4h7.4M6.6 3l2.6 2.4-2.6 2.4" />
      <path d="M14.2 10.6H6.8M9.4 8.2L6.8 10.6l2.6 2.4" />
    </Svg>
  )
}

function SpeakerIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M8.4 2.4L4.8 5.4H2.2v5.2h2.6l3.6 3z" />
      <path d="M11 5.6a3.4 3.4 0 010 4.8M13.2 3.6a6.4 6.4 0 010 8.8" />
    </Svg>
  )
}

function SpeakerOffIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M8.4 2.4L4.8 5.4H2.2v5.2h2.6l3.6 3z" />
      <path d="M11.2 6.4l3.2 3.2M14.4 6.4l-3.2 3.2" />
    </Svg>
  )
}

function CallIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M5.4 2.4L7 5.2 5.6 6.8a7.4 7.4 0 003.6 3.6l1.6-1.4 2.8 1.6v2.2a1 1 0 01-1.1 1A11.6 11.6 0 012 3.5a1 1 0 011-1.1z" />
    </Svg>
  )
}

function EndIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M1.8 9.4l1.6-2A7.4 7.4 0 018 5.6a7.4 7.4 0 014.6 1.8l1.6 2" />
      <path d="M4.4 8.6l-.9 2.2M11.6 8.6l.9 2.2" />
    </Svg>
  )
}

function StopIcon(): JSX.Element {
  return (
    <Svg>
      <rect x="4" y="4" width="8" height="8" rx="1.4" />
    </Svg>
  )
}

function AlertIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M8 2.6l6 10.8H2z" />
      <path d="M8 6.6v3" />
      <circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  )
}
