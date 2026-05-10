import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { injectKaizoData } from './utils/kaizoInjector'

// Inject Platinum Kaizo stat/move overrides into @smogon/calc before rendering
injectKaizoData()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
