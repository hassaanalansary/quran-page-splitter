export function recalculateNumbering(results, suras) {
  if (!results?.pages) return;
  const suraMap = new Map(suras.map((sura) => [Number(sura.number), sura]));
  let currentSura = Number(results.start_sura || 1);
  let currentAya = Number(results.start_aya || 1);

  for (const page of results.pages) {
    page.lines?.forEach((line, index) => {
      line.line_number = index + 1;
      if (line.type === "sura_header") {
        const manualSura = positiveNumber(line.manual_sura_anchor);
        if (manualSura) {
          currentSura = manualSura;
          currentAya = 1;
        } else if (currentAya !== 1) {
          currentSura += 1;
          currentAya = 1;
        }
        applyLineSura(line, currentSura, suraMap);
        delete line.segments;
        delete line.separator_cuts;
        return;
      }

      if (line.type === "basmala") {
        applyLineSura(line, currentSura, suraMap);
        delete line.segments;
        delete line.separator_cuts;
        return;
      }

      line.type = "text";
      regenerateSegments(line);
      for (const segment of line.segments || []) {
        const manualAya = positiveNumber(segment.manual_aya_anchor);
        if (manualAya) currentAya = manualAya;
        const sura = suraMap.get(currentSura);
        segment.sura_number = currentSura;
        segment.sura_name = sura?.name || null;
        segment.aya_number = currentAya;
        if (segment.has_separator) {
          segment.is_continuation = false;
          currentAya += 1;
        } else {
          segment.is_continuation = true;
        }
      }
    });
  }

  results.end_sura = currentSura;
  results.end_aya = currentAya;
}

export function regenerateSegments(line) {
  if (!line || line.type !== "text") return;
  const bbox = line.line_bbox;
  if (!bbox) return;
  const oldSegments = line.segments || [];
  const left = Number(bbox.x);
  const right = Number(bbox.x) + Number(bbox.w);
  const cuts = Array.from(
    new Set(
      (line.separator_cuts || [])
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value > left && value < right),
    ),
  ).sort((a, b) => a - b);
  line.separator_cuts = cuts;

  const segments = [];
  let end = right;
  for (let i = cuts.length - 1; i >= 0; i -= 1) {
    const cut = cuts[i];
    segments.push({
      has_separator: true,
      bbox: { x: cut, y: bbox.y, w: end - cut, h: bbox.h },
    });
    end = cut;
  }
  const leftWidth = end - left;
  if (leftWidth > 0 || !segments.length) {
    segments.push({
      has_separator: false,
      bbox: { x: left, y: bbox.y, w: Math.max(1, leftWidth), h: bbox.h },
    });
  }

  oldSegments.forEach((oldSegment, index) => {
    if (segments[index] && oldSegment.manual_aya_anchor) {
      segments[index].manual_aya_anchor = oldSegment.manual_aya_anchor;
    }
  });
  line.segments = segments;
}

function applyLineSura(line, currentSura, suraMap) {
  const sura = suraMap.get(currentSura);
  line.sura_number = currentSura;
  line.sura_name = sura?.name || null;
  line.sura_transliteration = sura?.transliteration || line.sura_transliteration;
}

function positiveNumber(value) {
  const result = Number(value);
  return Number.isInteger(result) && result > 0 ? result : null;
}
