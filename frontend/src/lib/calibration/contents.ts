/** What a blob holds, as the server says it: a person's `decided` key, the engine's
 * `reading`, and the two laid together as `contents` — each the *parts* of a contents
 * key (`core/text/contents.py`): `paws`, the letters piece by piece, and `marks`, the
 * marks touching them. `null` inside a list is an open element (`?`); `null` for a
 * whole list, an undecided group (`*`). The browser never builds or splits a key
 * string, and never lays the two together itself: the server sends `contents`.
 *
 * Ink's editor still speaks the words it was built in — a role a person decided
 * (`explicit`), a mark's type (`subtype`, typed by a person or by the reading), a body's
 * `exception` (marks inside it: mixed; several pieces: fused). They are worked out
 * from the parts when a document arrives (`readDocumentFromServer`), and turned back
 * into a decided key when a draft is sent (`decidedOfBlob`). */

import type {
  BlobException,
  CalibrationBlob,
  CalibrationDocument,
  CalibrationLine,
  CalibrationTypes,
  ContentsParts,
  TypeDoubt,
  TypeSuggestion,
  WordMarkCheck,
} from "./types";

const named = (group: (string | null)[] | null | undefined): string[] | null =>
  group && group.length && group.every((part) => part !== null) ? (group as string[]) : null;

/** The role a key says: body when it holds letters, mark when only marks. */
export function roleOfParts(parts: ContentsParts | null | undefined): "body" | "mark" | null {
  if (!parts) return null;
  if (parts.paws && parts.paws.length) return "body";
  if (parts.paws && parts.paws.length === 0 && parts.marks && parts.marks.length) return "mark";
  return null;
}

/** A key's marks as one type name ("fatha", "hamza+kasra"), "" when none or open. */
export function markNameOfParts(parts: ContentsParts | null | undefined): string {
  return named(parts?.marks)?.join("+") ?? "";
}

/** How many pieces a key's letters are; null when that is open. */
export function pawCountOfParts(parts: ContentsParts | null | undefined): number | null {
  const paws = parts?.paws;
  if (!paws || (paws.length === 1 && paws[0] === null)) return null;
  return paws.length;
}

/** The editor's words for a blob, from what it holds. */
export function readBlobFromServer(blob: CalibrationBlob): CalibrationBlob {
  const decided = blob.decided ?? null;
  const contents = blob.contents ?? null;
  const decidedRole = roleOfParts(decided);
  const decidedMarks = named(decided?.marks);
  const type = markNameOfParts(contents);
  const paws = pawCountOfParts(contents);
  const isBody = blob.role === "body";
  let exception: BlobException = (blob.flag as BlobException | undefined) || "";
  if (!exception && isBody && type) exception = "mixed";
  else if (!exception && isBody && paws !== null && paws > 1) exception = "fused";
  return {
    ...blob,
    explicit: decidedRole !== null,
    subtype: type,
    subtype_explicit: decidedMarks !== null,
    ...(type && decidedMarks === null ? { subtype_source: "text" as const } : {}),
    exception,
  };
}

export function readLineFromServer(line: CalibrationLine): CalibrationLine {
  return { ...line, blobs: line.blobs.map(readBlobFromServer) };
}

/** A document as the editor reads it: every blob in the editor's words. */
export function readDocumentFromServer(document: CalibrationDocument): CalibrationDocument {
  return {
    ...document,
    lines: document.lines.map(readLineFromServer),
    context: (document.context ?? []).map(readLineFromServer),
  };
}

/** What a person decided about a blob, as the parts of a key — from the editor's words,
 * keeping the letters the server already holds where they still fit. `null` when
 * nothing is decided. */
export function decidedOfBlob(blob: CalibrationBlob): ContentsParts | null {
  const isText = blob.role === "body" || blob.role === "mark";
  const typed = blob.subtype_explicit && blob.subtype ? blob.subtype.split("+") : null;
  if (!isText) return null;
  if (blob.role === "mark") {
    if (blob.explicit) return { paws: [], marks: typed ?? [null] };
    // A type with no role decided: what the mark is, not whether it is one.
    return typed ? { paws: null, marks: typed } : null;
  }
  const exception = blob.exception;
  const shares = blob.allocations ?? [];
  const given = blob.ownership_explicit && shares.length === 1 ? shares[0].paws : null;
  const count = exception === "fused" ? Math.max(2, given ?? 2) : given && given > 1 ? given : null;
  const held = blob.decided?.paws ?? null;
  let paws: (string | null)[] | null = null;
  if (count !== null) paws = held && held.length === count ? held : Array(count).fill(null);
  else if (blob.explicit || exception === "mixed") paws = held && held.length ? held : [null];
  const marks = typed ?? (exception === "mixed" ? [null] : null);
  if (paws === null && marks === null) return null;
  return { paws, marks };
}

/** What the last reading says about the page's marks, in the shape the editor's hints
 * take: a type for every mark nobody typed, the doubts, each word's check, the noise.
 * It changes only when the server reads the page again — saving teaches nothing. */
export function typesOfDocument(document: CalibrationDocument): CalibrationTypes {
  const suggestions: TypeSuggestion[] = [];
  const doubts: TypeDoubt[] = [];
  const words: WordMarkCheck[] = [];
  const tanween: { snapshot_id: string; blob_id: number }[] = [];
  let typedHere = 0;
  for (const line of document.lines) {
    const unsure = new Set<number>();
    for (const word of line.words) {
      if (word.word_id === null) continue;
      if (word.unsure) {
        for (const blob of line.blobs)
          if (blob.allocations.some((share) => share.word_id === word.word_id)) unsure.add(blob.id);
      }
      if (word.check) {
        const { missing, extra, disagree } = word.check;
        words.push({
          snapshot_id: line.snapshot_id,
          word_id: word.word_id,
          ok: !missing.length && !extra.length && !disagree.length,
          missing,
          extra,
          disagree,
        });
        for (const id of word.check.tanween)
          tanween.push({ snapshot_id: line.snapshot_id, blob_id: id });
      }
    }
    for (const blob of line.blobs) {
      if (blob.role !== "mark" || blob.erased) continue;
      const decided = named(blob.decided?.marks);
      if (decided) typedHere += 1;
      const read = markNameOfParts(blob.reading);
      if (!decided && read)
        suggestions.push({
          snapshot_id: line.snapshot_id,
          blob_id: blob.id,
          subtype: read,
          confidence: unsure.has(blob.id) ? 0.5 : 1,
          sure: !unsure.has(blob.id),
          source: "text",
        });
      if (blob.doubt)
        doubts.push({
          snapshot_id: line.snapshot_id,
          blob_id: blob.id,
          typed: decided?.join("+") ?? "",
          subtype: blob.doubt,
          sure: true,
          source: "examples",
        });
    }
  }
  return {
    suggestions,
    doubts,
    noise: document.noise ?? [],
    examples: document.library?.examples ?? 0,
    typed_here: typedHere,
    words,
    tanween,
  };
}
