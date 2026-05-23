import { pageImageUrl } from "./api.js";
import {
  cloneData,
  currentPage,
  notify,
  pushHistory,
  selectLine,
  selectSegment,
  selectSeparator,
  state,
} from "./state.js";
import { recalculateNumbering, regenerateSegments } from "./numbering.js";

let canvas;
let ctx;
let resizeObserver;
let drag = null;

const colors = {
  text: "rgba(75, 144, 226, 0.26)",
  sura_header: "rgba(232, 213, 163, 0.3)",
  basmala: "rgba(86, 180, 111, 0.25)",
  selected: "rgba(232, 213, 163, 0.8)",
  segment: "rgba(108, 190, 255, 0.32)",
};

export function initCanvas(canvasElement) {
  canvas = canvasElement;
  ctx = canvas.getContext("2d");
  resizeObserver = new ResizeObserver(resizeCanvas);
  resizeObserver.observe(canvas);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("dblclick", onDoubleClick);
  resizeCanvas();
}

export async function loadCurrentPageImage() {
  const page = currentPage();
  if (!page?.page_image_filename) {
    state.image = null;
    renderCanvas();
    return;
  }

  const image = new Image();
  image.onload = () => {
    state.image = image;
    fitToCanvas();
    renderCanvas();
  };
  image.onerror = () => {
    state.image = null;
    renderCanvas();
  };
  image.src = pageImageUrl(page.page_image_filename);
}

export function fitToCanvas() {
  if (!canvas || !state.image) return;
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  const scale = Math.min(width / state.image.width, height / state.image.height);
  state.zoom = Math.max(0.05, scale * 0.96);
  state.panX = (width - state.image.width * state.zoom) / 2;
  state.panY = (height - state.image.height * state.zoom) / 2;
  renderCanvas();
}

export function renderCanvas() {
  if (!canvas || !ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dpr = window.devicePixelRatio || 1;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#080808";
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  if (!state.image) {
    drawEmpty("No review page loaded");
    return;
  }

  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);
  ctx.drawImage(state.image, 0, 0);
  drawOverlays();
  ctx.restore();
}

export function pagePointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - state.panX) / state.zoom,
    y: (event.clientY - rect.top - state.panY) / state.zoom,
  };
}

function resizeCanvas() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    renderCanvas();
  }
}

function drawEmpty(text) {
  ctx.fillStyle = "#6b6860";
  ctx.font = "13px IBM Plex Mono, monospace";
  ctx.fillText(text, 24, 32);
}

function drawOverlays() {
  const page = currentPage();
  if (!page) return;
  if (page.crop_box) {
    drawRect(page.crop_box, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)", [12, 8]);
  }

  (page.lines || []).forEach((line, lineIndex) => {
    const selected = state.selectedLineIndex === lineIndex;
    drawRect(
      line.line_bbox,
      selected ? colors.selected : borderForLine(line),
      fillForLine(line),
      selected ? [] : [8, 5],
      selected ? 4 : 2,
    );

    drawLabel(
      line.line_bbox.x + 8,
      line.line_bbox.y + 20,
      `L${line.line_number || lineIndex + 1} ${labelForLine(line)}`,
    );

    if (line.type !== "text") return;
    (line.segments || []).forEach((segment, segmentIndex) => {
      if (state.selectedLineIndex === lineIndex && state.selectedSegmentIndex === segmentIndex) {
        drawRect(segment.bbox, "#6cc0ff", colors.segment, [], 3);
      }
      drawSegmentLabel(segment);
    });

    (line.separator_cuts || []).forEach((cut, separatorIndex) => {
      const active =
        state.selectedLineIndex === lineIndex &&
        state.selectedSeparatorIndex === separatorIndex;
      drawSeparator(line, cut, active);
    });
  });
}

function drawRect(box, stroke, fill, dash = [], width = 2) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.lineWidth = width / state.zoom;
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.restore();
}

function drawSeparator(line, cut, active) {
  ctx.save();
  ctx.setLineDash(active ? [] : [10 / state.zoom, 7 / state.zoom]);
  ctx.lineWidth = (active ? 4 : 2) / state.zoom;
  ctx.strokeStyle = active ? "#e8d5a3" : "#ff8d6a";
  ctx.beginPath();
  ctx.moveTo(cut, line.line_bbox.y);
  ctx.lineTo(cut, line.line_bbox.y + line.line_bbox.h);
  ctx.stroke();
  ctx.restore();
}

function drawLabel(x, y, text) {
  ctx.save();
  ctx.font = `${12 / state.zoom}px IBM Plex Mono, monospace`;
  const metrics = ctx.measureText(text);
  const pad = 5 / state.zoom;
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(x, y - 14 / state.zoom, metrics.width + pad * 2, 18 / state.zoom);
  ctx.fillStyle = "#f3e8c7";
  ctx.fillText(text, x + pad, y);
  ctx.restore();
}

function drawSegmentLabel(segment) {
  if (!segment?.bbox) return;
  const text = `S${segment.sura_number || "?"}:A${segment.aya_number || "?"}`;
  drawLabel(segment.bbox.x + 6, segment.bbox.y + segment.bbox.h - 8, text);
}

function fillForLine(line) {
  return colors[line.type] || colors.text;
}

function borderForLine(line) {
  if (line.type === "sura_header") return "#e8d5a3";
  if (line.type === "basmala") return "#58b370";
  return "#5a8edb";
}

function labelForLine(line) {
  if (line.type === "sura_header") return `sura ${line.sura_number || "?"}`;
  if (line.type === "basmala") return `basmala ${line.sura_number || "?"}`;
  return `${line.segments?.length || 0} seg`;
}

function onWheel(event) {
  event.preventDefault();
  if (!state.image) return;
  const rect = canvas.getBoundingClientRect();
  const before = pagePointFromEvent(event);
  const factor = event.deltaY < 0 ? 1.1 : 0.9;
  state.zoom = Math.max(0.04, Math.min(8, state.zoom * factor));
  state.panX = event.clientX - rect.left - before.x * state.zoom;
  state.panY = event.clientY - rect.top - before.y * state.zoom;
  renderCanvas();
}

function onPointerDown(event) {
  if (!state.image) return;
  const point = pagePointFromEvent(event);
  const hit = hitTest(point);
  canvas.setPointerCapture(event.pointerId);

  if (state.addSeparatorMode) {
    const line = selectedTextLineAt(point);
    if (line) {
      pushHistory();
      line.separator_cuts = [...(line.separator_cuts || []), Math.round(point.x)];
      regenerateSegments(line);
      recalculateNumbering(state.results, state.suras);
      state.addSeparatorMode = false;
      notify();
    }
    return;
  }

  if (hit?.kind === "separator") {
    selectSeparator(hit.lineIndex, hit.separatorIndex);
    drag = {
      kind: "separator",
      lineIndex: hit.lineIndex,
      separatorIndex: hit.separatorIndex,
      before: cloneData(state.results),
      changed: false,
    };
    return;
  }

  if (hit?.kind === "edge") {
    selectLine(hit.lineIndex);
    drag = {
      kind: hit.edge,
      lineIndex: hit.lineIndex,
      before: cloneData(state.results),
      changed: false,
    };
    return;
  }

  if (hit?.kind === "segment") {
    selectSegment(hit.lineIndex, hit.segmentIndex);
    return;
  }

  if (hit?.kind === "line") {
    selectLine(hit.lineIndex);
    return;
  }

  drag = {
    kind: "pan",
    startX: event.clientX,
    startY: event.clientY,
    panX: state.panX,
    panY: state.panY,
  };
}

function onPointerMove(event) {
  if (!drag) return;
  const point = pagePointFromEvent(event);
  if (drag.kind === "pan") {
    state.panX = drag.panX + event.clientX - drag.startX;
    state.panY = drag.panY + event.clientY - drag.startY;
    renderCanvas();
    return;
  }

  const page = currentPage();
  const line = page?.lines?.[drag.lineIndex];
  if (!line?.line_bbox) return;

  if (drag.kind === "separator") {
    const left = line.line_bbox.x + 2;
    const right = line.line_bbox.x + line.line_bbox.w - 2;
    line.separator_cuts[drag.separatorIndex] = Math.round(
      Math.max(left, Math.min(right, point.x)),
    );
    regenerateSegments(line);
    recalculateNumbering(state.results, state.suras);
    drag.changed = true;
    notify();
    return;
  }

  if (drag.kind === "top") {
    const bottom = line.line_bbox.y + line.line_bbox.h;
    const y = Math.round(Math.max(0, Math.min(bottom - 2, point.y)));
    line.line_bbox.y = y;
    line.line_bbox.h = bottom - y;
    if (line.type === "text") regenerateSegments(line);
    drag.changed = true;
    notify();
    return;
  }

  if (drag.kind === "bottom") {
    const y = Math.round(Math.max(line.line_bbox.y + 2, point.y));
    line.line_bbox.h = y - line.line_bbox.y;
    if (line.type === "text") regenerateSegments(line);
    drag.changed = true;
    notify();
  }
}

function onPointerUp() {
  if (drag?.before && drag.changed) {
    state.history.push(drag.before);
    state.future = [];
    state.hasEdits = true;
  }
  drag = null;
  notify();
}

function onDoubleClick(event) {
  const point = pagePointFromEvent(event);
  const line = selectedTextLineAt(point);
  if (!line) return;
  pushHistory();
  line.separator_cuts = [...(line.separator_cuts || []), Math.round(point.x)];
  regenerateSegments(line);
  recalculateNumbering(state.results, state.suras);
  notify();
}

function hitTest(point) {
  const page = currentPage();
  const lines = page?.lines || [];
  const tolerance = 8 / state.zoom;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!containsPoint(line.line_bbox, point)) continue;

    if (state.selectedLineIndex === lineIndex) {
      if (Math.abs(point.y - line.line_bbox.y) <= tolerance) {
        return { kind: "edge", edge: "top", lineIndex };
      }
      if (Math.abs(point.y - (line.line_bbox.y + line.line_bbox.h)) <= tolerance) {
        return { kind: "edge", edge: "bottom", lineIndex };
      }
      const separatorIndex = nearestSeparator(line, point.x, tolerance);
      if (separatorIndex != null) {
        return { kind: "separator", lineIndex, separatorIndex };
      }
    }

    if (line.type === "text") {
      const segmentIndex = (line.segments || []).findIndex((segment) =>
        containsPoint(segment.bbox, point),
      );
      if (segmentIndex >= 0) return { kind: "segment", lineIndex, segmentIndex };
    }
    return { kind: "line", lineIndex };
  }
  return null;
}

function nearestSeparator(line, x, tolerance) {
  const index = (line.separator_cuts || []).findIndex(
    (cut) => Math.abs(cut - x) <= tolerance,
  );
  return index >= 0 ? index : null;
}

function selectedTextLineAt(point) {
  const page = currentPage();
  const line = page?.lines?.[state.selectedLineIndex];
  if (!line || line.type !== "text" || !containsPoint(line.line_bbox, point)) {
    return null;
  }
  return line;
}

function containsPoint(box, point) {
  if (!box) return false;
  return (
    point.x >= box.x &&
    point.x <= box.x + box.w &&
    point.y >= box.y &&
    point.y <= box.y + box.h
  );
}
