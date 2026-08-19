import { useEffect } from 'react'

import { useStore } from '@renderer/state/store'

/**
 * Keeps the live browser stream running for as long as the caller is mounted.
 *
 * Extracted because two surfaces want it — the Browser tab and the floating
 * window — and the counting has to be shared. The mirror is reference counted
 * in main: both can watch at once, and the stream stops only when the last one
 * unmounts. Without a single hook it is far too easy for one of them to stop a
 * stream the other is still using.
 */
export function useMirrorStream(): void {
  const watchBrowser = useStore((s) => s.watchBrowser)
  useEffect(() => {
    void watchBrowser(true)
    return () => {
      void watchBrowser(false)
    }
  }, [watchBrowser])
}
