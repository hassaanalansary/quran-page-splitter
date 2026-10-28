// Calibration review: process one page, correct its blobs and words, preview,
// confirm, and read how each confirmed page's automatic results compare.
//
// Page-at-a-time like the word cuts — see backend/api/views/calibration.py. The
// page document is large (every blob of every line), which is why a draft save
// returns the whole document: the client never has to reconcile two copies.
import { useQuery } from "@tanstack/react-query";

import type {
  BatchPlan,
  CalibrationComparison,
  CalibrationDocument,
  CalibrationDraft,
  CalibrationEvaluation,
  CalibrationLibrary,
  CalibrationPageState,
  CalibrationReadiness,
  CalibrationSettings,
  CalibrationTypes,
  LibraryCompare,
  LibraryMembers,
  LibraryShape,
  TextRole,
} from "../calibration/types";
import { apiDelete, apiGet, apiJson } from "./http";
import { isJobRunning, type ProcessJob } from "./types";

export const calibrationKeys = {
  page: (id: string, page: number) => ["mushaf", id, "page", page, "calibration"] as const,
  pages: (id: string) => ["mushaf", id, "calibration-pages"] as const,
  job: (id: string) => ["mushaf", id, "calibration-job"] as const,
  evaluation: (id: string) => ["mushaf", id, "calibration-evaluation"] as const,
  readiness: (id: string) => ["mushaf", id, "calibration-readiness"] as const,
  /** Every library a page is shown — the one in force, and any LIMIT previewed. */
  libraries: (id: string) => ["mushaf", id, "calibration-library"] as const,
  library: (id: string, page: number, limit: number | null) =>
    ["mushaf", id, "calibration-library", page, limit] as const,
  members: (id: string, page: number, group: string, limit: number | null) =>
    ["mushaf", id, "calibration-library", page, limit, "members", group] as const,
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

/** One blob against the library that answers for the page: body or mark, a mark's
 * type, and the blob's distance to every kept shape. Asked with the draft, so marks
 * typed here and not yet saved count. `limit` asks a previewed library. */
export function compareWithLibrary(
  id: string,
  page: number,
  draft: CalibrationDraft,
  blob: { snapshot_id: string; blob_id: number },
  limit: number | null,
  signal?: AbortSignal,
) {
  return apiJson<LibraryCompare>(
    "POST",
    `${pagePath(id, page)}/library/compare`,
    { ...draft, ...blob, limit },
    signal,
  );
}

/** Say an example looks right — as the label it is confirmed as now — or take it back. */
export function setLibraryCheck(
  id: string,
  shape: Pick<LibraryShape, "snapshot_id" | "blob_id">,
  label: { role: TextRole; subtype: string } | null,
) {
  const path = `/api/mushafs/${id}/calibration/library/checks`;
  return label
    ? apiJson<unknown>("PUT", path, {
        snapshot_id: shape.snapshot_id,
        blob_id: shape.blob_id,
        ...label,
      })
    : apiDelete(`${path}?snapshot=${encodeURIComponent(shape.snapshot_id)}&blob=${shape.blob_id}`);
}

/** Process one page for review; the job is polled with `useCalibrationJob`. */
export function processCalibration(id: string, page: number) {
  return apiJson<{ job: ProcessJob }>("POST", `${pagePath(id, page)}/process`);
}

/** Stop the page or the batch being processed; a batch stops between pages. */
export function cancelCalibration(id: string) {
  return apiJson<ProcessJob>("POST", `/api/mushafs/${id}/calibration/cancel`);
}

/** A range of pages for a batch; `refresh` processes untouched drafts again too. */
export type BatchRange = { first: number; last: number; refresh: boolean };

/** What a batch over the range would do, page by page. Starts nothing. */
export function planCalibrationBatch(id: string, range: BatchRange, signal?: AbortSignal) {
  return apiJson<BatchPlan>(
    "POST",
    `/api/mushafs/${id}/calibration/batch`,
    { ...range, dry_run: true },
    signal,
  );
}

/** Process the range as one background job, polled with `useCalibrationJob`. */
export function startCalibrationBatch(id: string, range: BatchRange) {
  return apiJson<{ job: ProcessJob }>("POST", `/api/mushafs/${id}/calibration/batch`, range);
}

/** Save the whole setting: `limit` null is the comparison's default LIMIT. */
export function setCalibrationSettings(id: string, revision: number, limit: number | null) {
  return apiJson<CalibrationSettings>("PUT", `/api/mushafs/${id}/calibration/settings`, {
    revision,
    limit,
  });
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

/** The library that answers for the page, kind by kind; with `limit`, the one it
 * would be at that LIMIT (a preview: nothing saved). Seconds to build, so kept until a
 * confirmation or a setting changes it. */
export function useCalibrationLibrary(
  id: string,
  page: number,
  limit: number | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: calibrationKeys.library(id, page, limit),
    queryFn: ({ signal }) =>
      apiGet<CalibrationLibrary>(
        `${pagePath(id, page)}/library${limit === null ? "" : `?limit=${limit}`}`,
        signal,
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Every member of one group, the farthest first — asked for when a person wants all. */
export function useLibraryMembers(
  id: string,
  page: number,
  group: string | null,
  limit: number | null,
) {
  return useQuery({
    queryKey: calibrationKeys.members(id, page, group ?? "", limit),
    queryFn: ({ signal }) =>
      apiGet<LibraryMembers>(
        `${pagePath(id, page)}/library/members?group=${encodeURIComponent(group ?? "")}${
          limit === null ? "" : `&limit=${limit}`
        }`,
        signal,
      ),
    enabled: group !== null,
    staleTime: 5 * 60_000,
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

/** The readiness meter. Cheap to answer, but it reads every confirmed page, so it is
 * kept until a confirmation or a finished batch invalidates it. */
export function useCalibrationReadiness(id: string) {
  return useQuery({
    queryKey: calibrationKeys.readiness(id),
    queryFn: ({ signal }) =>
      apiGet<CalibrationReadiness>(`/api/mushafs/${id}/calibration/readiness`, signal),
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
