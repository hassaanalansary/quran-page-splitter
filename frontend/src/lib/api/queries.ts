// React Query hooks + shared query keys for the API.
import { useQuery } from "@tanstack/react-query";

import { getMushaf, getStats, listActivity, listMushafs, listTemplates } from "./mushafs";
import { getPage, listPages } from "./pages";
import { listRuns } from "./processing";
import { listQiraat } from "./qiraat";
import { DEFAULT_QIRAA, listSuras } from "./suras";

export const queryKeys = {
  mushafs: ["mushafs"] as const,
  mushaf: (id: string) => ["mushaf", id] as const,
  templates: (id: string) => ["mushaf", id, "templates"] as const,
  processedPages: (id: string) => ["mushaf", id, "processed-pages"] as const,
  runs: (id: string) => ["mushaf", id, "runs"] as const,
  stats: (id: string) => ["mushaf", id, "stats"] as const,
  activity: (id: string) => ["mushaf", id, "activity"] as const,
  qiraat: ["qiraat"] as const,
  suras: (qiraa: string) => ["suras", qiraa] as const,
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

export function useStats(id: string) {
  return useQuery({ queryKey: queryKeys.stats(id), queryFn: ({ signal }) => getStats(id, signal) });
}

export function useActivity(id: string) {
  return useQuery({
    queryKey: queryKeys.activity(id),
    queryFn: ({ signal }) => listActivity(id, 50, signal),
  });
}

/** All qiraat (recitation schools) for the mushaf picker; effectively static. */
export function useQiraat() {
  return useQuery({
    queryKey: queryKeys.qiraat,
    queryFn: ({ signal }) => listQiraat(signal),
    staleTime: Infinity,
  });
}

export function useSuras(qiraa: string | null | undefined) {
  const resolved = qiraa || DEFAULT_QIRAA;
  return useQuery({
    queryKey: queryKeys.suras(resolved),
    queryFn: ({ signal }) => listSuras(resolved, signal),
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
