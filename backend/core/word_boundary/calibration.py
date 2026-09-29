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
