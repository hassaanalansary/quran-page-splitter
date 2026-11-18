# One stored fingerprint set per mushaf

Settled with the user on 2026-11-17/18, in a Windows session that ended with the move to Ubuntu. Build it on this branch after the Celery branch is merged in. Nothing of it is built yet.

## 0. Summary

Ink's requests (`library/compare` on every selected blob, `types` on every typing change, processing a page) need the fingerprint library. Today it is **never stored**:

- **Rebuilt per request.** Each request rebuilds "every confirmed page but this one" from every confirmed blob: 4.1 s at 27 confirmed pages, growing with every page.
- **Held only in memory.** Each process keeps 2 libraries in memory, and a restart loses them.
- **Paid again and again.** Every Confirm, every reopened confirmed page and every restart pays the build, and with Celery each of the 4 server processes pays it separately.

Commit `9d4877c` made the warm requests fast: `compare` 2.1 s → 0.24 s, `types` 3.0 s → 0.77 s. The cold builds are still there.

This work stores **one fingerprint set per mushaf** in the database and updates it at every Confirm. Requests only read it.

| | Today | After |
|---|---|---|
| Confirm | 0.7 s | about +0.3 s (placing a page's 1,116 blobs took 0.08 s) |
| First lookup after a Confirm, a reopen, or a restart | 4.1 s, growing with pages | ~0.1–0.3 s, once per process per version |
| Memory per server process | up to ~240 MB | ~30–40 MB |

## 1. Decisions

| # | Decision |
|---|---|
| 1 | One set per mushaf, in the database, updated at every Confirm. Every page reads the same set, **its own blobs included**: a fingerprint is just an example of a shape. |
| 2 | Fingerprints **never move by themselves**. A from-scratch rebuild after adding one page replaced 44–52 of the 276 fingerprints, so a fingerprint changes only on Rebuild, on Remove, or when its page is re-confirmed with a different label. |
| 3 | Store only each fingerprint and its **up to 11 kept shapes** (2,446 rows at 27 pages, roughly flat as pages grow). No member list, no counts. The "All members" button and its endpoint go. Guesses only ever used the kept shapes. |
| 4 | **Letter fingerprints stay.** On pages 18–27, body-or-mark got 4 of 10,419 blobs wrong with them, and 66 with a mark-only cutoff even when the cutoff was chosen in hindsight. |
| 5 | **Remove** deletes a shape from the set and records its blob in a removed list, so a Rebuild never brings it back and Restore is possible. **Looks right** is a true/false field on the shape. A **wrong label** is fixed on its source page through "open its source", because the export reads the page; the re-confirm updates the set. |
| 6 | Processing a page that is **already confirmed** hides that page's own shapes for the run, so its first guesses stay an honest test for the readiness meter. The page's decisions come back from its earlier draft anyway. Editing never hides anything. |
| 7 | **Rebuild** regroups from the confirmed pages, as `build_library` does today: removed blobs are left out and looks-right blobs are seeded as fingerprints. It runs on a LIMIT or comparison change, a `FEATURE_VERSION`/`LIBRARY_VERSION` change, a failed check, or the user's button, **as a background job** (`jobs/kinds/`). The old set serves until the new one commits. |
| 8 | A failed consistency check never blocks a Confirm. The set is flagged `needs_rebuild`, and Library mode shows a banner with Rebuild. |
| 9 | A copy or an import **carries the set itself**: groups, shapes (snapshot ids remapped), looks-right flags and the removed list. It starts with identical fingerprints and can Rebuild at any time. |
| 10 | `restart_calibration` becomes **a real zero**. After its backup zip it deletes reviews, revisions, the set, the flags, the removed list and the confirmed words. It keeps line snapshots (measurements with no labels), settings and the activity log. |
| 11 | `CalibrationProfile` is dropped. Its job (a receipt of which pages a draft was made from) becomes the set's version number on the draft. |

Considered and rejected:
- **Saving today's per-page libraries**: one per page, still rebuilt per Confirm.
- **A frozen library number per page**: needs a version history, and isn't what fingerprints are for.
- **Rebuilding the one set from scratch on every Confirm**: moves 1 in 6 fingerprints each time, the "surprises" the user wants to avoid.
- **A stand-in fingerprint when hiding a page**: not needed, because guesses compare against all 12 kept shapes of a group, not only its fingerprint.

## 2. How it works

```text
Confirm page P   (inside calibration.save's transaction)
  1. lock the mushaf's FingerprintLibrary row
  2. drop P's shapes whose label changed, whose blob is gone, or that are removed
     a dropped fingerprint → its nearest kept shape takes over (distances re-measured); none left → the group goes
  3. each eligible blob of P (calibration._eligible) not already in the set and not removed:
     nearest fingerprint of its (role, type) within LIMIT → joins it; the spread rule decides whether it is kept
     none within LIMIT → starts a new group as its fingerprint
  4. check: every shape of P matches P's new labels   (a mismatch → needs_rebuild = True)
  5. version += 1

Any request → current_library(mushaf)
  a tiny query for the version: the cached copy is current? use it : load the rows → Library, cache by version
  no set yet (copies from before this change), or a FEATURE/LIBRARY_VERSION change → build it once

Processing an already-confirmed page → current_library(mushaf, hiding_page=P)
  the same rows without P's, restacked (~10 ms), cached per (version, page)
```

**Spread rule.** It replaces `library.spread()`, which needed every member. A group keeps at most 11 shapes besides its fingerprint.
- A newcomer is added while there is room, unless it is an exact copy of the fingerprint.
- When the group is full, the farthest shape stays. Of the others, the one with the smallest distance gap to its neighbour is dropped.
- Looks-right shapes are never dropped. Ties go by blob key.

**Per-page cap: measure only.** The page that starts a group fills it with its own blobs first. Hiding that page (decision 6) can then leave the group nearly empty, even when later pages had good blobs that were never kept. The replay (§5) reports how many groups a hidden page empties and how many guesses change, with and without a cap (at most 4 of the 11 kept from one page). No cap unless the numbers show a real loss. The user's view is that this matters little, since they review the library often.

**Rebuild.**
- Today's `build_library` runs over `confirmed_approvals(mushaf)`, minus removed blobs.
- `group()` takes the looks-right blob keys: the first walk starts from them, and the second keeps them as their own centres.
- The result is converted to stored groups, with `spread()`'s picks plus any looks-right members.

## 3. Data model (one migration, for the user to run)

- `FingerprintLibrary`: one-to-one with Mushaf; `version`, `comparison`, `limit`, `feature_version`, `library_version`, `needs_rebuild`.
- `FingerprintGroup`: library FK, `role`, `subtype`.
- `FingerprintShape`: library FK, group FK, snapshot FK, `blob_id`, revision FK (null, SET_NULL), `is_fingerprint`, `distance` (to its fingerprint), `looks_right`, `features` (binary: the blob's 1,030 numbers, i.e. its 32×32 mask plus 6 geometry values, float64). Unique (library, snapshot, blob_id).
- `RemovedShape`: mushaf FK, snapshot FK, `blob_id`, `role`, `subtype`. It counts while the blob is still confirmed as that role and type.
- Existing `LibraryCheck` rows become `looks_right` at the first build; then drop `LibraryCheck` and `CalibrationProfile`.

There is no blob table: a blob is (snapshot, blob id). Its geometry is in `snapshot.metadata["blobs"]` and its label in the page's confirmed revision payload.

## 4. Code map

New code uses descriptive verb+object names, no `_` functions, and small modules. Rename the `_` functions this work touches (`_approved` → `confirmed_approvals`, `_samples`, `_fusion_table`, `_profile_summary`); the rest of `calibration.py` waits for its own reorganization.

- **Core (pure):** new `backend/core/word_boundary/library_updates.py`.
  - Dataclasses `KeptShape` and `ShapeGroup`.
  - `place_example`, `keep_spread_shapes`, `drop_shape`, `hide_page_shapes`.
  - `library_from_groups`: one stacked matrix, with `reps` as row views of it, so the numbers are held once.
  - `groups_from_library`.
  - `library.py`: `group()`/`build_library()` take looks-right keys.
- **Services:** all new, under `backend/api/services/`.
  - `fingerprint_store.py`: `current_library` (cache by version, `BuildOnce` per key), `load_groups`, `save_groups`, `build_first_library`.
  - `fingerprint_updates.py`: `take_in_confirmation`, `remove_shape`, `restore_shape`, `set_looks_right`, `check_page_in_library`, `check_whole_library`.
  - `fingerprint_rebuild.py`: `rebuild_library`, plus `preview_library(mushaf, limit)` for the LIMIT preview, built in memory and saved nowhere.
- **Job:** new `jobs/kinds/library_rebuild.py`, with `start_library_rebuild_job` and `run_library_rebuild_job` modelled on `jobs/kinds/calibration_page.py`. Add a `ProcessJobKindChoices` entry, register it in `JOB_RUNNER_PATHS`, and include it in the calibration job kinds so Ink's job polling sees it.
- **Wiring, in `calibration.py`:**
  - `profile_for`/`_library`/`_library_of`/`_LIBRARIES`/`LIBRARY_BUILDS` → `current_library`.
  - `process_page` uses `hiding_page` for confirmed pages, and the draft records `library: {version, pages, fingerprints, limit, hid_own_page}`.
  - The fusion table comes from every confirmed page.
  - `save(confirm=True)` calls `take_in_confirmation`.
- **Elsewhere:**
  - `retype_from_text` calls `take_in_confirmation` per page it re-confirms.
  - The real-zero restart.
  - `bundle.serialize_calibration`/`restore_calibration` and `cloning` carry the set.
  - Applying a LIMIT in `save_settings` starts the rebuild job.
  - `_FEATURES_MAX` 256 → 64.
  - New commands `rebuild_library` and `check_library`.
- **Library mode, backend:** `library_document` comes from the stored set.
  - Adds `version`, `pages`, `draft_version`, `needs_rebuild`, `rebuilding`, `removed`.
  - Drops `left_out`, `draft_pages`, `examples`, `count`.
  - Checks endpoint: Remove, Restore and Looks right; new `POST …/library/rebuild`.
  - `library_members` is deleted.
- **Library mode, frontend:** `LibraryView.tsx`, `lib/calibration/types.ts`, `lib/api/calibration.ts`.
  - Header "Library v63 · N confirmed pages", plus a "draft from an older library" note.
  - Remove and Looks right on each shape, a "Removed (n)" row with Restore, and the needs-rebuild/rebuilding banner.
  - No ×count, no "All members".
  - `en.ts` and `ar.ts` get the same keys, and the two catalogs are diffed.

## 5. Verification

- `uv run python manage.py test --parallel 4 --noinput` on Postgres `test_quran`, one run at a time; `ruff check` and `ruff format`.
- `npx tsc --noEmit` and `npx eslint` only; the user builds the frontend.
- New `backend/api/tests/test_fingerprint_library.py`:
  - Confirm grows the set and bumps the version;
  - a re-confirm with a retyped mark swaps its shape;
  - Remove promotes the next shape and Restore re-adds it;
  - requests never build;
  - processing a confirmed page hides its shapes;
  - a LIMIT apply rebuilds and keeps looks-right;
  - a copy carries an identical set;
  - restart leaves nothing behind;
  - a failed check sets `needs_rebuild`.
- Update the tests that assume a page never sees itself: `test_calibration_library.py`, `test_calibration_library_cache.py`, `test_calibration_api.py`, `test_calibration_persistence.py`.
- **Replay on real data** (`wl-out/library/replay_incremental.py`), for each page in a run of confirmed pages:
  - the set grown Confirm by Confirm against a from-scratch build of the same earlier pages;
  - each page answered with its own shapes hidden, with and without the per-page cap;
  - body-or-mark and type guesses checked against the confirmed labels;
  - Confirm and first-load times;
  - the blobs the two answer differently, listed so the user can look at them as images, not just counts.
- The user's live check:
  - confirm, then open the next page: the first blob click should be fast;
  - restart the server: the first lookup should take well under a second;
  - Remove, Restore and Looks right;
  - preview and apply a LIMIT;
  - copy a mushaf.

## 6. Open

- **`docs/ENGINES_FLOW.md`:** its passage on `profile_for` ("other than the page itself") goes stale. Discuss with the user before touching it; the doc only takes "continue the flow" additions.
- **Then the real-zero restart** and a fresh walkthrough on the new approach.
