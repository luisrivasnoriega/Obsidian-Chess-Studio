import type { DrawShape } from "@lichess-org/chessground/draw";
import { makeSquare, parseUci } from "chessops";
import type { Annotation } from "@/utils/annotation";
import { ANNOTATION_INFO } from "@/utils/annotation";
import type { TreeNode } from "@/utils/treeReducer";

export type BookErrorMatch = {
  ply: number;
  expectedMove: string | null;
  expectedMoves: string[];
  playedMove: string;
};

export type BookUnknownMatch = {
  ply: number;
  expectedMove: string | null;
  expectedMoves: string[];
  playedMove: string;
};

export type ProfileBookPriorityInput = {
  matchedPlies: number[];
  errors: BookErrorMatch[];
  unknowns: BookUnknownMatch[];
};

const BOOK_ERROR_ANNOTATION: Annotation = "BookError";
const BOOK_UNKNOWN_ANNOTATION: Annotation = "BookUnknown";
const BOOK_ERROR_HINT_BRUSH = "green";
const BOOK_ERROR_HINT_LINE_WIDTH = 12;

function isBookErrorHintShape(shape: DrawShape): boolean {
  return (
    !!shape.dest &&
    shape.brush === BOOK_ERROR_HINT_BRUSH &&
    typeof shape.modifiers?.lineWidth === "number" &&
    shape.modifiers.lineWidth === BOOK_ERROR_HINT_LINE_WIDTH
  );
}

function buildBookErrorHintShape(expectedMove: string | null): DrawShape | null {
  if (!expectedMove) return null;
  const parsed = parseUci(expectedMove);
  if (!parsed || !("from" in parsed) || !("to" in parsed)) return null;
  const orig = makeSquare(parsed.from);
  const dest = makeSquare(parsed.to);
  if (!orig || !dest) return null;
  return {
    orig,
    dest,
    brush: BOOK_ERROR_HINT_BRUSH,
    modifiers: {
      lineWidth: BOOK_ERROR_HINT_LINE_WIDTH,
    },
  };
}

function getMainlineNodes(root: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  let current = root;
  while (current.children.length > 0) {
    const next = current.children[0];
    if (!next) break;
    out.push(next);
    current = next;
  }
  return out;
}

function removeBasicAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations.filter((ann) => {
    const info = ANNOTATION_INFO[ann];
    return !info || info.group !== "basic";
  });
}

export function clearBookErrorAnnotations(root: TreeNode): void {
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.annotations.includes(BOOK_ERROR_ANNOTATION) || node.annotations.includes(BOOK_UNKNOWN_ANNOTATION)) {
      node.annotations = node.annotations.filter(
        (annotation) => annotation !== BOOK_ERROR_ANNOTATION && annotation !== BOOK_UNKNOWN_ANNOTATION,
      );
    }
    if (node.shapes.length > 0) {
      node.shapes = node.shapes.filter((shape) => !isBookErrorHintShape(shape));
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
}

export function applyBookErrorsToMainline(root: TreeNode, errors: BookErrorMatch[]): void {
  if (errors.length === 0) return;
  const mainline = getMainlineNodes(root);
  for (const error of errors) {
    if (error.ply < 0 || error.ply >= mainline.length) continue;
    const node = mainline[error.ply];
    const withoutBasic = removeBasicAnnotations(node.annotations as Annotation[]);
    const withoutBook = withoutBasic.filter((ann) => ann !== "Book");
    const withoutBookUnknown = withoutBook.filter((ann) => ann !== BOOK_UNKNOWN_ANNOTATION);
    node.annotations = withoutBookUnknown;
    if (!node.annotations.includes(BOOK_ERROR_ANNOTATION)) {
      node.annotations = [...node.annotations, BOOK_ERROR_ANNOTATION];
    }

    const hintShape = buildBookErrorHintShape(error.expectedMove);
    if (!hintShape) continue;
    const exists = node.shapes.some(
      (shape) => shape.orig === hintShape.orig && shape.dest === hintShape.dest && shape.brush === hintShape.brush,
    );
    if (!exists) {
      node.shapes = [...node.shapes, hintShape];
    }
  }
}

export function isBookErrorHintForSerialization(shape: DrawShape): boolean {
  return isBookErrorHintShape(shape);
}

export function applyBookUnknownsToMainline(root: TreeNode, unknowns: BookUnknownMatch[]): void {
  if (unknowns.length === 0) return;
  const mainline = getMainlineNodes(root);
  for (const unknown of unknowns) {
    if (unknown.ply < 0 || unknown.ply >= mainline.length) continue;
    const node = mainline[unknown.ply];
    const withoutBasic = removeBasicAnnotations(node.annotations as Annotation[]);
    const withoutBook = withoutBasic.filter((ann) => ann !== "Book");
    const withoutBookError = withoutBook.filter((ann) => ann !== BOOK_ERROR_ANNOTATION);
    const withoutBookUnknown = withoutBookError.filter((ann) => ann !== BOOK_UNKNOWN_ANNOTATION);
    node.annotations = [...withoutBookUnknown, BOOK_UNKNOWN_ANNOTATION];
    if (node.shapes.length > 0) {
      node.shapes = node.shapes.filter((shape) => !isBookErrorHintShape(shape));
    }
  }
}

export function applyProfileBookPriorityToMainline(root: TreeNode, input: ProfileBookPriorityInput): void {
  const mainline = getMainlineNodes(root);
  const matched = new Set(input.matchedPlies.filter((ply) => Number.isFinite(ply) && ply >= 0));

  for (const ply of matched) {
    if (ply < 0 || ply >= mainline.length) continue;
    const node = mainline[ply];
    const withoutBasic = removeBasicAnnotations(node.annotations as Annotation[]);
    const withoutBookError = withoutBasic.filter((ann) => ann !== BOOK_ERROR_ANNOTATION);
    const withoutBookUnknown = withoutBookError.filter((ann) => ann !== BOOK_UNKNOWN_ANNOTATION);
    const withoutBookDup = withoutBookUnknown.filter((ann) => ann !== "Book");
    node.annotations = [...withoutBookDup, "Book"];
    if (node.shapes.length > 0) {
      node.shapes = node.shapes.filter((shape) => !isBookErrorHintShape(shape));
    }
  }

  applyBookUnknownsToMainline(root, input.unknowns);
  applyBookErrorsToMainline(root, input.errors);
}
