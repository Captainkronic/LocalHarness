/**
 * A conversation you can type into or talk into, for any workflow that says it
 * can take it.
 *
 * This began as Converse and is no longer only Converse. Nothing in it was
 * specific to that workflow — the thread, the composer, the microphone and the
 * panel are the same parts in every case — so Image and Audio use it unchanged,
 * and a workflow added next year gets it by writing `talk: true` rather than by
 * writing a screen.
 *
 * What makes that safe is on the definition, not here: `talk` asserts that this
 * workflow's MCP tools are safe to run without an approval dialog, because a
 * spoken turn has no way to show one. See WorkflowDefinition.talk. Code and Docs
 * do not have it and should not.
 *
 * Chat and Live were never separate threads to begin with. The live session
 * pushes plain user and assistant messages into `conv.messages` and composes its
 * requests with the same `buildMessages` a typed turn uses, so a spoken turn is
 * already an ordinary message in the transcript. Nothing had to be merged; it
 * only had to stop being hidden.
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
import './talk.css'

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

export default function TalkDeck(): JSX.Element {
  const liveStatus = useStore((s) => s.liveStatus)
  const startLive = useStore((s) => s.startLive)
  const stopLive = useStore((s) => s.stopLive)
  const requestInterrupt = useStore((s) => s.requestInterrupt)
  /* The honest test for "is there something to cut off". A reply keeps coming
     out of the speakers after the state has moved on, and `state === speaking`
     alone would hide the button while a sentence was still playing. */
  const audioPlaying = useStore((s) => s.audioPlaying)
  const openSettings = useStore((s) => s.setSettingsOpen)

  /* 'off' is the idle state; there is no 'idle'. Anything else means the
     microphone is open or a turn is in flight. */
  const state = liveStatus.state
  const running = state !== 'off'

  const toggleCall = useCallback(() => {
    if (running) void stopLive()
    else void startLive()
  }, [running, startLive, stopLive])

  return (
    <div className="tk">
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
          <div className={running ? 'tk-controls is-live' : 'tk-controls'} data-state={state}>
            {running ? (
              <>
                <VoiceIndicator state={state} />
                {/*
                  Interrupt, not Stop. Two different things and the labels have
                  to say which: this abandons the REPLY and goes back to
                  listening; Stop ends the call. Shown only while there is
                  something to abandon, so the row does not carry a dead control
                  through every silence.
                */}
                {audioPlaying || state === 'speaking' || state === 'thinking' || state === 'tool' ? (
                  <button
                    type="button"
                    className="tk-hush"
                    onClick={requestInterrupt}
                    title="Stop it talking and listen instead"
                    aria-label="Interrupt the reply"
                  >
                    Interrupt
                  </button>
                ) : null}
                <span className="tk-say" role="status">
                  {SAYS[state] ?? state}
                </span>
                <button
                  type="button"
                  className="tk-mic is-on"
                  onClick={toggleCall}
                  title="End the voice session"
                  aria-label="End the voice session"
                >
                  <MicIcon speaking={false} stop />
                  <span className="tk-mic-label">Stop</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="tk-mic"
                onClick={toggleCall}
                title="Talk instead of typing"
                aria-label="Talk instead of typing"
              >
                <MicIcon speaking={false} stop={false} />
                <span className="tk-mic-label">Talk</span>
              </button>
            )}
            {/* A shortcut into Settings, not a second copy of it. The controls
                live in one place; this is just the door nearest the microphone. */}
            <button
              type="button"
              className="tk-gear"
              onClick={() => openSettings(true)}
              title="Voice settings — including how loud you must be to interrupt"
              aria-label="Voice settings"
            >
              <GearIcon />
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
      <div className="tk-machinery" aria-hidden="true">
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
        <p className="tk-heard" title="What was transcribed">
          heard “{liveStatus.lastUserText}”
        </p>
      ) : null}
    </div>
  )
}

function GearIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2M12.5 12.5l-1.2-1.2M4.7 4.7L3.5 3.5" strokeLinecap="round" />
    </svg>
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
