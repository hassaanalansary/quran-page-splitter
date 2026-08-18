// Base HTTP helpers for the Django Ninja API.
//
// In dev, Vite proxies `/api` → localhost:8000 (see vite.config.ts). In prod the
// SPA is served same-origin, so an empty base also works. `VITE_API_BASE_URL`
// can override the origin when the API lives elsewhere.

export const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "").replace(
  /\/$/,
  "",
);

/** Resolve a backend-served media path to a browser-usable URL. */
export function mediaUrl(path: string): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path)) return path;
  const normalized = path.replace(/^\/+/, "/");
  return `${API_BASE}${normalized}`;
}

/** Current UI language, mirrored onto <html lang> — sent so the API can
 * localize its error messages (see backend api/i18n.py). */
function acceptLanguage(): string {
  const lang = typeof document !== "undefined" ? document.documentElement.lang : "";
  return lang === "ar" ? "ar" : "en";
}

/** Read a cookie by name. Django's CSRF cookie is not HttpOnly by design
 * (see CSRF_COOKIE_HTTPONLY in config/settings.py) so the SPA can echo it. */
export function getCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

/** Headers every request carries: language, session cookie, CSRF on writes. */
function headersFor(method: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept-Language": acceptLanguage(),
    ...extra,
  };
  // Django exempts GET/HEAD/OPTIONS/TRACE from CSRF; sending it anyway is
  // harmless but noisy.
  if (!["GET", "HEAD", "OPTIONS", "TRACE"].includes(method)) {
    headers["X-CSRFToken"] = getCookie("csrftoken");
  }
  return headers;
}

/** Called when an /api call comes back 401, so the app can send the user to
 * sign in. Registered by the router rather than imported here, to keep this
 * module free of a dependency on routing. */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** Thrown for any non-2xx response; carries the HTTP status for callers to branch on. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Coerce a Ninja error body (`{detail}` or validation array) into a message. */
function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const first = detail[0];
      if (first && typeof first === "object" && "msg" in first) {
        return String((first as { msg: unknown }).msg);
      }
      return JSON.stringify(detail);
    }
  }
  return fallback;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, messageFromBody(body, `${res.status} ${res.statusText}`));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return fetch(`${API_BASE}${path}`, {
    signal,
    credentials: "include",
    headers: headersFor("GET"),
  }).then(handle<T>);
}

export function apiJson<T>(
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers: headersFor(method, { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  }).then(handle<T>);
}

export function apiForm<T>(
  method: "POST" | "PUT",
  path: string,
  form: FormData,
  signal?: AbortSignal,
): Promise<T> {
  return fetch(`${API_BASE}${path}`, {
    method,
    body: form,
    signal,
    credentials: "include",
    // No Content-Type: the browser sets it with the multipart boundary.
    headers: headersFor(method),
  }).then(handle<T>);
}

export function apiDelete(path: string, signal?: AbortSignal): Promise<void> {
  return fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    signal,
    credentials: "include",
    headers: headersFor("DELETE"),
  }).then(handle<void>);
}
