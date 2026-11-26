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
  LibraryCompare,
  LibraryKeyDetail,
  LibraryKeyFilters,
  LibraryKeyList,
  LibraryShape,
} from "../calibration/types";
import { apiGet, apiJson } from "./http";
import { readDocumentFromServer } from "../calibration/contents";
import { isJobActive, type ProcessJob } from "./types";

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
};

const pagePath = (id: string, page: number) => `/api/mushafs/${id}/pages/${page}/calibration`;

export function getCalibration(id: string, page: number, signal?: AbortSignal) {
  return apiGet<CalibrationDocument>(pagePath(id, page), signal).then(readDocumentFromServer);
}

/** Save the draft. Never a source of examples — only a confirmation is. */
export function saveCalibration(id: string, page: number, draft: CalibrationDraft) {
  return apiJson<CalibrationDocument>("PUT", pagePath(id, page), draft).then(
    readDocumentFromServer,
  );
}

/** These edits re-aligned, for accept or discard. Stores nothing. */
export function previewCalibration(id: string, page: number, draft: CalibrationDraft) {
  return apiJson<CalibrationDocument>("POST", `${pagePath(id, page)}/preview`, draft).then(
    readDocumentFromServer,
  );
}

/** Approve the whole page: its words become the product, its blobs examples. */
export function confirmCalibration(id: string, page: number, draft: CalibrationDraft) {
  return apiJson<CalibrationDocument>("POST", `${pagePath(id, page)}/confirm`, draft).then(
    readDocumentFromServer,
  );
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

type ShapeRef = Pick<LibraryShape, "snapshot_id" | "blob_id">;
const libraryPath = (id: string) => `/api/mushafs/${id}/calibration/library`;

/** Say a kept shape looks right, or take it back: a looks-right shape is never
 * dropped, and a looks-right fingerprint stays one through a Rebuild. */
export function setShapeLooksRight(id: string, shape: ShapeRef, looksRight: boolean) {
  return apiJson<{ version: number }>("PUT", `${libraryPath(id)}/looks-right`, {
    snapshot_id: shape.snapshot_id,
    blob_id: shape.blob_id,
    looks_right: looksRight,
  });
}

/** Take a badly printed example out of the set; a Rebuild never brings it back. */
export function removeLibraryShape(id: string, shape: ShapeRef) {
  return apiJson<{ version: number }>("POST", `${libraryPath(id)}/remove`, {
    snapshot_id: shape.snapshot_id,
    blob_id: shape.blob_id,
  });
}

/** Put a removed example back where it fits. */
export function restoreLibraryShape(id: string, shape: ShapeRef) {
  return apiJson<{ version: number }>("POST", `${libraryPath(id)}/restore`, {
    snapshot_id: shape.snapshot_id,
    blob_id: shape.blob_id,
  });
}

/** Regroup the set from every confirmed page, in the background; the job is polled
 * with `useCalibrationJob`. */
export function rebuildLibrary(id: string) {
  return apiJson<{ job: ProcessJob }>("POST", `${libraryPath(id)}/rebuild`);
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
    refetchInterval: (query) => (isJobActive(query.state.data) ? intervalMs : false),
    staleTime: 0,
  });
}

/** The mushaf's fingerprint set, kind by kind; with `limit`, the one every confirmed
 * page would make at that LIMIT (a preview: nothing saved). Kept until a confirmation,
 * a change in Library mode or a setting moves it on. */
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
    // While a rebuild runs, ask again until the regrouped set lands.
    refetchInterval: (query) => (query.state.data?.rebuilding ? 2_000 : false),
  });
}

/** One page of the set's keys that pass the Library view's filters — asked only once a
 * filter is picked: the body keys run to thousands. */
export function useLibraryKeys(id: string, filters: LibraryKeyFilters | null) {
  return useQuery({
    queryKey: ["mushaf", id, "library-keys", filters] as const,
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ tab: "bodies" });
      if (filters) {
        if (filters.letters !== null) query.set("letters", String(filters.letters));
        if (filters.first) query.set("first", filters.first);
        if (filters.contains) query.set("contains", filters.contains);
        query.set("show", filters.show);
        query.set("sort", filters.sort);
        query.set("page", String(filters.page));
      }
      return apiGet<LibraryKeyList>(`/api/mushafs/${id}/calibration/library/keys?${query}`, signal);
    },
    enabled: filters !== null,
    staleTime: 60_000,
  });
}

/** One key's groups with their pictures, when it is opened. */
export function useLibraryKey(id: string, key: string | null) {
  return useQuery({
    queryKey: ["mushaf", id, "library-key", key] as const,
    queryFn: ({ signal }) =>
      apiGet<LibraryKeyDetail>(
        `/api/mushafs/${id}/calibration/library/key?${new URLSearchParams({ key: key ?? "" })}`,
        signal,
      ),
    enabled: key !== null,
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
