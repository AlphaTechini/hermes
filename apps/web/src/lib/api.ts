import type { ApiErrorBody } from "@hermes/shared";

/** Thrown for every non-2xx response and for network failures (status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: { path: string; message: string }[];
  constructor(status: number, code: string, message: string, issues?: { path: string; message: string }[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/** Plain-language message for toasts and inline errors. */
export function errorMessage(e: unknown, fallback = "Something went wrong. Try again."): string {
  if (isApiError(e)) return e.isNetwork ? "Hermes did not respond. Check your connection and try again." : e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

type TokenGetter = () => Promise<string | null | undefined>;
let tokenGetter: TokenGetter | null = null;

/** Called by the AuthProvider. In Privy mode this is `usePrivy().getAccessToken`; in DEV mode it stays null. */
export function setAccessTokenGetter(fn: TokenGetter | null): void {
  tokenGetter = fn;
}
export async function getAccessToken(): Promise<string | null> {
  if (!tokenGetter) return null;
  try {
    return (await tokenGetter()) ?? null;
  } catch {
    return null;
  }
}

export const API_BASE: string = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = API_BASE + path;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

/**
 * Typed fetch wrapper. Adds the bearer token (Privy mode), sends JSON, and converts the server's
 * `{ error: { code, message } }` shape into {@link ApiError}.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = await getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method: opts.method ?? "GET", headers, body, signal: opts.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network_error", "Hermes did not respond.");
  }
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  if (!res.ok) {
    const err = (json as Partial<ApiErrorBody> | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? (res.statusText || "Request failed"), err?.issues);
  }
  return json as T;
}

export const get = <T>(path: string, query?: RequestOptions["query"], signal?: AbortSignal) => api<T>(path, { query, signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
