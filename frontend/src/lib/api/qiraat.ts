// Qiraat reference data (recitation schools) for the mushaf qiraa picker.
import { apiGet } from "./http";
import type { Qiraa } from "./types";

export function listQiraat(lang: string = "en", signal?: AbortSignal): Promise<Qiraa[]> {
  return apiGet<Qiraa[]>(`/api/qiraat?lang=${encodeURIComponent(lang)}`, signal);
}
