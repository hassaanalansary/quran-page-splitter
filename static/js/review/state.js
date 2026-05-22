export const state = {
  status: null,
  results: null,
  suras: [],
  ayaCounts: new Map(),
  customAyaCounts: null,
  currentPageIndex: 0,
  selectedLineIndex: null,
  selectedSegmentIndex: null,
  selectedSeparatorIndex: null,
  image: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  addSeparatorMode: false,
  validationEnabled: false,
  history: [],
  future: [],
};

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
}

export function notify() {
  for (const listener of listeners) listener();
}

export function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

export function pushHistory() {
  if (!state.results) return;
  state.history.push(cloneData(state.results));
  if (state.history.length > 80) state.history.shift();
  state.future = [];
}

export function undo() {
  if (!state.history.length || !state.results) return;
  state.future.push(cloneData(state.results));
  state.results = state.history.pop();
  clearSelectionIfInvalid();
  notify();
}

export function redo() {
  if (!state.future.length || !state.results) return;
  state.history.push(cloneData(state.results));
  state.results = state.future.pop();
  clearSelectionIfInvalid();
  notify();
}

export function currentPage() {
  return state.results?.pages?.[state.currentPageIndex] || null;
}

export function currentLine() {
  const page = currentPage();
  if (state.selectedLineIndex == null) return null;
  return page?.lines?.[state.selectedLineIndex] || null;
}

export function currentSegment() {
  const line = currentLine();
  if (!line || state.selectedSegmentIndex == null) return null;
  return line.segments?.[state.selectedSegmentIndex] || null;
}

export function selectPage(index) {
  if (!state.results?.pages?.length) return;
  state.currentPageIndex = Math.max(
    0,
    Math.min(index, state.results.pages.length - 1),
  );
  state.selectedLineIndex = null;
  state.selectedSegmentIndex = null;
  state.selectedSeparatorIndex = null;
  state.addSeparatorMode = false;
  notify();
}

export function selectLine(lineIndex) {
  state.selectedLineIndex = lineIndex;
  state.selectedSegmentIndex = null;
  state.selectedSeparatorIndex = null;
  state.addSeparatorMode = false;
  notify();
}

export function selectSegment(lineIndex, segmentIndex) {
  state.selectedLineIndex = lineIndex;
  state.selectedSegmentIndex = segmentIndex;
  state.selectedSeparatorIndex = null;
  state.addSeparatorMode = false;
  notify();
}

export function selectSeparator(lineIndex, separatorIndex) {
  state.selectedLineIndex = lineIndex;
  state.selectedSegmentIndex = null;
  state.selectedSeparatorIndex = separatorIndex;
  state.addSeparatorMode = false;
  notify();
}

export function replaceResults(results) {
  state.results = results;
  state.currentPageIndex = 0;
  state.selectedLineIndex = null;
  state.selectedSegmentIndex = null;
  state.selectedSeparatorIndex = null;
  state.history = [];
  state.future = [];
  notify();
}

function clearSelectionIfInvalid() {
  const page = currentPage();
  if (!page) {
    state.currentPageIndex = 0;
    state.selectedLineIndex = null;
    state.selectedSegmentIndex = null;
    state.selectedSeparatorIndex = null;
    return;
  }
  if (state.selectedLineIndex != null && !page.lines?.[state.selectedLineIndex]) {
    state.selectedLineIndex = null;
  }
  const line = currentLine();
  if (!line) {
    state.selectedSegmentIndex = null;
    state.selectedSeparatorIndex = null;
    return;
  }
  if (
    state.selectedSegmentIndex != null &&
    !line.segments?.[state.selectedSegmentIndex]
  ) {
    state.selectedSegmentIndex = null;
  }
  if (
    state.selectedSeparatorIndex != null &&
    !line.separator_cuts?.[state.selectedSeparatorIndex]
  ) {
    state.selectedSeparatorIndex = null;
  }
}
