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
  const prevConfigRef = useRef<string>("");
  const prevHandleChangeRef = useRef<(() => void) | null>(null);
  const prevHandleSelectRef = useRef<((key: Key) => void) | null>(null);
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
      // Removed chessgroundConfigProps itself - it's always a new object reference
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

    // Create a stable hash of the config to detect actual changes
    // Include all relevant config properties to catch any changes
    const configHash = JSON.stringify({
      fen: chessgroundConfig.fen,
      orientation: chessgroundConfig.orientation,
      turnColor: chessgroundConfig.turnColor,
      moveMethod,
      // Include nested config objects - use JSON.stringify for deep comparison
      movable: chessgroundConfig.movable ? JSON.stringify(chessgroundConfig.movable) : null,
      draggable: chessgroundConfig.draggable ? JSON.stringify(chessgroundConfig.draggable) : null,
      selectable: chessgroundConfig.selectable ? JSON.stringify(chessgroundConfig.selectable) : null,
      drawable: chessgroundConfig.drawable ? JSON.stringify(chessgroundConfig.drawable) : null,
      check: chessgroundConfig.check,
      lastMove: chessgroundConfig.lastMove ? JSON.stringify(chessgroundConfig.lastMove) : null,
    });

    // Skip if nothing has actually changed (ignore callback reference changes since they use refs)
    if (prevConfigRef.current === configHash) {
      return;
    }

    prevConfigRef.current = configHash;
    // Update refs for logging (but don't use them for comparison)
    prevHandleChangeRef.current = handleChange;
    prevHandleSelectRef.current = handleSelect;

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
  }, [api, moveMethod, chessgroundConfig, handleChange, handleSelect]);

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
