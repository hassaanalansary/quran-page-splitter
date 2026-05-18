# Protected Header/Basmala Line Detection Plan

## Summary

Implement pre-line-detection template matching for sura headers and optional basmala, then protect those bands from valley splitting. Sura headers remain one output crop but consume configurable layout slots, default `1`.

Locked decisions:

- Header mask mode: one ignore rectangle.
- Header crop mode: free crop; backend supports 2D matching, while full-width crops naturally become vertical-only scans.
- Basmala template: optional.
- `sura_header_slots`: default `1`.

## Key Interface Changes

- Add `LineResult.slot_count: int = 1`; validation changes from `len(ctx.lines) == expected_lines` to `sum(line.slot_count for line in ctx.lines) == expected_lines`.
- Add upload fields:
  - Required/compatible: sura header template, aya separator template.
  - Optional: basmala template.
  - Optional ignore metadata: `sura_header_ignore_x/y/w/h`, `aya_separator_ignore_x/y/w/h`.
  - Numeric controls: `sura_header_slots` default `1`, `sura_header_threshold` default `0.60`, `basmala_threshold` default `0.70`, `max_sura_headers` default `3`.
- Frontend crop modes become: `bounds`, `sura_header`, `sura_header_ignore`, `basmala`, `aya_separator`, `aya_separator_ignore`.

## Implementation Changes

- Add a pre-split template locator:
  - Prepare grayscale template and optional mask from ignore rectangle.
  - Run `cv2.matchTemplate(..., cv2.TM_CCOEFF_NORMED, mask=mask)` on the cropped page.
  - Accept peaks above threshold with vertical non-maximum suppression around one template height.
  - Return protected full-width bands with `kind`, `top`, `bottom`, `score`, and `slot_count`.
  - Detect up to `max_sura_headers` headers per page.
  - Search for at most one basmala below each detected header, before the next header or page end.

- Update line detection flow:
  - Run header/basmala locator before valley splitting.
  - Create `LineResult` objects directly for protected bands, marked `is_sura` or `is_basmala`.
  - Split only unprotected text regions using the existing valley splitter.
  - Allocate remaining slots across text regions by trimmed ink height, then adjust allocations so protected slots + text slots equal `expected_lines`.
  - If no protected bands are found, preserve current global valley behavior.

- Update downstream pipeline:
  - Remove the normal post-split `SuraClassifier.classify(ctx)` call from the main path.
  - Keep existing sura tracking behavior based on `line.is_sura`.
  - Skip aya separator detection for both `is_sura` and `is_basmala` lines.
  - Update debug/error reporting to include exported band count, total slot count, per-line height, and per-line slot count.

- Update frontend:
  - Store template crop rects as metadata, not only blobs.
  - For ignore targets, require the related template crop to exist and convert the drawn crop to template-relative coordinates.
  - Add status pills for header, header ignore, basmala, aya, and aya ignore.
  - Add optional basmala upload and the numeric detection controls above.
  - Preserve existing bounds/template upload flow.

## Test Plan

- Unit-style checks:
  - Mask creation from ignore rectangle.
  - Header locator detects multiple headers and suppresses duplicate peaks.
  - Basmala locator finds one basmala below each header and handles absence.
  - Slot validation uses `sum(slot_count)`, not output line count.

- Regression pages:
  - `data/quran-hafs-mushaf/563.png`: no tiny final crop; header/basmala protected.
  - `data/shamarli/042.png`: sura decoration not split internally.
  - `data/almadinah-kabir-azraq/054.png`: header decoration not cut in half.
  - `data/shamarli/522.png`: supports up to 3 headers on one page.

- Verification commands:
  - `.\.venv\Scripts\python.exe -m ruff check .`
  - `.\.venv\Scripts\python.exe -m mypy .`
  - Manual upload through the UI with representative pages and saved templates.

## Assumptions

- Templates are taken from the same mushaf style and roughly the same scale as processed pages.
- Header output remains one crop even when `sura_header_slots > 1`.
- Basmala detection is best-effort when template is provided; absence does not block processing.
- If protected-band allocation becomes impossible, the page should fail line-geometry validation instead of silently exporting misleading crops.
