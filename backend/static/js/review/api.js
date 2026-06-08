export async function loadStatus() {
  return readJson("/api/review/status");
}

export async function loadResults(source = "latest") {
  const response = await readJson(`/api/review/results?source=${source}`);
  return response.data;
}

export async function saveResults(data) {
  return readJson("/api/review/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
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
