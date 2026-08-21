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
          messages, so there is nothing to switch to in order to read them. */}
      <div className="cv-thread">
        <ChatView />
      </div>

      <div className="cv-bar">
        <button
          type="button"
          className={running ? 'cv-call is-on' : 'cv-call'}
          onClick={toggleCall}
          aria-pressed={running}
          title={running ? 'End the voice session' : 'Start talking'}
        >
          <span aria-hidden="true">{running ? '■' : '🎙'}</span>
          {running ? 'Stop' : 'Talk'}
        </button>

        {/* A level meter only while there is a level. A dead bar beside an idle
            microphone reads as broken hardware. */}
        {running ? (
          <span className="cv-level" aria-hidden="true">
            <span
              className={liveStatus.userSpeaking ? 'cv-level-fill is-hot' : 'cv-level-fill'}
              style={{ width: `${Math.round(Math.min(1, Math.max(0, liveStatus.level)) * 100)}%` }}
            />
          </span>
        ) : null}

        <span className="cv-say">{SAYS[state] ?? state}</span>

        {running && liveStatus.lastUserText ? (
          /* What it thought it heard, next to what you said. A misheard word is
             the usual explanation for a strange answer, and without this the
             answer simply looks wrong. */
          <span className="cv-heard" title="What was transcribed">
            “{liveStatus.lastUserText}”
          </span>
        ) : null}
      </div>
    </div>
  )
}
