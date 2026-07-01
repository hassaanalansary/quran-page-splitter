// In-memory, per-mushaf draft of unsaved template captures, so leaving and
// returning to the Templates step within the app keeps work in progress. (A full
// page reload clears it; saved templates are then re-fetched from the backend.)
import type { Rect, TemplateType } from "@/lib/api/types";

export type Capture = { blob: Blob; url: string; rect: Rect };

export type TemplateDraft = {
  captures: Partial<Record<TemplateType, Capture>>;
  ignores: Partial<Record<TemplateType, Rect>>;
  savedAt: Partial<Record<TemplateType, boolean>>;
};

const store = new Map<string, TemplateDraft>();

export function getTemplateDraft(mushafId: string): TemplateDraft {
  return store.get(mushafId) ?? { captures: {}, ignores: {}, savedAt: {} };
}

export function setTemplateDraft(mushafId: string, draft: TemplateDraft): void {
  store.set(mushafId, draft);
}
