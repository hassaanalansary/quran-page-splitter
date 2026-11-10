/** The window event the spine's "How this step works" sends to open the step's guide
 * (CanvasHelp listens for it). */
export const OPEN_GUIDE_EVENT = "satr:open-guide";

/** Ask the step on screen to open its guide. */
export function openGuide() {
  window.dispatchEvent(new Event(OPEN_GUIDE_EVENT));
}
