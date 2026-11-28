// Served by the rehearsal-data plugin in demo/vite.config.ts, from docs/decisions/data/. An
// ambient module can't import a relative path, so it's typed in main.tsx, where it's read.
declare module 'virtual:rehearsal-data' {
  const data: unknown;
  export default data;
}
