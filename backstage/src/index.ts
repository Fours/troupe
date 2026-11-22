// The Backstage UI, for a page that runs it: the demo now, and the page `serveBackstage` serves
// in T6. Not part of the package's API: it ships only as built files.

export type { BackstageClient } from './client.ts';
export { Backstage, type BackstageProps, type Panel } from './ui/Backstage.tsx';
export { createStore, type BackstageStore, type ViewModel } from './store/store.ts';
