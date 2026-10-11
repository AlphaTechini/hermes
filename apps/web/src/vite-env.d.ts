/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When set, the app uses Privy for login. When empty, DEV mode (server AUTH_MODE=dev). */
  readonly VITE_PRIVY_APP_ID?: string;
  /** Optional: absolute API origin. Default is same-origin (Vite proxies /api and /hooks in dev). */
  readonly VITE_API_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
