/// <reference types="vite/client" />

/** Injected by Vite's `define`; see vite.config.ts. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Public API origin. The only runtime configuration the bundle carries. */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ENVIRONMENT_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
