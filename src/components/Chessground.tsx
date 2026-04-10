import { Chessground as NativeChessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Config } from "@lichess-org/chessground/config";
import type { Key, Piece } from "@lichess-org/chessground/types";
import { Box } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardImageAtom, moveMethodAtom } from "@/state/atoms";
import "@lichess-org/chessground/assets/chessground.base.css";

export interface ChessgroundProps extends Config {
  setBoardFen?: (fen: string) => void;
  selectedPiece?: Piece | null;
  setSelectedPiece?: (piece: Piece | null) => void;
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

  const setBoardFenRef = useRef(setBoardFen);
  const setSelectedPieceRef = useRef(setSelectedPiece);

  // Use refs to track previous values and prevent unnecessary api.set() calls
  const prevConfigRef = useRef<{
    fen: string | undefined;
    orientation: Config["orientation"];
    turnColor: Config["turnColor"];
    moveMethod: "drag" | "select" | "both";
    movable: Config["movable"] | undefined;
    premovable: Config["premovable"] | undefined;
    draggable: Config["draggable"] | undefined;
    selectable: Config["selectable"] | undefined;
    drawable: Config["drawable"] | undefined;
    check: Config["check"];
    lastMove: Config["lastMove"];
    coordinates: Config["coordinates"];
    coordinatesOnSquares: Config["coordinatesOnSquares"];
    animation: Config["animation"] | undefined;
  } | null>(null);
  const isSettingRef = useRef(false);

  // Update refs without triggering effects - do this synchronously during render
  // This avoids the useEffect dependency issue that can cause infinite loops
  if (setBoardFenRef.current !== setBoardFen) {
    setBoardFenRef.current = setBoardFen;
  }
  if (setSelectedPieceRef.current !== setSelectedPiece) {
    setSelectedPieceRef.current = setSelectedPiece;
  }

  // Memoize chessgroundConfig to avoid recreating it on every render
  // Don't include chessgroundConfigProps itself in dependencies since it's a new object every render
  // We track all individual properties instead
  const chessgroundConfig = useMemo(
    () => chessgroundConfigProps,
    // biome-ignore lint/correctness/useExhaustiveDependencies: chessgroundConfigProps is a spread object, we track its key properties
    [
      chessgroundConfigProps.fen,
      chessgroundConfigProps.orientation,
      chessgroundConfigProps.turnColor,
      chessgroundConfigProps.movable,
      chessgroundConfigProps.premovable,
      chessgroundConfigProps.predroppable,
      chessgroundConfigProps.drawable,
      chessgroundConfigProps.lastMove,
      chessgroundConfigProps.check,
      chessgroundConfigProps.coordinates,
      chessgroundConfigProps.coordinatesOnSquares,
      chessgroundConfigProps.draggable,
      chessgroundConfigProps.selectable,
      chessgroundConfigProps.highlight,
      chessgroundConfigProps.animation,
      chessgroundConfigProps.events,
      chessgroundConfigProps,
    ],
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: Chessground must initialize exactly once; updates go through `api.set(...)`.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Initialize Chessground once; subsequent updates go through `api.set(...)`.

    const config: Config = {
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
    };

    const chessgroundApi = NativeChessground(el, config);
    setApi(chessgroundApi);

    return () => {
      chessgroundApi.destroy?.();
      setApi(null);
    };
  }, []);

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
      moveMethod,
      movable: chessgroundConfig.movable,
      premovable: chessgroundConfig.premovable,
      draggable: chessgroundConfig.draggable,
      selectable: chessgroundConfig.selectable,
      drawable: chessgroundConfig.drawable,
      check: chessgroundConfig.check,
      lastMove: chessgroundConfig.lastMove,
      coordinates: chessgroundConfig.coordinates,
      coordinatesOnSquares: chessgroundConfig.coordinatesOnSquares,
      animation: chessgroundConfig.animation,
    } as const;

    const prev = prevConfigRef.current;
    const unchanged =
      prev !== null &&
      prev.fen === snapshot.fen &&
      prev.orientation === snapshot.orientation &&
      prev.turnColor === snapshot.turnColor &&
      prev.moveMethod === snapshot.moveMethod &&
      prev.movable === snapshot.movable &&
      prev.premovable === snapshot.premovable &&
      prev.draggable === snapshot.draggable &&
      prev.selectable === snapshot.selectable &&
      prev.drawable === snapshot.drawable &&
      prev.check === snapshot.check &&
      prev.lastMove === snapshot.lastMove &&
      prev.coordinates === snapshot.coordinates &&
      prev.coordinatesOnSquares === snapshot.coordinatesOnSquares &&
      prev.animation === snapshot.animation;

    if (unchanged) {
      return;
    }

    prevConfigRef.current = snapshot;

    // Set flag BEFORE creating config to prevent any synchronous events from triggering state updates
    isSettingRef.current = true;

    const config: Config = {
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
    };

    // Call api.set() synchronously - the isSettingRef flag will prevent handleChange from updating state
    api.set(config);

    // Reset flag asynchronously to allow any queued events to process first
    // Use a microtask to ensure this happens after any synchronous events from api.set()
    queueMicrotask(() => {
      isSettingRef.current = false;
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: chessgroundConfig is memoized and contains all necessary dependencies
    // Note: We don't include handleChange and handleSelect in dependencies since we use refs
  }, [api, moveMethod, chessgroundConfig]);

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
