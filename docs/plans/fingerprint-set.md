# One stored fingerprint set per mushaf

Settled with the user on 2026-11-17/18, in a Windows session (`1a3b5dc9`) that ended with the move to Ubuntu. The Celery branch was merged into this branch on 2026-11-18 (`b17218c`). Being built from 2026-11-18, with the names in §4.1 and the choices in §7.

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
Confirm page P   (inside calibration_saving.confirm_page's transaction)
  1. lock the mushaf's FingerprintLibrary row
  2. drop P's shapes whose label changed, whose blob is gone, or that are removed
     a dropped fingerprint → its nearest kept shape takes over (distances re-measured); none left → the group goes
  3. each eligible blob of P (is_blob_eligible_for_library) not already in the set and not removed:
     nearest fingerprint of its (role, type) within LIMIT → joins it; the spread rule decides whether it is kept
     none within LIMIT → starts a new group as its fingerprint
  4. check: every shape of P matches P's new labels   (a mismatch → needs_rebuild = True)
  5. version += 1

Any request → load_current_library(mushaf)
  a tiny query for the version: the cached copy is current? use it : load the rows → Library, cache by version
  no set yet (copies from before this change), or a FEATURE/LIBRARY_VERSION change → build it once

Processing an already-confirmed page → load_current_library(mushaf, hiding_page=P)
  the same rows without P's, restacked (~10 ms), cached per (version, page)
```

**Spread rule** (`keep_spread_shapes`). It replaces `library.pick_spread_members()` (was `spread()`), which needed every member. A group keeps at most 11 shapes besides its fingerprint.
- A newcomer is added while there is room, unless it is an exact copy of the fingerprint.
- When the group is full, the farthest shape stays. Of the others, the one with the smallest distance gap to its neighbour is dropped.
- Looks-right shapes are never dropped, and they count toward the 11. A newcomer that can't displace anything is not kept.
- "Neighbour" means the next kept shape when they are sorted by distance to the fingerprint. An exact copy is within `_EXACT` (1e-6), as before.
- On a tie the newcomer goes, so the kept shapes don't churn; then by blob key.

**Per-page cap: measure only.** The page that starts a group fills it with its own blobs first. Hiding that page (decision 6) can then leave the group nearly empty, even when later pages had good blobs that were never kept. The replay (§5) reports how many groups a hidden page empties and how many guesses change, with and without a cap (at most 4 of the 11 kept from one page). No cap unless the numbers show a real loss. The user's view is that this matters little, since they review the library often.

**Rebuild.**
- Today's `build_library` runs over `find_confirmed_revisions(mushaf)`, minus removed blobs.
- `group_examples()` takes the looks-right **fingerprint** keys: the first walk starts from them, and the second keeps them as their own centres. Looks-right kept members join their nearest group and are never dropped from it (§7 choice 7).
- The result is converted to stored groups, with `pick_spread_members()`'s picks plus any looks-right members.
- A Confirm that lands while the Rebuild computes is placed onto the new groups at commit, under the set's row lock (§7 choice 8).

## 3. Data model (one migration, for the user to run)

- `FingerprintLibrary`: one-to-one with Mushaf; `version`, `comparison`, `limit`, `feature_version`, `library_version`, `needs_rebuild`.
- `FingerprintGroup`: library FK, `role`, `subtype`.
- `FingerprintShape`: library FK, group FK, snapshot FK, `blob_id`, revision FK (null, SET_NULL), `is_fingerprint`, `distance` (to its fingerprint), `looks_right`, `features` (binary: the blob's 1,030 numbers, i.e. its 32×32 mask plus 6 geometry values, float64). Unique (library, snapshot, blob_id).
- `RemovedShape`: mushaf FK, snapshot FK, `blob_id`, `role`, `subtype`. It counts while the blob is still confirmed as that role and type.
- Existing `LibraryCheck` rows become `looks_right` at the first build; then drop `LibraryCheck` and `CalibrationProfile`.

There is no blob table: a blob is (snapshot, blob id). Its geometry is in `snapshot.metadata["blobs"]` and its label in the page's confirmed revision payload.

## 4. Code map

Every function this work touches, or that new code calls from another module, gets a verb+object name, and no `_` functions remain in touched code (the rule the Celery plan applied to the job system). Old → new is in §4.1. Untouched code in `calibration.py` waits for its own reorganization.

- **Core (pure):** new `backend/core/word_boundary/library_updates.py`.
  - Dataclasses `KeptShape` and `ShapeGroup`.
  - `place_example_in_groups`, `keep_spread_shapes`, `drop_shape_from_group`, `hide_shapes_of_page`.
  - `build_library_from_groups`: one stacked matrix, with `reps` as row views of it, so the numbers are held once.
  - `convert_library_to_groups`.
  - `library.py`: `group_examples()`/`build_library()` take looks-right keys.
- **Services:** all new, under `backend/api/services/`.
  - `fingerprint_store.py`: `load_current_library` (cache by version, `BuildOnce` per key), `load_stored_groups`, `save_stored_groups`, `build_first_fingerprint_set`, `describe_library_for_draft`, `read_library_record`.
  - `fingerprint_updates.py`: `add_confirmed_page_to_library`, `remove_shape_from_library`, `restore_removed_shape`, `set_shape_looks_right`, `check_page_shapes_match_labels`, `check_every_shape_matches_labels`.
  - `fingerprint_rebuild.py`: `rebuild_fingerprint_set`, plus `build_preview_library(mushaf, limit)` for the LIMIT preview, built in memory and saved nowhere.
- **Job:** new `jobs/kinds/library_rebuild.py`, with `start_library_rebuild_job` and `run_library_rebuild_job` modelled on `jobs/kinds/calibration_page.py`. Add a `ProcessJobKindChoices` entry, register it in `JOB_RUNNER_PATHS`, and include it in the calibration job kinds so Ink's job polling sees it.
- **Wiring, in `calibration.py`:**
  - `profile_for`/`_library`/`_library_of`/`_LIBRARIES`/`LIBRARY_BUILDS` → `load_current_library`.
  - `make_fresh_draft_of_page` (was `process_page`) uses `hiding_page` for confirmed pages, and the draft records `library: {version, pages, fingerprints, limit, hid_own_page, mode}` in place of `profile`. `read_library_record` reads an old draft's `profile` the same way.
  - The fusion table comes from every confirmed page.
  - `calibration_saving.confirm_page` (was `save(confirm=True)`) calls `add_confirmed_page_to_library`.
- **Elsewhere:**
  - `retype_from_text` calls `add_confirmed_page_to_library` per page it re-confirms.
  - The real-zero restart.
  - `bundle.serialize_calibration`/`restore_calibration` and `cloning` carry the set.
  - Applying a LIMIT in `save_calibration_settings` starts the rebuild job; refused while another job runs on the mushaf (§7 choice 9).
  - `FEATURES_CACHE_MAX` (was `_FEATURES_MAX`) 256 → 64.
  - New commands `rebuild_library` and `check_library`.
- **Library mode, backend:** `serialize_library_view` (was `library_document`) comes from the stored set.
  - Adds `version`, `pages`, `draft_version`, `needs_rebuild`, `rebuilding`, `removed`.
  - Drops `left_out`, `draft_pages`, `examples`, `count`.
  - Checks endpoint: Remove, Restore and Looks right; new `POST …/library/rebuild`.
  - `library_members` is deleted.
- **Library mode, frontend:** `LibraryView.tsx`, `lib/calibration/types.ts`, `lib/api/calibration.ts`.
  - Header "Library v63 · N confirmed pages", plus a "draft from an older library" note.
  - Remove and Looks right on each shape, a "Removed (n)" row with Restore, and the needs-rebuild/rebuilding banner.
  - No ×count, no "All members".
  - `en.ts` and `ar.ts` get the same keys, and the two catalogs are diffed.

### 4.1 Old name → new name

**Rule:** a touched function gets a verb+object name; an underscore function that new code calls from another module becomes public. The renames land first, in their own commit, with no behaviour change.

| Today | New | Module |
|---|---|---|
| `_approved(mushaf, page)` | `find_confirmed_revisions_except_page`, then `find_confirmed_revisions(mushaf)` once the page exclusion goes | `calibration.py` |
| `_approvals(mushaf)` (unused) | deleted | `calibration.py` |
| `approvals_with_payloads` | `load_revision_payloads` | `calibration.py` |
| `_approval(review)` | `find_confirmed_revision_of_review` | `calibration.py` |
| `_eligible` | `is_blob_eligible_for_library` | `calibration.py` |
| `_samples` | `collect_library_examples` | `calibration.py` |
| `_typed`, `_typed_samples` | `is_mark_typed`, `collect_typed_marks_of_draft` | `calibration.py` |
| `_apply_edits` | `apply_edits_to_draft` | `calibration.py` |
| `_refuse` | `refuse_request` | `calibration.py` |
| `_record`, `_require_context` | `build_revision_record`, `refuse_if_context_lines_changed` | `calibration.py` |
| `_fusion_table`; `_FUSIONS`, `_FUSIONS_MAX`, `take_cached_fusions` | `load_fusion_table`; `FUSION_TABLES`, `FUSION_TABLES_MAX`, `take_cached_fusion_table` | `calibration.py` |
| `process_page` | `make_fresh_draft_of_page` | `calibration.py` |
| `save(…, confirm=)`, `_request_hash` | `save_page_draft`, `confirm_page` (sharing `read_reviewer_edits` and the steps below it), `hash_save_request` | new `calibration_saving.py` |
| `type_suggestions`, `_apply_text_types` | `suggest_mark_types`, `apply_text_types_to_draft` | `calibration.py` |
| `settings_document`, `save_settings` | `serialize_calibration_settings`, `save_calibration_settings` | `calibration.py` |
| `_LIBRARIES`, `_LIBRARIES_MAX`, `LIBRARY_BUILDS`, `take_cached_library`, `_library_of`, `profile_for`, `_library`, `_profile_summary` | deleted → `fingerprint_store.load_current_library`, `describe_library_for_draft` | |
| `_preview`, `_PREVIEW` | `build_preview_library` (moves to `fingerprint_rebuild.py`), `PREVIEW_LIBRARIES` | `calibration_library.py` |
| `_library(mushaf, page, limit)` | `choose_library_to_show` | `calibration_library.py` |
| `_key`, `_group_id`, `_ordered` | `blob_key_of`, `group_id_of`, `order_groups_for_audit` | `calibration_library.py` |
| `_Shapes`, `.of` | `ShapeImages`, `.describe_shape` | `calibration_library.py` |
| `library_document`, `compare` | `serialize_library_view`, `compare_blob_with_library` | `calibration_library.py` |
| `library_members`, `MEMBERS_PAGE`, `set_check`, `clear_check` | deleted (`fingerprint_updates.set_shape_looks_right`) | `calibration_library.py` |
| views `calibration_library`, `calibration_library_compare`, `calibration_settings` | `get_calibration_library`, `compare_blob_with_calibration_library`, `save_calibration_settings` | `views/calibration.py` |
| views `calibration_library_members`, `put_library_check`, `delete_library_check` | deleted → `set_library_shape_looks_right`, `remove_library_shape`, `restore_library_shape`, `start_library_rebuild` | `views/calibration.py` |
| `bundle.build`, `_portable_profile`, `_remap_snapshot_refs` | `build_mushaf_bundle`, deleted, `remap_snapshot_ids` | `bundle.py` |
| `restart_calibration`'s `handle` body | `back_up_calibration`, `delete_calibration_labels` | new `calibration_restart.py` |
| `retype_from_text._renamed`, `._retype` | `find_marks_the_text_retypes`, `retype_marks_in_document` | the command |
| `_FEATURES`, `_FEATURES_MAX` | `FEATURES_CACHE`, `FEATURES_CACHE_MAX` | `calibration_snapshots.py` |
| `group`, `_walk`, `_typical` | `group_examples`, `assign_examples_to_fingerprints`, `find_typical_member` | `core/word_boundary/library.py` |
| `spread`, `kept`, `_ref_of` | `pick_spread_members`, `list_kept_shapes`, `reference_of_example` | `core/word_boundary/library.py` |
| `Library._distances` | `Library.measure_distances` | `core/word_boundary/library.py` |

Unchanged: `serialize_calibration`, `restore_calibration`, `apply_bundle`, `build_library`, the command names. One comment in the frozen `core/word_boundary/calibration.py` still says ``calibration._fusion_table``; it is left alone.

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

## 7. Choices taken (2026-11-18, all defaults)

1. `save` is split into `save_page_draft` and `confirm_page` (new `calibration_saving.py`).
2. `_refuse` is renamed `refuse_request` everywhere.
3. The renames land in their own commit first.
4. One migration drops `LibraryCheck` and `CalibrationProfile`. The new Docker database holds no checks, and bundles never carried them.
5. The replay script is written here; the user runs it once enough pages of the new mushaf are confirmed.
6. Spread rule: as in §2 (neighbour by sorted distance, exact = 1e-6, looks-right counts toward the 11 and is never dropped).
7. A Rebuild seeds only looks-right *fingerprints* as centres; looks-right members join their nearest group and stay kept.
8. A Confirm during a Rebuild is placed onto the new groups at commit.
9. Applying a LIMIT while another job runs on the mushaf is refused with the "a job is running" message.
10. A doubt on a typed mark that is itself a kept shape compares against the whole set, its own shape included (as settled: no second opinion on a confirmed page).
11. A bundle's set replaces the target's only when the target has no confirmed pages of its own; otherwise the target's set is deleted and built again at the next lookup.

## 8. Settled in the session, not written above

- **No second opinion on a confirmed page.** Its kept shapes match themselves, so suggestions and doubts can echo its labels. Accepted: the periodic Library review replaces that check. Only kept-shape blobs are affected (2,446 of 25,756); other marks still get a real doubt.
- **A page's own typed marks** (`Library.with_typed`) skip any mark already in the set as a kept shape, so it doesn't count twice toward a type's `support`.
- **Old bundles** carry `profiles` and no set: `profiles` is ignored, and the set is built at the first lookup (`build_first_fingerprint_set`). That is how the other mushafs come over after the move to Ubuntu.
- **The measurement scripts** behind §0 and §1 (`measure_one_set.py`, `measure_reshuffle.py`, `letters_or_not.py`, `count_by_type.py`) lived in the Windows scratchpad, never in `wl-out/`. They were recovered from the session transcript for the replay.
- **No Redis.** One version query per request keeps every process current.

