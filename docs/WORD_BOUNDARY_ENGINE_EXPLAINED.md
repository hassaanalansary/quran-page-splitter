# Understanding the Word-Boundary Engine

This document explains the **word-by-word recognition / boundary engine** in the `quran-page-splitter` project, with special attention to the part that is easiest to misunderstand: **alignment**.

The goal is not to reproduce every implementation detail. The goal is to give a mental model that makes the code easy to follow and easy to explain to somebody else.

The explanation below follows the `feature/word-by-word_recognition` branch.

---

## 1. The project has two very different jobs

The project can be thought of as two engines:

### Engine 1 — Page / Aya analysis

This engine starts with a full Quran page and determines things such as:

- where the text lines are,
- what type each line is,
- which aya belongs to which part of the page,
- the coordinates of lines and ayat,
- and the numbering/order needed by the rest of the system.

Its job is essentially **page understanding**.

### Engine 2 — Word boundaries

This engine starts with:

- already-cropped text lines, and
- the **known Quran words that must appear on those lines**,

and determines where each word is located horizontally.

Its final purpose is not OCR. It does **not** read an unknown Arabic sentence and guess what the sentence says.

It already knows the text.

Instead, it answers:

> **“Given these ink components and this known sequence of Quran words, which components belong to which words, and where does each word end?”**

That distinction is the key to understanding the entire engine.

---

# 2. The big idea: this is alignment, not recognition

Suppose the database tells us that a line contains:

```text
word A   word B   word C   word D
```

The image gives us a sequence of connected components:

```text
blob 1, blob 2, blob 3, blob 4, blob 5, blob 6, ...
```

The engine's task is to align these two sequences:

```text
Text words:   A       B          C      D
              |       |          |      |
Ink blobs:   [1 2]   [3 4 5]    [6]    [7 8]
```

The difficult part is that a connected component is **not necessarily a whole letter or a whole word**.

Arabic creates several complications:

- dots and tashkeel can become separate connected components,
- one word can contain several disconnected pieces,
- a printed letter can break into multiple pieces,
- two things that visually belong to one word can sometimes be fused,
- and a component that looks like a dot may still be a real part of a letter body.

So the engine cannot simply say:

> “Every component is a word.”

or even:

> “Every component is a letter.”

Instead it asks:

> **“What assignment of the observed components to the known words is most plausible?”**

That is exactly why this phase is called **alignment**.

---

# 3. Phase A: turn the line image into measurable components

The first important file is:

```text
backend/core/word_boundary/ink.py
```

`analyse_line()` converts a line image into a `LineInk` object.

The basic pipeline is:

```text
line image
    ↓
binary ink mask
    ↓
tight crop
    ↓
writing-band detection
    ↓
connected components
    ↓
initial body/mark evidence
```

The code explicitly treats this first classification as **evidence, not truth**.

That is important.

## 3.1 Tight crop

The line is cropped to the smallest rectangle containing ink.

The original position is remembered as:

```text
offset_x
offset_y
```

The actual parsing can therefore work in a small local coordinate system.

The offsets are added back later when the final word boxes are produced.

---

## 3.2 Find the writing band

The engine computes the amount of ink in every horizontal row.

The row containing the most ink is treated as the **peak** of the writing line.

The engine then grows a band around that peak while the row density remains sufficiently high.

Conceptually:

```text
        tashkeel / dots
              •
              •
      ────────────────   ← writing band
       letter bodies
      ────────────────
              •
           lower marks
```

This is much more useful than using a fixed pixel height because different lines and mushaf images can have different scales.

---

# 4. Initial component classification

Once the connected components are found, every component gets an initial preference:

- `body` — it crosses the writing line,
- `mark` — it is near the band but does not cross the peak,
- `mark-only` — it is clearly floating away from the writing band.

The project deliberately does **not** make this classification final.

Why?

Because size alone is unreliable.

A large mark can be larger than a small letter, and a small letter can be smaller than a large mark.

So the engine also computes a `body_score` from several pieces of geometric evidence:

```text
crosses writing line  → strongest evidence
band overlap          → useful evidence
relative area         → useful evidence
relative height       → weaker evidence
```

The result is a score such as:

```text
blob #17 → body score 13 / 14
blob #18 → body score 4 / 14
```

This does **not** mean:

```text
13 = definitely body
4  = definitely mark
```

Instead it means:

> “Using this blob as a body is cheap for #17 and expensive for #18.”

That idea becomes crucial during alignment.

The calibration file makes this explicit: the scores are **weights in a cost model, not hard gates**.

---

# 5. Before alignment: the engine already knows the text

The word engine receives a sequence of `WordInput` objects.

Each word contains more information than just its text. Most importantly, it contains values such as:

- `text`
- `paws`
- `ijam_above`
- `ijam_below`
- aya identity
- database word id

The most important field for alignment is:

```text
paws
```

PAW means a disconnected **piece of an Arabic word** as determined by the Arabic joining rules.

The crucial property is:

> The text can predict how many disconnected body pieces a word should have.

So the engine has a powerful relationship:

```text
KNOWN TEXT                         IMAGE
---------                          -----
word A should have 2 PAWs   ←→    maybe 2 body components
word B should have 3 PAWs   ←→    maybe 3 body components
word C should have 1 PAW    ←→    maybe 1 body component
```

The image does not know what the words are.

The text does not know where the pixels are.

Alignment is where those two sources of information meet.

---

# 6. The most important idea: the parser has a cursor

Imagine the known Quran words as a numbered sequence:

```text
0       1       2       3       4       5
الله    رب       العالمين  ...
```

The parser keeps a **cursor** saying:

> “I am currently trying to place word #2.”

It also keeps a second number:

> “Word #2 has currently received N blobs.”

So the fundamental parser state is:

```text
(word_index, blobs_taken_for_current_word)
```

For example:

```text
(5, 0)
```

means:

> “We are working on word #5, and we have not assigned any body blob to it yet.”

And:

```text
(5, 2)
```

means:

> “We are still on word #5, and it has already consumed two body blobs.”

This tiny state is the heart of the algorithm.

---

# 7. Why the parser has to branch

Suppose the next connected component is blob #12.

The engine has two basic possibilities.

## Option 1 — Treat the blob as a mark / unused ink

The parser does **not** give it to the current word.

Conceptually:

```text
current state
     │
     └── leave blob out
```

This is useful for:

- dots,
- tashkeel,
- ornament pieces that slipped into consideration,
- or extra/spurious strokes.

Of course, leaving a body-looking blob unused has a cost.

---

## Option 2 — Give the blob to the current word

The parser uses it as part of the current word.

Conceptually:

```text
current state
     │
     └── consume blob as body
```

Now the parser has two sub-options:

### 2a. Keep building the same word

```text
(word 5, 1)
        ↓ next blob
(word 5, 2)
```

### 2b. Close the word here

```text
(word 5, 1)
        ↓ close
(word 6, 0)
```

So one image component can create multiple possible future interpretations.

That is why a simple left-to-right or right-to-left greedy algorithm would be dangerous.

---

# 8. The algorithm is Dynamic Programming

The code is using a small **dynamic-programming / shortest-path search**.

You can think of it as a graph.

Every possible parser state is a node:

```text
(word_index, blobs_taken)
```

Every possible decision is an edge:

```text
ignore blob
consume blob
close word
```

And every edge has a **cost**.

The parser explores possible paths and keeps the cheapest one.

So the entire problem becomes:

> **Among all valid ways to distribute the observed blobs among the known words, which path has the lowest total cost?**

This is the key sentence to remember.

---

# 9. What does “cost” actually mean?

The engine has several kinds of evidence.

## 9.1 Body cost

Every component has a `body_score`.

If a component looks strongly like a body, using it as a body is cheap.

If it looks strongly like a mark, using it as a body is expensive.

Conceptually:

```text
body_score = 14
cost_as_body = 0
```

is strongly preferred.

While:

```text
body_score = 2
cost_as_body = 12
```

is possible, but unattractive.

The important point is:

> Geometry influences the decision, but geometry does not control the decision.

---

## 9.2 Mark / unused cost

If the parser leaves a component out of word bodies, that also has a cost.

The project deliberately caps this cost.

Why?

Because a slightly suspicious extra component should not force the parser to invent an extra word just to consume it.

This is especially important for broken or noisy ink.

---

# 10. The strongest rule: PAW count

Suppose the text says:

```text
word X → expected PAWs = 3
```

The parser would strongly prefer:

```text
blob 1 + blob 2 + blob 3 = word X
```

rather than:

```text
blob 1 + blob 2 = word X
```

or:

```text
blob 1 + blob 2 + blob 3 + blob 4 + blob 5 = word X
```

The reason is that closing a word with the wrong number of PAWs incurs:

```text
COUNT_WEIGHT * abs(actual - expected)
```

The configured count weight is intentionally much larger than the body-shape costs.

So the algorithm effectively says:

> **“Prefer the spelling's PAW structure over a small disagreement in visual appearance.”**

This is one of the most important design decisions in the whole engine.

---

# 11. Why this fixes a common Arabic problem

Imagine two neighbouring words visually look like this:

```text
[blob blob blob][blob blob]
```

But because of printing quality, the first word's final letter touches the next word.

A naive connected-component approach may think:

```text
one huge component
```

and therefore conclude:

```text
one word
```

The alignment engine can instead say:

> “The text expects two words, and their PAW counts make that split much more plausible. I will allow a fused-looking component to participate in a slightly imperfect parse rather than destroying the rest of the line.”

That is exactly what `COUNT_SLACK` and the deviation cost are for.

The implementation allows a word to finish a little above or below its ideal PAW count, while recording that deviation for review.

---

# 12. A tiny example

Suppose the known text is:

```text
A   B   C
```

and the text predicts:

```text
A = 2 PAWs
B = 1 PAW
C = 2 PAWs
```

The image produces five candidate body-looking blobs:

```text
1  2  3  4  5
```

A very plausible parse is:

```text
A → [1, 2]
B → [3]
C → [4, 5]
```

But the parser cannot simply commit after seeing blob 2.

At blob 2 it has to consider:

```text
Option A:
A ends here

Option B:
A continues and consumes another blob
```

Later evidence decides which path wins.

This is exactly why the algorithm is easier to understand as a **path search** than as a sequence of `if` statements.

---

# 13. What the DP actually does with each blob

For each blob, the parser looks at every currently surviving state.

From each state it tries:

```text
1. ignore the blob / treat it as a mark
2. consume the blob as body
   a. keep the current word open
   b. close the current word
```

A simplified diagram is:

```text
                         ┌── ignore blob
                         │
(current word, count) ───┼── consume → keep word open
                         │
                         └── consume → close word
```

Each resulting state receives a total cost.

For the next blob, the same process repeats.

---

# 14. Why it does not explode exponentially

At first glance, branching at every blob sounds exponential.

The implementation avoids that by **merging equivalent states**.

Suppose two different histories both arrive at:

```text
(word 8, 1)
```

The future only cares about that state and its accumulated evidence.

So the parser keeps the cheaper path.

If two paths have equal cost, the engine keeps the ambiguity information instead of keeping every possible history.

So conceptually:

```text
many histories
      ↓
 same state
      ↓
keep cheapest evidence
```

This is the main DP optimization in the code.

There is also a hard limit on the number of live states. If the search becomes too large, the segment is marked unresolved instead of being allowed to consume unbounded resources.

---

# 15. The i'jam check: dots provide an extra constraint

The engine has another important validation step: **i'jam**.

For example, the text of a word may require a certain number of dots above or below it.

The parser may find a visually plausible assignment where a dot was accidentally consumed as if it were part of the letter body.

That would be bad because the word would then lose a dot that the spelling requires.

So after a candidate parse, the engine checks approximately:

```text
Does every word still have enough required dots above/below its body span?
```

If not, that parse is flagged.

This is a powerful concept because the text gives a **minimum requirement** that the image must satisfy.

It is not trying to recognize every haraka. It mainly uses the dots that the spelling guarantees must exist.

---

# 16. Ornaments are alignment anchors

One of the most clever parts of the engine is how it handles aya-number ornaments.

The line may contain a non-text ornament separating ayat.

Those ornaments are detected separately and then inserted into the parser event stream.

So the parser sees something conceptually like:

```text
word ink word ink word ink ORNAMENT word ink word
```

The ornament is not just another blob.

It is a **hard structural anchor**.

It says:

> “An aya boundary happens here.”

Therefore the engine splits the line into stretches:

```text
Stretch 1 | ornament | Stretch 2 | ornament | Stretch 3
```

and aligns each stretch independently.

---

# 17. Why splitting at ornaments is so important

Without this idea, a mistake near the beginning of the line could shift every word after it.

For example:

```text
wrong assignment
       ↓
wrong cursor
       ↓
wrong next word
       ↓
wrong next word
       ↓
wrong next word
       ↓
whole line drifts
```

With an ornament anchor:

```text
segment A      ornament      segment B
  wrong             ↓          correct
  locally                      re-sync
```

The second segment gets a fresh structural anchor.

This is why the code describes ornaments as **absolute anchors rather than merely validation points**.

---

# 18. The “cursor” moves from line to line

Words cannot cross a physical line boundary.

Therefore, after parsing one line, the engine knows which word should be next on the following line.

For example:

```text
line 1 → consumed words 0..12
line 2 → must start at word 13
line 3 → must start where line 2 ended
```

The variable is effectively a stream cursor.

So the whole page/span is one continuous word sequence:

```text
words:
0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 ...

line 1:
0 ---------------------- 12

line 2:
                         13 ---------------- 24

line 3:
                                             25 -------- ...
```

This is why the engine is more than a collection of independent line parsers.

---

# 19. Aya boundaries also constrain the cursor

The Quran text model knows where each aya starts in the word stream.

Suppose the parser reaches an aya ornament.

The engine knows that the words before this anchor must finish the current aya.

So the ornament effectively tells the parser:

```text
“Whatever assignment you chose, the segment must end at this text boundary.”
```

If the cheapest visual interpretation disagrees slightly with that boundary, the engine does not necessarily throw everything away.

It can record the boundary as a concern and continue.

This is a deliberate robustness decision.

---

# 20. What happens when there is no perfect solution?

The engine does **not** require every line to be perfect.

Instead, it categorises the result.

Conceptually:

```text
exact
  ↓
clean alignment

scored
  ↓
alignment exists but has warnings

partial
  ↓
some segments resolved, some did not

unresolved
  ↓
no trustworthy alignment
```

This is an important engineering decision.

A real image-processing pipeline should not hide uncertainty.

The output therefore carries reasons such as:

- aya boundary missed,
- word off expected PAW count,
- multiple equal-cost readings,
- i'jam short,
- no parse,
- search budget exceeded.

---

# 21. Equal-cost solutions

Sometimes two different assignments are equally plausible according to the scoring system.

For example:

```text
Reading A → boundary after blob 10
Reading B → boundary after blob 11
```

with exactly the same total cost.

The engine does not pretend that one is mathematically superior.

Instead it:

1. records that ambiguity,
2. chooses a deterministic representative so the pipeline can continue,
3. exposes the tie as a review signal.

This is a good pattern for production image processing:

> **Make a deterministic choice, but do not erase the fact that the choice was ambiguous.**

---

# 22. The final word boundary

Once the parser has decided which body blobs belong to each word, the engine can construct a word box.

The box includes the body's marks for visual containment, but the semantic word end is determined from the **body geometry**, not from floating marks.

This distinction matters.

A fatha or dot can extend horizontally beyond the body that owns it.

It should not move the actual cut between two words.

So conceptually:

```text
visual box:
┌───────────────────────┐
│      word + marks     │
└───────────────────────┘

semantic boundary:
              ↑
        body-only end
```

This is what eventually produces the `x-start` / `x-end` information needed by callers.

---

# 23. One complete mental model of the engine

You can explain the whole word-boundary engine using this diagram:

```text
                 KNOWN QURAN TEXT
                       │
                       │
                WordInput sequence
                       │
             expected PAW / i'jam data
                       │
                       ▼
LINE IMAGE ──► connected components
                       │
                       ▼
              geometry-based evidence
              body score / mark score
                       │
                       ▼
             detect aya ornaments
                       │
                       ▼
          split line into stretches
                       │
                       ▼
              DYNAMIC PROGRAMMING
                       │
          ┌────────────┼────────────┐
          │            │            │
      ignore blob   use as body   close word
          │            │            │
          └────────────┼────────────┘
                       │
                 score each path
                       │
             PAW count dominates
              visual evidence is
                   secondary
                       │
                       ▼
             cheapest valid parse
                       │
               + ambiguity flags
               + deviation counts
                       │
                       ▼
                 word groups
                       │
                       ▼
              word bounding boxes
                       │
                       ▼
                  x-start / x-end
```

---

# 24. The simplest way to explain “alignment” to another developer

A good explanation is:

> **The image gives us a sequence of disconnected ink components, while the Quran database gives us the exact sequence of words. Alignment is the process of finding the cheapest way to assign those components to those known words. The parser walks the components from right to left and keeps a state consisting of the current word and how many PAWs that word has received. For each component it can ignore it as a mark or use it as part of the current word, optionally closing that word. Each choice has a cost based on visual evidence and PAW-count disagreement. The cheapest path wins. Aya ornaments act as hard anchors that split the line into independent stretches and prevent an early mistake from shifting everything after it.**

That paragraph is the core of the algorithm.

---

# 25. A useful analogy: filling a form with known answers

Another simple analogy is:

Imagine you already know the answer sheet:

```text
[ A needs 2 slots ] [ B needs 1 slot ] [ C needs 2 slots ]
```

and you are given a pile of physical pieces:

```text
piece 1, piece 2, piece 3, piece 4, piece 5
```

Your job is not to identify what the answer sheet says.

Your job is to decide:

```text
which pieces fill A?
which piece fills B?
which pieces fill C?
```

You have hints about what each piece looks like, but the slot counts written on the answer sheet are stronger evidence.

That is almost exactly what the alignment engine is doing.

---

# 26. How to read the code without getting lost

When reading `alignment.py`, resist the temptation to read it line by line immediately.

Read it in this order:

### Step 1 — Understand the state

Find:

```python
state: tuple[int, int]
```

and remember:

```text
(word index, PAWs already consumed)
```

### Step 2 — Understand the two actions

Look at:

```python
_with_mark(...)
_with_body(...)
```

These represent the two fundamental decisions:

```text
ignore this component
or
use this component as body ink
```

### Step 3 — Understand word closing

Inside `_with_body()`, notice that consuming a blob can either:

```text
stay on the current word
```

or:

```text
close the current word and move to the next word
```

### Step 4 — Understand `_merge_record()`

This is the DP compression step:

```text
same state → keep the cheapest path
```

Equal-cost paths are remembered as ambiguity.

### Step 5 — Understand `_parse_segment()`

This is the loop that applies those transitions to every blob in one ornament-delimited stretch.

At the end it selects the cheapest valid final state.

### Step 6 — Understand `parse_line()`

Only after understanding one segment should you study how the line is split at ornaments and how the cursor moves from segment to segment.

### Step 7 — Understand `engine.detect_words()`

Finally, see the whole pipeline:

```text
analyse_line()
→ split_separators()
→ parse_line()
→ apply_parse_roles()
→ build_line_boxes()
```

This reading order is much easier than starting at `detect_words()` and following every data structure immediately.

---

# 27. The key variables to remember

| Variable / concept | Meaning |
|---|---|
| `Blob` | One connected ink component |
| `body_score` | How much the geometry suggests “body” |
| `cost_as_body` | Price of using a blob as body ink |
| `cost_as_mark` | Price of leaving the blob out of word bodies |
| `WordInput.paws` | Expected disconnected body pieces for that word |
| `(word_index, done)` | DP state: current word + PAWs already consumed |
| `COUNT_WEIGHT` | Penalty for closing a word with the wrong PAW count |
| `COUNT_SLACK` | Allowed PAW deviation before the path becomes impossible |
| `separator` / ornament | Aya boundary anchor |
| `cursor` | Which known text word must be placed next |
| `groups` | Blob labels assigned to each word |
| `end_sequences` | Number of equally good boundary readings retained/reported |
| `deviations` | Number of words that closed off their expected PAW count |
| `WordBox.end_x` | Semantic word end derived from body geometry |

---

# 28. The one-sentence summary

If you remember only one thing, remember this:

> **The word-boundary engine does not recognize Quran words from pixels; it uses the already-known Quran text as a structural template and searches for the lowest-cost alignment between expected word structure and observed connected components.**

That is why the algorithm can be robust without needing an OCR model.

---

## Relevant source files

The explanation maps mainly to these files:

```text
backend/core/word_boundary/ink.py
backend/core/word_boundary/alignment.py
backend/core/word_boundary/engine.py
backend/core/word_boundary/calibration.py
backend/quran/services/words.py
```

The central implementation of the alignment algorithm is `alignment.py`.
