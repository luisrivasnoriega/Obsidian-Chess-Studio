import { Chessground as NativeChessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Config } from "@lichess-org/chessground/config";
import type { Key, Piece } from "@lichess-org/chessground/types";
import { Box } from "@mantine/core";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardImageAtom, boardInteractionActiveAtom, moveMethodAtom } from "@/state/atoms";
import "@lichess-org/chessground/assets/chessground.base.css";

export interface ChessgroundProps extends Config {
  setBoardFen?: (fen: string) => void;
  selectedPiece?: Piece | null;
  setSelectedPiece?: (piece: Piece | null) => void;
}

type MoveMethod = "drag" | "select" | "both";

type ChessgroundConfigSnapshot = {
  fen: string | undefined;
  orientation: Config["orientation"];
  turnColor: Config["turnColor"];
  selected: Config["selected"];
  moveMethod: MoveMethod;
  movable: Config["movable"] | undefined;
  premovable: Config["premovable"] | undefined;
  predroppable: Config["predroppable"] | undefined;
  draggable: Config["draggable"] | undefined;
  selectable: Config["selectable"] | undefined;
  drawable: Config["drawable"] | undefined;
  check: Config["check"];
  lastMove: Config["lastMove"];
  coordinates: Config["coordinates"];
  coordinatesOnSquares: Config["coordinatesOnSquares"];
  ranksPosition: Config["ranksPosition"];
  autoCastle: Config["autoCastle"];
  viewOnly: Config["viewOnly"];
  disableContextMenu: Config["disableContextMenu"];
  addPieceZIndex: Config["addPieceZIndex"];
  addDimensionsCssVarsTo: Config["addDimensionsCssVarsTo"];
  blockTouchScroll: Config["blockTouchScroll"];
  touchIgnoreRadius: Config["touchIgnoreRadius"];
  trustAllEvents: Config["trustAllEvents"];
  jsHover: Config["jsHover"];
  highlight: Config["highlight"] | undefined;
  events: Config["events"] | undefined;
  animation: Config["animation"] | undefined;
};

type PendingChessgroundConfig = {
  snapshot: ChessgroundConfigSnapshot;
  config: Config;
};

function omitUndefinedConfig(config: Config): Config {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as Config;
}

export function Chessground({
  setBoardFen,
  selectedPiece,
  setSelectedPiece,
  ...chessgroundConfigProps
}: ChessgroundProps) {
  const [api, setApi] = useState<Api | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const moveMethod = useAtomValue(moveMethodAtom);
  const boardImage = useAtomValue(boardImageAtom);
  const setBoardInteractionActive = useSetAtom(boardInteractionActiveAtom);
  const [isDocumentHidden, setIsDocumentHidden] = useState(() =>
    typeof document !== "undefined" ? document.hidden : false,
  );

  const setBoardFenRef = useRef(setBoardFen);
  const setSelectedPieceRef = useRef(setSelectedPiece);

  // Use refs to track previous values and prevent unnecessary api.set() calls
  const prevConfigRef = useRef<ChessgroundConfigSnapshot | null>(null);
  const interactionActiveRef = useRef(false);
  const pendingConfigRef = useRef<PendingChessgroundConfig | null>(null);
  const pendingFrameRef = useRef<number | null>(null);
  const isSettingRef = useRef(false);

  // Update refs without triggering effects - do this synchronously during render
  // This avoids the useEffect dependency issue that can cause infinite loops
  if (setBoardFenRef.current !== setBoardFen) {
    setBoardFenRef.current = setBoardFen;
  }
  if (setSelectedPieceRef.current !== setSelectedPiece) {
    setSelectedPieceRef.current = setSelectedPiece;
  }

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      setIsDocumentHidden(document.hidden);
    };
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const {
    addDimensionsCssVarsTo,
    addPieceZIndex,
    animation,
    autoCastle,
    blockTouchScroll,
    check,
    coordinates,
    coordinatesOnSquares,
    disableContextMenu,
    drawable,
    draggable,
    events,
    fen,
    highlight,
    jsHover,
    lastMove,
    movable,
    orientation,
    predroppable,
    premovable,
    ranksPosition,
    selectable,
    selected,
    touchIgnoreRadius,
    trustAllEvents,
    turnColor,
    viewOnly,
  } = chessgroundConfigProps;

  const chessgroundConfig = useMemo<Config>(
    () =>
      omitUndefinedConfig({
        addDimensionsCssVarsTo,
        addPieceZIndex,
        animation,
        autoCastle,
        blockTouchScroll,
        check,
        coordinates,
        coordinatesOnSquares,
        disableContextMenu,
        drawable,
        draggable,
        events,
        fen,
        highlight,
        jsHover,
        lastMove,
        movable,
        orientation,
        predroppable,
        premovable,
        ranksPosition,
        selectable,
        selected,
        touchIgnoreRadius,
        trustAllEvents,
        turnColor,
        viewOnly,
      }),
    [
      addDimensionsCssVarsTo,
      addPieceZIndex,
      animation,
      autoCastle,
      blockTouchScroll,
      check,
      coordinates,
      coordinatesOnSquares,
      disableContextMenu,
      drawable,
      draggable,
      events,
      fen,
      highlight,
      jsHover,
      lastMove,
      movable,
      orientation,
      predroppable,
      premovable,
      ranksPosition,
      selectable,
      selected,
      touchIgnoreRadius,
      trustAllEvents,
      turnColor,
      viewOnly,
    ],
  );

  const effectiveAnimation = useMemo<Config["animation"]>(() => {
    if (!isDocumentHidden) {
      return chessgroundConfig.animation;
    }
    const baseAnimation = chessgroundConfig.animation ?? {};
    return {
      ...baseAnimation,
      enabled: false,
    };
  }, [chessgroundConfig.animation, isDocumentHidden]);

  const withOptionalAnimation = useCallback(
    (config: Config): Config => {
      if (effectiveAnimation === undefined) {
        const { animation: _animation, ...configWithoutAnimation } = config;
        return configWithoutAnimation;
      }
      return {
        ...config,
        animation: effectiveAnimation,
      };
    },
    [effectiveAnimation],
  );

  // Store handleChange in a ref so it doesn't need to be in dependencies
  const handleChangeRef = useRef<(() => void) | null>(null);
  const handleChange = useCallback(() => {
    // Prevent state updates during api.set() calls to avoid infinite loops
    if (isSettingRef.current) {
      return;
    }
    if (setBoardFenRef.current && api) {
      const fen = api.getFen();
      setBoardFenRef.current(fen);
    }
  }, [api]);
  handleChangeRef.current = handleChange;

  // Store handleSelect in a ref so it doesn't need to be in dependencies
  const handleSelectRef = useRef<((key: Key) => void) | null>(null);
  const handleSelect = useCallback(
    (key: Key) => {
      if (chessgroundConfig.movable?.free && selectedPiece && api) {
        api.setPieces(new Map([[key, selectedPiece]]));
        if (setBoardFenRef.current) {
          setBoardFenRef.current(api.getFen());
        }
      }
    },
    [chessgroundConfig.movable?.free, selectedPiece, api],
  );
  handleSelectRef.current = handleSelect;

  const applyConfig = useCallback(
    (snapshot: ChessgroundConfigSnapshot, config: Config) => {
      if (!api) return;

      prevConfigRef.current = snapshot;
      isSettingRef.current = true;
      api.set(config);
      queueMicrotask(() => {
        isSettingRef.current = false;
      });
    },
    [api],
  );

  const flushPendingConfig = useCallback(() => {
    if (pendingFrameRef.current != null) {
      return;
    }
    pendingFrameRef.current = window.requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      const pending = pendingConfigRef.current;
      pendingConfigRef.current = null;
      if (pending) {
        applyConfig(pending.snapshot, pending.config);
      }
    });
  }, [applyConfig]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Chessground must initialize exactly once; updates go through `api.set(...)`.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Initialize Chessground once; subsequent updates go through `api.set(...)`.

    const config: Config = withOptionalAnimation({
      ...chessgroundConfig,
      addDimensionsCssVarsTo: el,
      events: {
        ...chessgroundConfig.events,
        change: handleChange,
        select: handleSelect,
      },
      draggable: {
        ...chessgroundConfig.draggable,
        enabled: moveMethod !== "select",
      },
      selectable: {
        ...chessgroundConfig.selectable,
        enabled: moveMethod !== "drag",
      },
    });

    const chessgroundApi = NativeChessground(el, config);
    setApi(chessgroundApi);

    return () => {
      chessgroundApi.destroy?.();
      setApi(null);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const startInteraction = () => {
      interactionActiveRef.current = true;
      setBoardInteractionActive(true);
      if (pendingFrameRef.current != null) {
        window.cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
    };

    const endInteraction = () => {
      if (!interactionActiveRef.current && !pendingConfigRef.current) return;
      interactionActiveRef.current = false;
      setBoardInteractionActive(false);
      flushPendingConfig();
    };

    el.addEventListener("pointerdown", startInteraction);
    el.addEventListener("touchstart", startInteraction, { passive: true });
    document.addEventListener("pointerup", endInteraction, true);
    document.addEventListener("pointercancel", endInteraction, true);
    document.addEventListener("touchend", endInteraction, true);
    document.addEventListener("touchcancel", endInteraction, true);
    window.addEventListener("blur", endInteraction);

    return () => {
      el.removeEventListener("pointerdown", startInteraction);
      el.removeEventListener("touchstart", startInteraction);
      document.removeEventListener("pointerup", endInteraction, true);
      document.removeEventListener("pointercancel", endInteraction, true);
      document.removeEventListener("touchend", endInteraction, true);
      document.removeEventListener("touchcancel", endInteraction, true);
      window.removeEventListener("blur", endInteraction);
      if (pendingFrameRef.current != null) {
        window.cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
      pendingConfigRef.current = null;
      interactionActiveRef.current = false;
      setBoardInteractionActive(false);
    };
  }, [flushPendingConfig, setBoardInteractionActive]);

  // Android WebView can treat drag gestures as scroll even if the board uses `touch-action: none`,
  // especially when the board is adjacent to or nested near scroll containers.
  // Forcefully prevent scrolling while interacting with the board (non-passive listener).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof window === "undefined" || typeof navigator === "undefined") return;
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (!isAndroid) return;

    const preventIfCancelable = (event: TouchEvent) => {
      // Only prevent scroll; allow other logic to run.
      if (event.cancelable) {
        event.preventDefault();
      }
    };

    el.addEventListener("touchmove", preventIfCancelable, { passive: false });
    return () => {
      el.removeEventListener("touchmove", preventIfCancelable);
    };
  }, []);

  useEffect(() => {
    if (!api) return;

    // Prevent re-entry during api.set() calls
    if (isSettingRef.current) {
      return;
    }

    const snapshot = {
      fen: chessgroundConfig.fen,
      orientation: chessgroundConfig.orientation,
      turnColor: chessgroundConfig.turnColor,
      selected: chessgroundConfig.selected,
      moveMethod,
      movable: chessgroundConfig.movable,
      premovable: chessgroundConfig.premovable,
      predroppable: chessgroundConfig.predroppable,
      draggable: chessgroundConfig.draggable,
      selectable: chessgroundConfig.selectable,
      drawable: chessgroundConfig.drawable,
      check: chessgroundConfig.check,
      lastMove: chessgroundConfig.lastMove,
      coordinates: chessgroundConfig.coordinates,
      coordinatesOnSquares: chessgroundConfig.coordinatesOnSquares,
      ranksPosition: chessgroundConfig.ranksPosition,
      autoCastle: chessgroundConfig.autoCastle,
      viewOnly: chessgroundConfig.viewOnly,
      disableContextMenu: chessgroundConfig.disableContextMenu,
      addPieceZIndex: chessgroundConfig.addPieceZIndex,
      addDimensionsCssVarsTo: chessgroundConfig.addDimensionsCssVarsTo,
      blockTouchScroll: chessgroundConfig.blockTouchScroll,
      touchIgnoreRadius: chessgroundConfig.touchIgnoreRadius,
      trustAllEvents: chessgroundConfig.trustAllEvents,
      jsHover: chessgroundConfig.jsHover,
      highlight: chessgroundConfig.highlight,
      events: chessgroundConfig.events,
      animation: effectiveAnimation,
    } as const;

    const prev = prevConfigRef.current;
    const unchanged =
      prev !== null &&
      prev.fen === snapshot.fen &&
      prev.orientation === snapshot.orientation &&
      prev.turnColor === snapshot.turnColor &&
      prev.selected === snapshot.selected &&
      prev.moveMethod === snapshot.moveMethod &&
      prev.movable === snapshot.movable &&
      prev.premovable === snapshot.premovable &&
      prev.predroppable === snapshot.predroppable &&
      prev.draggable === snapshot.draggable &&
      prev.selectable === snapshot.selectable &&
      prev.drawable === snapshot.drawable &&
      prev.check === snapshot.check &&
      prev.lastMove === snapshot.lastMove &&
      prev.coordinates === snapshot.coordinates &&
      prev.coordinatesOnSquares === snapshot.coordinatesOnSquares &&
      prev.ranksPosition === snapshot.ranksPosition &&
      prev.autoCastle === snapshot.autoCastle &&
      prev.viewOnly === snapshot.viewOnly &&
      prev.disableContextMenu === snapshot.disableContextMenu &&
      prev.addPieceZIndex === snapshot.addPieceZIndex &&
      prev.addDimensionsCssVarsTo === snapshot.addDimensionsCssVarsTo &&
      prev.blockTouchScroll === snapshot.blockTouchScroll &&
      prev.touchIgnoreRadius === snapshot.touchIgnoreRadius &&
      prev.trustAllEvents === snapshot.trustAllEvents &&
      prev.jsHover === snapshot.jsHover &&
      prev.highlight === snapshot.highlight &&
      prev.events === snapshot.events &&
      prev.animation === snapshot.animation;

    if (unchanged) {
      return;
    }

    const config: Config = withOptionalAnimation({
      ...chessgroundConfig,
      events: {
        ...chessgroundConfig.events,
        // Use refs to get the latest callbacks without depending on their references
        change: () => handleChangeRef.current?.(),
        select: (key: Key) => handleSelectRef.current?.(key),
      },
      draggable: {
        ...chessgroundConfig.draggable,
        enabled: moveMethod !== "select",
      },
      selectable: {
        ...chessgroundConfig.selectable,
        enabled: moveMethod !== "drag",
      },
    });

    if (interactionActiveRef.current || pendingFrameRef.current != null) {
      pendingConfigRef.current = { snapshot, config };
      return;
    }

    applyConfig(snapshot, config);
    // Note: We don't include handleChange and handleSelect in dependencies since we use refs
  }, [api, moveMethod, chessgroundConfig, effectiveAnimation, withOptionalAnimation, applyConfig]);

  // Clear selected piece when not in free move mode
  useEffect(() => {
    if (!chessgroundConfig.movable?.free && selectedPiece && setSelectedPieceRef.current) {
      setSelectedPieceRef.current(null);
    }
  }, [chessgroundConfig.movable?.free, selectedPiece]);

  return (
    <Box
      ref={ref}
      style={{
        aspectRatio: 1,
        width: "100%",
        touchAction: "none",
        "--board-image": `url('/board/${boardImage}')`,
      }}
    />
  );
}
