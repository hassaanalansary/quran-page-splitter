export async function loadStatus() {
  return readJson("/api/cut-review/status");
}

export async function loadResults() {
  return readJson("/api/cut-review/results");
}

export async function saveCutEdits(edits) {
  return readJson("/api/cut-review/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export async function exportLinePngs() {
  return readJson("/api/cut-review/export", { method: "POST" });
}

export async function loadSuras() {
  return readJson("/api/suras");
}

export function pageImageUrl(filename) {
  return `/api/review/pages/${encodeURIComponent(filename)}`;
}

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.detail || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload;
}
