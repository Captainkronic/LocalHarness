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
import VoiceIndicator from './VoiceIndicator'
import { useStore } from '@renderer/state/store'
import './converse.css'

/**
 * What each session state means to someone looking at the bar.
 *
 * Spelled out rather than shown as a status word, because during a spoken turn
 * the only other signal is silence, and silence reads as a crash.
 */
const SAYS: Record<string, string> = {
  /* Short, because these now sit inside the composer's control row rather
     than on a line of their own. Two or three words each. */
  off: '',
  starting: 'Starting…',
  listening: 'Listening',
  capturing: 'Hearing you',
  transcribing: 'Got that…',
  thinking: 'Thinking',
  tool: 'Looking it up',
  speaking: 'Speaking',
  error: 'Stopped'
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
          /*
            One row in both states, because the orb's own row was a row spent
            on a dot that never changed.

            Idle it is just the button. Live it becomes the status: the meter
            moves with your voice, the word says what is happening, and Stop is
            the way out. Nothing appears or disappears above the text box, so
            the composer does not jump height when a call starts.
          */
          <div className={running ? 'cv-controls is-live' : 'cv-controls'} data-state={state}>
            {running ? (
              <>
                <VoiceIndicator state={state} />
                <span className="cv-say" role="status">
                  {SAYS[state] ?? state}
                </span>
                <button
                  type="button"
                  className="cv-mic is-on"
                  onClick={toggleCall}
                  title="End the voice session"
                  aria-label="End the voice session"
                >
                  <MicIcon speaking={false} stop />
                  <span className="cv-mic-label">Stop</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="cv-mic"
                onClick={toggleCall}
                title="Talk instead of typing"
                aria-label="Talk instead of typing"
              >
                <MicIcon speaking={false} stop={false} />
                <span className="cv-mic-label">Talk</span>
              </button>
            )}
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
      {/*
        What it thought it heard, and only that.

        The state used to be spelled out down here as well, which meant a
        second row appearing under the composer the moment a call started and
        saying the same thing the control now says. This is the part that row
        had which the control cannot: a misheard word is the usual explanation
        for a strange answer, and without seeing it the answer just looks wrong.
      */}
      {running && liveStatus.lastUserText !== '' ? (
        <p className="cv-heard" title="What was transcribed">
          heard “{liveStatus.lastUserText}”
        </p>
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
