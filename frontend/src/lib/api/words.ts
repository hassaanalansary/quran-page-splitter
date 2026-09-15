// Word boundaries: run the engine over a span of ayat, read what it found, fix it.
//
// The run is a background job on the same table detection uses, so start/poll/cancel
// mirror ./processing exactly — see backend/api/views/words.py. What differs is the
// address: a run is `(sura, aya)` to `(sura, aya)`, never a page range, because the
// engine walks one cursor through the word stream and an aya is the only point it can
// start from. Reading and fixing are page-at-a-time, like review and finalize.
import { apiGet, apiJson } from "./http";
import type {
  DetectWordsRequest,
  DetectWordsResult,
  PageWords,
  PageWordsSave,
  ProcessJob,
  RunLogTail,
  WordCoverage,
} from "./types";

/** Start a run over a span of ayat. 409 if this mushaf already has one in flight
 * — of either kind, since a detection run would delete the lines this one writes. */
export function startWordDetection(
  id: string,
  req: DetectWordsRequest,
  signal?: AbortSignal,
): Promise<DetectWordsResult> {
  return apiJson<DetectWordsResult>("POST", `/api/mushafs/${id}/words`, req, signal);
}

/** The mushaf's current or most recent WORD run; null when it has never run.
 * Filtered server-side by kind, so a detection run in flight never shows up here. */
export function getWordsJob(id: string, signal?: AbortSignal): Promise<ProcessJob | null> {
  return apiGet<{ job: ProcessJob | null }>(`/api/mushafs/${id}/words/job`, signal).then(
    (body) => body.job,
  );
}

/** Ask the running word job to stop (404 if none is). It stops at the next chunk
 * boundary, never inside one — everything already written stays written. */
export function cancelWordDetection(id: string, signal?: AbortSignal): Promise<ProcessJob> {
  return apiJson<ProcessJob>("POST", `/api/mushafs/${id}/words/cancel`, undefined, signal);
}

/** Which pages hold words, and how many of their lines still want a look. */
export function getWordsCoverage(id: string, signal?: AbortSignal): Promise<WordCoverage> {
  return apiGet<WordCoverage>(`/api/mushafs/${id}/words/coverage`, signal);
}

/** One page's lines, their cuts in reading order, and the engine's verdict. */
export function getPageWords(
  id: string,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<PageWords> {
  return apiGet<PageWords>(`/api/mushafs/${id}/pages/${pageNumber}/words`, signal);
}

/** Replace the words of the named lines — the manual fix, one transaction.
 *
 * Coherence breaks come back in `issues[]` rather than being refused: correcting
 * line 10 before line 11 goes through a broken state on purpose. */
export function savePageWords(
  id: string,
  pageNumber: number,
  data: PageWordsSave,
): Promise<PageWords> {
  return apiJson<PageWords>("PUT", `/api/mushafs/${id}/pages/${pageNumber}/words`, data);
}

// ── the run's log ────────────────────────────────────────────────────────────
//
// Addressed by JOB, where detection's is addressed by run: a word run creates no
// `ProcessingRun` row — it writes cuts onto lines that already exist — so the job is
// the only thing that lives exactly as long as the run. The tail contract is
// byte-for-byte detection's, which is what lets one viewer read either.

/** One poll of the live viewer: whole lines only, resumed by byte offset. */
export function getWordsLogTail(
  id: string,
  jobId: string,
  offset = 0,
  signal?: AbortSignal,
): Promise<RunLogTail> {
  return apiGet<RunLogTail>(
    `/api/mushafs/${id}/words/jobs/${jobId}/log/tail?offset=${Math.max(0, Math.trunc(offset))}`,
    signal,
  );
}

/** Whole-file URL for the download link (and the browser's own viewer). */
export function wordsLogUrl(id: string, jobId: string): string {
  return `/api/mushafs/${id}/words/jobs/${jobId}/log`;
}

/** The log's machine-readable twin: every line, its verdict, every word placed.
 * Written when the run settles, so this 404s while one is still going. */
export function wordsReportUrl(id: string, jobId: string): string {
  return `/api/mushafs/${id}/words/jobs/${jobId}/report`;
}
