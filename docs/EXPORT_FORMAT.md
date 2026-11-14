# The Full Data Export (`mushaf-export/v2`)

Everything the tool knows about a mushaf's pages, in one zip: every line, aya, word
and blob, placed on the page and on each line's PNG, plus two pixel maps per line.

Download it from **Details → Export → Words, marks & maps**, from the gallery
page of a published mushaf, or for one page from *Page N · learning* in Ink.

```
GET /api/mushafs/{id}/export.zip                  the whole mushaf
GET /api/mushafs/{id}/export.zip?page=7           one page
    &images=false                                 without the line PNGs
    &maps=false                                   without the pixel maps
GET /api/gallery/{id}/export.zip                  the same, for a published mushaf
```

The older `coordinates.json` (`aya-bbox/v1`) is unchanged.

---

## 1. What is in the zip

```
mushaf-export.zip
├── README.txt                          a short version of this page
├── manifest.json                       the mushaf, the conventions, one entry per page
├── pages/
│   └── page-0007.json                  one page: lines → ayat, words, blobs
├── lines/
│   └── page-0007/line-03.png           the exported line image (as in lines.zip)
└── maps/
    ├── words/page-0007/line-03.png     each ink pixel → which word
    └── blobs/page-0007/line-03.png     each ink pixel → which blob
```

A line PNG appears only once that page's lines were exported (*Export all lines*).
Maps appear only for lines processed in Ink — they need the blobs.

---

## 2. The words used

```
page ─┬─ line ─┬─ aya        a stretch of the line belonging to one aya
      │        ├─ word       a word of the Quran text, with its box
      │        └─ blob       one connected piece of ink
```

A **blob** is one connected piece of ink — *not* a letter, and not a word. Its
`class` says what it is:

| class      | what it is                                       | extra fields              |
|------------|--------------------------------------------------|---------------------------|
| `body`     | part of a letter                                 | `words`, `paws`, `set_by` |
| `mark`     | anything above, below or beside the letters      | `words`, `type`, `type_by`, `set_by` |
| `ornament` | an aya-end ring                                  | `aya` — the aya it closes |
| `symbol`   | a sajda or rub' sign                             | `symbol` — which sign     |

A mark's `type` is `fatha`, `kasra`, `damma`, `sukun`, `shadda`, `smallLetter`, ...
— `manifest.json` lists every type the export holds, with counts. Two types joined
by `+` (`hamza+kasra`) are two marks printed as one blob. `type_by` says who set it:
`person`, or `text` (the Quran text named it). A mark nobody typed has `type: null`.

`set_by` says who decided the class: `person`, `text`, `learning` or `engine`. On a
confirmed page a person approved every one of them, whoever set it first.

---

## 3. Two coordinate spaces

Every rectangle is given twice, as `[x, y, w, h]` with y running down:

```
"box": { "page": [2410, 300, 186, 116],     pixels of the page image (300 dpi)
         "png":  [2310,   0, 186, 116] }    pixels of this line's PNG
```

The PNG is the page cut at the text column and the line's height. The mushaf's
*Line image size* then decides its height: the line's own box; or, for *Same size
across the page*, centred on a canvas the size of the page's largest line; or, for
*Tight to the ink*, cut down to the line's first and last inked row, so `crop`
starts and ends there; or, for *Tight, then same size across the page*, cut so first
and then centred on a canvas the size of the page's tallest cut line, so `crop` is
tight and `offset` pads it. Each line says how:

```
"png": {
  "file":   "lines/page-0007/line-03.png",
  "size":   [2350, 130],        the PNG's width and height
  "crop":   [100, 300, 2350, 116],   where it was cut from the page (page px)
  "offset": [0, 7],             where that cut sits inside the PNG
  "exported": true,             the tool has an exported PNG for this line
  "outdated": false             that PNG's size no longer matches: export again
}
```

So, for any point:

```
png_x = page_x - crop_x + offset_x
png_y = page_y - crop_y + offset_y
```

A toy example. A word's left edge is at page x 1830 on a line cut from page x 100,
with no padding: in the PNG it is at 1830 − 100 + 0 = 1730.

Export the line images again after editing a page's lines; until then a stored PNG
may not match what the JSON describes (`outdated` catches a change of size).

---

## 4. A page file

```jsonc
{
  "schema": "mushaf-export/v2",
  "page": 7,
  "pdf_page": 9,
  "size": [1595, 2280],                 the page image's size in pixels
  "reviewed": true,                     lines and ayat reviewed in Review
  "calibration": {
    "state": "confirmed",               see below
    "revision": 12, "confirmed_revision": 12,
    "stale": false                      lines changed after it was processed
  },
  "lines": [
    {
      "line": 3, "type": "text", "sura": 2,
      "box": { "page": [...], "png": [...] },
      "png": { ... },                   see section 3
      "ayat": [
        { "sura": 2, "aya": 5, "ends_here": true, "box": { "page": [...], "png": [...] } }
      ],
      "words": [
        {
          "id": 31, "ref": "2:5:1", "text": "أُو۟لَـٰٓئِكَ",
          "box": { ... },               the word's slot: its x span, the line's height
          "ink": { ... },               tight around its own ink (null without blobs)
          "blobs": [12, 13, 15]
        }
      ],
      "blobs": [
        { "id": 12, "class": "body", "box": { ... }, "area": 412,
          "words": [31], "paws": 1, "set_by": "engine" },
        { "id": 15, "class": "mark", "box": { ... }, "area": 38,
          "words": [31], "type": "damma", "type_by": "text", "set_by": "engine" },
        { "id": 40, "class": "ornament", "box": { ... }, "area": 1803, "aya": "2:5" }
      ],
      "maps": {
        "words": "maps/words/page-0007/line-03.png",
        "blobs": "maps/blobs/page-0007/line-03.png"
      }
    }
  ]
}
```

- `id` is the word's number in the whole Quran, counted from 1; `ref` is
  `sura:aya:position` in this mushaf's counting. A word the stored text does not
  have (another riwaya's) has `id: null`.
- `words` lists a line's words in reading order (right to left).
- `paws` is how many pieces of its word a body is: 1 normally, 2 or more for
  bodies printed touching, 0 for a broken fragment.
- `flag` is a person's note that the blob is out of the ordinary: `mixed` (a body
  and a mark in one blob), `broken`, `fused` or `uncertain`. A `mixed` body may carry
  `marks`: the marks printed touching it, as a person named them (`"fatha"`, two or
  more joined by `+`).

### How far each page got

| `calibration.state` | meaning                                                       |
|---------------------|---------------------------------------------------------------|
| `confirmed`         | confirmed in Ink, and unchanged since                         |
| `edited`            | confirmed, then changed — confirm it again                    |
| `draft`             | processed in Ink, never confirmed: **nobody checked it**      |
| `none`              | never processed in Ink: word boxes only, no blobs and no maps |

The export hides nothing; which states to trust is the reading app's call.

---

## 5. The pixel maps

Both maps are RGB PNGs **exactly the size of the line PNG**, laid over it pixel for
pixel. Each pixel holds one number:

```
value = R + 256·G + 65536·B          0 = background
```

| map   | value `k` means                                  |
|-------|--------------------------------------------------|
| words | the line's `words[k-1]` (ornaments and stray ink are 0) |
| blobs | the blob whose `id` is `k`                       |

A blob shared by two words — printed touching across the word break — is split
between them at their boxes in the word map.

The maps hold ink as the engine measured it, so the faint anti-aliased edge of a
letter in the PNG may read 0. When hit-testing a tap, look a pixel or two around.

Reading one in a browser:

```js
const img = await createImageBitmap(await (await fetch(url)).blob());
const canvas = new OffscreenCanvas(img.width, img.height);
const ctx = canvas.getContext("2d");
ctx.drawImage(img, 0, 0);
const { data } = ctx.getImageData(0, 0, img.width, img.height);
const at = (x, y) => {
  const i = (y * img.width + x) * 4;
  return data[i] + 256 * data[i + 1] + 65536 * data[i + 2];
};
// Which word was tapped:  line.words[at(x, y) - 1]
```

In Python:

```python
import numpy as np
from PIL import Image

rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.uint32)
values = rgb[..., 0] + 256 * rgb[..., 1] + 65536 * rgb[..., 2]
```

---

## 6. What the manifest says

`manifest.json` repeats these conventions in words, and adds the mushaf (`name`,
`qiraa`, `dpi`, `png_size` — `box`, `uniform`, `tight` or `tight_uniform` — and `uniform_png_size`,
true for `uniform`, kept for readers from before `png_size`), the mark types found
with their counts, totals
by calibration state, and one entry per page:

```json
{ "page": 7, "file": "pages/page-0007.json", "calibration": "confirmed",
  "stale": false, "lines": 15, "words": 128, "blobs": 1012 }
```

---

## 7. Size and time

A page holds about a thousand blobs, so a page file is a few hundred kilobytes
before compression. The export is written while it downloads: a page starts
arriving at once, and a whole mushaf with images and maps takes a few minutes.
`images=false` and `maps=false` make it much smaller and faster.
