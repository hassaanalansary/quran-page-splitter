// Base HTTP helpers for the Django Ninja API.
//
// In dev, Vite proxies `/api` → localhost:8000 (see vite.config.ts). In prod the
// SPA is served same-origin, so an empty base also works. `VITE_API_BASE_URL`
// can override the origin when the API lives elsewhere.

export const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "").replace(
  /\/$/,
  "",
);

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
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, messageFromBody(body, `${res.status} ${res.statusText}`));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return fetch(`${API_BASE}${path}`, { signal }).then(handle<T>);
}

export function apiJson<T>(
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
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
  return fetch(`${API_BASE}${path}`, { method, body: form, signal }).then(handle<T>);
}

export function apiDelete(path: string, signal?: AbortSignal): Promise<void> {
  return fetch(`${API_BASE}${path}`, { method: "DELETE", signal }).then(handle<void>);
}
