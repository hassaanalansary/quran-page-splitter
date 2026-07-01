// Qiraat reference data (recitation schools) for the mushaf qiraa picker.
import { apiGet } from "./http";
import type { Qiraa } from "./types";

export function listQiraat(signal?: AbortSignal): Promise<Qiraa[]> {
  return apiGet<Qiraa[]>("/api/qiraat", signal);
}
