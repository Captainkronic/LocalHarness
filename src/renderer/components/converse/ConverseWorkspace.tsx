/**
 * One conversation you can type into or talk into, without changing screens.
 *
 * Chat and Live were never separate threads. The live session pushes plain user
 * and assistant messages into `conv.messages` and composes its requests with the
 * same `buildMessages` a typed turn uses, so a spoken turn is already an
 * ordinary message in the transcript. Nothing had to be merged; it only had to
 * stop being hidden.
 *
 * Which is what the first version of this got wrong. It toggled between the
 * chat view and the live workspace, so speaking HID the conversation in order
 * to show a microphone — and seeing the two interleaved is the entire thing
 * that makes them feel like one thread. The transcript now always stays and
 * only the input changes.
 *
 * There is deliberately no mode to be in. The composer is always live and the
 * call button is always there, so replying to something you heard by typing is
 * just typing, with nothing to switch first.
 */

import { useCallback, type JSX } from 'react'

import ChatView from '@renderer/components/chat/ChatView'
import LiveWorkspace from '@renderer/components/live/LiveWorkspace'
import VoiceOrb from '@renderer/components/live/VoiceOrb'
import { useStore } from '@renderer/state/store'
import './converse.css'

/**
 * What each session state means to someone looking at the bar.
 *
 * Spelled out rather than shown as a status word, because during a spoken turn
 * the only other signal is silence, and silence reads as a crash.
 */
const SAYS: Record<string, string> = {
  off: 'Type, or press Talk and say it out loud.',
  starting: 'Opening the microphone…',
  listening: 'Listening — just talk.',
  capturing: 'Hearing you…',
  transcribing: 'Working out what you said…',
  thinking: 'Thinking…',
  tool: 'Looking something up…',
  speaking: 'Speaking — say anything to interrupt.',
  error: 'The voice session stopped.'
}

export default function ConverseWorkspace(): JSX.Element {
  const liveStatus = useStore((s) => s.liveStatus)
  const startLive = useStore((s) => s.startLive)
  const stopLive = useStore((s) => s.stopLive)

  /* 'off' is the idle state; there is no 'idle'. Anything else means the
     microphone is open or a turn is in flight. */
  const state = liveStatus.state
  const running = state !== 'off'

  const toggleCall = useCallback(() => {
    if (running) void stopLive()
    else void startLive()
  }, [running, startLive, stopLive])

  return (
    <div className="cv">
      {/* The conversation, always. Spoken turns arrive here as ordinary
          messages, so there is nothing to switch to in order to read them.

          The microphone goes INSIDE the composer's input row, beside Send. The
          first attempt put it in a strip underneath, where it read as a
          footnote and sat two pixels from the bottom of the window — present,
          and effectively invisible. A second way to say something belongs
          where the first one already is. */}
      <ChatView
        composerAccessory={
          <div className="cv-controls">
            {/*
              The orb, directly above the control it belongs to.

              It was in the right-hand panel, which put the one thing that shows
              what the microphone is doing at the far side of the window from
              the button that opens it. Here it is where you already are: you
              press Talk and the state changes an inch above your cursor.

              Scaled down to a glance rather than a display — the tick ring,
              the dial marks and the corner brackets are all hidden below,
              because at this size they are mush rather than detail. What
              survives is the part that carries the state: colour, the level
              arc, and the glyph in the middle.

              aria-hidden because it is a picture of state, not the state
              itself. The button's own label already says what pressing it
              does, and the status line under the composer says what the
              session is doing in words.
            */}
            <div className="cv-orb-mini" aria-hidden="true">
              <VoiceOrb state={state} level={liveStatus.level} />
            </div>
            <button
              type="button"
              className={running ? 'cv-mic is-on' : 'cv-mic'}
              onClick={toggleCall}
              aria-pressed={running}
              title={running ? 'Stop talking (end the voice session)' : 'Talk instead of typing'}
              aria-label={running ? 'Stop the voice session' : 'Talk instead of typing'}
            >
              <MicIcon speaking={running && liveStatus.userSpeaking} stop={running} />
              <span className="cv-mic-label">{running ? 'Stop' : 'Talk'}</span>
            </button>
          </div>
        }
      />

      {/*
        LiveWorkspace, mounted and hidden. This is machinery, not decoration.

        The microphone lives in the RENDERER: useAudioCapture runs
        getUserMedia, does the energy VAD, keeps the pre-roll buffer and posts
        each utterance up. LiveWorkspace is the only thing that mounts it, and
        it also owns TTS playback, barge-in and the echo suppression that stops
        a reply coming back through the mic as a new question.

        Leaving it out is exactly what broke this: pressing Talk started a
        session on the main side — Kokoro loaded, the state reached 'listening'
        — and then nothing, because nothing was listening. Reimplementing those
        two hundred lines here would be a second copy of subtle audio
        coordination to keep in step.

        Hidden with display:none, which affects layout and nothing else. Audio
        capture and playback do not care whether their component is painted.
      */}
      <div className="cv-machinery" aria-hidden="true">
        <LiveWorkspace />
      </div>

      {/*
        A status line only while a call is up.

        During a spoken turn the only other signal is silence, and silence reads
        as a crash — so what it is doing is spelled out, with the level meter
        and the transcription of what it heard beside it. When nothing is
        running this whole row is absent rather than empty, because a permanent
        strip saying "idle" is a strip of wasted screen.
      */}
      {running ? (
        <div className="cv-bar" role="status">
          <span className="cv-level" aria-hidden="true">
            <span
              className={liveStatus.userSpeaking ? 'cv-level-fill is-hot' : 'cv-level-fill'}
              style={{ width: `${Math.round(Math.min(1, Math.max(0, liveStatus.level)) * 100)}%` }}
            />
          </span>
          <span className="cv-say">{SAYS[state] ?? state}</span>
          {liveStatus.lastUserText ? (
            /* What it thought it heard. A misheard word is the usual
               explanation for a strange answer; without this the answer simply
               looks wrong. */
            <span className="cv-heard" title="What was transcribed">
              “{liveStatus.lastUserText}”
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Filled while you are actually speaking, so the button reflects the room. */
function MicIcon({ speaking, stop }: { speaking: boolean; stop: boolean }): JSX.Element {
  if (stop) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill={speaking ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="6" y="2" width="4" height="7" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 009 0M8 12v2" />
    </svg>
  )
}
