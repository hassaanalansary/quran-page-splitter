"""The tuning surface, and the measurements that justify each number.

Alone in a file because these are the knobs. Every one of them was arrived at by
measuring, and the evidence is recorded beside it — read that before changing
one. Nothing here is a threshold or a gate: the weights price a reading, they
never forbid it.
"""

from __future__ import annotations

#: Ceiling on live DP states per segment. A line that needs more than this is
#: not being parsed, it is being searched, so the segment gives up and says so
#: rather than burning the run.
MAX_LIVE_STATES = 4096
#: With the fingerprint library's prices, a reading already this much dearer than the
#: best one at the same point of the line is dropped: it could only win if every
#: cheaper reading later paid that much more — three words off their count. Those
#: prices make a role nearly fixed, so the one way left to absorb a PAW too few or too
#: many is a word off its count, at the same 20 wherever it falls; the readings that
#: put it in each word all tie, nothing prunes them, and pages 15-17 of the first
#: mushaf needed up to 13,685 live states (the frozen prices: 5,869) — so lines hit the
#: ceiling above and were committed early, mid-aya, in the wrong place. Applies only
#: where the library prices a component; the frozen engine searches as it always has.
PRICED_BEAM = 60

# Every weight below is evidence that a component is a letter body rather than a
# mark. Nothing here is a gate: a component can always be read either way, it
# merely costs the distance from what the evidence suggests. Each feature is
# measured against the line's own geometry, so the numbers stay meaningful
# across mushafs and hands. These four weights are the knob to tune.
#
#: Spans the densest row — the writing line itself. The strongest single signal:
#: letters sit on the line, a fatha hangs above it and a kasra below.
SCORE_CROSSES_WRITING_LINE = 6
#: Share of the **band** the component covers — not the share of the component
#: that lies inside it. Dividing by the component's own height punished a letter
#: for being tall: an alef 52px high with 12px inside a 16px band scored 0.23 of
#: this weight while a 16px tashkeel sitting squarely on the line scored 0.94, so
#: the mark outscored the letter it displaced. Measured on p602:l3, where the
#: real alef came to 9 and the mark to 11.
SCORE_BAND_OVERLAP = 3
#: Area against the typical area of components that do cross the writing line.
SCORE_RELATIVE_AREA = 3
#: Height against the band's height.
SCORE_RELATIVE_HEIGHT = 2
BODY_SCORE_MAX = SCORE_CROSSES_WRITING_LINE + SCORE_BAND_OVERLAP + SCORE_RELATIVE_AREA + SCORE_RELATIVE_HEIGHT
# What the scale actually does, measured over pages 151-160 (148 lines, 10,177
# components): the scores come out bimodal with an empty gap at 7-9, and only 76
# components land on a score where both roles occur. So the score decides almost
# nothing on its own — its whole job is pricing that contested 0.7%, where 31
# mark-looking components were committed as letters because the word count
# demanded it and 45 letter-looking ones were dropped.
#
# Influence of each weight, by how many of 1200 word cuts move when it changes:
#
#     CROSSES_WRITING_LINE   -> 0: 508    x2:  15   dominant, and saturated:
#                                                   doubling it changes nothing,
#                                                   only its dominance matters
#     RELATIVE_AREA          -> 0: 302    x2: 618   strong but volatile; at 6 it
#                                                   starts overruling position,
#                                                   which is the size-gate
#                                                   failure creeping back in
#     BAND_OVERLAP           -> 0: 164    x2: 168   responsive in both directions
#     RELATIVE_HEIGHT        -> 0:  85    x2:  48   weakest, as intended
#
# Read that as influence, not correctness — a moved cut is not necessarily a
# broken one. It says the ordering 6 > 3 = 3 > 2 is right and that two of the
# four sit on flat ground, not that these are the best four numbers.

#: Price of a word taking one blob more or fewer than its spelling demands. Set
#: well above BODY_SCORE_MAX so exact PAW accounting always wins where it is
#: available, and reinterpreting components is preferred to miscounting.
COUNT_WEIGHT = 20
#: How far a word may stray from its expected PAW count. This is what lets a
#: fused word be parsed at a price instead of collapsing the line: a genuine
#: merge costs one deviation and the rest of the aya continues undisturbed.
COUNT_SLACK = 2
#: Ceiling on what it costs to leave a component out of every word. See
#: Blob.cost_as_mark — this is the calibration knob that decides how readily the
#: parser tolerates a spurious stroke instead of inventing a word to absorb it.
MAX_UNUSED_COMPONENT_COST = 6

#: What it costs to read a blob against the fingerprint library's answer when the
#: library is sure (``Blob.library_*``): dearer than a word one PAW off its count plus
#: the mark cap (20 + 6), so two PAWs printed touching leave their word a PAW short —
#: flagged — instead of promoting the nearest mark to make up the count, which the
#: body score's prices (at most 14 against 20) always did.
SURE_PRICE = 40
#: The confidence from which the library counts as sure. Its confidence,
#: (far - near) / (far + near), runs low even when it is right: over pages 15-17 of the
#: first mushaf it was right on all 2,804 blobs, yet half its answers scored under
#: 0.49 and a tenth of the marks under 0.37 — and priced in proportion to that, a
#: right kasra at 0.36 still lost to a missing PAW and was promoted. 95% score 0.19 or
#: more. Below this the price falls in proportion, so a truly torn answer — a
#: letter's broken-off fragment, as like a mark as a letter — still bends cheaply.
#: Replayed against the reviewed drafts: wl-out/shapes/REPORT.md §16.
SURE_CONFIDENCE = 0.2
#: The most a word's missing PAW is made cheaper by how likely its joins are to be
#: printed touching (``WordInput.short_weight``): COUNT_WEIGHT - FUSION_DISCOUNT x the
#: chance that one of them is. Every word of a stretch otherwise pays the same 20 for
#: a missing PAW, and which one comes up short is a tie the search settles by reaching
#: it first; the discount puts it where a touching pair is likely. The chance comes
#: from the confirmed pages, join by join (``calibration._fusion_table``): on the first
#: mushaf's pages 1-14 a ر touched the next piece of its word 9 times in 33 before a و,
#: 13 in 194 overall, a و 3 in 557 — and no letter ever touched across the space
#: between two words, in 1,493. Never below 8: a missing PAW stays dearer than any
#: exact reading. Replayed against reviewed drafts: wl-out/shapes/REPORT.md §16.
FUSION_DISCOUNT = 12

#: Taken off a component that sits wholly inside a much larger one's box. Such a
#: blob is almost always that letter's own diacritic lying in its sweep — the
#: kasra of ``مِّن`` inside the bowl of its ``ن``, which was read as a letter and
#: shifted the rest of the line. "Sits on the writing line" says nothing when it
#: is sitting on it *inside another letter*, so this cancels most of
#: SCORE_CROSSES_WRITING_LINE rather than forbidding the reading: a small letter
#: genuinely can sit under a sweeping tail, and containment predicts a misread
#: line only 2-3x more often than not on measured pages.
SCORE_NESTED_IN_A_BODY = 4
#: How much smaller than its container a blob must be to count as nested. A
#: letter under a tail is comparable in size; a diacritic is not.
NESTED_AREA_FRACTION = 0.35
