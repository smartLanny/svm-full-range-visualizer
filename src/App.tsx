import React from 'react';
import { Shell } from './shell/Shell';
import { ErrorBoundary } from './shell/ErrorBoundary';

/** App root: the shell owns layout, panels, dialogs, presentation mode and shortcuts. */
export default function App() {
  return (
    <ErrorBoundary scope="app">
      <Shell />
    </ErrorBoundary>
  );
}
