// Calibration review: process one page, correct its blobs and words, preview,
// confirm, and read how each confirmed page's automatic results compare.
//
// Page-at-a-time like the word cuts — see backend/api/views/calibration.py. The
// page document is large (every blob of every line), which is why a draft save
// returns the whole document: the client never has to reconcile two copies.
import { useQuery } from "@tanstack/react-query";

import type {
  CalibrationComparison,
  CalibrationDocument,
  CalibrationDraft,
  CalibrationEvaluation,
  CalibrationExamples,
  CalibrationPageState,
  CalibrationTypes,
  TypeEvidence,
} from "../calibration/types";
import { apiGet, apiJson } from "./http";
import { isJobRunning, type ProcessJob } from "./types";

export const calibrationKeys = {
  page: (id: string, page: number) => ["mushaf", id, "page", page, "calibration"] as const,
  pages: (id: string) => ["mushaf", id, "calibration-pages"] as const,
  job: (id: string) => ["mushaf", id, "calibration-job"] as const,
  evaluation: (id: string) => ["mushaf", id, "calibration-evaluation"] as const,
  examples: (id: string, page: number, snapshot: string, blob: number) =>
    ["mushaf", id, "page", page, "calibration-examples", snapshot, blob] as const,
};

const pagePath = (id: string, page: number) => `/api/mushafs/${id}/pages/${page}/calibration`;

export function getCalibration(id: string, page: number, signal?: AbortSignal) {
  return apiGet<CalibrationDocument>(pagePath(id, page), signal);
}

/** Save the draft. Never a source of examples — only a confirmation is. */
export function saveCalibration(id: string, page: number, draft: CalibrationDraft) {
  return apiJson<CalibrationDocument>("PUT", pagePath(id, page), draft);
}

/** These edits re-aligned, for accept or discard. Stores nothing. */
export function previewCalibration(id: string, page: number, draft: CalibrationDraft) {
  return apiJson<CalibrationDocument>("POST", `${pagePath(id, page)}/preview`, draft);
}

/** Approve the whole page: its words become the product, its blobs examples. */
export function confirmCalibration(id: string, page: number, draft: CalibrationDraft) {
  return apiJson<CalibrationDocument>("POST", `${pagePath(id, page)}/confirm`, draft);
}

/** A type for every mark nobody has typed, learned from the typed ones — the
 * confirmed pages' and this draft's. Stores nothing, so it can be asked again as
 * often as the reviewer types. */
export function suggestTypes(
  id: string,
  page: number,
  draft: CalibrationDraft,
  signal?: AbortSignal,
) {
  return apiJson<CalibrationTypes>("POST", `${pagePath(id, page)}/types`, draft, signal);
}

/** The typed examples nearest one mark, type by type: why it is expected to be what
 * it is. Asked with the draft, so marks typed here and not yet saved count. */
export function explainType(
  id: string,
  page: number,
  draft: CalibrationDraft,
  mark: { snapshot_id: string; blob_id: number },
  signal?: AbortSignal,
) {
  return apiJson<TypeEvidence>(
    "POST",
    `${pagePath(id, page)}/types/evidence`,
    { ...draft, ...mark },
    signal,
  );
}

/** Process one page for review; the job is polled with `useCalibrationJob`. */
export function processCalibration(id: string, page: number) {
  return apiJson<{ job: ProcessJob }>("POST", `${pagePath(id, page)}/process`);
}

export function cancelCalibration(id: string) {
  return apiJson<ProcessJob>("POST", `/api/mushafs/${id}/calibration/cancel`);
}

export function setCalibrationSettings(id: string, revision: number, experimental: boolean) {
  return apiJson<{ revision: number; experimental: boolean }>(
    "PUT",
    `/api/mushafs/${id}/calibration/settings`,
    { revision, experimental, acknowledge_unvalidated: experimental },
  );
}

export function useCalibration(id: string, page: number, enabled = true) {
  return useQuery({
    queryKey: calibrationKeys.page(id, page),
    queryFn: ({ signal }) => getCalibration(id, page, signal),
    enabled,
  });
}

/** Which pages have a review, processed or confirmed — the page rail's marks. */
export function useCalibrationPages(id: string) {
  return useQuery({
    queryKey: calibrationKeys.pages(id),
    queryFn: ({ signal }) =>
      apiGet<{ pages: CalibrationPageState[] }>(
        `/api/mushafs/${id}/calibration/pages`,
        signal,
      ).then((body) => body.pages),
  });
}

/** The mushaf's calibration processing job, polled while it works. */
export function useCalibrationJob(id: string, intervalMs = 1000) {
  return useQuery<ProcessJob | null>({
    queryKey: calibrationKeys.job(id),
    queryFn: ({ signal }) =>
      apiGet<{ job: ProcessJob | null }>(`/api/mushafs/${id}/calibration/job`, signal).then(
        (body) => body.job,
      ),
    refetchInterval: (query) => (isJobRunning(query.state.data) ? intervalMs : false),
    staleTime: 0,
  });
}

/** One blob's nearest confirmed examples — asked for when the inspector opens it. */
export function useCalibrationExamples(
  id: string,
  page: number,
  snapshot: string | null,
  blob: number | null,
) {
  return useQuery({
    queryKey: calibrationKeys.examples(id, page, snapshot ?? "", blob ?? 0),
    queryFn: ({ signal }) =>
      apiGet<CalibrationExamples>(
        `${pagePath(id, page)}/examples?snapshot=${encodeURIComponent(snapshot ?? "")}&blob=${blob ?? 0}`,
        signal,
      ),
    enabled: snapshot !== null && blob !== null,
    staleTime: 60_000,
  });
}

/** Every confirmed page re-read three ways — expensive, so asked for only while the
 * panel is open, and kept until a confirmation invalidates it. */
export function useCalibrationEvaluation(id: string, enabled: boolean) {
  return useQuery({
    queryKey: calibrationKeys.evaluation(id),
    queryFn: ({ signal }) =>
      apiGet<CalibrationEvaluation>(`/api/mushafs/${id}/calibration/evaluation`, signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useCalibrationComparison(id: string, page: number | null) {
  return useQuery({
    queryKey: [...calibrationKeys.evaluation(id), page],
    queryFn: ({ signal }) =>
      apiGet<CalibrationComparison>(`${pagePath(id, page!)}/evaluation`, signal),
    enabled: page !== null,
    staleTime: 5 * 60_000,
  });
}
