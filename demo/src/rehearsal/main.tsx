// Rehearsal's own entry: the page loads its drawings and the worker that runs seeds, and none of
// the other pages. The recorded runs are built in (virtual:rehearsal-data, demo/vite.config.ts).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import data from 'virtual:rehearsal-data';
import { initAnalytics } from '../site/browser-analytics.ts';
import { App } from './App.tsx';
import type { RehearsalData } from './data.ts';
import './rehearsal.css';

// The plugin builds it with loadRehearsalData, which returns a RehearsalData or fails the build.
const rehearsal = data as RehearsalData;

const root = document.getElementById('root');
if (root === null) throw new Error('rehearsal/index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <App data={rehearsal} />
  </StrictMode>,
);

initAnalytics();
