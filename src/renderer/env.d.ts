/// <reference types="vite/client" />

import type { HarnessBridge } from '@shared/ipc'

declare global {
  interface Window {
    harness: HarnessBridge
  }
}

export {}
