/**
 * One conversation, two front doors.
 *
 * Chat and Live were never separate threads. The live session pushes into
 * `conv.messages` and composes its requests with the same `buildMessages` a
 * typed turn uses, so the model has always seen one history. The only real
 * difference is the input surface — a composer or a microphone — and the app
 * made you switch WORKFLOW to switch between them, which files the conversation
 * elsewhere and loses your place.
 *
 * So this holds both and swaps only the surface. Say something, switch to
 * typing, and the model still knows what you said.
 *
 * The one thing it will not do is leave both live at once. A microphone open
 * behind a text composer is a running cost and a privacy surprise — every
 * utterance is transcribed and sent — so moving to text ends the call, visibly
 * and on purpose rather than as a side effect.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'

import ChatView from '@renderer/components/chat/ChatView'
import LiveWorkspace from '@renderer/components/live/LiveWorkspace'
import { useStore } from '@renderer/state/store'
import './converse.css'

type Mode = 'text' | 'voice'

export default function ConverseWorkspace(): JSX.Element {
  const [mode, setMode] = useState<Mode>('text')
  const liveStatus = useStore((s) => s.liveStatus)
  const stopLive = useStore((s) => s.stopLive)

  /* 'off' is the idle state — there is no 'idle'. Anything else means the
     microphone is open or a turn is in flight. */
  const callRunning = liveStatus.state !== 'off'

  const toText = useCallback(() => {
    setMode('text')
    /* Ending the call is the point, not a cleanup detail — see the header. */
    if (callRunning) void stopLive()
  }, [callRunning, stopLive])

  /*
   * If a call ends by itself — the workspace's own Stop, or a dropped session —
   * come back to text rather than leaving a dead orb with no way to type.
   *
   * On the TRANSITION out of a running call, not on the state being 'off'. The
   * first version tested `state === 'off'` and so fired the instant you pressed
   * Talk, before any call had started: the mode flipped to voice and was
   * yanked straight back, and the button looked broken. Switching to voice is
   * exactly when there is no call yet.
   */
  const wasRunning = useRef(false)
  useEffect(() => {
    const running = liveStatus.state !== 'off'
    if (mode === 'voice' && wasRunning.current && !running) setMode('text')
    wasRunning.current = running
  }, [liveStatus.state, mode])

  return (
    <div className="cv">
      <div className="cv-switch" role="tablist" aria-label="Input mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'text'}
          className={mode === 'text' ? 'cv-tab is-on' : 'cv-tab'}
          onClick={toText}
        >
          <span aria-hidden="true">⌨</span> Type
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'voice'}
          className={mode === 'voice' ? 'cv-tab is-on' : 'cv-tab'}
          onClick={() => setMode('voice')}
        >
          <span aria-hidden="true">🎙</span> Talk
        </button>
        {/* Said here rather than left to be discovered: the reason to switch is
            that nothing is lost by switching. */}
        <span className="cv-note">
          {callRunning
            ? 'Listening — switching to Type will end the call.'
            : 'Same conversation either way.'}
        </span>
      </div>

      {/*
        Both are mounted, and only one is shown.

        Unmounting the live workspace would tear down its audio capture and
        device permissions on every toggle, which is slow and re-prompts; and
        unmounting the chat view loses scroll position in a transcript the voice
        turns are still being appended to. Hiding costs a little memory and
        keeps both honest.
      */}
      <div className={mode === 'text' ? 'cv-pane' : 'cv-pane is-hidden'} aria-hidden={mode !== 'text'}>
        <ChatView />
      </div>
      <div className={mode === 'voice' ? 'cv-pane' : 'cv-pane is-hidden'} aria-hidden={mode !== 'voice'}>
        <LiveWorkspace />
      </div>
    </div>
  )
}
