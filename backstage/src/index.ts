// The Backstage UI, for a page that runs it, such as the demo. The page `serveBackstage` serves
// is src/standalone/. Not part of the package's API: it ships only as built files.

export type { BackstageClient } from './client.ts';
export { Backstage, type BackstageProps, type Panel } from './ui/Backstage.tsx';
export { createStore, type BackstageStore, type ViewModel } from './store/store.ts';
