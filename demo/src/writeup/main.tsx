// The write-up's own entry: none of the demo, no actor system and no Backstage, so the page
// loads fast for a reader who came for the text. Its chart data is built in
// (virtual:writeup-data, demo/vite.config.ts).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import data from 'virtual:writeup-data';
import type { WriteupData } from './data.ts';
import { initAnalytics } from '../site/browser-analytics.ts';
import { WriteUp } from './WriteUp.tsx';
import './writeup.css';

// The plugin builds it with loadWriteupData, which returns a WriteupData or fails the build.
const writeup = data as WriteupData;

const root = document.getElementById('root');
if (root === null) throw new Error('how-it-works/index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <WriteUp data={writeup} />
  </StrictMode>,
);

initAnalytics();
