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

Turn on **Apply learning to new pages (experimental)** in the calibration sidebar,
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

## Edit Efficiently

1. In **Blobs**, the filter says what a click, a drag and the arrow keys may pick:
   **All blobs**, **Marks only**, **Bodies only** — or one **mark type**, whose marks
   (typed or only expected) are painted blue with everything else faded; **Not typed
   yet**; or **Doubtful** (see below). Choosing *fatha* and walking through its marks
   is the quick way to catch a madda or a wasla that is not what it says.
2. Click a blob, or press **←**. The bar under the lines says what it is: body or
   mark, its type — typed, or expected and how sure — the word it belongs to with
   that word's PAW count, and what asks for a look. The common decisions are there
   too, each with its key.
3. **← →** move blob by blob through what the filter lets through (left is onward,
   as Arabic reads); **↑ ↓** move to the line below or above; **Shift+← →** add the
   next blob on the line to the selection. Shift-click and dragging a rectangle work
   as before.
4. **B** body, **M** mark. **1–9, 0** type the selected marks: 1 fatha, 2 damma,
   3 kasra, 4 sukun, 5 shadda, 6 madda, 7 wasla, 8 hamza, 9 dagger alif, 0 i'jam
   dot; the other types are under *More…*. **A** accepts the expected type. **N** /
   **Shift+N** step through what asks for a look. **Ctrl+Z** undoes, **Ctrl+S** saves.
5. The right panel keeps the rarer decisions: **Assign** gives all selected text blobs
   to a word without changing their roles (bodies contribute PAWs, marks zero);
   **Unassign marks** leaves selected marks unattached, and preview and reprocessing
   keep that; *Out of the ordinary*; taking decisions back; and the nearest confirmed
   examples for body-or-mark. The page's revision and the learning switch are folded
   away under *Page · learning*.

Bodies are near-black; marks are teal. Selected bodies have solid outlines, selected
marks dashed outlines, and the bar names the role in words.

Setting a human role resolves old uncertainty/override/disagreement warnings.
Geometry conflicts and genuinely unresolved decisions can still require attention.
Marking ink as broken/fused is a resolved exception, not an endless attention item;
its PAW contribution and any confirmation exceptions still need checking.

## Mark Types Learn Too

Every mark nobody has typed gets an **expected type**, learned from the marks you
have typed — on every confirmed page, and on the page you are on. Type a few fathas
and, half a second later, every mark that looks like them is expected to be a fatha.

- Under each line, every mark shows its type in its own slot: **solid** when you typed
  it, **dashed** when it is only expected (fainter when merely likely), a dot when
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

**The evidence.** Select one mark and the bar shows, beside it, the types nearest it —
each with its score and pictures of its nearest typed examples. Each picture opens the
page it was typed on. It is how to see *why* a guess was made, and the fastest way to
find an example typed wrong: a wasla among the "shadda" pictures is a slip on that page.

**Doubtful marks.** A mark you typed is asked of the *other* pages alone; when their
examples name another type, the mark is **doubtful** — listed under *Doubtful* in the
filter, ringed in its slot, and explained in the bar. Most often it is a slip of the
hand, and a slip on a confirmed page teaches every page after it, so fix it there and
confirm the page again. A type the other pages have no example of is never doubtful.
The check is only as good as the other pages: pages 1 and 2 of a Madina mushaf are
printed smaller than the rest (a page-3 fatha is about 25×18 px, a page-1 fatha 23×13),
so while they are the only other pages, some doubts on page 3 are false alarms.

## Preview

Preview is optional. Assigning ink already recalculates the affected word edges:
a word's box spans its bodies and its marks. A dragged box does too — a drag can
widen a box, or move the cut inside a body two words share, but never leave the
word's own ink outside. A box stored before that rule (a cut from the word editor
that stops at the body) shows its marks held when the page is opened, and is stored
that way at the next save.
Use preview when you want alignment to reconsider the affected aya around your edits.
Unrelated ayat keep their previous words and assignments. An unresolved reading
keeps the draft and reports the failure instead of clearing its words. Manual
assignments and dragged edges remain protected. Accepting saves one undoable change;
discarding leaves your edits as they were.

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
- Restores pre-calibration manual boundaries from the earliest legacy archive.
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
