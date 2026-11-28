// The page `serveBackstage` serves: Backstage on its own, over HTTP, with a line saying whether
// it's connected.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/backstage.css';
import { App } from './App.tsx';
import './standalone.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
