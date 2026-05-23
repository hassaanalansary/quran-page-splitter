import {
  loadResults,
  loadStatus,
  loadSuras,
  reExportImages,
  saveResults,
} from "./api.js";
import {
  currentLine,
  currentPage,
  currentSegment,
  cloneData,
  notify,
  pushHistory,
  redo,
  replaceResults,
  selectLine,
  selectPage,
  selectSegment,
  selectSeparator,
  state,
  subscribe,
  undo,
} from "./state.js";
import {
  fitToCanvas,
  initCanvas,
  loadCurrentPageImage,
  renderCanvas,
} from "./canvas.js";
import { recalculateNumbering, regenerateSegments } from "./numbering.js";
import { buildWarnings, readMetadataFile } from "./validation.js";

const els = {};
let loadedPageImage = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  initCanvas(els.canvas);
  wireEvents();
  subscribe(render);

  try {
    state.status = await loadStatus();
    state.suras = await loadSuras();
    state.ayaCounts = new Map(
      state.suras.map((sura) => [Number(sura.number), Number(sura.aya_count)]),
    );
    if (!state.status.review_available) {
      renderUnavailable();
      return;
    }
    replaceResults(await loadResults("latest"));
  } catch (error) {
    renderError(error.message);
  }
}

function bindElements() {
  [
    "review-status",
    "page-title",
    "canvas-hint",
    "review-canvas",
    "fit-btn",
    "undo-btn",
    "redo-btn",
    "prev-page-btn",
    "next-page-btn",
    "page-strip",
    "line-list",
    "selection-panel",
    "validation-toggle",
    "metadata-file",
    "validation-panel",
    "reexport-images",
    "save-review-btn",
    "reload-original-btn",
  ].forEach((id) => {
    els[toCamel(id)] = document.getElementById(id);
  });
  els.canvas = els.reviewCanvas;
}

function wireEvents() {
  els.fitBtn.addEventListener("click", fitToCanvas);
  els.undoBtn.addEventListener("click", undo);
  els.redoBtn.addEventListener("click", redo);
  els.prevPageBtn.addEventListener("click", () => selectPage(state.currentPageIndex - 1));
  els.nextPageBtn.addEventListener("click", () => selectPage(state.currentPageIndex + 1));
  els.validationToggle.addEventListener("change", () => {
    state.validationEnabled = els.validationToggle.checked;
    notify();
  });
  els.metadataFile.addEventListener("change", async () => {
    const file = els.metadataFile.files?.[0];
    state.customAyaCounts = file ? await readMetadataFile(file) : null;
    notify();
  });
  els.saveReviewBtn.addEventListener("click", saveReview);
  els.reloadOriginalBtn.addEventListener("click", reloadOriginal);
}

function render() {
  if (!state.results) return;
  if (state.hasEdits) {
    recalculateNumbering(state.results, state.suras);
  }
  const page = currentPage();
  const pageImage = page?.page_image_filename || null;
  if (pageImage !== loadedPageImage) {
    loadedPageImage = pageImage;
    loadCurrentPageImage();
  }
  renderHeader();
  renderPages();
  renderLines();
  renderSelection();
  renderValidation();
  renderCanvas();
}

function renderHeader() {
  const page = currentPage();
  const total = state.results?.pages?.length || 0;
  els.reviewStatus.textContent = page
    ? `page ${state.currentPageIndex + 1} / ${total} · ${page.image_filename}`
    : "no page selected";
  els.pageTitle.textContent = page
    ? `// Page ${page.page_number} · ${page.image_filename}`
    : "// Page";
  els.canvasHint.textContent = state.addSeparatorMode
    ? "Click inside the selected text line to add a separator."
    : "Double-click a selected text line to add a separator. Drag selected line edges or separator cuts.";
  els.undoBtn.disabled = state.history.length === 0;
  els.redoBtn.disabled = state.future.length === 0;
}

function renderPages() {
  els.pageStrip.innerHTML = "";
  (state.results.pages || []).forEach((page, index) => {
    const button = document.createElement("button");
    button.className = `page-btn${index === state.currentPageIndex ? " active" : ""}`;
    button.textContent = String(page.page_number || index + 1).padStart(3, "0");
    button.addEventListener("click", () => selectPage(index));
    els.pageStrip.appendChild(button);
  });
}

function renderLines() {
  const page = currentPage();
  els.lineList.innerHTML = "";
  (page?.lines || []).forEach((line, index) => {
    const button = document.createElement("button");
    button.className = `line-btn${index === state.selectedLineIndex ? " active" : ""}`;
    button.innerHTML = `
      <span class="type-dot ${line.type}"></span>
      <span>L${line.line_number || index + 1} · ${line.type}</span>
      <span class="line-meta">${lineSummary(line)}</span>
    `;
    button.addEventListener("click", () => selectLine(index));
    els.lineList.appendChild(button);
  });
}

function renderSelection() {
  const line = currentLine();
  if (!line) {
    els.selectionPanel.innerHTML = `<p class="empty-state">No line selected.</p>`;
    return;
  }

  els.selectionPanel.innerHTML = `
    <div class="field-grid">
      ${numberField("line-x", "X", line.line_bbox.x)}
      ${numberField("line-y", "Y", line.line_bbox.y)}
      ${numberField("line-w", "Width", line.line_bbox.w)}
      ${numberField("line-h", "Height", line.line_bbox.h)}
    </div>
    <div class="field">
      <label>Type</label>
      <input value="${line.type}" disabled />
    </div>
    <div id="line-specific"></div>
  `;
  ["x", "y", "w", "h"].forEach((key) => {
    document
      .getElementById(`line-${key}`)
      .addEventListener("change", (event) => updateLineBox(key, event.target.value));
  });
  renderLineSpecific(line);
}

function renderLineSpecific(line) {
  const container = document.getElementById("line-specific");
  if (line.type === "sura_header") {
    container.innerHTML = `
      <div class="field">
        <label>Sura anchor</label>
        <select id="sura-anchor">${suraOptions(line.manual_sura_anchor || line.sura_number)}</select>
      </div>
    `;
    document.getElementById("sura-anchor").addEventListener("change", (event) => {
      editWithHistory(() => {
        line.manual_sura_anchor = Number(event.target.value);
      });
    });
    return;
  }

  if (line.type === "basmala") {
    container.innerHTML = `
      <p class="empty-state">Basmala for Sura ${line.sura_number || "?"}.</p>
    `;
    return;
  }

  const segment = currentSegment();
  container.innerHTML = `
    <div class="review-actions">
      <button id="add-separator-btn">Add separator</button>
      <button id="remove-separator-btn" ${state.selectedSeparatorIndex == null ? "disabled" : ""}>Remove selected separator</button>
    </div>
    <div class="field">
      <label>Selected aya anchor</label>
      <input id="aya-anchor" type="number" min="1" value="${segment?.manual_aya_anchor || segment?.aya_number || ""}" ${segment ? "" : "disabled"} />
    </div>
    <div id="segment-list"></div>
  `;
  document.getElementById("add-separator-btn").addEventListener("click", () => {
    state.addSeparatorMode = true;
    notify();
  });
  document.getElementById("remove-separator-btn").addEventListener("click", () => {
    if (state.selectedSeparatorIndex == null) return;
    editWithHistory(() => {
      line.separator_cuts.splice(state.selectedSeparatorIndex, 1);
      state.selectedSeparatorIndex = null;
      regenerateSegments(line);
    });
  });
  document.getElementById("aya-anchor").addEventListener("change", (event) => {
    if (!segment) return;
    editWithHistory(() => {
      const value = Number(event.target.value);
      if (Number.isInteger(value) && value > 0) {
        segment.manual_aya_anchor = value;
      } else {
        delete segment.manual_aya_anchor;
      }
    });
  });
  renderSegments(line);
}

function renderSegments(line) {
  const container = document.getElementById("segment-list");
  container.innerHTML = "";
  (line.segments || []).forEach((segment, index) => {
    const row = document.createElement("div");
    row.className = `segment-row${index === state.selectedSegmentIndex ? " active" : ""}`;
    row.innerHTML = `
      <div>
        <div class="segment-title">Segment ${index + 1} · S${segment.sura_number || "?"}:A${segment.aya_number || "?"}</div>
        <div class="segment-subtitle">${segment.has_separator ? "ends aya" : "continuation"} · x ${segment.bbox.x}, w ${segment.bbox.w}</div>
      </div>
      <button>Select</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      selectSegment(state.selectedLineIndex, index);
    });
    container.appendChild(row);
  });

  (line.separator_cuts || []).forEach((cut, index) => {
    const row = document.createElement("div");
    row.className = `segment-row${index === state.selectedSeparatorIndex ? " active" : ""}`;
    row.innerHTML = `
      <div>
        <div class="segment-title">Separator ${index + 1}</div>
        <div class="segment-subtitle">x ${cut}</div>
      </div>
      <button>Select</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      selectSeparator(state.selectedLineIndex, index);
    });
    container.appendChild(row);
  });
}

function renderValidation() {
  els.validationPanel.innerHTML = "";
  if (!state.validationEnabled) {
    els.validationPanel.innerHTML = `<p class="empty-state">Validation is disabled.</p>`;
    return;
  }
  const counts = state.customAyaCounts || state.ayaCounts;
  const warnings = buildWarnings(state.results, counts);
  if (!warnings.length) {
    els.validationPanel.innerHTML = `<p class="empty-state">No advisory warnings.</p>`;
    return;
  }
  warnings.forEach((warning) => {
    const item = document.createElement("div");
    item.className = "warning-item";
    item.innerHTML = `
      Sura ${warning.sura}: expected ${warning.expected}, found ${warning.found}.
      <br />
      <button>Jump to page ${warning.pageNumber || "?"}</button>
    `;
    item.querySelector("button").addEventListener("click", () => {
      const index = (state.results.pages || []).findIndex(
        (page) => page.page_number === warning.pageNumber,
      );
      if (index >= 0) selectPage(index);
    });
    els.validationPanel.appendChild(item);
  });
}

function updateLineBox(key, rawValue) {
  const line = currentLine();
  if (!line) return;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return;
  editWithHistory(() => {
    line.line_bbox[key] = key === "w" || key === "h" ? Math.max(1, value) : Math.max(0, value);
    if (line.type === "text") regenerateSegments(line);
  });
}

function editWithHistory(callback) {
  pushHistory();
  callback();
  recalculateNumbering(state.results, state.suras);
  notify();
}

async function saveReview() {
  if (!state.results) return;
  els.saveReviewBtn.disabled = true;
  els.saveReviewBtn.textContent = "Saving...";
  try {
    if (state.hasEdits) {
      recalculateNumbering(state.results, state.suras);
    }
    const payload = cloneData(state.results);
    payload._review_has_edits = state.hasEdits;
    const response = await saveResults(payload);
    replaceResults(response.data);
    if (els.reexportImages.checked) {
      els.saveReviewBtn.textContent = "Exporting...";
      await reExportImages();
    }
    alert("Corrected data saved.");
  } catch (error) {
    alert(`Save failed: ${error.message}`);
  } finally {
    els.saveReviewBtn.disabled = false;
    els.saveReviewBtn.textContent = "Save corrected JSON";
  }
}

async function reloadOriginal() {
  try {
    replaceResults(await loadResults("original"));
  } catch (error) {
    alert(`Reload failed: ${error.message}`);
  }
}

function renderUnavailable() {
  els.reviewStatus.textContent = "review unavailable";
  els.selectionPanel.innerHTML = `
    <p class="empty-state">Run a normal export with coordinate output first.</p>
  `;
}

function renderError(message) {
  els.reviewStatus.textContent = "review failed";
  els.selectionPanel.innerHTML = `<p class="empty-state">${message}</p>`;
}

function lineSummary(line) {
  if (line.type === "text") return `${line.segments?.length || 0} seg`;
  if (line.type === "sura_header") return `S${line.sura_number || "?"}`;
  return `S${line.sura_number || "?"}`;
}

function numberField(id, label, value) {
  return `
    <div class="field">
      <label for="${id}">${label}</label>
      <input id="${id}" type="number" step="1" value="${value}" />
    </div>
  `;
}

function suraOptions(selected) {
  return state.suras
    .map((sura) => {
      const number = Number(sura.number);
      const isSelected = number === Number(selected) ? "selected" : "";
      return `<option value="${number}" ${isSelected}>${number} · ${sura.name}</option>`;
    })
    .join("");
}

function toCamel(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
