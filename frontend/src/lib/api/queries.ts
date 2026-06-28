// React Query hooks + shared query keys for the API.
import { useQuery } from "@tanstack/react-query";

import { getMushaf, listMushafs } from "./mushafs";
import { getPage } from "./pages";
import { DEFAULT_QIRAA, listSuras } from "./suras";

export const queryKeys = {
  mushafs: ["mushafs"] as const,
  mushaf: (id: string) => ["mushaf", id] as const,
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
