// React Query hooks + shared query keys for the API.
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { baseLanguage } from "@/i18n/config";

import { getMushaf, getStats, listActivity, listMushafs, listTemplates } from "./mushafs";
import { getPage, listPages } from "./pages";
import { getProcessJob, listRuns } from "./processing";
import { listQiraat } from "./qiraat";
import { DEFAULT_QIRAA, listSuras } from "./suras";
import { isJobRunning, type ProcessJob } from "./types";

export const queryKeys = {
  mushafs: ["mushafs"] as const,
  mushaf: (id: string) => ["mushaf", id] as const,
  templates: (id: string) => ["mushaf", id, "templates"] as const,
  processedPages: (id: string) => ["mushaf", id, "processed-pages"] as const,
  runs: (id: string) => ["mushaf", id, "runs"] as const,
  processJob: (id: string) => ["mushaf", id, "process-job"] as const,
  stats: (id: string) => ["mushaf", id, "stats"] as const,
  activity: (id: string) => ["mushaf", id, "activity"] as const,
  qiraat: (lang: string) => ["qiraat", lang] as const,
  suras: (qiraa: string, lang: string) => ["suras", qiraa, lang] as const,
  page: (mushafId: string, pageNumber: number) => ["mushaf", mushafId, "page", pageNumber] as const,
};

export function useMushafs() {
  return useQuery({ queryKey: queryKeys.mushafs, queryFn: ({ signal }) => listMushafs(signal) });
}

export function useMushaf(id: string) {
  return useQuery({
    queryKey: queryKeys.mushaf(id),
    queryFn: ({ signal }) => getMushaf(id, signal),
  });
}

export function useTemplates(id: string) {
  return useQuery({
    queryKey: queryKeys.templates(id),
    queryFn: ({ signal }) => listTemplates(id, signal),
  });
}

/** Processed/reviewed logical page numbers, as sets, for the page-rail indicator. */
export function useProcessedPages(id: string) {
  return useQuery({
    queryKey: queryKeys.processedPages(id),
    queryFn: ({ signal }) => listPages(id, signal),
    select: (rows) => ({
      processed: new Set(rows.map((r) => r.page_number)),
      reviewed: new Set(rows.filter((r) => r.reviewed).map((r) => r.page_number)),
    }),
  });
}

/** Full per-page summaries (details page); shares the cache entry of useProcessedPages. */
export function usePageSummaries(id: string) {
  return useQuery({
    queryKey: queryKeys.processedPages(id),
    queryFn: ({ signal }) => listPages(id, signal),
  });
}

export function useRuns(id: string) {
  return useQuery({ queryKey: queryKeys.runs(id), queryFn: ({ signal }) => listRuns(id, signal) });
}

/** The mushaf's processing run, polled while it is working.
 *
 * Fetching on mount is what makes a run survive a page reload or a second tab:
 * the server, not this component, holds the state. Polling stops the moment the
 * job settles, so an idle Process page makes exactly one request. */
export function useProcessJob(id: string, intervalMs = 1000) {
  // The type argument is required, not decoration: `refetchInterval` reads
  // `query.state.data`, which makes inferring the data type from `queryFn`
  // circular — without it TanStack resolves `data` to `never`.
  return useQuery<ProcessJob | null>({
    queryKey: queryKeys.processJob(id),
    queryFn: ({ signal }) => getProcessJob(id, signal),
    refetchInterval: (query) => (isJobRunning(query.state.data) ? intervalMs : false),
    // A poll is the point — never serve it from cache.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function useStats(id: string) {
  return useQuery({ queryKey: queryKeys.stats(id), queryFn: ({ signal }) => getStats(id, signal) });
}

export function useActivity(id: string) {
  return useQuery({
    queryKey: queryKeys.activity(id),
    queryFn: ({ signal }) => listActivity(id, 50, signal),
  });
}

/** All qiraat (recitation schools) for the mushaf picker; names localized per language. */
export function useQiraat() {
  const { i18n } = useTranslation();
  const lang = baseLanguage(i18n.language);
  return useQuery({
    queryKey: queryKeys.qiraat(lang),
    queryFn: ({ signal }) => listQiraat(lang, signal),
    staleTime: Infinity,
  });
}

export function useSuras(qiraa: string | null | undefined) {
  const { i18n } = useTranslation();
  const lang = baseLanguage(i18n.language);
  const resolved = qiraa || DEFAULT_QIRAA;
  return useQuery({
    queryKey: queryKeys.suras(resolved, lang),
    queryFn: ({ signal }) => listSuras(resolved, lang, signal),
    staleTime: Infinity,
  });
}

export function usePage(mushafId: string, pageNumber: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.page(mushafId, pageNumber),
    queryFn: ({ signal }) => getPage(mushafId, pageNumber, signal),
    enabled,
  });
}
