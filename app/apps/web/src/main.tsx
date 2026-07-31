import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/fonts.css';
import './theme/tokens.css';
import './styles/app.css';
import './styles/wo-detail.css';
import './styles/messages.css';
import './styles/s4-forms.css';
import './styles/quote.css';
import './styles/payment.css';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
