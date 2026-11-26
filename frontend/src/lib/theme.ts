// The Light · Dark · System theme preference.
//
// The choice is kept in the browser and applied as <html data-theme="light|dark">;
// styles.css swaps the token values on that attribute. "System" follows the OS's
// prefers-color-scheme, live, and a change made in another tab is picked up here.
// index.html resolves the same preference inline before first paint, so a dark page
// never flashes light: keep THEME_KEY in step with its script.
import { useSyncExternalStore } from "react";

import { readString, writeString } from "./prefs";

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type Theme = "light" | "dark";

const THEME_KEY = "qps-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

type ThemeState = { preference: ThemePreference; theme: Theme };

function read(): ThemeState {
  const stored = readString(THEME_KEY);
  const preference = (THEME_PREFERENCES as readonly string[]).includes(stored ?? "")
    ? (stored as ThemePreference)
    : "system";
  const system: Theme =
    typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  return { preference, theme: preference === "system" ? system : preference };
}

let state = read();
const listeners = new Set<() => void>();

/** Re-read the preference, apply it to <html>, and tell subscribers if it moved. */
function refresh(): void {
  const next = read();
  document.documentElement.dataset.theme = next.theme;
  if (next.preference === state.preference && next.theme === state.theme) return;
  state = next;
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  window.matchMedia(DARK_QUERY).addEventListener("change", refresh);
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY) refresh();
  });
  refresh();
}

export function setThemePreference(preference: ThemePreference): void {
  writeString(THEME_KEY, preference);
  refresh();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The stored preference and the theme it resolves to now. */
export function useTheme(): ThemeState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
