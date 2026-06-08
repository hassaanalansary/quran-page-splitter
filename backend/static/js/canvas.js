import { state } from "./state.js";

export const mainCanvas = document.getElementById("main-canvas");
export const ctx = mainCanvas.getContext("2d");

// ---- coordinate conversion ----
export function canvasToOrig(cx, cy) {
  return { x: Math.round(cx / state.scale), y: Math.round(cy / state.scale) };
}
export function origToCanvas(ox, oy) {
  return { x: ox * state.scale, y: oy * state.scale };
}
export function origSizeToCanvas(w, h) {
  return { w: w * state.scale, h: h * state.scale };
}

/** Draw imgEl onto mainCanvas, computing and storing scale in state. */
export function drawToCanvas(imgEl) {
  const maxW = Math.min(window.innerWidth - 80, 900);
  const maxH = window.innerHeight * 0.6;
  state.scale = Math.min(1, maxW / imgEl.width, maxH / imgEl.height);
  mainCanvas.width = Math.round(imgEl.width * state.scale);
  mainCanvas.height = Math.round(imgEl.height * state.scale);
  ctx.drawImage(imgEl, 0, 0, mainCanvas.width, mainCanvas.height);
}
