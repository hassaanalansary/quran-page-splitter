export function buildWarnings(results, ayaCounts) {
  if (!results?.pages || !ayaCounts) return [];
  const counts = new Map();
  const firstPageBySura = new Map();
  const completedSuras = new Set();
  let previousHeader = null;

  for (const page of results.pages) {
    for (const line of page.lines || []) {
      if (line.type === "sura_header" && line.sura_number) {
        if (previousHeader != null) completedSuras.add(previousHeader);
        previousHeader = Number(line.sura_number);
        if (!firstPageBySura.has(previousHeader)) {
          firstPageBySura.set(previousHeader, page.page_number);
        }
      }
      if (line.type !== "text") continue;
      for (const segment of line.segments || []) {
        if (!segment.has_separator || !segment.sura_number) continue;
        const sura = Number(segment.sura_number);
        counts.set(sura, (counts.get(sura) || 0) + 1);
        if (!firstPageBySura.has(sura)) firstPageBySura.set(sura, page.page_number);
      }
    }
  }

  const warnings = [];
  for (const sura of completedSuras) {
    const expected = ayaCounts.get(sura);
    if (!expected) continue;
    const found = counts.get(sura) || 0;
    if (found !== expected) {
      warnings.push({
        sura,
        expected,
        found,
        pageNumber: firstPageBySura.get(sura),
      });
    }
  }
  return warnings;
}

export async function readMetadataFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  const suras = data.suras || data;
  const counts = new Map();
  Object.entries(suras).forEach(([key, value]) => {
    if (typeof value === "number") {
      counts.set(Number(key), value);
    } else if (value && typeof value === "object" && value.aya_count) {
      counts.set(Number(key), Number(value.aya_count));
    }
  });
  return counts;
}
