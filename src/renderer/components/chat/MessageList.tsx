/**
 * The scrolling transcript.
 *
 * Auto-scroll follows the stream only while the user is already at the bottom.
 * The moment they scroll up to read something, following stops and a jump
 * affordance appears instead — a chat that yanks the viewport away mid-read is
 * worse than no auto-scroll at all.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@renderer/state/store'
import Message from './Message'
import './chat.css'

/** How close to the bottom still counts as "following". */
const STICK_PX = 56

export default function MessageList() {
  const conversation = useStore((s) => s.conversation)
  const messages = conversation?.messages
  const conversationId = conversation?.id ?? null

  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [following, setFollowing] = useState(true)

  const visible = useMemo(
    () => (messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant'),
    [messages]
  )

  // Tool results may arrive as their own role:'tool' messages; index them so
  // each card can show its own output.
  const toolResults = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of messages ?? []) {
      if (m.role === 'tool' && m.toolCallId !== undefined) map.set(m.toolCallId, m.content)
    }
    return map
  }, [messages])

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    stickRef.current = atBottom
    setFollowing((prev) => (prev === atBottom ? prev : atBottom))
  }, [])

  // Content grows a few times a second while decoding; an observer beats
  // depending on the message array identity.
  useEffect(() => {
    const inner = innerRef.current
    const scroller = scrollRef.current
    if (!inner || !scroller) return
    const ro = new ResizeObserver(() => {
      if (stickRef.current) scroller.scrollTop = scroller.scrollHeight
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  // A different conversation starts pinned to its end.
  useLayoutEffect(() => {
    stickRef.current = true
    setFollowing(true)
    scrollToBottom(false)
  }, [conversationId, scrollToBottom])

  return (
    <div className="msglist">
      <div className="msglist-scroll scroll-y" ref={scrollRef} onScroll={onScroll}>
        <div className="msglist-inner chat-measure" ref={innerRef}>
          {visible.length === 0 ? (
            <div className="msglist-empty">Nothing in this conversation yet.</div>
          ) : (
            visible.map((m) => <Message key={m.id} message={m} toolResults={toolResults} />)
          )}
        </div>
      </div>

      {!following ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            stickRef.current = true
            setFollowing(true)
            scrollToBottom(true)
          }}
        >
          <svg
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
            <path d="M8 3.5v9M4.5 9L8 12.5 11.5 9" />
          </svg>
          Jump to latest
        </button>
      ) : null}
    </div>
  )
}
