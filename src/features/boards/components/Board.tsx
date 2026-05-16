import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Piece } from "@lichess-org/chessground/types";
import { Box, Group, Portal, Text, useMantineTheme } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { makeSquare, type NormalMove, parseSquare, parseUci, type SquareName } from "chessops";
import { chessgroundDests, chessgroundMove } from "chessops/compat";
import { INITIAL_FEN } from "chessops/fen";
import { makeSan } from "chessops/san";
import domtoimage from "dom-to-image";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { memo, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import BoardControlsMenu from "@/components/BoardControlsMenu";
import { Chessground } from "@/components/Chessground";
import Clock from "@/components/Clock";
import MoveControls from "@/components/MoveControls";
import { arrowColors } from "@/components/panels/analysis/BestMoves";
import ShowMaterial from "@/components/ShowMaterial";
import { TreeStateContext } from "@/components/TreeStateContext";
import { updateCardPerformance } from "@/features/files/utils/opening";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  autoPromoteAtom,
  bestMovesFamily,
  blindfoldAtom,
  currentEvalOpenAtom,
  currentTabAtom,
  deckAtomFamily,
  enableBoardScrollAtom,
  enginesAtom,
  eraseDrawablesOnClickAtom,
  moveInputAtom,
  showArrowsAtom,
  showConsecutiveArrowsAtom,
  showCoordinatesAtom,
  showDestsAtom,
  snapArrowsAtom,
} from "@/state/atoms";
import { keyMapAtom } from "@/state/keybindings";
import { blindfold, chessboard } from "@/styles/Chessboard.css";
import { annotationColors, isBasicAnnotation } from "@/utils/annotation";
import { getMaterialDiff, getVariationLine } from "@/utils/chess";
import { chessopsError, positionFromFen } from "@/utils/chessops";
import { getDocumentDir } from "@/utils/documentDir";
import type { TreeNode } from "@/utils/treeReducer";
import AnnotationHint from "./AnnotationHint";
import EvalBar from "./EvalBar";
import MoveInput from "./MoveInput";
import PromotionModal from "./PromotionModal";

const LARGE_BRUSH = 11;
const MEDIUM_BRUSH = 7.5;
const SMALL_BRUSH = 4;
const MATERIAL_OVERLAY_HEIGHT = 34;

type BoardNodeSnapshot = Pick<TreeNode, "annotations" | "fen" | "halfMoves" | "move" | "san" | "shapes"> & {
  childrenLength: number;
};

interface ChessboardProps {
  dirty: boolean;
  editingMode: boolean;
  toggleEditingMode: () => void;
  viewOnly?: boolean;
  disableVariations?: boolean;
  movable?: "both" | "white" | "black" | "turn" | "none";
  boardRef: React.MutableRefObject<HTMLDivElement | null>;
  saveFile?: () => void;
  copyPgn?: () => void;
  reload?: () => void;
  addGame?: () => void;
  canTakeBack?: boolean;
  whiteTime?: number;
  blackTime?: number;
  practicing?: boolean;
  showClock?: boolean;
  // Board controls props
  viewPawnStructure?: boolean;
  setViewPawnStructure?: (value: boolean) => void;
  takeSnapshot?: () => void;
  deleteMove?: () => void;
  changeTabType?: () => void;
  currentTabType?: "analysis" | "play";
  eraseDrawablesOnClick?: boolean;
  clearShapes?: () => void;
  toggleOrientation?: () => void;
  currentTabSourceType?: string;
  selectedPiece?: Piece | null;
  setSelectedPiece?: (piece: Piece | null) => void;
  // Start Game props
  startGame?: () => void;
  gameState?: "settingUp" | "playing" | "gameOver";
  startGameDisabled?: boolean;
  // Hide clock spaces for compact mode (e.g., PlayVsEngineBoard)
  hideClockSpaces?: boolean;
  // Hide eval bar and footer controls for game mode (e.g., PlayVsEngineBoard)
  hideEvalBar?: boolean;
  hideFooterControls?: boolean;
  desktopFooterContent?: ReactNode;
  materialPlacement?: "flow" | "overlay";
  allowPremove?: boolean;
}

function CurrentEvalBar({ orientation, turn }: { orientation: "white" | "black"; turn: "white" | "black" }) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("CurrentEvalBar must be used within a TreeStateProvider");
  }

  const score = useStore(store, (s) => s.currentNode().score);
  const engines = useAtomValue(enginesAtom);
  const [, setEvalOpen] = useAtom(currentEvalOpenAtom);

  const hasUCI_ShowWDL = useMemo(() => {
    const loadedEngines = engines.filter((engine) => engine.loaded);
    const hasInSettings = loadedEngines.some((engine) => {
      return engine.settings?.some(
        (setting) => setting.name === "UCI_ShowWDL" && (setting.value === true || setting.value === "true"),
      );
    });
    return hasInSettings || score?.wdl != null;
  }, [engines, score]);

  return (
    <Box h="100%" onClick={() => setEvalOpen((prevState) => !prevState)}>
      <EvalBar score={score ?? null} orientation={orientation} turn={turn} showWDL={hasUCI_ShowWDL} />
    </Box>
  );
}

function Board({
  dirty,
  editingMode,
  toggleEditingMode,
  viewOnly,
  disableVariations,
  movable = "turn",
  boardRef,
  saveFile,
  copyPgn,
  reload,
  addGame,
  canTakeBack,
  whiteTime,
  blackTime,
  practicing,
  showClock = true,
  // Board controls props
  viewPawnStructure,
  setViewPawnStructure,
  takeSnapshot,
  deleteMove,
  changeTabType,
  currentTabType,
  eraseDrawablesOnClick,
  clearShapes,
  toggleOrientation,
  currentTabSourceType,
  selectedPiece,
  setSelectedPiece,
  // Start Game props
  startGame,
  gameState,
  startGameDisabled,
  hideClockSpaces = false,
  hideEvalBar = false,
  hideFooterControls = false,
  desktopFooterContent,
  materialPlacement = "flow",
  allowPremove = false,
}: ChessboardProps) {
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();
  const boardAreaRef = useRef<HTMLDivElement | null>(null);
  const [boardAreaSize, setBoardAreaSize] = useState({ width: 0, height: 0 });
  const [hasBoardControlsRail, setHasBoardControlsRail] = useState(false);

  useEffect(() => {
    const el = boardAreaRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;

    let rafId = 0;

    const measure = (width: number, height: number) => {
      const w = Math.floor(width);
      const h = Math.floor(height);
      setBoardAreaSize((current) => (current.width === w && current.height === h ? current : { width: w, height: h }));
    };

    const rect = el.getBoundingClientRect();
    measure(rect.width, rect.height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => measure(width, height));
    });

    observer.observe(el);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("Board must be used within a TreeStateProvider");
  }

  const rootFen = useStore(store, (s) => s.root.fen);
  const position = useStore(store, (s) => s.position);
  const headers = useStore(store, (s) => s.headers);
  const currentNodeAnnotations = useStore(store, (s) => s.currentNode().annotations);
  const currentNodeChildrenLength = useStore(store, (s) => s.currentNode().children.length);
  const currentNodeFen = useStore(store, (s) => s.currentNode().fen);
  const currentNodeHalfMoves = useStore(store, (s) => s.currentNode().halfMoves);
  const currentNodeMove = useStore(store, (s) => s.currentNode().move);
  const currentNodeSan = useStore(store, (s) => s.currentNode().san);
  const currentNodeShapes = useStore(store, (s) => s.currentNode().shapes);
  const currentNode = useMemo<BoardNodeSnapshot>(
    () => ({
      annotations: currentNodeAnnotations,
      childrenLength: currentNodeChildrenLength,
      fen: currentNodeFen,
      halfMoves: currentNodeHalfMoves,
      move: currentNodeMove,
      san: currentNodeSan,
      shapes: currentNodeShapes,
    }),
    [
      currentNodeAnnotations,
      currentNodeChildrenLength,
      currentNodeFen,
      currentNodeHalfMoves,
      currentNodeMove,
      currentNodeSan,
      currentNodeShapes,
    ],
  );

  const goToNext = useStore(store, (s) => s.goToNext);
  const goToPrevious = useStore(store, (s) => s.goToPrevious);
  const storeMakeMove = useStore(store, (s) => s.makeMove);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const storeDeleteMove = useStore(store, (s) => s.deleteMove);
  const storeClearShapes = useStore(store, (s) => s.clearShapes);
  const setShapes = useStore(store, (s) => s.setShapes);
  const setFen = useStore(store, (s) => s.setFen);

  const [pos, error] = useMemo(() => positionFromFen(currentNode?.fen ?? INITIAL_FEN), [currentNode?.fen]);

  const moveInput = useAtomValue(moveInputAtom);
  const showDests = useAtomValue(showDestsAtom);
  const showArrows = useAtomValue(showArrowsAtom);
  const showConsecutiveArrows = useAtomValue(showConsecutiveArrowsAtom);
  const storeEraseDrawablesOnClick = useAtomValue(eraseDrawablesOnClickAtom);
  const autoPromote = useAtomValue(autoPromoteAtom);
  const showCoordinates = useAtomValue(showCoordinatesAtom);
  const isBlindfold = useAtomValue(blindfoldAtom);
  const setBlindfold = useSetAtom(blindfoldAtom);
  const _activeTab = useAtomValue(currentTabAtom);

  const dests: Map<SquareName, SquareName[]> = useMemo(() => {
    if (!pos) return new Map();
    return chessgroundDests(pos);
  }, [pos]);

  const [localViewPawnStructure, setLocalViewPawnStructure] = useState(false);
  const [pendingMove, setPendingMove] = useState<NormalMove | null>(null);

  const turn = pos?.turn || "white";
  const orientation = headers.orientation || "white";
  const localToggleOrientation = () =>
    setHeaders({
      ...headers,
      fen: rootFen, // Keep current board setup
      orientation: orientation === "black" ? "white" : "black",
    });

  const localTakeSnapshot = async () => {
    const ref = boardRef?.current;
    if (ref == null) return;

    // We must get the first children three levels below, as it has the right dimensions.
    const refChildNode = ref.children[0].children[0].children[0] as HTMLElement;
    if (refChildNode == null) return;

    domtoimage.toBlob(refChildNode).then(async (blob) => {
      if (blob == null) return;
      const documentsDirPath: string = await getDocumentDir();

      const filePath = await save({
        title: "Save board snapshot",
        defaultPath: documentsDirPath,
        filters: [
          {
            name: "Png image",
            extensions: ["png"],
          },
        ],
      });
      const arrayBuffer = await blob.arrayBuffer();
      if (filePath == null) return;
      await writeFile(filePath, new Uint8Array(arrayBuffer));
    });
  };

  const keyMap = useAtomValue(keyMapAtom);
  useHotkeys([[keyMap.SWAP_ORIENTATION.keys, () => (toggleOrientation ?? localToggleOrientation)()]]);
  const [currentTab, setCurrentTab] = useAtom(currentTabAtom);
  const [evalOpen, setEvalOpen] = useAtom(currentEvalOpenAtom);

  const emptyMoves = useMemo(() => [] as string[], []);
  const arrowMoves = useMemo(() => {
    if (!showArrows || !evalOpen) return emptyMoves;
    return getVariationLine(store.getState().root, position, headers.variant === "Chess960");
  }, [emptyMoves, evalOpen, headers.variant, position, showArrows, store]);

  const arrows = useAtomValue(
    bestMovesFamily({
      fen: rootFen,
      gameMoves: arrowMoves,
    }),
  );

  const [deck, setDeck] = useAtom(
    deckAtomFamily({
      file: currentTab?.source?.type === "file" ? currentTab.source.path : "",
      game: currentTab?.gameNumber || 0,
    }),
  );

  const makeMove = useCallback(
    async (move: NormalMove) => {
      if (!pos) return;
      const san = makeSan(pos, move);
      if (practicing) {
        const c = deck.positions.find((c) => c.fen === currentNode.fen);
        if (!c) {
          return;
        }

        let isRecalled = true;
        if (san !== c?.answer) {
          isRecalled = false;
        }
        const i = deck.positions.indexOf(c);

        if (!isRecalled) {
          notifications.show({
            title: t("common.incorrect"),
            message: t("features.board.practice.correctMoveWas", { move: c.answer }),
            color: "red",
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
          goToNext();
        } else {
          storeMakeMove({
            payload: move,
          });
          setPendingMove(null);
        }

        updateCardPerformance(setDeck, i, c.card, isRecalled ? 4 : 1);
      } else {
        storeMakeMove({
          payload: move,
          clock: pos.turn === "white" ? whiteTime : blackTime,
        });
        setPendingMove(null);
      }
    },
    [blackTime, currentNode.fen, deck.positions, goToNext, pos, practicing, setDeck, storeMakeMove, t, whiteTime],
  );

  const shapes = useMemo(() => {
    const nextShapes: DrawShape[] = [];
    if (showArrows && evalOpen && arrows.size > 0 && pos) {
      const entries = Array.from(arrows.entries()).sort((a, b) => a[0] - b[0]);
      for (const [engineIndex, bestMoves] of entries) {
        if (engineIndex >= 4) continue;
        const bestWinChance = bestMoves[0]?.winChance;
        if (bestWinChance == null) continue;

        for (const [variationIndex, { pv, winChance }] of bestMoves.entries()) {
          let prevSquare: string | null = null;

          for (const [moveIndex, uci] of pv.entries()) {
            const move = parseUci(uci) as NormalMove | undefined;
            if (!move) break;

            const from = makeSquare(move.from);
            const to = makeSquare(move.to);
            if (!from || !to) break;

            if (prevSquare === null) {
              prevSquare = from;
            }

            const brushSize = match(bestWinChance - winChance)
              .when(
                (d) => d < 2.5,
                () => LARGE_BRUSH,
              )
              .when(
                (d) => d < 5,
                () => MEDIUM_BRUSH,
              )
              .otherwise(() => SMALL_BRUSH);

            const shouldDraw =
              moveIndex === 0 || (showConsecutiveArrows && variationIndex === 0 && moveIndex % 2 === 0);
            if (!shouldDraw) continue;

            const isDuplicate = nextShapes.some((s) => s.orig === from && s.dest === to);
            const isContinuation = prevSquare === from;
            if (!isContinuation || isDuplicate) break;

            if (moveIndex >= 5) break; // cap arrow count per line

            const arrowColor = variationIndex === 0 ? arrowColors[engineIndex].strong : arrowColors[engineIndex].pale;

            nextShapes.push({
              orig: from,
              dest: to,
              brush: arrowColor,
              modifiers: {
                lineWidth: brushSize,
              },
            });
            prevSquare = to;
          }
        }
      }
    }

    if (currentNode.shapes.length > 0) {
      nextShapes.push(...currentNode.shapes);
    }

    return nextShapes;
  }, [arrows, currentNode.shapes, evalOpen, pos, showArrows, showConsecutiveArrows]);

  const hasClock =
    showClock &&
    (whiteTime !== undefined ||
      blackTime !== undefined ||
      headers.time_control !== undefined ||
      headers.white_time_control !== undefined ||
      headers.black_time_control !== undefined);

  function localChangeTabType() {
    setCurrentTab((t) => {
      return {
        ...t,
        type: t.type === "analysis" ? "play" : "analysis",
      };
    });
  }

  const materialDiff = getMaterialDiff(currentNode.fen);
  const practiceLock = !!practicing && !deck.positions.find((c) => c.fen === currentNode.fen);

  const movableColor: "white" | "black" | "both" | undefined = useMemo(() => {
    return practiceLock
      ? undefined
      : editingMode
        ? "both"
        : match(movable)
            .with("white", () => "white" as const)
            .with("black", () => "black" as const)
            .with("turn", () => turn)
            .with("both", () => "both" as const)
            .with("none", () => undefined)
            .exhaustive();
  }, [practiceLock, editingMode, movable, turn]);

  const _theme = useMantineTheme();
  const annotationColor = annotationColors[currentNode.annotations[0]] || "#6B7280";
  // Use the hex color directly for both light and dark variants
  const lightColor = annotationColor;
  const darkColor = annotationColor;

  const [enableBoardScroll] = useAtom(enableBoardScrollAtom);
  const [snapArrows] = useAtom(snapArrowsAtom);

  const showDesktopSideControls = !hideFooterControls && layout.chessBoard.layoutType !== "mobile";
  const topMaterialColor = orientation === "white" ? "black" : "white";
  const bottomMaterialColor = orientation;
  const materialHasVisibleContent = (color: "white" | "black") => {
    if (!materialDiff) return false;
    return color === "white" ? materialDiff.diff > 0 : materialDiff.diff < 0;
  };
  const useOverlayMaterial = materialPlacement === "overlay" && !hideClockSpaces && !!materialDiff;

  const boardSquareSize = useMemo(() => {
    const size = Math.floor(Math.min(boardAreaSize.width, boardAreaSize.height));
    return Number.isFinite(size) && size > 0 ? size : null;
  }, [boardAreaSize.height, boardAreaSize.width]);

  const materialOverlayOffset = useMemo(() => {
    if (!boardSquareSize) return 0;
    return Math.max(0, Math.floor((boardAreaSize.height - boardSquareSize) / 2 - MATERIAL_OVERLAY_HEIGHT));
  }, [boardAreaSize.height, boardSquareSize]);

  const setBoardFen = useCallback(
    (fen: string) => {
      if (!fen || !editingMode) {
        return;
      }
      const newFen = `${fen} ${currentNode.fen.split(" ").slice(1).join(" ")}`;

      if (newFen !== currentNode.fen) {
        setFen(newFen);
      }
    },
    [editingMode, currentNode.fen, setFen],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const linkId = "view-pawn-structure-css";

    if (viewPawnStructure) {
      if (!document.getElementById(linkId)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/pieces/view-pawn-structure.css";
        link.id = linkId;

        document.head.appendChild(link);
      }
    } else {
      const existingLink = document.getElementById(linkId);
      if (existingLink) {
        document.head.removeChild(existingLink);
      }
    }

    return () => {
      const existingLink = document.getElementById(linkId);
      if (existingLink) {
        document.head.removeChild(existingLink);
      }
    };
  }, [viewPawnStructure]);

  useEffect(() => {
    if (!showDesktopSideControls) {
      setHasBoardControlsRail(false);
      return;
    }

    let raf = 0;
    const check = () => {
      const exists = !!document.getElementById("board-controls-rail");
      if (exists) {
        setHasBoardControlsRail(true);
        return;
      }
      raf = requestAnimationFrame(check);
    };

    check();
    return () => cancelAnimationFrame(raf);
  }, [showDesktopSideControls]);

  useHotkeys([
    [keyMap.TOGGLE_EVAL_BAR.keys, () => setEvalOpen((e) => !e)],
    [keyMap.BLINDFOLD.keys, () => setBlindfold((v) => !v)],
  ]);

  const square = match(currentNode)
    .with({ san: "O-O" }, ({ halfMoves }) => parseSquare(halfMoves % 2 === 1 ? "g1" : "g8"))
    .with({ san: "O-O-O" }, ({ halfMoves }) => parseSquare(halfMoves % 2 === 1 ? "c1" : "c8"))
    .otherwise((node) => node?.move?.to);

  let lastMove: [SquareName, SquareName] | undefined;
  if (currentNode?.move && square !== undefined) {
    const destination = makeSquare(square);
    if (destination) {
      lastMove = [chessgroundMove(currentNode.move)[0], destination];
    }
  }

  // ---------------------------------------------------------------------------
  // Performance: keep Chessground config object references stable across frequent
  // engine updates (score/progress), to avoid calling chessground api.set(...) on
  // every render while dragging pieces.

  const animationConfig = useMemo(() => ({ enabled: !editingMode }), [editingMode]);
  const premovableConfig = useMemo(() => ({ enabled: allowPremove }), [allowPremove]);

  const onAfterMove = useCallback(
    (orig: string, dest: string, metadata: { ctrlKey?: boolean }) => {
      if (editingMode) return;

      const from = parseSquare(orig);
      const to = parseSquare(dest);
      // IMPORTANT: `parseSquare("a1")` returns 0, which is falsy.
      // Use null/undefined checks instead of truthiness.
      if (from == null || to == null) return;

      if (!pos) return;
      if (
        pos.board.get(from)?.role === "pawn" &&
        ((dest[1] === "8" && turn === "white") || (dest[1] === "1" && turn === "black"))
      ) {
        if (autoPromote && !metadata.ctrlKey) {
          makeMove({
            from,
            to,
            promotion: "queen",
          });
        } else {
          setPendingMove({
            from,
            to,
          });
        }
      } else {
        makeMove({
          from,
          to,
        });
      }
    },
    [autoPromote, editingMode, makeMove, pos, turn],
  );

  const movableConfig = useMemo(
    () => ({
      free: editingMode,
      color: movableColor,
      dests:
        editingMode || viewOnly ? undefined : disableVariations && currentNode.childrenLength > 0 ? undefined : dests,
      showDests,
      events: {
        after: onAfterMove,
      },
    }),
    [currentNode.childrenLength, dests, disableVariations, editingMode, movableColor, onAfterMove, showDests, viewOnly],
  );

  const draggableConfig = useMemo(
    () => ({
      enabled: !viewPawnStructure && !layout.chessBoard.touchOptimized,
      deleteOnDropOff: editingMode,
    }),
    [editingMode, layout.chessBoard.touchOptimized, viewPawnStructure],
  );

  const selectableConfig = useMemo(
    () => ({
      enabled: layout.chessBoard.touchOptimized,
    }),
    [layout.chessBoard.touchOptimized],
  );

  const onDrawableChange = useCallback(
    (next: DrawShape[]) => {
      setShapes(next);
    },
    [setShapes],
  );

  const drawableConfig = useMemo(
    () => ({
      enabled: true,
      visible: true,
      defaultSnapToValidMove: snapArrows,
      autoShapes: shapes,
      onChange: onDrawableChange,
    }),
    [onDrawableChange, shapes, snapArrows],
  );

  return (
    <Box w="100%" h="100%">
      <Box
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          gap: hideClockSpaces ? "0" : "0.5rem",
          flexWrap: "nowrap",
          overflow: "hidden",
          // Let the board use available space - responsive sizing is handled by the container
          maxWidth: "100%",
          maxHeight: "100%",
          minHeight: 0,
          minWidth: 0,
        }}
      >
        {!useOverlayMaterial && !hideClockSpaces && materialDiff && (
          <Group ml="2.5rem" h="2.125rem">
            {hasClock && (
              <Clock
                color={orientation === "black" ? "white" : "black"}
                turn={turn}
                whiteTime={whiteTime}
                blackTime={blackTime}
              />
            )}
            <ShowMaterial
              diff={materialDiff.diff}
              pieces={materialDiff.pieces}
              color={orientation === "white" ? "black" : "white"}
            />
          </Group>
        )}
        <Group
          align="stretch"
          style={{
            position: "relative",
            flexWrap: "nowrap",
            flex: "1 1 0",
            minHeight: 0,
            minWidth: 0,
            height: hideClockSpaces ? "100%" : undefined,
            overflow: "hidden",
          }}
          gap="md"
        >
          {currentNode?.annotations?.length > 0 && currentNode?.move && square !== undefined && (
            <Box pl="2.5rem" w="100%" h="100%" pos="absolute">
              <Box pos="relative" w="100%" h="100%">
                <AnnotationHint orientation={orientation} square={square} annotation={currentNode.annotations[0]} />
              </Box>
            </Box>
          )}
          {!hideEvalBar && layout.chessBoard.layoutType !== "mobile" && (
            <CurrentEvalBar orientation={orientation} turn={turn} />
          )}
          <Box
            ref={boardAreaRef}
            style={{
              position: "relative",
              flex: "1 1 0",
              height: "100%",
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {useOverlayMaterial && boardSquareSize && materialHasVisibleContent(topMaterialColor) && (
              <Group
                h="2.125rem"
                style={{
                  position: "absolute",
                  top: `${materialOverlayOffset}px`,
                  left: `calc(50% - ${boardSquareSize / 2}px)`,
                  width: `${boardSquareSize}px`,
                  overflow: "hidden",
                  pointerEvents: "none",
                  zIndex: 2,
                }}
              >
                <ShowMaterial diff={materialDiff.diff} pieces={materialDiff.pieces} color={topMaterialColor} />
              </Group>
            )}
            {useOverlayMaterial && boardSquareSize && materialHasVisibleContent(bottomMaterialColor) && (
              <Group
                h="2.125rem"
                style={{
                  position: "absolute",
                  bottom: `${materialOverlayOffset}px`,
                  left: `calc(50% - ${boardSquareSize / 2}px)`,
                  width: `${boardSquareSize}px`,
                  overflow: "hidden",
                  pointerEvents: "none",
                  zIndex: 2,
                }}
              >
                <ShowMaterial diff={materialDiff.diff} pieces={materialDiff.pieces} color={bottomMaterialColor} />
              </Group>
            )}
            <Box
              style={{
                ...(isBasicAnnotation(currentNode.annotations[0])
                  ? {
                      "--light-color": lightColor,
                      "--dark-color": darkColor,
                    }
                  : {}),
                width: boardSquareSize ? `${boardSquareSize}px` : "100%",
                height: boardSquareSize ? `${boardSquareSize}px` : "100%",
                aspectRatio: boardSquareSize ? undefined : "1 / 1",
                maxWidth: "100%",
                maxHeight: "100%",
                minWidth: 0,
                minHeight: 0,
                flex: "0 0 auto",
              }}
              className={`${chessboard} ${isBlindfold ? blindfold : ""}`}
              ref={boardRef}
              onClick={() => {
                (eraseDrawablesOnClick ?? storeEraseDrawablesOnClick) && (clearShapes ?? storeClearShapes)();
              }}
              onWheel={(e) => {
                if (enableBoardScroll) {
                  if (e.deltaY > 0) {
                    goToNext();
                  } else {
                    goToPrevious();
                  }
                }
              }}
            >
              <PromotionModal
                pendingMove={pendingMove}
                cancelMove={() => setPendingMove(null)}
                confirmMove={(p) => {
                  if (pendingMove) {
                    makeMove({
                      from: pendingMove.from,
                      to: pendingMove.to,
                      promotion: p,
                    });
                  }
                }}
                turn={turn}
                orientation={orientation}
              />

              <Chessground
                selectedPiece={selectedPiece}
                setSelectedPiece={setSelectedPiece}
                setBoardFen={setBoardFen}
                orientation={orientation}
                fen={currentNode.fen}
                animation={animationConfig}
                coordinates={showCoordinates !== "none"}
                coordinatesOnSquares={showCoordinates === "all"}
                movable={movableConfig}
                turnColor={turn}
                check={pos?.isCheck()}
                lastMove={editingMode ? undefined : lastMove}
                premovable={premovableConfig}
                // Leverage Chessground's built-in touch optimization
                draggable={draggableConfig}
                selectable={selectableConfig}
                drawable={drawableConfig}
              />
            </Box>
          </Box>
        </Group>

        {showDesktopSideControls && hasBoardControlsRail && (
          <Portal target="#board-controls-rail">
            <BoardControlsMenu
              viewPawnStructure={viewPawnStructure ?? localViewPawnStructure}
              setViewPawnStructure={setViewPawnStructure ?? setLocalViewPawnStructure}
              takeSnapshot={takeSnapshot ?? localTakeSnapshot}
              canTakeBack={canTakeBack}
              deleteMove={deleteMove ?? storeDeleteMove}
              changeTabType={changeTabType ?? localChangeTabType}
              currentTabType={currentTabType}
              eraseDrawablesOnClick={eraseDrawablesOnClick ?? storeEraseDrawablesOnClick}
              clearShapes={clearShapes ?? storeClearShapes}
              disableVariations={disableVariations}
              editingMode={editingMode}
              toggleEditingMode={toggleEditingMode}
              saveFile={saveFile}
              copyPgn={copyPgn}
              reload={reload}
              addGame={addGame}
              toggleOrientation={toggleOrientation ?? localToggleOrientation}
              currentTabSourceType={currentTabSourceType}
              count={currentTabType === "play" ? 3 : 6}
              dirty={dirty}
              autoSave={false}
              orientation="vertical"
            />
          </Portal>
        )}
        {!hideFooterControls && (
          <Group justify="space-between" h={hideClockSpaces ? "auto" : "2.125rem"} wrap="nowrap">
            {desktopFooterContent ? (
              <Box ml={hideClockSpaces ? 0 : "2.5rem"} style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden" }}>
                {desktopFooterContent}
              </Box>
            ) : useOverlayMaterial ? (
              <Box ml="2.5rem" style={{ flex: "1 1 auto", minWidth: 0 }} />
            ) : !hideClockSpaces && materialDiff ? (
              <Group ml="2.5rem">
                {hasClock && <Clock color={orientation} turn={turn} whiteTime={whiteTime} blackTime={blackTime} />}
                <ShowMaterial diff={materialDiff.diff} pieces={materialDiff.pieces} color={orientation} />
              </Group>
            ) : null}

            {error && (
              <Text ta="center" c="red">
                {t(chessopsError(error))}
              </Text>
            )}

            {moveInput && <MoveInput currentFen={currentNode.fen} />}

            {showDesktopSideControls && !hasBoardControlsRail && (
              <BoardControlsMenu
                viewPawnStructure={viewPawnStructure ?? localViewPawnStructure}
                setViewPawnStructure={setViewPawnStructure ?? setLocalViewPawnStructure}
                takeSnapshot={takeSnapshot ?? localTakeSnapshot}
                canTakeBack={canTakeBack}
                deleteMove={deleteMove ?? storeDeleteMove}
                changeTabType={changeTabType ?? localChangeTabType}
                currentTabType={currentTabType}
                eraseDrawablesOnClick={eraseDrawablesOnClick ?? storeEraseDrawablesOnClick}
                clearShapes={clearShapes ?? storeClearShapes}
                disableVariations={disableVariations}
                editingMode={editingMode}
                toggleEditingMode={toggleEditingMode}
                saveFile={saveFile}
                copyPgn={copyPgn}
                reload={reload}
                addGame={addGame}
                toggleOrientation={toggleOrientation ?? localToggleOrientation}
                currentTabSourceType={currentTabSourceType}
                dirty={dirty}
                autoSave={false}
              />
            )}
          </Group>
        )}

        {/* MoveControls with board controls menu */}
        {!hideFooterControls && layout.chessBoard.layoutType === "mobile" && (
          <MoveControls
            viewPawnStructure={viewPawnStructure ?? localViewPawnStructure}
            setViewPawnStructure={setViewPawnStructure ?? setLocalViewPawnStructure}
            takeSnapshot={takeSnapshot ?? localTakeSnapshot}
            canTakeBack={canTakeBack}
            deleteMove={deleteMove ?? storeDeleteMove}
            changeTabType={changeTabType ?? localChangeTabType}
            currentTabType={currentTabType}
            eraseDrawablesOnClick={eraseDrawablesOnClick ?? storeEraseDrawablesOnClick}
            clearShapes={clearShapes ?? storeClearShapes}
            disableVariations={disableVariations}
            editingMode={editingMode}
            toggleEditingMode={toggleEditingMode}
            saveFile={saveFile}
            copyPgn={copyPgn}
            dirty={dirty}
            autoSave={false} // Board component doesn't have autoSave context
            reload={reload}
            addGame={addGame}
            toggleOrientation={toggleOrientation ?? localToggleOrientation}
            currentTabSourceType={currentTabSourceType}
            // Start Game props
            startGame={startGame}
            gameState={gameState}
            startGameDisabled={startGameDisabled}
          />
        )}
      </Box>
    </Box>
  );
}

export default memo(Board);
