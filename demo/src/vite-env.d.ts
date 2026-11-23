/// <reference types="vite/client" />

// PostHog's key and host, from demo/.env.local (demo/.env.example). Both are optional: without a
// key, analytics never loads.
interface ImportMetaEnv {
  readonly VITE_PUBLIC_POSTHOG_KEY?: string;
  readonly VITE_PUBLIC_POSTHOG_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
