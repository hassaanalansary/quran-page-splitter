// Canonical sura reference data (aya counts are per-qiraa).
import { apiGet } from "./http";
import type { Sura } from "./types";

export const DEFAULT_QIRAA = "hafs";

export function listSuras(qiraa: string = DEFAULT_QIRAA, signal?: AbortSignal): Promise<Sura[]> {
  return apiGet<Sura[]>(`/api/suras?qiraa=${encodeURIComponent(qiraa)}`, signal);
}
