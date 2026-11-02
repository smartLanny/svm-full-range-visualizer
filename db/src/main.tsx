import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import './styles.css';
import { App } from './App';

/*
 * Screen database entry. It never calls the workbench's bootstrap(): no IndexedDB, no saved
 * settings; the workbench components it reuses read only the default language from the
 * in-memory store.
 */
const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
