# Calibration Review

## The Three Actions

| Action | What it does | Teaches later pages? |
| --- | --- | --- |
| Save draft | Keeps unfinished edits | No |
| Preview | Recalculates affected ayat using your decisions; accept or discard | No |
| Confirm page | Saves approved words and makes the page's labels available as examples | Yes |

After confirming, open the next page and press **Process page**. Its predictions
use earlier confirmed pages immediately; there is no separate training job.
Existing processed pages are not silently rewritten. A page never teaches itself.

## Enable Automatic Application

Turn on **Apply learning to new pages (experimental)** under *Page · learning*,
then accept its warning. This is an opt-in, not an accuracy certification.

With it on, new pages use sufficiently confident body/mark predictions before
alignment. Five distinct nearby descriptor groups must agree and be separated
from opposite-class examples. Experimental mode permits support from one earlier
confirmed page, so page 1 can help page 2. Repeated identical dots do not count as
five independent examples. Insufficient evidence leaves the frozen search in charge.

Your labels always take precedence. Automatic locks can be released by the existing
aya retry when they prevent a valid boundary reading. Exact PAW counts do not prove
the result is correct. Review every page.

Turning the switch off affects newly processed pages, not historical readings.
The page's mode note reports how that page was processed, separately from the
switch's setting for future pages. Copies/imports start with application off.

## When Is It Enough — and Where Do Pages Get Processed?

There are two ways a page gets its word boxes, both in the **Words** step:

```
 Cuts       run the engine over a sura, a range or the whole mushaf at once
            → every page's boxes; you fix the flagged lines by hand
            → the frozen engine only: it learns nothing from calibration
 Calibrate  one page at a time: Process page → correct → Confirm page
            → that page's boxes (confirming writes them) + examples for the next
            → with the learning switch on, each new page starts from them
```

What calibration learns today is **body or mark**, which is what word boxes depend
on: the PAW count of a word is the number of bodies it owns. **Mark types teach the
word engine nothing yet** — they are data for later rules and for their own sake.
Typing every mark does not make the next page's words any better.

It is *enough* when a new page comes out needing (almost) nothing: open **How
calibration would do** at the bottom of the panel. For each confirmed page it lays
the frozen engine, the engine's own full-line reading, and the calibrated reading —
each made before you touched the page — against what you confirmed, and counts body
and mark mistakes and words moved, missing or on the wrong line. When the
*calibrated* column is near zero for several pages in a row, and its pictures agree,
learning is doing the work. While it still equals the engine's own column, the
examples are not helping yet — pages 1 and 2 of a Madina mushaf are printed smaller
than the rest, so the first ordinary pages teach the most.

Processing many pages *with* calibration at once does not exist yet: a Cuts run
ignores it, and Calibrate processes one page at a time. That is the step to build
once the evaluation says learning is good enough.

## Edit Efficiently

1. In **Blobs**, the filter says what a click, a drag and the arrow keys may pick:
   **All blobs**, **Marks only**, **Bodies only** — or one **mark type**, whose marks
   (typed or only expected) are painted blue with everything else faded; **Not typed
   yet**; or **Doubtful** (see below). Choosing *fatha* and walking through its marks
   is the quick way to catch a madda or a wasla that is not what it says.
2. With a kind of mark shown, a band under the toolbar says how many there are and
   how many of them are only expected. **Clicks pick the faded ink too** lets a click
   or a rectangle reach a mark the filter missed — a fatha expected as something
   else — so it can be fixed in place; the arrow keys still visit only what is
   shown. **Accept the N expected** types every shown mark that is only expected, on
   the whole page, in one undoable step: fix the wrong ones first, then accept the rest.
3. Click a blob, or press **←**. The bar under the lines, always the same height,
   says everything about the selection in three panes:

   ```
   what it is                   │ its word              │ [Which type?] [Body or mark?]
   picture · role · type        │ word · aya · PAWs     │ the nearest examples,
   where · who decided          │ assign · share        │ as pictures
   doubt · flags                │ unattach · flag       │
   Body Mark · 1…9 0 · Accept   │ take back             │
   ```
4. **← →** move blob by blob through what the filter lets through (left is onward,
   as Arabic reads); **↑ ↓** move to the line below or above; **Shift+← →** add the
   next blob on the line to the selection; **Ctrl+← →** select a whole word's ink,
   word by word across the page — so do the arrows above the word list, and a word
   in the list selects that word and brings it into view.
5. **B** body, **M** mark. **1–9, 0** type the selected marks: 1 fatha, 2 damma,
   3 kasra, 4 sukun, 5 shadda, 6 madda, 7 wasla, 8 hamza, 9 dagger alif, 0 i'jam
   dot; the other types are under *More…*. **A** accepts the expected type. **R** takes
   the selected word's box from its ink again. **N** /
   **Shift+N** step through what asks for a look. **Ctrl+Z** undoes, **Ctrl+S** saves.
6. The middle pane holds the rarer decisions: **Assign** gives all selected text blobs
   to a word without changing their roles (bodies contribute PAWs, marks zero);
   **Share** splits one body printed across a word break; **Unassign marks** leaves
   selected marks unattached, and preview and reprocessing keep that; *Out of the
   ordinary*; taking decisions back.
7. **Gallery** (the third mode, beside Blobs and Words) lays the page's marks side by
   side, one group per type — or, with *Body or mark*, all its ink in two groups. It
   replaces a scan of the page per type with one scroll: a madda among fathas, a
   dot among waslas, stands out. Every crop is at one zoom — never stretched to a
   square, which is how the matcher came to take maddas for fathas — so a wider or
   smaller mark still looks it. Within a group, what most needs a look comes first:
   doubts, then unsure guesses; by role, the marks the engine found most like bodies
   and the bodies most like marks. Click a crop to select it (a digit retypes it, B
   and M decide its role), **← →** step crop by crop, **↑ ↓** group by group, and a
   double-click or **Enter** shows it in its line when the crop alone cannot settle
   it. Each type's header has *Accept the N expected* for the rest of its group. The
   toolbar filter narrows the gallery too.

A quick way through a page: accept what is sure; in the gallery, fix the odd ones out
type by type and accept each group; look at what asks for a look (N); preview and step
through the words it moved; play the words, risky ones first; confirm.

Bodies are near-black; marks are teal. Selected bodies have solid outlines, selected
marks dashed outlines, and the bar names the role in words.

Setting a human role resolves old uncertainty/override/disagreement warnings. So does
agreement: the engine's own doubts — a score in the contested band, a first guess the
count overruled, a tie — are not raised when the confirmed examples agree with the role
the blob ended up with, or the text named it (the bar says which). Thin alefs used to
ask on every page; the examples' role proposals were right 4,569 of 4,569 times on the
first mushaf's pages 3-10.
Geometry conflicts and genuinely unresolved decisions can still require attention.
Marking ink as broken/fused is a resolved exception, not an endless attention item;
its PAW contribution and any confirmation exceptions still need checking.

## Mark Types Learn Too

Every mark nobody has typed gets an **expected type**, learned from the marks you
have typed — on every confirmed page, and on the page you are on. Type a few fathas
and, half a second later, every mark that looks like them is expected to be a fatha.

- Under each line, every mark shows its type in its own slot: **solid** when you typed
  it — or the text did (see below) — **dashed** when it is only expected (fainter when merely likely), a dot when
  nothing like it has been typed yet, a warning ring when it is doubtful. Clicking a
  slot selects that mark.
- **A** gives the selected marks their expected types (each its own); a digit or a
  type button gives them all one type instead — that is how you reject a guess.
- **Accept sure types** in the *Mark types* panel types every mark on the page whose
  guess is sure. It is one undoable step — but read the page before confirming it: a
  wrong type accepted in bulk teaches every page after it.
- A guess teaches nothing. Only a type you set or accepted does, and only once the
  page is confirmed.

**How a type is guessed.** Each mark is described by a 32×32 picture of its ink —
stretched to fill the square, so a small mark and a large one of the same shape look
alike — and six numbers: its width, height and area against the line's text band, how
much of its box is ink, how wide it is for its height, and how far above or below the
line it sits. Every typed type is then scored by how close its **own three nearest
examples** are to the mark, and the closest-scoring type is the guess. It is **sure**
when that type is clearly closer than the next (its score at most 0.85 of the next
type's) and at least two of its examples are close, or when one example is the same
bitmap. Examples further than a fixed distance say nothing, so a new kind of mark stays
untyped until you type one of it.

Until 2026-09-29 the seven nearest examples *voted*, whatever their type, and a common
type won by numbers: with one madda typed and forty-four fathas, every madda was
expected to be a fatha — a fatha's stroke stretched to the square is nearly a madda's,
and the fathas filled the seven seats. Judged type by type, a rarer type is no longer
outvoted. Replaying pages 2 to 8 of the first mushaf as each was first opened: maddas
guessed wrong 10 → 1, sure-and-wrong guesses 36 → 30 of 4,626.

**The evidence — two questions, two tabs.** The bar's right pane answers one of
two questions about the selected blob:

- **Which type?** — the *mark-type* matcher. The types nearest the mark, each with
  its score and pictures of its own nearest typed marks. For a mark nobody has typed,
  they come from the confirmed pages and this one; for a mark you typed, from the
  *other* confirmed pages only — the question its doubt asks. It is how to see *why* a
  guess was made, and the fastest way to find an example typed wrong: a wasla among
  the "shadda" pictures is a slip on that page.
- **Body or mark?** — the *role* matcher. The confirmed blobs nearest this one, of
  either role, from the pages before this one — what calibration reads body-or-mark
  from, and what it would propose. It never looks at types.

Each picture opens the page it came from.

**Doubtful marks.** A mark you typed is asked of the *other* pages alone; when their
examples name another type, the mark is **doubtful** — listed under *Doubtful* in the
filter, ringed in its slot, and explained in the bar. Most often it is a slip of the
hand, and a slip on a confirmed page teaches every page after it, so fix it there and
confirm the page again. A type the other pages have no example of is never doubtful.
The check is only as good as the other pages: pages 1 and 2 of a Madina mushaf are
printed smaller than the rest (a page-3 fatha is about 25×18 px, a page-1 fatha 23×13),
so while they are the only other pages, some doubts on page 3 are false alarms.

## The Text Checks the Marks

The Uthmani text names every mark of every word — harakat, shadda, sukun, madda,
tanween, the small letters, the hamza a letter carries, the i'jam dots, and, from the
complete text in `backend/quran/data`, the pause sign after a word. So each word's marks
are checked against its text, the way its bodies are counted against its pieces.
The text is Hafs's, so all of this is for a mushaf whose riwaya is Hafs; for another
riwaya — other harakat, other small letters, other pauses — it stands aside and the
examples alone guess.

```
عَظِيمٌ    the text names          the ink has
above    fatha · dot · dammatan   fa · ij · da da   ✓  (the dammatan in two strokes)
below    kasra · dots             ka · ij           ✓
```

- **A mark nobody typed takes the type its text names** when the word fits its text and
  the confirmed examples are not sure of another type. It shows as typed — *set by the
  text* — typing it yourself replaces it, and it teaches like a typed mark once the
  page is confirmed. Replayed over pages 3-10 with their types wiped, the text typed
  5,652 of 5,921 marks so, and 3 differed from yours — two of them names: a joined
  tanween typed *tanween*, a dagger alef and madda printed as one typed *other*.
- **What it names but not surely** is offered as the expected type (*from its word's
  text* in the bar). Where the examples are sure of one type and the text names
  another, the bar says so — two marks over one letter (a dot and its sukun) are where
  the text can swap them, and the shapes cannot.
- **A typed mark the text names otherwise is doubtful** (*its word's text names …*), in
  the *Doubtful* filter beside the examples' doubts.
- **Each word says how it fits**: ✓ in the word list, or ≠ with what is missing and
  what is left over (the bar's word pane says it in words). *Play words* counts a word
  that does not fit as a risk.
- **The small waw and ya on the line** (بِهِۦ, لَهُۥ) come from the text too: the first
  ink after the word's heh, on the line and small beside the letters, is locked as the
  word's mark and typed *small letter* before the page is read. Your own decision always
  wins, and the lock lets go when the aya cannot be read with it. Replayed over pages
  3-10: 18 of 20 found, none wrong, and two given back to the word they belong to.

What the print may do differently is allowed, never flagged:

| Text | Printed |
|---|---|
| tanween | one blob (type it *tanween*), or two strokes — type each as the vowel it looks like; the lane shows them as the tanween they make. A dammatan's second stroke is a curl |
| tanween + small meem (iqlab) | one vowel stroke and the meem |
| أ ؤ ئ ٱ | the hamza or the wasla inside its letter, or apart |
| final ك | a small mark inside it, typed *hamza* |
| a pause sign | only where the reading pauses: none is required, and one the text lacks is no error |

**New types.** *Round zero* ۟ — a letter written and never read (كَفَرُوا۟); *upright
zero* ۠ — read only when stopping (أَنَا۠); and the *embraced pause* ۛ ۛ, whose three
loose dots in a triangle are found from the ink (a letter's dots touch, or nearly) and
made sure by the text where it has them. To type one by hand, select all three dots —
drag a box around them, or click one and Shift-click the other two — and choose
*Embraced pause* under *More…*: each dot carries the type. Like any pause sign, the
dots belong to the word the sign follows; if the next word shows ≠, they went to it.
Marks printed as **one blob** are typed as a
pair: **Shift** with a digit adds that type to the mark's own — a hamza with Shift+3
becomes *hamza + kasra* — and *+ Pair…* in the bar does the same. Pressing a plain digit
types a single type again.

## Preview

Preview reads the ayat you changed again, under your decisions. The words its reading
moved are outlined **blue**, the band above the lines counts them, and its ‹ › step
from one to the next — look at those before accepting. Accepting stores the reading
as the draft; discarding leaves the draft as it was.

**Play words** (in the toolbar) plays the page word by word. *Risky words first* puts
the words with something worth a look at the front — a count that does not close,
ink asking for a look, a box wider than its ink, a line not settled, a word with no
ink — and says which. A word with none of these is not thereby right: play them all
before confirming.

The confirm dialog says what the page will teach: how many bodies and marks become
examples of their role, and how many typed marks of their type.

Preview is optional. Assigning ink already recalculates the affected word edges:
a word's box spans its bodies and its marks. A dragged box does too — a drag can
widen a box, or move the cut inside a body two words share, but never leave the
word's own ink outside. A box stored before that rule (a cut from the word editor
that stops at the body) shows its marks held when the page is opened, and is stored
that way at the next save.

**Dashed, solid and red boxes.** A *dashed* box is taken from its word's ink — its
bodies and marks — and follows it when ink changes hands. A *solid* box was set by
hand: dragged in Words mode, or carried in from the Cuts step when the page was
processed. It is kept as it is (only ever widened to hold its own ink), and a
confirmation writes it as the word's cut. Most solid boxes carried in from the Cuts
step sit exactly on their ink and change nothing; a *red* one reaches more than a
few pixels past its ink — on one draft, boxes 123, 241 and 332 px too wide — and would
be written so. **R** (or ↺ in the word list) takes the selected word's box from its
ink; *Take all from their ink* in the word list does every hand-set box on the page at
once, as one undoable step, except a cut inside a body two words share — the one
place a hand-set edge is needed, since ink cannot say where that cut is.
Use preview when you want alignment to reconsider the affected aya around your edits.
Unrelated ayat keep their previous words and assignments. An unresolved reading
keeps the draft and reports the failure instead of clearing its words. Manual
assignments and dragged edges remain protected. Accepting saves one undoable change;
discarding leaves your edits as they were.

## Rename Marks Typed Before Their Type Existed

Rings were typed *sukun* and the embraced pause sign's dots *i'jam dot* before those
had types of their own; left so, they teach every later page the wrong name. The text
finds them. Close calibration tabs and stop processing jobs first. In PowerShell:

```powershell
Set-Location 'D:\work\Programing materials\quran-page-splitter\backend'
.\.venv\Scripts\python.exe manage.py retype_from_text b9975701-a795-4b18-8c66-5551dd47aae1
```

This is a **dry run**: it lists, page by page, the marks it would rename. On 2026-09-30
that was 84 rings on pages 2-10 and the six dots on page 2. Then:

```powershell
.\.venv\Scripts\python.exe manage.py retype_from_text b9975701-a795-4b18-8c66-5551dd47aae1 --apply
```

Each confirmed page it touches is confirmed again — a new confirmation, identical but for
those types — and the draft gets the same; the old confirmation stays in the page's
history. Nothing else changes: no role, no word, no edge.

## Start Fresh Without Losing Older Manual Work

Close calibration tabs and stop processing jobs first. In PowerShell:

```powershell
Set-Location 'D:\work\Programing materials\quran-page-splitter\backend'
.\.venv\Scripts\python.exe manage.py restart_calibration b9975701-a795-4b18-8c66-5551dd47aae1
```

This is a **dry run**. It changes nothing. Inspect its page list, then explicitly run:

```powershell
.\.venv\Scripts\python.exe manage.py restart_calibration b9975701-a795-4b18-8c66-5551dd47aae1 --apply --backup '..\calibration-before-restart.zip'
```

The command refuses to overwrite an existing backup. Choose a new filename on a
later restart. It creates a work-bundle backup before modifying anything and:

- Restarts active calibration drafts and confirmations, excluding their old labels
  from future teaching.
- Restores pre-calibration manual boundaries from the latest legacy archive before
  calibration began (each archive carries every hand-cut line seen so far).
- Returns other affected lines to their first stored canonical engine reading.
- Leaves PDF, layout, numbering, templates, erasures and unrelated pages alone.
- Keeps immutable old revisions and snapshots as history, rather than deleting
  source evidence. These inactive confirmations do not train future predictions.
- Turns experimental application off. Enable it again when starting the new review.

The command refuses a restart if the original line geometry no longer matches.
The dry run on 2026-09-27 listed pages 1-13, restoring 35 older manual lines there;
the other 20 pre-calibration manual lines are outside that reset and untouched.
Afterward refresh the app, process page 1, review, confirm, then process page 2.

No reset was applied during implementation or live UI verification.

## How Each Page Went

```powershell
.\.venv\Scripts\python.exe manage.py calibration_report b9975701-a795-4b18-8c66-5551dd47aae1
```

Read-only. One row per confirmed page, measured against what you confirmed:

```
engine wrong       roles the engine's own reading got wrong (no learning, no text)
learning decided   blobs the confirmed examples proposed a role for — and how many
learning wrong       of those proposals were wrong
looks asked        blobs the first draft asked you to look at
roles fixed        roles you changed
text typed/fixed   marks the text typed, and how many of those you changed
small locked       small waw/ya on the line the text locked as marks;
lock undone          the locks you did not keep; small letters you made marks
small by hand        yourself
words fixed        words whose box ended up different
min                minutes from processing to the first confirmation, breaks included
```

"First draft" is the page as you first saw it after processing: since 2026-10-01 it
is kept beside the prediction record, so the report can tell what *you* changed — the
text's types you corrected, the small letters it missed. A page processed before then
has none: its words are compared with the engine's first reading instead (marked `~`)
and the first-draft columns stay blank. Like every count here, it says where the work
went; the pages themselves say whether it is right.
