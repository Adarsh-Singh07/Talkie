interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_SIGNALING_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
