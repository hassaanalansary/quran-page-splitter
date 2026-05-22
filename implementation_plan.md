# Visual Review UI + Optional Metadata Validation

Build a post-processing review page (`/review`) where the user views pipeline results overlaid on original page images, edits line boundaries and separator positions, corrects classifications, auto-recalculates sura/aya numbering, saves corrected `results.json`, and optionally re-exports cropped images.

## User Review Required

> [!IMPORTANT]
> **Scope & phasing**: This is a large feature. The plan is split into 4 phases. Phase 1–3 deliver a usable review editor. Phase 4 adds advanced editing and optional validation. Do you want to proceed with all phases, or start with Phase 1–2 only?

> [!IMPORTANT]
> **Original page images**: During processing, the pipeline currently discards the original page images after extracting lines. For the review UI, we need to save copies. This adds disk usage (~5MB × number of pages). Are you OK with saving originals to `results/pages/`?

> [!IMPORTANT]
> **Coordinate export**: The review UI requires `results.json` (coordinate export) to exist. Should we **always** generate coordinates during processing (removing the toggle), or keep it optional and require the user to enable "Export coordinates" before processing?

## Open Questions

> [!IMPORTANT]
> **Re-export scope**: When the user saves corrected `results.json`, should the "Re-export" button regenerate ALL page images, or only pages that were modified?

> [!NOTE]
> **Undo/redo**: Should we implement undo/redo in Phase 3, or defer it to a later phase? It adds significant state management complexity but greatly improves UX.

---

## Proposed Changes

### Phase 1: Foundation (Backend)

Save original page images, enrich `results.json`, and add review API endpoints.

---

#### [MODIFY] [pipeline.py](file:///d:/work/Programing%20materials/quran-page-splitter/core/pipeline.py)

Save each original page image to `results/pages/` before processing so the review UI can load them later. Add `crop_box` metadata to the output so the review UI knows the analyzed region.

```python
# In Pipeline.run(), after opening the image:
pages_dir = Path(self.processor.results_dir) / "pages"
pages_dir.mkdir(exist_ok=True)
img.save(pages_dir / filename)
```

Add `crop_box` to the coordinate output:

```python
# In the final output dict:
if cfg.export_coordinates and coordinate_pages:
    coordinate_data = {
        ...
        "crop_box": {
            "x": crop_cfg.x, "y": crop_cfg.y,
            "w": crop_cfg.w, "h": crop_cfg.h
        },
        ...
    }
```

---

#### [MODIFY] [coordinate_exporter.py](file:///d:/work/Programing%20materials/quran-page-splitter/core/coordinate_exporter.py)

Add `has_separator` field to each segment in the export. The review UI needs this to know where separator cut points are (distinct from `is_continuation` which is about aya tracking).

```diff
 line_data["segments"].append({
     "sura_number": seg.sura_number,
     "sura_name": ...,
     "aya_number": seg.aya_number,
     "is_continuation": seg.is_continuation,
+    "has_separator": seg.has_separator,
     "bbox": seg.bbox.as_xywh(),
 })
```

---

#### [MODIFY] [server.py](file:///d:/work/Programing%20materials/quran-page-splitter/server.py)

Add review-related API endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/review` | GET | Serve `review.html` |
| `/api/review/results` | GET | Return current `results.json` |
| `/api/review/pages/{filename}` | GET | Serve an original page image from `results/pages/` |
| `/api/review/save` | POST | Accept corrected results JSON and write to `results.json` |
| `/api/review/re-export` | POST | Re-crop images from corrected coordinates |

---

#### [NEW] [re_exporter.py](file:///d:/work/Programing%20materials/quran-page-splitter/core/re_exporter.py)

New module that reads a corrected `results.json` and corresponding page images from `results/pages/`, then crops and saves segment images to `results/`. Mirrors the logic in [PageProcessor._export_images](file:///d:/work/Programing%20materials/quran-page-splitter/core/page_processor.py#L169-L218) but driven by the JSON data rather than in-memory `PageContext`.

```python
def re_export(results_path: Path, pages_dir: Path, output_dir: Path) -> dict:
    """Re-export segment images from a (possibly corrected) results.json."""
    # Load results JSON
    # For each page:
    #   Load original image from pages_dir
    #   For each line:
    #     If sura/basmala: crop line bbox, make transparent, save
    #     If text: for each segment, crop bbox, make transparent, save
    # Return summary of exported files
```

---

### Phase 2: View + Navigate (Frontend)

Build the review page with canvas rendering, overlays, and page navigation. No editing yet — this phase is read-only.

---

#### [NEW] [review.html](file:///d:/work/Programing%20materials/quran-page-splitter/review.html)

New page with a two-panel layout:

```
┌──────────────────────────────────────────────────────────────────┐
│  ✧ REVIEW MODE                    Page 3 / 500   [Save] [Export]│
├────────────────────────────────────┬─────────────────────────────┤
│                                    │  // Page Navigation         │
│                                    │  [← Prev]  [Next →]        │
│   Canvas: page image               │  ┌───────────────────────┐ │
│   with colored line overlays       │  │  page thumbnails      │ │
│   and separator cut lines          │  └───────────────────────┘ │
│                                    │                             │
│   Zoom: scroll wheel               │  // Lines Panel            │
│   Pan: click + drag (on bg)        │  ┌───────────────────────┐ │
│                                    │  │ L1 ▍sura_header       │ │
│   Color key:                       │  │ L2 ▍basmala           │ │
│   🟡 sura_header                   │  │ L3 ▍text (3 segs)    │ │
│   🟢 basmala                       │  │ L4 ▍text (4 segs) ◄  │ │
│   🔵 text line                     │  │ L5 ▍text (2 segs)    │ │
│   ┃  separator cut                 │  └───────────────────────┘ │
│                                    │                             │
│                                    │  // Selected Line Details   │
│                                    │  (Phase 3: edit controls)   │
│                                    │                             │
│                                    │  // Validation Warnings     │
│                                    │  (Phase 4: metadata check)  │
└────────────────────────────────────┴─────────────────────────────┘
```

Key HTML elements:
- `<canvas id="review-canvas">` — main image + overlays canvas
- `#page-list` — scrollable thumbnail strip
- `#line-panel` — list of detected lines with type badges
- `#edit-panel` — controls for editing the selected line (Phase 3)
- `#validation-panel` — warnings from metadata validation (Phase 4)

---

#### [NEW] [review.css](file:///d:/work/Programing%20materials/quran-page-splitter/static/css/review.css)

Styles for the review page. Reuses the existing design system (CSS variables from [base.css](file:///d:/work/Programing%20materials/quran-page-splitter/static/css/base.css)): dark background, gold accents, IBM Plex fonts. Adds:

- Two-column layout (canvas left, panels right)
- Line list items with colored type badges
- Selected line highlight
- Separator cut line styling
- Validation warning cards
- Page thumbnail strip (horizontal scroll)

---

#### [NEW] static/js/review/ directory

| File | Purpose |
|---|---|
| `main.js` | Entry point: fetch results, wire events, initialize canvas |
| `state.js` | Reactive state: current page index, selected line, results data, zoom/pan |
| `api.js` | API helpers: `loadResults()`, `saveResults()`, `reExport()` |
| `canvas.js` | Canvas setup with zoom (scroll wheel) and pan (drag on background) |
| `overlay.js` | Draw line bands (colored semi-transparent rectangles) and separator cuts (vertical dashed lines) on the canvas. Renders on top of the page image. |
| `page_nav.js` | Page navigation: thumbnail strip, prev/next buttons, jump-to-page |

**Canvas rendering pipeline** (`overlay.js`):
1. Clear canvas
2. Draw page image (scaled by zoom, offset by pan)
3. Draw crop region outline (dashed border)
4. For each line on the current page:
   - Draw semi-transparent colored band (gold=sura, green=basmala, blue=text)
   - If text line: draw vertical dashed lines at separator positions
   - If selected: draw with brighter color and thicker border
5. Draw line index labels

**Zoom/pan** (`canvas.js`):
- Scroll wheel → zoom in/out (centered on cursor)
- Middle-click + drag or Ctrl+click + drag → pan
- Fit-to-width on page load

---

### Phase 3: Editing (Core Feature)

Add interactive editing capabilities. This is the heart of the review UI.

---

#### [NEW] [editor.js](file:///d:/work/Programing%20materials/quran-page-splitter/static/js/review/editor.js)

Handles all editing interactions on the canvas and sidebar:

**Line selection:**
- Click on a line overlay → select it, highlight in sidebar, show edit controls
- Click on empty area → deselect

**Line type change:**
- Dropdown in sidebar: `text` / `sura_header` / `basmala`
- Changing type updates the line in state and re-renders
- Changing to `sura_header` removes all segments
- Changing from `sura_header` to `text` creates a single full-width segment

**Line boundary editing:**
- Hover near top/bottom edge of selected line → cursor changes to `ns-resize`
- Drag top edge → change `line_bbox.y` (and recalculate `h`)
- Drag bottom edge → change `line_bbox.h`
- Constraint: can't overlap with adjacent lines
- Visual feedback: highlighted edge with grab handle

**Separator editing (within text lines):**
- Click inside a selected text line → add a new separator cut at that X position
- Click on an existing separator cut → select it (highlight)
- Drag a selected separator left/right → move the cut point
- Press Delete or click remove button → remove the separator
- Separators split the line into segments; adding/removing recalculates segment bboxes

**Segment recalculation:**
When separators change, segments must be recalculated:
- Sort separator X positions (ascending)
- Create segments between: [line.left, sep1], [sep1, sep2], ..., [sepN, line.right]
- In RTL order: rightmost segment has `has_separator: true` (if a separator is to its left)
- Leftmost segment has `has_separator: false` (continuation)

---

#### [NEW] [numbering.js](file:///d:/work/Programing%20materials/quran-page-splitter/static/js/review/numbering.js)

Auto-recalculate sura/aya numbers across all pages after any edit. Mirrors the backend logic in [coordinate_exporter.py:track_positions](file:///d:/work/Programing%20materials/quran-page-splitter/core/coordinate_exporter.py#L26-L76):

```javascript
function recalculateNumbering(results) {
  let currentSura = results.start_sura;
  let currentAya = results.start_aya;
  let pendingBasmala = false;

  for (const page of results.pages) {
    for (const line of page.lines) {
      if (line.type === "sura_header") {
        if (currentAya !== 1) {
          currentSura++;
          currentAya = 1;
        }
        pendingBasmala = true;
        line.sura_number = currentSura;
        line.sura_name = getSuraName(currentSura);
        continue;
      }
      if (line.type === "basmala") {
        pendingBasmala = false;
        line.sura_number = currentSura;
        line.sura_name = getSuraName(currentSura);
        continue;
      }
      // text line
      if (pendingBasmala) {
        // Check if first segment has separator → not a basmala, treat as text
        pendingBasmala = false;
      }
      for (const seg of line.segments) {
        seg.sura_number = currentSura;
        seg.sura_name = getSuraName(currentSura);
        seg.aya_number = currentAya;
        if (seg.has_separator) {
          seg.is_continuation = false;
          currentAya++;
        } else {
          seg.is_continuation = true;
        }
      }
    }
  }
  results.end_sura = currentSura;
  results.end_aya = currentAya;
}
```

This runs every time the user makes an edit (type change, separator add/remove). All sura/aya labels on the canvas and in the sidebar update in real-time.

Sura names are fetched once from `GET /api/suras` (already exists).

---

#### Save flow:

1. User makes edits → state updates → overlay re-renders → numbering recalculates
2. User clicks "Save" → `POST /api/review/save` with the full corrected results JSON
3. Backend overwrites `results.json`
4. Success confirmation in the UI

---

### Phase 4: Advanced Editing + Validation

---

#### Advanced line operations (additions to `editor.js`):

| Operation | Description |
|---|---|
| **Delete line** | Remove a line entirely. Adjacent lines expand to fill the gap (optional). All subsequent line numbers re-index. |
| **Add line** | Click "Split line" → click a Y position within a selected line → splits into two lines at that Y. |
| **Merge lines** | Select a line → click "Merge with line below" → combines two adjacent lines into one. |
| **Adjust slot count** | For sura headers: change `slot_count` (how many layout slots this line consumes). |

---

#### [NEW] [validation.js](file:///d:/work/Programing%20materials/quran-page-splitter/static/js/review/validation.js)

Optional metadata-based validation. The user provides a custom JSON with aya counts per sura for their specific qira'a (reading tradition), or uses the built-in defaults.

**UI**: A collapsible "Validation" panel at the bottom of the sidebar:
- Toggle: "Enable metadata validation"
- File input: "Upload custom aya counts JSON" (optional)
- Warning list: shows mismatches between detected and expected aya counts

**Custom metadata format**:
```json
{
  "description": "Hafs reading",
  "suras": {
    "1": { "name": "الفاتحة", "aya_count": 7 },
    "2": { "name": "البقرة", "aya_count": 286 },
    ...
  }
}
```

If no custom file is uploaded but validation is enabled, fall back to the built-in [quran_metadata.py](file:///d:/work/Programing%20materials/quran-page-splitter/core/quran_metadata.py) data (served via the existing `/api/suras` endpoint which already includes `aya_count`).

**Validation logic**:
- Count separators (segments with `has_separator: true`) per sura across all pages
- Compare against expected aya count for that sura
- Show warnings for mismatches: "Sura 92 (الليل): expected 21 ayas, found 20"
- Clicking a warning jumps to the first page of that sura

> [!NOTE]
> As the user noted, aya counts vary by qira'a. The validation is explicitly marked as **optional** and advisory. It never blocks saving or exporting. The warning text explains that mismatches may be expected depending on the reading tradition.

---

#### Re-export (uses [re_exporter.py](file:///d:/work/Programing%20materials/quran-page-splitter/core/re_exporter.py) from Phase 1):

- "Re-export images" button in the review UI
- Calls `POST /api/review/re-export`
- Backend reads corrected `results.json`, crops images, saves to `results/`
- Progress indicator in the UI (or simple "done" alert)

---

## New File Summary

| File | Type | Phase |
|---|---|---|
| [review.html](file:///d:/work/Programing%20materials/quran-page-splitter/review.html) | Frontend page | 2 |
| [static/css/review.css](file:///d:/work/Programing%20materials/quran-page-splitter/static/css/review.css) | Styles | 2 |
| `static/js/review/main.js` | JS entry point | 2 |
| `static/js/review/state.js` | State management | 2 |
| `static/js/review/api.js` | API calls | 2 |
| `static/js/review/canvas.js` | Canvas zoom/pan | 2 |
| `static/js/review/overlay.js` | Overlay rendering | 2 |
| `static/js/review/page_nav.js` | Page navigation | 2 |
| `static/js/review/editor.js` | Edit interactions | 3 |
| `static/js/review/numbering.js` | Aya recalculation | 3 |
| `static/js/review/validation.js` | Metadata validation | 4 |
| [core/re_exporter.py](file:///d:/work/Programing%20materials/quran-page-splitter/core/re_exporter.py) | Re-export logic | 1 |

## Modified File Summary

| File | Change | Phase |
|---|---|---|
| [pipeline.py](file:///d:/work/Programing%20materials/quran-page-splitter/core/pipeline.py) | Save original pages, add crop_box to output | 1 |
| [coordinate_exporter.py](file:///d:/work/Programing%20materials/quran-page-splitter/core/coordinate_exporter.py) | Add `has_separator` to segment export | 1 |
| [server.py](file:///d:/work/Programing%20materials/quran-page-splitter/server.py) | Add `/review` and `/api/review/*` endpoints | 1 |

---

## Verification Plan

### Automated Tests
- Backend: verify `results/pages/` directory is populated after processing
- Backend: verify `results.json` contains `crop_box` and `has_separator` fields
- Backend: verify `/api/review/results` returns valid JSON
- Backend: verify `/api/review/save` round-trips correctly (save → load → compare)
- Backend: verify re-export produces the same images as original export (given unmodified results)

### Manual Verification
1. Process a small batch (5–10 pages) through the existing UI with "Export coordinates" enabled
2. Navigate to `/review` — verify page images load with correct overlays
3. Click through pages — verify navigation and thumbnail strip
4. Select a line — verify highlight and sidebar details
5. Change a line type — verify overlay color changes and numbering recalculates
6. Drag a line boundary — verify the overlay resizes
7. Add a separator — verify new cut line appears and segments recalculate
8. Remove a separator — verify segments merge
9. Save — verify `results.json` is updated on disk
10. Re-export — verify cropped images match corrected coordinates
11. Enable metadata validation — verify warnings appear for aya count mismatches
