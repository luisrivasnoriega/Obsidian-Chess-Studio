import { invoke } from "@tauri-apps/api/core";
import { exists, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { makeUci, parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { commands, type MoveAnalysis } from "@/bindings";
import { type Directory, type FileMetadata, processEntriesRecursively } from "@/features/files/utils/file";
import { getVariantsDirectory } from "@/features/variants/utils/profileDir";
import { addAnalysis } from "@/state/store/tree";
import { getMainLine, getPGN, parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { getDocumentDir } from "@/utils/documentDir";
import type { LocalEngine } from "@/utils/engines";
import { createFile } from "@/utils/files";
import { formatDateToPGN } from "@/utils/format";
import { finishPerfBaselineSpan, startPerfBaselineSpan } from "@/utils/perfBaseline";
import type { GameHeaders, TreeNode, TreeState } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

const MIN_ENGINE_MS_PER_MOVE = 1000;
const MAX_SAN_MOVES_PER_PUZZLE = 6;

type MoveQuality = "dubious" | "mistake" | "blunder";

export type PostGameReviewInput = {
  root: TreeNode;
  headers: GameHeaders;
  humanColor: "white" | "black" | null;
  profileId: string | null;
  profileName: string | null;
  engines: LocalEngine[];
  mode: "local" | "lichess";
  minEngineMsPerMove?: number;
};

export type PostGameReviewResult = {
  status: "ok" | "skipped" | "error";
  reason?: "no_engine" | "no_moves" | "analysis_failed";
  error?: string;
  engineName: string | null;
  engineMsPerMove: number;
  dubiousCount: number;
  mistakeCount: number;
  blunderCount: number;
  variantDeviationDetected: boolean;
  variantDeviationPly: number | null;
  newLineAdded: boolean;
  variantsBookPath: string | null;
  variantsBookName: string | null;
  addedVariantLine: string | null;
  openVariantsAfterReview: boolean;
  puzzlesGenerated: number;
  puzzleFilePath: string | null;
};

type BookNode = {
  allowedMoves: Set<string>;
  turn: "white" | "black";
};

type BookNodesByFen = Map<string, BookNode>;
type VariantBook = {
  path: string;
  orientation: "white" | "black" | null;
  entryFenKey: string | null;
  entryPly: number;
  nodesByFen: BookNodesByFen;
};

type VariantDeviationDecision = {
  detected: boolean;
  ply: number | null;
  targetBookPath: string | null;
  bookPath: string | null;
  shouldOpenVariants: boolean;
  kind: "none" | "self" | "opp" | "no-entry" | "ambiguous" | "no-book";
};

type PostGameReviewVariantsBackendResult = {
  detected: boolean;
  variantDeviationPly: number | null;
  newLineAdded: boolean;
  variantsBookPath: string | null;
  variantsBookName: string | null;
  addedVariantLine: string | null;
  openVariantsAfterReview: boolean;
  kind: "none" | "self" | "opp" | "no-entry" | "ambiguous" | "no-book";
};

type BookEvaluationStatus =
  | "NO_MATCH"
  | "MATCHING"
  | "FULLY_MATCHED"
  | "BOOK_ENDED_OR_OUTSIDE_SCOPE"
  | "DIVERGED_BEFORE_ENTRY"
  | "SELF_DEVIATION"
  | "OPP_NOVELTY";

type BookEvaluationState = {
  book: VariantBook;
  entryReached: boolean;
  entryReachedAtPly: number | null;
  matchedDepth: number;
  matchedOwnMoves: number;
  matchedOpponentMoves: number;
  selfDeviationPly: number | null;
  selfDeviationFen: string | null;
  expectedOwnMoves: Set<string> | null;
  oppDeviationPly: number | null;
  oppDeviationFen: string | null;
  opponentNewMove: string | null;
  decidingPlyOrInfinity: number;
  status: BookEvaluationStatus;
};

type ReviewIssue = {
  quality: MoveQuality;
  ply: number;
  fenBeforeMove: string;
  playedSan: string;
  solutionSan: string[];
  label: string;
};

function sanitizeFileName(input: string): string {
  const invalidChars = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  const cleaned = Array.from(input)
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code <= 0x1f || invalidChars.has(char)) return "_";
      return char;
    })
    .join("")
    .trim();
  if (!cleaned) return "auto";
  return cleaned.slice(0, 120);
}

function normalizeFenKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(" ");
}

function normalizeMoveKey(move: string): string {
  return move.trim().toLowerCase();
}

function escapePgnTagValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function flattenFileEntries(entries: Array<FileMetadata | Directory>): FileMetadata[] {
  const out: FileMetadata[] = [];
  for (const entry of entries) {
    if (entry.type === "file") {
      out.push(entry);
      continue;
    }
    out.push(...flattenFileEntries(entry.children));
  }
  return out;
}

function cloneTreeState(headers: GameHeaders, root: TreeNode): TreeState {
  return {
    dirty: false,
    position: [],
    headers: structuredClone(headers),
    root: structuredClone(root),
    report: {
      progress: 0,
      isCompleted: false,
      inProgress: false,
    },
  };
}

function collectMainlineNodes(root: TreeNode): TreeNode[] {
  const nodes: TreeNode[] = [];
  let current = root;
  while (current.children.length > 0) {
    const child = current.children[0];
    nodes.push(child);
    current = child;
  }
  return nodes;
}

function formatSanLineFromFen(fen: string, sanMoves: string[]): string {
  if (sanMoves.length === 0) return "";

  const fields = fen.trim().split(/\s+/);
  let turn: "white" | "black" = fields[1] === "b" ? "black" : "white";
  let moveNumber = Number.parseInt(fields[5] ?? "1", 10);
  if (!Number.isFinite(moveNumber) || moveNumber <= 0) moveNumber = 1;

  const parts: string[] = [];
  for (const san of sanMoves) {
    const cleanedSan = san.trim();
    if (!cleanedSan) continue;

    if (turn === "white") {
      parts.push(`${moveNumber}.`, cleanedSan);
      turn = "black";
    } else {
      if (parts.length === 0) {
        parts.push(`${moveNumber}...`, cleanedSan);
      } else {
        parts.push(cleanedSan);
      }
      moveNumber += 1;
      turn = "white";
    }
  }

  return parts.join(" ").trim();
}

function uciLineToSanFromFen(fen: string, uciMoves: string[]): string[] {
  const [startPos] = positionFromFen(fen);
  if (!startPos) return [];

  const pos = startPos.clone();
  const sanMoves: string[] = [];

  for (const uci of uciMoves) {
    const move = parseUci(uci);
    if (!move) break;

    const san = makeSan(pos, move);
    if (!san || san === "--") break;

    sanMoves.push(san);
    pos.play(move);
  }

  return sanMoves;
}

function isFirstMovePlayableFromFen(fen: string, uciMoves: string[]): boolean {
  const first = uciMoves[0];
  if (!first) return false;

  const [startPos] = positionFromFen(fen);
  if (!startPos) return false;

  const move = parseUci(first);
  if (!move) return false;
  const san = makeSan(startPos, move);
  return !!san && san !== "--";
}

function selectBestLineForFen(analysis: MoveAnalysis[], ply: number, fenBeforeMove: string) {
  const candidateIndexes = [ply, ply - 1, ply + 1].filter(
    (idx, i, arr) => idx >= 0 && idx < analysis.length && arr.indexOf(idx) === i,
  );

  for (const index of candidateIndexes) {
    const lines = analysis[index]?.best ?? [];
    for (const line of lines) {
      if (isFirstMovePlayableFromFen(fenBeforeMove, line.uciMoves)) {
        const sanMoves =
          line.sanMoves && line.sanMoves.length > 0
            ? line.sanMoves.map((san) => san.trim()).filter(Boolean)
            : uciLineToSanFromFen(fenBeforeMove, line.uciMoves);
        if (sanMoves.length > 0) {
          return { line, sanMoves };
        }
      }
    }
  }

  return null;
}

function normalizePuzzleSolutionLine(
  fenBeforeMove: string,
  sanMoves: string[],
  humanColor: "white" | "black" | null,
): string[] {
  const cleaned = sanMoves
    .map((san) => san.trim())
    .filter(Boolean)
    .slice(0, MAX_SAN_MOVES_PER_PUZZLE);

  if (cleaned.length === 0 || !humanColor) return cleaned;

  const [pos] = positionFromFen(fenBeforeMove);
  if (!pos || pos.turn !== humanColor) return [];

  // Puzzle board auto-plays the first move when move count is even.
  // Keep an odd-length line so the human side always plays first.
  if (cleaned.length % 2 === 0) {
    cleaned.pop();
  }

  return cleaned;
}

function pickLocalEngine(engines: LocalEngine[]): LocalEngine | null {
  if (engines.length === 0) return null;
  return engines.find((engine) => !!engine.enabled) ?? engines[0];
}

function parseBookOrientation(tags: string[] | undefined): "white" | "black" | null {
  if (!Array.isArray(tags)) return null;
  for (const raw of tags) {
    const tag = raw.toLowerCase();
    if (tag.startsWith("orientation:")) {
      const value = tag.slice("orientation:".length).trim();
      if (value === "white" || value === "black") return value;
    }
    if (tag.startsWith("side:")) {
      const value = tag.slice("side:".length).trim();
      if (value === "white" || value === "black") return value;
    }
    if (tag.startsWith("color:")) {
      const value = tag.slice("color:".length).trim();
      if (value === "white" || value === "black") return value;
    }
  }
  return null;
}

function parseBookEntryFen(tags: string[] | undefined): string | null {
  if (!Array.isArray(tags)) return null;
  for (const rawTag of tags) {
    const trimmed = rawTag.trim();
    if (!trimmed.toLowerCase().startsWith("fen:")) continue;
    const fenValue = trimmed.slice(4).trim();
    if (!fenValue) continue;
    return normalizeFenKey(fenValue);
  }
  return null;
}

function parseTurnFromFenKey(fenKey: string): "white" | "black" {
  const side = fenKey.split(/\s+/)[1];
  return side === "b" ? "black" : "white";
}

function matchBookToHumanColor(book: VariantBook, humanColor: "white" | "black" | null): boolean {
  if (!humanColor) return true;
  if (!book.orientation) return true;
  return book.orientation === humanColor;
}

async function _loadVariantBooks(documentDir: string): Promise<VariantBook[]> {
  const books: VariantBook[] = [];
  const entries = await readDir(documentDir);
  const allEntries = await processEntriesRecursively(documentDir, entries);
  const files = flattenFileEntries(allEntries).filter((entry) => entry.metadata.type === "variants");

  for (const file of files) {
    const nodesByFen: BookNodesByFen = new Map();
    let orientation = parseBookOrientation(file.metadata.tags);
    const entryFenKey = parseBookEntryFen(file.metadata.tags);
    let entryPly = Number.POSITIVE_INFINITY;
    let gameCount = 0;
    try {
      gameCount = unwrap(await commands.countPgnGames(file.path));
    } catch {
      continue;
    }

    if (gameCount <= 0) continue;

    const batchSize = 25;
    for (let start = 0; start < gameCount; start += batchSize) {
      const end = Math.min(gameCount - 1, start + batchSize - 1);
      let games: string[] = [];
      try {
        games = unwrap(await commands.readGames(file.path, start, end));
      } catch {
        continue;
      }

      for (const game of games) {
        let parsed: TreeState | null = null;
        try {
          parsed = await parsePGN(game);
        } catch {
          parsed = null;
        }
        if (!parsed) continue;
        if (!orientation) {
          const parsedOrientation = parsed.headers.orientation;
          if (parsedOrientation === "white" || parsedOrientation === "black") {
            orientation = parsedOrientation;
          }
        }

        const stack: Array<{ node: TreeNode; ply: number }> = [{ node: parsed.root, ply: 0 }];
        while (stack.length > 0) {
          const { node, ply } = stack.pop()!;
          const fenKey = normalizeFenKey(node.fen);
          if (entryFenKey && fenKey === entryFenKey) {
            entryPly = Math.min(entryPly, ply);
          }

          if (node.children.length > 0) {
            const currentNode =
              nodesByFen.get(fenKey) ??
              ({
                allowedMoves: new Set<string>(),
                turn: parseTurnFromFenKey(fenKey),
              } as BookNode);

            for (const child of node.children) {
              if (child.move) {
                currentNode.allowedMoves.add(makeUci(child.move));
              }
              stack.push({ node: child, ply: ply + 1 });
            }

            nodesByFen.set(fenKey, currentNode);
          }
        }
      }
    }

    const normalizedEntryPly = Number.isFinite(entryPly) ? entryPly : 0;
    books.push({
      path: file.path,
      orientation,
      entryFenKey,
      entryPly: normalizedEntryPly,
      nodesByFen,
    });
  }

  return books;
}

export async function detectProfileBookErrorPlies(input: {
  profileId: string | null;
  initialFen: string;
  moves: string[];
  humanColor: "white" | "black" | null;
}): Promise<number[]> {
  if (!input.humanColor || input.moves.length === 0) {
    return [];
  }

  const variantsDir = await getVariantsDirectory(input.profileId);
  if (!(await exists(variantsDir))) {
    return [];
  }

  const books = await _loadVariantBooks(variantsDir);
  const scopedBooks = books.filter((book) => book.orientation === input.humanColor);
  if (scopedBooks.length === 0) {
    return [];
  }

  const [startPos] = positionFromFen(input.initialFen);
  if (!startPos) {
    return [];
  }

  const pos = startPos.clone();
  const errorPlies: number[] = [];

  for (let ply = 0; ply < input.moves.length; ply += 1) {
    const playedMoveRaw = input.moves[ply];
    const playedMove = normalizeMoveKey(playedMoveRaw);
    const sideToMove = pos.turn as "white" | "black";

    const fenBeforeMove = normalizeFenKey(makeFen(pos.toSetup()));
    if (sideToMove === input.humanColor) {
      const allowed = new Set<string>();
      for (const book of scopedBooks) {
        const node = book.nodesByFen.get(fenBeforeMove);
        if (!node || node.turn !== sideToMove) {
          continue;
        }
        for (const allowedMove of node.allowedMoves) {
          allowed.add(normalizeMoveKey(allowedMove));
        }
      }

      if (allowed.size > 0 && !allowed.has(playedMove)) {
        errorPlies.push(ply);
      }
    }

    const parsed = parseUci(playedMove);
    if (!parsed) {
      break;
    }
    pos.play(parsed);
  }

  return errorPlies;
}

function evaluateBookAgainstGame(args: {
  book: VariantBook;
  initialFen: string;
  moves: string[];
  humanColor: "white" | "black" | null;
}): BookEvaluationState {
  const baseState: BookEvaluationState = {
    book: args.book,
    entryReached: false,
    entryReachedAtPly: null,
    matchedDepth: 0,
    matchedOwnMoves: 0,
    matchedOpponentMoves: 0,
    selfDeviationPly: null,
    selfDeviationFen: null,
    expectedOwnMoves: null,
    oppDeviationPly: null,
    oppDeviationFen: null,
    opponentNewMove: null,
    decidingPlyOrInfinity: Number.POSITIVE_INFINITY,
    status: "NO_MATCH",
  };

  const [startPos] = positionFromFen(args.initialFen);
  if (!startPos || !args.humanColor) return baseState;
  const position = startPos.clone();
  const opponentColor = args.humanColor === "white" ? "black" : "white";

  if (args.book.entryFenKey && normalizeFenKey(makeFen(position.toSetup())) === args.book.entryFenKey) {
    baseState.entryReached = true;
    baseState.entryReachedAtPly = 0;
  }

  for (let ply0 = 0; ply0 < args.moves.length; ply0 += 1) {
    const ply = ply0;
    const move = args.moves[ply0];
    const colorToMove = position.turn as "white" | "black";

    const fenBeforeMove = normalizeFenKey(makeFen(position.toSetup()));
    const node = args.book.nodesByFen.get(fenBeforeMove);

    if (!node) {
      baseState.status = baseState.entryReached ? "BOOK_ENDED_OR_OUTSIDE_SCOPE" : "NO_MATCH";
      break;
    }

    if (node.allowedMoves.has(move)) {
      baseState.status = "MATCHING";
      baseState.matchedDepth = ply;
      if (colorToMove === args.humanColor) {
        baseState.matchedOwnMoves += 1;
      } else {
        baseState.matchedOpponentMoves += 1;
      }

      const parsedMove = parseUci(move);
      if (!parsedMove) break;
      position.play(parsedMove);

      if (!baseState.entryReached && args.book.entryFenKey) {
        const nextFen = normalizeFenKey(makeFen(position.toSetup()));
        if (nextFen === args.book.entryFenKey) {
          baseState.entryReached = true;
          baseState.entryReachedAtPly = ply;
        }
      }
      continue;
    }

    if (!baseState.entryReached) {
      baseState.status = "DIVERGED_BEFORE_ENTRY";
      baseState.decidingPlyOrInfinity = ply;
      if (colorToMove === args.humanColor) {
        baseState.selfDeviationPly = ply;
        baseState.selfDeviationFen = fenBeforeMove;
        baseState.expectedOwnMoves = new Set(node.allowedMoves);
      } else if (colorToMove === opponentColor) {
        baseState.oppDeviationPly = ply;
        baseState.oppDeviationFen = fenBeforeMove;
        baseState.opponentNewMove = move;
      }
      break;
    }

    if (colorToMove === args.humanColor) {
      baseState.status = "SELF_DEVIATION";
      baseState.selfDeviationPly = ply;
      baseState.selfDeviationFen = fenBeforeMove;
      baseState.expectedOwnMoves = new Set(node.allowedMoves);
      baseState.decidingPlyOrInfinity = ply;
      break;
    }

    baseState.status = "OPP_NOVELTY";
    baseState.oppDeviationPly = ply;
    baseState.oppDeviationFen = fenBeforeMove;
    baseState.opponentNewMove = move;
    baseState.decidingPlyOrInfinity = ply;
    break;
  }

  if (baseState.status === "MATCHING") {
    baseState.status = baseState.entryReached ? "FULLY_MATCHED" : "NO_MATCH";
  }

  return baseState;
}

function _detectVariantDeviation(args: {
  initialFen: string;
  moves: string[];
  humanColor: "white" | "black" | null;
  books: VariantBook[];
}): VariantDeviationDecision {
  if (!args.humanColor) {
    return {
      detected: false,
      ply: null,
      targetBookPath: null,
      bookPath: null,
      shouldOpenVariants: false,
      kind: "none",
    };
  }

  const scopedBooks = args.books.filter((book) => matchBookToHumanColor(book, args.humanColor));
  if (scopedBooks.length === 0) {
    return {
      detected: true,
      ply: null,
      targetBookPath: null,
      bookPath: null,
      shouldOpenVariants: true,
      kind: "no-book",
    };
  }

  const evaluations = scopedBooks.map((book) =>
    evaluateBookAgainstGame({
      book,
      initialFen: args.initialFen,
      moves: args.moves,
      humanColor: args.humanColor,
    }),
  );

  const reached = evaluations.filter((state) => state.entryReached);
  if (reached.length === 0) {
    const nearEntryOppCandidates = evaluations
      .filter(
        (state) =>
          state.book.entryPly > 0 &&
          state.oppDeviationPly !== null &&
          state.matchedDepth >= Math.max(0, state.book.entryPly - 2),
      )
      .sort((a, b) => {
        if (a.matchedDepth !== b.matchedDepth) return b.matchedDepth - a.matchedDepth;
        if (a.book.entryPly !== b.book.entryPly) return b.book.entryPly - a.book.entryPly;
        return a.decidingPlyOrInfinity - b.decidingPlyOrInfinity;
      });

    const bestNear = nearEntryOppCandidates[0];
    if (bestNear) {
      const topTuple = `${bestNear.matchedDepth}|${bestNear.book.entryPly}|${bestNear.decidingPlyOrInfinity}`;
      const tied = nearEntryOppCandidates.filter(
        (state) => `${state.matchedDepth}|${state.book.entryPly}|${state.decidingPlyOrInfinity}` === topTuple,
      );
      if (tied.length > 1) {
        return {
          detected: true,
          ply: null,
          targetBookPath: null,
          bookPath: null,
          shouldOpenVariants: true,
          kind: "ambiguous",
        };
      }

      return {
        detected: true,
        ply: bestNear.oppDeviationPly,
        targetBookPath: bestNear.book.path,
        bookPath: bestNear.book.path,
        shouldOpenVariants: true,
        kind: "no-entry",
      };
    }

    return {
      detected: true,
      ply: null,
      targetBookPath: null,
      bookPath: null,
      shouldOpenVariants: true,
      kind: "no-entry",
    };
  }

  const sorted = [...reached].sort((a, b) => {
    if (a.book.entryPly !== b.book.entryPly) return b.book.entryPly - a.book.entryPly;
    if (a.matchedDepth !== b.matchedDepth) return b.matchedDepth - a.matchedDepth;
    return a.decidingPlyOrInfinity - b.decidingPlyOrInfinity;
  });
  const best = sorted[0];
  const bestTuple = `${best.book.entryPly}|${best.matchedDepth}|${best.decidingPlyOrInfinity}`;
  const tied = sorted.filter(
    (state) => `${state.book.entryPly}|${state.matchedDepth}|${state.decidingPlyOrInfinity}` === bestTuple,
  );

  if (tied.length > 1) {
    return {
      detected: true,
      ply: null,
      targetBookPath: null,
      bookPath: null,
      shouldOpenVariants: true,
      kind: "ambiguous",
    };
  }

  if (
    best.selfDeviationPly !== null &&
    (best.oppDeviationPly === null || best.selfDeviationPly <= best.oppDeviationPly)
  ) {
    return {
      detected: true,
      ply: best.selfDeviationPly,
      targetBookPath: null,
      bookPath: best.book.path,
      shouldOpenVariants: false,
      kind: "self",
    };
  }

  if (best.oppDeviationPly !== null) {
    return {
      detected: true,
      ply: best.oppDeviationPly,
      targetBookPath: best.book.path,
      bookPath: best.book.path,
      shouldOpenVariants: false,
      kind: "opp",
    };
  }

  return {
    detected: false,
    ply: null,
    targetBookPath: null,
    bookPath: best.book.path,
    shouldOpenVariants: false,
    kind: "none",
  };
}

function buildReviewIssues(args: {
  root: TreeNode;
  analysis: MoveAnalysis[];
  humanColor: "white" | "black" | null;
  variantDeviationPly: number | null;
}): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const mainline = collectMainlineNodes(args.root);

  for (let ply = 0; ply < mainline.length; ply += 1) {
    const node = mainline[ply];
    const annotation = node.annotations.find((a) => a === "?!" || a === "?" || a === "??") ?? null;
    if (!annotation) continue;

    const parentFen = ply === 0 ? args.root.fen : mainline[ply - 1].fen;
    const [parentPos] = positionFromFen(parentFen);
    if (args.humanColor && parentPos?.turn && parentPos.turn !== args.humanColor) {
      continue;
    }

    const selected = selectBestLineForFen(args.analysis, ply, parentFen);
    if (!selected) continue;
    const sanMoves = normalizePuzzleSolutionLine(parentFen, selected.sanMoves, args.humanColor);
    if (sanMoves.length === 0) continue;
    const quality: MoveQuality = annotation === "??" ? "blunder" : annotation === "?" ? "mistake" : "dubious";

    issues.push({
      quality,
      ply,
      fenBeforeMove: parentFen,
      playedSan: node.san ?? "",
      solutionSan: sanMoves,
      label: annotation,
    });
  }

  if (args.variantDeviationPly !== null) {
    const ply = args.variantDeviationPly;
    const parentFen = ply === 0 ? args.root.fen : (mainline[ply - 1]?.fen ?? args.root.fen);
    const [parentPos] = positionFromFen(parentFen);
    if (args.humanColor && parentPos?.turn && parentPos.turn !== args.humanColor) {
      return issues;
    }

    const selected = selectBestLineForFen(args.analysis, ply, parentFen);
    const sanMoves = normalizePuzzleSolutionLine(parentFen, selected?.sanMoves ?? [], args.humanColor);
    if (sanMoves.length > 0) {
      const playedNode = mainline[ply];

      issues.push({
        quality: "mistake",
        ply,
        fenBeforeMove: parentFen,
        playedSan: playedNode?.san ?? "",
        solutionSan: sanMoves,
        label: "VARIANT_DEVIATION",
      });
    }
  }

  const dedupe = new Set<string>();
  return issues.filter((issue) => {
    const key = `${normalizeFenKey(issue.fenBeforeMove)}|${issue.solutionSan.join(" ")}|${issue.label}`;
    if (dedupe.has(key)) return false;
    dedupe.add(key);
    return true;
  });
}

function buildPuzzlePgn(issues: ReviewIssue[]): string {
  if (issues.length === 0) return "";

  const dateTag = formatDateToPGN(new Date());

  return issues
    .map((issue, index) => {
      const solutionValue = issue.solutionSan.join(" ");
      const movetext = formatSanLineFromFen(issue.fenBeforeMove, issue.solutionSan);
      const qualityTag = issue.label === "VARIANT_DEVIATION" ? "variant-deviation" : issue.quality;

      return [
        `[Event "Post-game review puzzle"]`,
        `[Site "Obsidian Chess Studio"]`,
        `[Date "${dateTag}"]`,
        `[Round "${index + 1}"]`,
        `[White "?"]`,
        `[Black "?"]`,
        `[Result "*"]`,
        `[SetUp "1"]`,
        `[FEN "${escapePgnTagValue(issue.fenBeforeMove)}"]`,
        `[PuzzleType "${qualityTag}"]`,
        `[MoveQuality "${escapePgnTagValue(issue.label)}"]`,
        `[PlayedMove "${escapePgnTagValue(issue.playedSan)}"]`,
        `[Solution "${escapePgnTagValue(solutionValue)}"]`,
        ``,
        `${movetext} *`.trim(),
        ``,
      ].join("\n");
    })
    .join("\n");
}

async function _appendLineToVariantsBook(args: {
  bookPath: string;
  root: TreeNode;
  headers: GameHeaders;
  untilPly: number;
}): Promise<{ path: string; line: string | null } | null> {
  if (!(await exists(args.bookPath))) return null;
  const mainlineLength = collectMainlineNodes(args.root).length;
  if (mainlineLength <= 0) return null;
  const boundedPly = Math.max(0, Math.min(args.untilPly, mainlineLength - 1));
  const mainlinePath = Array.from({ length: boundedPly + 1 }, () => 0);

  const headersForPgn: GameHeaders = {
    ...args.headers,
    event: args.headers.event || "Variant extension",
    site: args.headers.site || "Obsidian Chess Studio",
    date: args.headers.date || formatDateToPGN(new Date()),
    result: "*",
  };

  const linePgn = getPGN(args.root, {
    headers: headersForPgn,
    comments: false,
    extraMarkups: false,
    glyphs: false,
    variations: false,
    path: mainlinePath,
  });
  if (!linePgn || linePgn.trim().length === 0) return null;

  const mainlineNodes = collectMainlineNodes(args.root).slice(0, boundedPly + 1);
  const sanMoves = mainlineNodes.map((node) => node.san?.trim() ?? "").filter((san) => san.length > 0);
  const lineText = sanMoves.length > 0 ? formatSanLineFromFen(args.root.fen, sanMoves) : null;

  const current = await readTextFile(args.bookPath);
  const next = `${current.trimEnd()}\n\n${linePgn}\n`;
  await writeTextFile(args.bookPath, next);
  return { path: args.bookPath, line: lineText };
}

function _extractBookName(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export async function runPostGameAutoReview(input: PostGameReviewInput): Promise<PostGameReviewResult> {
  const localEngines = input.engines.filter((engine) => engine.type === "local");
  const selectedEngine = pickLocalEngine(localEngines);
  const initialFen = input.headers.fen?.trim() || input.root.fen;
  const is960 = input.headers.variant === "Chess960";
  const moves = getMainLine(input.root, is960);
  const engineMsPerMove = Math.max(input.minEngineMsPerMove ?? MIN_ENGINE_MS_PER_MOVE, MIN_ENGINE_MS_PER_MOVE);
  const reviewSpan = startPerfBaselineSpan({
    scope: "boards.post_game_review",
    label: "run",
    metadata: {
      mode: input.mode,
      humanColor: input.humanColor ?? "none",
      engine: selectedEngine?.name ?? "none",
      moves: moves.length,
      minEngineMsPerMove: input.minEngineMsPerMove ?? null,
    },
  });
  let reviewStatus = "running";
  let generatedPuzzles = 0;
  const documentDir = await getDocumentDir();
  const variantsDir = await getVariantsDirectory(input.profileId);
  let variantDeviation: VariantDeviationDecision = {
    detected: false,
    ply: null,
    targetBookPath: null,
    bookPath: null,
    shouldOpenVariants: false,
    kind: "none",
  };
  let newLineAdded = false;
  let variantsBookPath: string | null = null;
  let variantsBookName: string | null = null;
  let addedVariantLine: string | null = null;

  try {
    if (moves.length > 0) {
      try {
        const variantReview = await invoke<PostGameReviewVariantsBackendResult>("post_game_review_variants", {
          input: {
            documentDir: variantsDir,
            initialFen,
            moves,
            humanColor: input.humanColor,
          },
        });

        variantDeviation = {
          detected: variantReview.detected,
          ply: variantReview.variantDeviationPly,
          targetBookPath: null,
          bookPath: variantReview.variantsBookPath,
          shouldOpenVariants: variantReview.openVariantsAfterReview,
          kind: variantReview.kind,
        };
        newLineAdded = variantReview.newLineAdded;
        variantsBookPath = variantReview.variantsBookPath;
        variantsBookName = variantReview.variantsBookName;
        addedVariantLine = variantReview.addedVariantLine;
      } catch {
        // Keep review flow resilient if backend variants command fails.
      }
    }

    if (!selectedEngine) {
      reviewStatus = "skipped_no_engine";
      return {
        status: "skipped",
        reason: "no_engine",
        engineName: null,
        engineMsPerMove,
        dubiousCount: 0,
        mistakeCount: 0,
        blunderCount: 0,
        variantDeviationDetected: variantDeviation.detected,
        variantDeviationPly: variantDeviation.ply,
        newLineAdded,
        variantsBookPath,
        variantsBookName,
        addedVariantLine,
        openVariantsAfterReview: variantDeviation.shouldOpenVariants,
        puzzlesGenerated: 0,
        puzzleFilePath: null,
      };
    }

    if (moves.length === 0) {
      reviewStatus = "skipped_no_moves";
      return {
        status: "skipped",
        reason: "no_moves",
        engineName: selectedEngine.name,
        engineMsPerMove,
        dubiousCount: 0,
        mistakeCount: 0,
        blunderCount: 0,
        variantDeviationDetected: variantDeviation.detected,
        variantDeviationPly: variantDeviation.ply,
        newLineAdded,
        variantsBookPath,
        variantsBookName,
        addedVariantLine,
        openVariantsAfterReview: variantDeviation.shouldOpenVariants,
        puzzlesGenerated: 0,
        puzzleFilePath: null,
      };
    }

    const analysisId = `post_game_review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const engineSettings = (selectedEngine.settings ?? []).map((setting) => ({
      ...setting,
      value: setting.value?.toString() ?? "",
    }));

    if (is960 && !engineSettings.some((option) => option.name === "UCI_Chess960")) {
      engineSettings.push({ name: "UCI_Chess960", value: "true" });
    }

    let analysis: MoveAnalysis[];
    try {
      const analyzed = await commands.analyzeGame(
        analysisId,
        selectedEngine.path,
        { t: "Time", c: engineMsPerMove },
        {
          annotateNovelties: false,
          fen: initialFen,
          referenceDb: null,
          reversed: false,
          moves,
        },
        engineSettings,
      );
      analysis = unwrap(analyzed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reviewStatus = "analysis_failed";
      return {
        status: "error",
        reason: "analysis_failed",
        error: message,
        engineName: selectedEngine.name,
        engineMsPerMove,
        dubiousCount: 0,
        mistakeCount: 0,
        blunderCount: 0,
        variantDeviationDetected: variantDeviation.detected,
        variantDeviationPly: variantDeviation.ply,
        newLineAdded,
        variantsBookPath,
        variantsBookName,
        addedVariantLine,
        openVariantsAfterReview: variantDeviation.shouldOpenVariants,
        puzzlesGenerated: 0,
        puzzleFilePath: null,
      };
    }

    const analyzedTree = cloneTreeState(input.headers, input.root);
    addAnalysis(analyzedTree, analysis);

    const issues = buildReviewIssues({
      root: analyzedTree.root,
      analysis,
      humanColor: input.humanColor,
      variantDeviationPly: variantDeviation.ply,
    });

    const dubiousCount = issues.filter((issue) => issue.quality === "dubious").length;
    const mistakeCount = issues.filter((issue) => issue.quality === "mistake").length;
    const blunderCount = issues.filter((issue) => issue.quality === "blunder").length;

    let puzzleFilePath: string | null = null;
    if (issues.length > 0) {
      const puzzlePgn = buildPuzzlePgn(issues);
      if (puzzlePgn.trim().length > 0) {
        const dateTag = formatDateToPGN(new Date());
        const stamp = String(Date.now()).slice(-6);
        const modeTag = input.mode === "lichess" ? "lichess" : "local";
        const fileName = sanitizeFileName(`post-game-puzzles-${modeTag}-${dateTag}-${stamp}`);

        const created = await createFile({
          filename: fileName,
          filetype: "puzzle",
          tags: [
            "post-game-review",
            input.mode === "lichess" ? "source:lichess" : "source:local",
            input.profileId ? `profile:${input.profileId}` : "profile:none",
            variantDeviation.detected ? "variant-deviation" : "",
          ].filter(Boolean),
          pgn: puzzlePgn,
          dir: documentDir,
        });

        if (created.isOk) {
          puzzleFilePath = created.value.path;
        }
      }
    }

    generatedPuzzles = issues.length;
    reviewStatus = "ok";
    return {
      status: "ok",
      engineName: selectedEngine.name,
      engineMsPerMove,
      dubiousCount,
      mistakeCount,
      blunderCount,
      variantDeviationDetected: variantDeviation.detected,
      variantDeviationPly: variantDeviation.ply,
      newLineAdded,
      variantsBookPath,
      variantsBookName,
      addedVariantLine,
      openVariantsAfterReview: variantDeviation.shouldOpenVariants,
      puzzlesGenerated: issues.length,
      puzzleFilePath,
    };
  } finally {
    await finishPerfBaselineSpan(reviewSpan, {
      status: reviewStatus,
      mode: input.mode,
      humanColor: input.humanColor ?? "none",
      moves: moves.length,
      engine: selectedEngine?.name ?? "none",
      puzzlesGenerated: generatedPuzzles,
      variantDeviationDetected: variantDeviation.detected,
      variantDeviationPly: variantDeviation.ply ?? null,
    });
  }
}
