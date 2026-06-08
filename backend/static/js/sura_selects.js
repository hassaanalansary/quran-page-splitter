/** Populate start sura / start aya from GET /api/suras (matches core.quran_metadata). */

import { state } from "./state.js";

let surasCache = null;
let handlersAttached = false;

async function loadSuras() {
  if (surasCache) return surasCache;
  const res = await fetch("/api/suras");
  if (!res.ok) {
    throw new Error(`Failed to load suras: ${res.status} ${res.statusText}`);
  }
  surasCache = await res.json();
  return surasCache;
}

function suraForNumber(suras, n) {
  return suras.find((s) => s.number === n) ?? suras[0];
}

function populateStartSuraSelect(selectEl, suras) {
  selectEl.innerHTML = "";
  for (const s of suras) {
    const opt = document.createElement("option");
    opt.value = String(s.number);
    opt.textContent = `${s.number}. ${s.name} — ${s.transliteration}`;
    selectEl.appendChild(opt);
  }
}

function populateStartAyaSelect(selectEl, ayaCount, preferredAya) {
  selectEl.innerHTML = "";
  for (let a = 1; a <= ayaCount; a += 1) {
    const opt = document.createElement("option");
    opt.value = String(a);
    opt.textContent = String(a);
    selectEl.appendChild(opt);
  }
  const v = Math.min(Math.max(1, preferredAya ?? 1), ayaCount);
  selectEl.value = String(v);
  state.startAya = v;
}

function attachHandlers(startSuraEl, startAyaEl, suras) {
  if (handlersAttached) return;
  handlersAttached = true;

  startSuraEl.addEventListener("change", () => {
    const n = parseInt(startSuraEl.value, 10);
    state.startSura = Number.isFinite(n) ? n : 1;
    const sura = suraForNumber(suras, state.startSura);
    const prevAya = state.startAya;
    populateStartAyaSelect(startAyaEl, sura.aya_count, prevAya);
  });

  startAyaEl.addEventListener("change", () => {
    const n = parseInt(startAyaEl.value, 10);
    state.startAya = Number.isFinite(n) ? n : 1;
  });
}

/**
 * Load metadata and bind selects once. Keeps state.startSura / state.startAya in sync.
 */
export async function initSuraSelects() {
  const startSuraEl = document.getElementById("start-sura");
  const startAyaEl = document.getElementById("start-aya");
  if (!startSuraEl || !startAyaEl) return;

  const suras = await loadSuras();
  populateStartSuraSelect(startSuraEl, suras);

  const initial = suraForNumber(suras, state.startSura);
  state.startSura = initial.number;
  startSuraEl.value = String(initial.number);
  populateStartAyaSelect(startAyaEl, initial.aya_count, state.startAya);

  attachHandlers(startSuraEl, startAyaEl, suras);
}

/**
 * Called from fullReset: revert to default sura/aya without refetching.
 */
export function resetSuraSelects() {
  const startSuraEl = document.getElementById("start-sura");
  const startAyaEl = document.getElementById("start-aya");
  state.startSura = 1;
  state.startAya = 1;

  if (!startSuraEl || !startAyaEl || !surasCache?.length) {
    return;
  }

  startSuraEl.value = "1";
  const sura = suraForNumber(surasCache, 1);
  populateStartAyaSelect(startAyaEl, sura.aya_count, 1);
}
