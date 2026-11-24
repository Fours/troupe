// Festival night's own entry: the cluster page loads none of opening night's page, only the
// domain it reuses (the shows, the crowd and the sales board) and Backstage.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initAnalytics } from '../site/browser-analytics.ts';
import { App } from './App.tsx';
import './festival.css';

const root = document.getElementById('root');
if (root === null) throw new Error('cluster/index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

initAnalytics();
