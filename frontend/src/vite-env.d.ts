interface ImportMetaEnv {
  /** Base URL of the API: absolute in development, `/api` in production. */
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
