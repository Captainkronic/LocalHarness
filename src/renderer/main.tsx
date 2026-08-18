// Style order matters: tokens first, then the shell layout, then whatever the
// components pull in behind them.
import '@renderer/styles/theme.css'
import '@renderer/styles/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@renderer/App'

// Stamped on <html> before React mounts, so CodeWorkspace can read it in its
// initial state rather than flashing the wrong half. ESM imports are hoisted,
// so this cannot sit above them and mean anything — it belongs here.
const forcedCodeMode = new URLSearchParams(window.location.search).get('codeMode')
if (forcedCodeMode === 'chat' || forcedCodeMode === 'watch') {
  document.documentElement.dataset.codeMode = forcedCodeMode
}

// Same idea, for the Live workspace: pins the call state so each one can be
// photographed. See LiveWorkspace.
const forcedLiveState = new URLSearchParams(window.location.search).get('liveState')
if (forcedLiveState !== null && forcedLiveState !== '') {
  document.documentElement.dataset.liveState = forcedLiveState
}

// And the avatar builder, which is a dialog and so cannot be reached at all by
// a screenshot that has no way to click.
if (new URLSearchParams(window.location.search).get('avatarBuilder') === '1') {
  document.documentElement.dataset.avatarBuilder = '1'
}

const container = document.getElementById('root')
if (!container) throw new Error('LocalHarness: #root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
