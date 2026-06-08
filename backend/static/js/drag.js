import { state } from "./state.js";
import { setCrop, clampCropBounds } from "./crop.js";
import { updateUIFromCrop, selBox } from "./ui.js";
import { mainCanvas } from "./canvas.js";

const CURSORS = {
  move: "grab",
  top: "ns-resize",
  bottom: "ns-resize",
  left: "ew-resize",
  right: "ew-resize",
  topLeft: "nw-resize",
  topRight: "ne-resize",
  bottomLeft: "sw-resize",
  bottomRight: "se-resize",
};

function getHandleType(mx, my) {
  if (!state.selectionActive || state.cropW <= 0) return null;
  const s = state.scale;
  const l = state.cropX * s,
    r = (state.cropX + state.cropW) * s;
  const t = state.cropY * s,
    b = (state.cropY + state.cropH) * s;
  const T = 12; // hit threshold px
  const nL = Math.abs(mx - l) <= T,
    nR = Math.abs(mx - r) <= T;
  const nT = Math.abs(my - t) <= T,
    nB = Math.abs(my - b) <= T;
  if (nL && nT) return "topLeft";
  if (nR && nT) return "topRight";
  if (nL && nB) return "bottomLeft";
  if (nR && nB) return "bottomRight";
  if (nL) return "left";
  if (nR) return "right";
  if (nT) return "top";
  if (nB) return "bottom";
  if (mx > l && mx < r && my > t && my < b) return "move";
  return null;
}

export function onSelBoxMousemove(e) {
  if (!state.selectionActive || state.dragActive) return;
  const rect = mainCanvas.getBoundingClientRect();
  const handle = getHandleType(e.clientX - rect.left, e.clientY - rect.top);
  selBox.style.cursor = CURSORS[handle] || "grab";
}

export function onSelBoxMouseDown(e) {
  if (!state.selectionActive || state.cropW <= 0) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = mainCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left,
    my = e.clientY - rect.top;
  const handle = getHandleType(mx, my);
  if (!handle) return;

  state.dragActive = true;
  state.dragType = handle;
  state.dragStartMouse = { x: mx, y: my };
  state.dragStartCrop = {
    x: state.cropX,
    y: state.cropY,
    w: state.cropW,
    h: state.cropH,
  };
  document.body.style.userSelect = "none";

  window.addEventListener("mousemove", onGlobalMouseMove);
  window.addEventListener("mouseup", onGlobalMouseUp);
}

function onGlobalMouseMove(e) {
  if (!state.dragActive || !state.img) return;
  const rect = mainCanvas.getBoundingClientRect();
  const mx = Math.min(Math.max(0, e.clientX - rect.left), mainCanvas.width);
  const my = Math.min(Math.max(0, e.clientY - rect.top), mainCanvas.height);
  const dx = (mx - state.dragStartMouse.x) / state.scale;
  const dy = (my - state.dragStartMouse.y) / state.scale;
  const { x: sx, y: sy, w: sw, h: sh } = state.dragStartCrop;
  let nx = sx,
    ny = sy,
    nw = sw,
    nh = sh;

  switch (state.dragType) {
    case "move":
      nx = sx + dx;
      ny = sy + dy;
      break;
    case "right":
      nw = sw + dx;
      break;
    case "left":
      nx = sx + dx;
      nw = sw - dx;
      break;
    case "bottom":
      nh = sh + dy;
      break;
    case "top":
      ny = sy + dy;
      nh = sh - dy;
      break;
    case "topRight":
      ny = sy + dy;
      nh = sh - dy;
      nw = sw + dx;
      break;
    case "topLeft":
      nx = sx + dx;
      nw = sw - dx;
      ny = sy + dy;
      nh = sh - dy;
      break;
    case "bottomRight":
      nw = sw + dx;
      nh = sh + dy;
      break;
    case "bottomLeft":
      nx = sx + dx;
      nw = sw - dx;
      nh = sh + dy;
      break;
  }
  if (nw < 2) nw = 2;
  if (nh < 2) nh = 2;
  setCrop(nx, ny, nw, nh, true);
  clampCropBounds();
  updateUIFromCrop();
}

function onGlobalMouseUp() {
  state.dragActive = false;
  state.dragType = null;
  document.body.style.userSelect = "";
  window.removeEventListener("mousemove", onGlobalMouseMove);
  window.removeEventListener("mouseup", onGlobalMouseUp);
  if (state.selectionActive && state.cropW > 0) updateUIFromCrop();
}
