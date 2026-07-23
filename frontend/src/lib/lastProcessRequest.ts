/** The last processing request the user sent, mirrored into localStorage.
 *
 * Exactly one snapshot is kept — every new run overwrites the previous one — so
 * the Process step can refill itself when the user comes back to the same
 * mushaf, and other tooling can read what was last run. A snapshot belonging to
 * a different mushaf is ignored rather than applied. */
import type { ProcessRequest } from "@/lib/api/types";

const KEY = "qps.lastProcessRequest";

export type LastRunOutcome = {
  status: "completed" | "aborted" | "error";
  /** Logical pages actually written before the run settled. */
  pages_saved: number;
  /** Logical page detection stopped on (aborted runs only). */
  abort_page?: number;
  message?: string;
  ended_at: string;
};

export type LastProcessRequest = {
  mushaf_id: string;
  mushaf_name?: string;
  /** ISO timestamp of when the request was sent. */
  sent_at: string;
  /** The whole payload the Process step submits, with the range as the user
   * chose it (the engine is fed in chunks, but this is the requested range). */
  request: ProcessRequest;
  outcome?: LastRunOutcome;
};

function isRect(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return ["x", "y", "w", "h"].every((k) => typeof r[k] === "number");
}

/** The stored snapshot, or null when absent, unreadable or malformed. */
export function readLastProcessRequest(): LastProcessRequest | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as LastProcessRequest;
    if (typeof entry.mushaf_id !== "string" || !entry.mushaf_id) return null;
    if (typeof entry.request !== "object" || entry.request === null) return null;
    if (!isRect(entry.request.bounds)) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Same as {@link readLastProcessRequest}, but only when it belongs to `mushafId`. */
export function readLastProcessRequestFor(mushafId: string): LastProcessRequest | null {
  const entry = readLastProcessRequest();
  return entry && entry.mushaf_id === mushafId ? entry : null;
}

export function writeLastProcessRequest(entry: LastProcessRequest): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entry));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** Attach the result to the stored snapshot, if it is still the one we wrote. */
export function writeLastProcessOutcome(mushafId: string, outcome: LastRunOutcome): void {
  const entry = readLastProcessRequestFor(mushafId);
  if (!entry) return;
  writeLastProcessRequest({ ...entry, outcome });
}
