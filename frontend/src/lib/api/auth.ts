// Client for django-allauth's headless API (browser client, session cookies).
//
// This is a separate module from http.ts because allauth speaks a different
// protocol from the Ninja API: every response is wrapped in
// `{status, data?, meta?, errors?}`, errors are a list of
// `{message, code, param?}` rather than Ninja's `{detail}`, and — importantly —
// **HTTP 401 on the session endpoint is the normal signed-out state**, not a
// failure. Routing those through http.ts's handler would fire the global
// "you got logged out" redirect every time an anonymous visitor loads the page.
//
// Endpoint paths and field names were read off allauth 65.19.1 itself
// (allauth/headless/{urls,account/inputs}.py); the protocol is version-specific,
// and in development the authoritative spec is served at /_allauth/openapi.html.

import { API_BASE, getCookie } from "./http";

const ALLAUTH_BASE = `${API_BASE}/_allauth/browser/v1`;

/** The user payload allauth serializes (see headless/adapter.py). Keys whose
 * value is empty are omitted entirely, hence the optionals. */
export interface SessionUser {
  id: string;
  email?: string;
  display?: string;
  has_usable_password?: boolean;
}

interface AllauthEnvelope<T> {
  status: number;
  data?: T;
  meta?: { is_authenticated?: boolean; [k: string]: unknown };
  errors?: { message: string; code?: string; param?: string }[];
}

/** A failed allauth call. `code` is allauth's stable machine-readable reason
 * (e.g. "email_password_mismatch"), which is what UI copy should branch on —
 * `message` is English text from the server. */
export class AuthError extends Error {
  status: number;
  code?: string;
  param?: string;

  constructor(status: number, message: string, code?: string, param?: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

/** Get a CSRF token, fetching one first if the cookie is not set yet.
 *
 * Django only issues the cookie when something calls `get_token()`. In
 * production the SPA's own HTML response does it — config/spa.py is decorated
 * with `@ensure_csrf_cookie`. In development Vite serves index.html and Django
 * never sees that request, so a cold load of /auth/login would POST with an
 * empty token and get a 403. Every headless *browser* endpoint calls
 * `get_token` (allauth/headless/internal/decorators.py), so one GET to /config
 * is enough to prime it.
 */
async function ensureCsrfToken(): Promise<string> {
  const existing = getCookie("csrftoken");
  if (existing) return existing;
  try {
    await fetch(`${ALLAUTH_BASE}/config`, { credentials: "include" });
  } catch {
    // Offline or the backend is down; let the real request produce the error.
  }
  return getCookie("csrftoken");
}

async function call<T>(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<AllauthEnvelope<T>> {
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers["X-CSRFToken"] = await ensureCsrfToken();
  }

  const res = await fetch(`${ALLAUTH_BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init?.signal,
  });

  const body = (await res.json().catch(() => null)) as AllauthEnvelope<T> | null;

  // 401 here means "not (fully) authenticated", which several endpoints use as
  // a normal outcome. Callers decide what it means; only 4xx/5xx *with* an
  // errors array is an actual failure.
  if (body?.errors?.length) {
    const first = body.errors[0];
    throw new AuthError(res.status, first.message, first.code, first.param);
  }
  // 409 carries no errors array — allauth uses a bare ConflictResponse to mean
  // "this flow doesn't apply right now", most often "you are already signed in"
  // on login/signup. Give it a code so callers can react instead of showing the
  // user a raw status line.
  if (res.status === 409) {
    throw new AuthError(409, "Already signed in.", "already_authenticated");
  }
  if (!res.ok && res.status !== 401) {
    throw new AuthError(res.status, `${res.status} ${res.statusText}`);
  }
  return body ?? { status: res.status };
}

/** Current session. `null` means signed out — including the 401 that allauth
 * returns for an anonymous visitor, which is expected rather than an error. */
export async function getSession(signal?: AbortSignal): Promise<SessionUser | null> {
  const body = await call<{ user?: SessionUser }>("/auth/session", { signal });
  if (body.meta?.is_authenticated && body.data?.user) return body.data.user;
  return null;
}

export async function login(email: string, password: string): Promise<SessionUser | null> {
  const body = await call<{ user?: SessionUser }>("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  return body.data?.user ?? null;
}

/** Creates the account. With ACCOUNT_EMAIL_VERIFICATION="mandatory" the reply is
 * a 401 carrying a pending `verify_email` flow, not a session — the caller
 * should tell the user to go and check their inbox. */
export async function signup(email: string, password: string): Promise<{ verified: boolean }> {
  const body = await call<{ user?: SessionUser }>("/auth/signup", {
    method: "POST",
    body: { email, password },
  });
  return { verified: Boolean(body.meta?.is_authenticated) };
}

export async function logout(): Promise<void> {
  // Settles as 401 ("you are now anonymous"), which `call` treats as success.
  await call("/auth/session", { method: "DELETE" });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await call("/auth/password/request", { method: "POST", body: { email } });
}

export async function resetPassword(key: string, password: string): Promise<void> {
  await call("/auth/password/reset", { method: "POST", body: { key, password } });
}

export async function verifyEmail(key: string): Promise<void> {
  await call("/auth/email/verify", { method: "POST", body: { key } });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await call("/account/password/change", {
    method: "POST",
    body: { current_password: currentPassword, new_password: newPassword },
  });
}

/** Starts Google sign-in.
 *
 * This has to be a real form submission, not fetch: the browser must follow the
 * redirect to Google and come back with its own cookies. A fetch would be
 * blocked by CORS at Google's end and would lose the navigation entirely.
 */
export async function startProviderLogin(provider: string, nextPath = "/"): Promise<void> {
  const csrf = await ensureCsrfToken();

  const form = document.createElement("form");
  form.method = "POST";
  form.action = `${ALLAUTH_BASE}/auth/provider/redirect`;

  const fields: Record<string, string> = {
    provider,
    callback_url: nextPath,
    process: "login",
    csrfmiddlewaretoken: csrf,
  };
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}
