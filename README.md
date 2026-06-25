# Quran Page Splitter

Digital Quran applications that render text with fonts cannot fully reproduce
the experience of reading a printed Mushaf. The core problem is that the written
Mushaf is a handcrafted calligraphic work: a single Arabic letter can take
different shapes depending on its position and context on the page, and lines are
visually justified to align at both edges in a way that text layout engines
cannot replicate. Implementing a faithful font requires encoding a unique glyph
for every character instance on every page, which is an enormous undertaking and
still falls short of the original.

The image-based approach sidesteps this entirely: applications display scanned
or photographed pages as-is, preserving every calligraphic detail and the exact
visual layout the reader knows from the printed copy. To make those images
interactive — highlighting an aya, jumping to a verse, playing audio in sync
with the text — the application needs two things: the bounding box of each aya
on each page, and the page cut into individual line images.

Serving whole page images also creates a responsive layout problem. If the page
is a single image, resizing the application window either stretches it or leaves
dead space. The solution is to display each line as its own image and let the
application adjust the spacing between lines to fill the available height. The
lines themselves scale uniformly to the window width, and the vertical gaps
absorb the remaining space, so the page always fills the screen without
distortion at any window size.

Quran Page Splitter is a local tool that produces both. It processes a full set
of Mushaf page images, automatically detects lines and aya boundaries, lets the
user review and correct the output, then exports coordinate JSON and transparent
line PNG files ready to be consumed by a Mushaf application.

## What It Does

- Accepts up to 610 page images at once.
- Sorts uploaded files naturally by filename, so `2.png` comes before `10.png`.
- Crops each page to the main Mushaf text region.
- Detects line bands using horizontal projection valleys.
- Protects detected sura headers before line splitting so ornamental headers are
not accidentally split as ordinary text.
- Detects aya separator ornaments inside text lines using template matching.
- Tracks sura and aya numbering across pages.
- Exports coordinate JSON from the main processing run.
- Saves source page copies for review.
- Lets the user correct output visually in `/verify`.
- Lets the user adjust final line cuts and eraser masks in `/finalize`.

## Tech Stack

**Backend** — FastAPI + Uvicorn (Python ≥ 3.13), managed by `uv`. Key libraries:
Pillow, NumPy, OpenCV headless (with optional OpenCL acceleration), PyMuPDF,
pdf2image, python-multipart.

**Frontend** — React 19 SPA built with Vite, TanStack Router (file-based
routing), TailwindCSS 4, Radix UI components, TanStack React Query, and
TypeScript.

## Requirements

- Python `>=3.13`
- Node.js (for the frontend build)
- `uv`
- A modern browser

## Install And Run

Install backend dependencies:

```bash
cd backend
uv sync
```

Install frontend dependencies and build the SPA:

```bash
cd ../frontend
npm install
npm run build
```

Start the FastAPI web server:

```bash
cd ../backend
uv run server.py
```

Open:

```text
http://localhost:8000/
```

`/` redirects to the upload workflow:

```text
http://localhost:8000/upload
```

The coordinate verification editor is available at:

```text
http://localhost:8000/verify
```

The final line cleanup/export editor is available at:

```text
http://localhost:8000/finalize
```

The verification and finalization pages only work after a main processing run.

## Recommended Workflow

1. Prepare page images.
  - Use PNG/JPG/WEBP/GIF inputs.
  - Name pages in reading order, for example `001.png`, `002.png`, `003.png`.
  - If starting from PDFs, see `script/pdf_to_pngs.py`.
2. Open `http://localhost:8000/upload`.
3. Drag images into the drop zone or use `browse`.
4. Define the required crop targets:
  - `bounds`
  - `sura_header`
  - `aya_separator`
5. Optionally define ignore regions:
  - `sura_header_ignore`
  - `aya_separator_ignore`
6. Tune detection and numbering settings.
7. Click `Upload all`.
8. Open `/verify` to correct remaining coordinate, numbering, or geometry issues.
9. Open `/finalize` to adjust final line boxes and paint transparent masks.
10. Export final line PNGs.

## Main Page Controls

### Image Queue

The upload queue accepts image files only. The frontend limits the queue to the
first 610 images. A thumbnail strip appears after loading images, with `Prev`
and `Next` buttons for moving through the queue while choosing crop targets.

The crop settings are global for the whole uploaded batch, not per page.

### Crop Target

The `Target` dropdown decides what the current crop rectangle means when you
click `Apply crop (live)`.


| Target                 | Required | Meaning                                                                                                                                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bounds`               | Yes      | The main page text area. The detector ignores outer margins outside this rectangle.                                                                                                  |
| `sura_header`          | Yes      | A template crop of a sura header ornament/name area. Used to detect protected sura header bands.                                                                                     |
| `sura_header_ignore`   | No       | A rectangle inside the `sura_header` template to ignore during matching, usually variable text or numbers. Must be fully inside the saved `sura_header` crop.                        |
| `aya_separator`        | Yes      | A template crop of one aya separator ornament. Used to split text lines into aya segments.                                                                                           |
| `aya_separator_ignore` | No       | A rectangle inside the `aya_separator` template to ignore during matching, usually the variable aya number inside the ornament. Must be fully inside the saved `aya_separator` crop. |


The status pills show which required targets are ready.

### Coordinate Inputs


| Input    | Meaning                                                                 |
| -------- | ----------------------------------------------------------------------- |
| `X (px)` | Left coordinate of the current crop rectangle in original image pixels. |
| `Y (px)` | Top coordinate of the current crop rectangle in original image pixels.  |
| `Width`  | Width of the current crop rectangle in pixels.                          |
| `Height` | Height of the current crop rectangle in pixels.                         |


You can draw the rectangle on the image or type exact values manually. The live
preview shows the current rectangle.

### Crop Buttons


| Button              | Meaning                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- |
| `Start cropping`    | Enables drawing a rectangle on the current image.                                   |
| `Apply crop (live)` | Saves the current rectangle for the selected target and updates the preview/status. |
| `Save PNG`          | Downloads the current live preview crop. This is for manual inspection only.        |
| `New crop`          | Starts drawing another crop rectangle.                                              |
| `Reset all`         | Clears the queue, crop targets, and settings back to defaults.                      |
| `Upload all`        | Sends all queued pages and selected settings to the backend for processing.         |


## Processing Settings


| Setting               | Default | Meaning                                                                                                                                                                         |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Padding`             | `4`     | Extra pixels added above and below detected line boxes. Increase if Arabic marks are clipped; decrease if neighboring lines leak into crops.                                    |
| `Lines / page`        | `15`    | Expected number of line slots per page. Sura headers consume their configured slot count. If detected slots do not match, the batch aborts at that page.                        |
| `Header slots`        | `1`     | Number of text-line slots a sura header occupies. Use `2` or more for Mushafs where a header visually replaces multiple ordinary line rows.                                     |
| `Header thr.`         | `0.60`  | Template matching threshold for detecting sura headers. Higher values reduce false positives; lower values find weaker matches.                                                 |
| `Max headers`         | `3`     | Maximum sura headers expected on one page. This prevents repeated template matches from creating too many protected header bands.                                               |
| `Aya thr.`            | `0.50`  | Template matching threshold for aya separators. Higher values reduce false separators; lower values find faint separators.                                                      |
| `Alternate margins`   | Off     | Mirrors the `bounds` crop horizontally on every even processed page. Use when facing pages have mirrored inner/outer margins.                                                   |
| `Prefer acceleration` | On      | Uses OpenCL-accelerated matching when possible. If ignore masks are used, the ignored area is approximated for speed. Disable for stricter CPU matching with full mask support. |
| `Start Sura`          | `1`     | Sura number at the first uploaded page.                                                                                                                                         |
| `Start Aya`           | `1`     | Aya number at the first uploaded page.                                                                                                                                          |


## How Detection Works

The backend processes each page in this order:

1. Binarize the page.
2. Crop to `bounds`.
3. Find protected sura header bands using the `sura_header` template.
4. Split remaining text regions into the expected number of line slots using
  valley detection over horizontal ink projection.
5. Detect aya separator positions inside non-header lines using the
  `aya_separator` template.
6. Split text lines right-to-left at separator cuts.
7. Track sura and aya numbers.
8. Export coordinate JSON.

Aya separator semantics:

- Segment order is right-to-left.
- A separator belongs to the aya text on its right.
- A segment with `has_separator: true` completes the current aya.
- A segment with `has_separator: false` is treated as a continuation.

## Output Files

Each new upload run clears the previous `results/` directory and removes old
`results.json` / `corrected_results.json`.


| Path                            | Created When         | Meaning                                                                        |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `results/`                      | Always               | Main output folder for templates, page copies, debug crops, and final line exports. |
| `results/sura_header.png`       | Always               | Saved template crop sent by the frontend.                                      |
| `results/aya_separator.png`     | Always               | Saved template crop sent by the frontend.                                      |
| `results/pages/`                | Always               | Safe copies of original uploaded pages, used by the review page.               |
| `results/line_detection_debug/` | Line count failure   | Per-line debug crops for the page where line detection failed.                 |
| `results/final_lines/`          | Cut review export    | Final transparent line PNGs after bbox overrides and eraser masks.             |
| `results.json`                  | Main processing run  | Original automatic coordinate output. Kept unchanged by the review editor.     |
| `corrected_results.json`        | Review save          | Corrected coordinate output from `/verify`.                                    |
| `line_cut_edits.json`           | Cut review save      | Bbox overrides and eraser strokes from `/finalize`.                            |
| `line_cut_results.json`         | Cut review save/export | Final coordinate output after cut-review bbox overrides.                     |
| `results.log`                   | Processing run       | Detailed backend processing log.                                               |


Typical final line image names:

```text
001-l03-sura104-header.png
001-l04-sura104-basmala.png
001-l07-sura104-aya003-004.png
001-l08-sura104-aya005.png
```

The exact prefix is based on the source page filename.

## Coordinate JSON

`results.json` contains:

- `start_sura`, `start_aya`
- `end_sura`, `end_aya`
- `pages_processed`
- `pages[]`

Each page includes:

- `page_number`
- `image_filename`
- `page_image_filename`
- `crop_box`
- `lines[]`

Each line includes:

- `line_number`
- `slot_count`
- `line_bbox`
- `type`: `text`, `sura_header`, or `basmala`

Text lines also include:

- `separator_cuts`: page-absolute x positions of aya cuts
- `segments[]`

Each segment includes:

- `sura_number`
- `sura_name`
- `aya_number`
- `is_continuation`
- `has_separator`
- `bbox`

## Review Page

Open:

```text
http://localhost:8000/verify
```

The review page requires:

- `results.json`
- `results/pages/`

If those are missing, run the main page again.

The review editor loads `corrected_results.json` if it exists; otherwise it loads
the original `results.json`. The original `results.json` is not overwritten.

### Review Layout


| Area       | Meaning                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Canvas     | Shows the original page with overlays for crop box, line boxes, segment boxes, separator cuts, and sura/aya labels. |
| Pages      | Page navigation buttons.                                                                                            |
| Lines      | List of detected/corrected lines on the current page.                                                               |
| Selection  | Controls for the selected line, separator, or segment.                                                              |
| Validation | Optional advisory aya-count validation.                                                                             |
| Sync       | Saves corrected JSON.                                                                                              |


### Review Canvas

The canvas shows:

- page image
- crop region
- line boxes
- segment boxes
- vertical separator cuts
- line numbers
- sura/aya labels

Canvas controls:

- `Fit`: fit the page in the canvas.
- mouse wheel: zoom.
- drag empty canvas: pan.
- click line/segment/separator: select.
- double-click selected text line: add a separator at that x position.
- drag selected separator: move the separator.
- drag top/bottom edge of selected line: adjust vertical line bounds.

### Review Selection Controls

For every selected line:

- edit `x`, `y`, `w`, `h`
- change line type: `text`, `sura_header`, `basmala`
- add a line above or below
- delete the selected line

For text lines:

- add a separator
- select/delete a separator
- select/delete a segment
- set an aya anchor for the selected segment

For sura headers:

- set the sura anchor for that header

Keyboard:

- `Delete` removes the selected separator if one is selected.
- Otherwise `Delete` removes the selected segment if one is selected.
- Otherwise `Delete` removes the selected line.
- `Delete` is ignored while typing in an input/select.

Undo/redo:

- Use `Undo` and `Redo` in the review toolbar.
- Drag operations are stored as one undo step when the drag ends.

### Review Numbering Rules

The backend is the final source of truth when corrected JSON is saved.

- Editing an aya number creates an aya anchor on that segment.
- Aya anchors propagate from that segment until the current sura ends.
- Aya anchors do not propagate into the next sura.
- Editing a sura number is allowed on sura headers.
- Sura header anchors propagate through later sura headers to the end of the
mushaf.
- Changing line type or separators recalculates affected segment metadata.

### Review Validation

Validation is optional and advisory. It never blocks saving.

By default, validation uses the built-in sura metadata in
`core/quran_metadata.py`. Because aya counts may differ by qira'a, you can upload
custom metadata JSON in the validation panel.

Accepted custom metadata formats:

```json
{
  "suras": {
    "104": { "name": "الهمزة", "aya_count": 9 },
    "105": { "name": "الفيل", "aya_count": 5 }
  }
}
```

or:

```json
{
  "104": 9,
  "105": 5
}
```

Validation compares unique aya numbers found per completed sura against the
configured aya count.

### Saving Corrections

`Save corrected JSON` writes:

```text
corrected_results.json
```

The original automatic `results.json` remains available as the fallback source.

`Reload original` discards the loaded review state and reloads `results.json`.

## Cut Review Page

Open:

```text
http://localhost:8000/finalize
```

The cut review page loads `corrected_results.json` if it exists; otherwise it
uses `results.json`. It also loads source page copies from `results/pages/`.

`Save cut JSON` writes:

```text
line_cut_edits.json
line_cut_results.json
```

`line_cut_edits.json` stores only the manual cut layer: line `bbox_override`
values and eraser strokes. Bbox overrides are merged into final line and segment
coordinates. Eraser strokes only affect PNG transparency.

`Export line PNGs` writes final transparent line images into:

```text
results/final_lines/
```

### Review Guide

The most reliable way to fix wrong output is to review the Mushaf in order,
one page at a time.

On each page, compare the first visible aya in the image with the sura/aya label
shown in the overlay. If they match, continue to the next page. If they do not
match, the numbering probably shifted on the previous page or earlier on the
current page. Go back and scan line by line until you find the first incorrect
separator or label.

Most corrections fall into these cases:

- A separator mark appears in the wrong place. This is shown as a vertical
dashed line where there is no real aya separator in the page image. Select
that separator and delete it.
- A real aya separator exists in the page image but has no dashed marker. Add a
new separator at that position.
- A line starts too early, starts too late, or has the wrong width. Select the
line and adjust its `x`, `y`, `w`, or `h` values from the side panel.

After fixing the first error, continue reviewing forward. One missed or extra
separator can shift every later aya label in the same sura, so fixing the first
wrong point is usually enough to make the following labels line up again.

## Tuning Guide

### Too Many Or Too Few Lines

- Confirm `Lines / page` matches the Mushaf layout.
- Increase `Header slots` if sura headers occupy more than one normal line slot.
- Check `bounds`; outer decoration or page margins can confuse row projection.
- Inspect `results/line_detection_debug/` if the batch aborts.

### Sura Headers Missed

- Lower `Header thr.` slightly.
- Crop `sura_header` more tightly.
- Define `sura_header_ignore` around changing text or numbers inside the header
template.
- Increase `Max headers` if a page can contain more headers than the current
value.

### False Sura Headers

- Increase `Header thr.`.
- Use a more distinctive `sura_header` template.
- Define a better `sura_header_ignore` if variable content is dominating the
match.
- Use `/verify` to reclassify false header lines.

### Aya Separators Missed

- Lower `Aya thr.` slightly.
- Crop `aya_separator` tightly around the separator ornament.
- Define `aya_separator_ignore` around the inner aya number.
- Disable `Prefer acceleration` if you need stricter masked matching.
- Use `/verify` to add missing separators.

### False Aya Separators

- Increase `Aya thr.`.
- Use a cleaner separator template.
- Check whether dots or ornamental marks resemble the separator.
- Use `/verify` to delete false separators or delete empty segments.

### Crops Have Empty Horizontal Margins

Text line coordinate export uses the union of segment boxes, but you can still
adjust `line_bbox.x` and `line_bbox.w` in `/verify`. Separator cuts are clamped
inside the line box, and segments are regenerated from:

```text
line_bbox + separator_cuts
```

If a cut falls outside the edited line box, normalization drops it.

## PDF Helper Script

`script/pdf_to_pngs.py` converts PDFs in `data/` to 300-DPI PNG pages:

```bash
uv run script/pdf_to_pngs.py
```

The script expects:

```text
data/*.pdf
```

and writes:

```text
data/<pdf-name-without-extension>/001.png
data/<pdf-name-without-extension>/002.png
...
```

## API Overview

Main endpoints:


| Endpoint                                      | Method | Meaning                                                 |
| --------------------------------------------- | ------ | ------------------------------------------------------- |
| `/upload`                                     | GET    | Main processing UI.                                     |
| `/verify`                                     | GET    | Visual review/correction UI.                            |
| `/finalize`                                   | GET    | Final line cut review UI.                               |
| `/api/suras`                                  | GET    | Built-in sura metadata.                                 |
| `/upload/`                                    | POST   | Process uploaded images and templates.                  |
| `/api/review/status`                          | GET    | Whether review data exists.                             |
| `/api/review/results?source=latest\|original` | GET    | Load review coordinates (latest or original).           |
| `/api/review/pages/{filename}`                | GET    | Serve saved original page images for review.            |
| `/api/review/save`                            | POST   | Save corrected review JSON.                             |
| `/api/cut-review/status`                      | GET    | Whether cut review data exists.                         |
| `/api/cut-review/results`                     | GET    | Load source coordinates, cut edits, and merged results. |
| `/api/cut-review/save`                        | POST   | Save cut edit JSON and final coordinate JSON.           |
| `/api/cut-review/export`                      | POST   | Export final transparent line PNGs.                    |


## Development

Useful checks:

```bash
uv run ruff check .
uv run mypy .
uv run python -m unittest
```

Note: `mypy .` may report issues in experimental/helper scripts if they are not
kept type-clean.

## Known Limits

- Processing is synchronous; full Mushaf runs can take time.
- The crop/template settings are global for the submitted batch.
- Highly decorated first pages may still need special handling or manual review.
- A line-count mismatch aborts the batch so parameters can be fixed before later
pages drift.
- Review correction depends on a coordinate export and saved original page
copies from the same run.
