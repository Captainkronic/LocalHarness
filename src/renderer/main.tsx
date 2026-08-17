// Style order matters: tokens first, then the shell layout, then whatever the
// components pull in behind them.
import '@renderer/styles/theme.css'
import '@renderer/styles/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@renderer/App'

const container = document.getElementById('root')
if (!container) throw new Error('LocalHarness: #root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
