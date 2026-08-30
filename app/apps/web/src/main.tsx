import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/fonts.css';
import './theme/tokens.css';
import './styles/app.css';
import './styles/wo-detail.css';
import './styles/messages.css';
import './styles/s4-forms.css';
import './styles/forms.css';
import './styles/quote.css';
import './styles/payment.css';
import './styles/auth.css';
import './styles/wo-list.css';
import { App } from './App';
import { initOKnob } from './lib/oknob';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

// Native scrollbars are hidden app-wide (app.css); the O-knob manager mounts
// the branded replacement on every scrollable that ever appears.
initOKnob();

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
