import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TooltipProvider } from './components/Tooltip';
import './styles/index.css';
import type { DashboardPayload } from '@coderadius/shared-types';

declare global {
  interface Window {
    __RADIUS_DATA__: DashboardPayload;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={200} skipDelayDuration={0}>
      <App data={window.__RADIUS_DATA__} />
    </TooltipProvider>
  </React.StrictMode>
);
