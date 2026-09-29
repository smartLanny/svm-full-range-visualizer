import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import './styles.css';
import App from './App';
import { bootstrap } from './store/bootstrap';
import { useAppStore } from './store/appStore';
import { getActiveTimeline } from './timeline/timeline';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

void bootstrap();

// Automation / debugging handle (visual smoke tests drive the app through this).
(window as unknown as { __svm: unknown }).__svm = { store: useAppStore, timeline: getActiveTimeline };

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
