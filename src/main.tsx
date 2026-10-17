import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// Configure Monaco to load from the local bundle (not CDN) before any editor
// mounts. Must run early — importing for its side effects.
import './core/monaco/setup';
import { installErrorLogging } from './core/errors/errorLog';

// Before the first render, so errors thrown while mounting are captured too.
installErrorLogging();

// Disable default browser context menu (Inspect Element, Save As, etc.)
if (typeof window !== 'undefined') {
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
