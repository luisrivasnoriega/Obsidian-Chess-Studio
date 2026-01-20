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

  useEffect(() => {
    setBoardFenRef.current = setBoardFen;
    setSelectedPieceRef.current = setSelectedPiece;
  });

  // Memoize chessgroundConfig to avoid recreating it on every render
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

  const handleChange = useCallback(() => {
    if (setBoardFenRef.current && api) {
      setBoardFenRef.current(api.getFen());
    }
  }, [api]);

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

    const config: Config = {
      ...chessgroundConfig,
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

    api.set(config);
    // biome-ignore lint/correctness/useExhaustiveDependencies: chessgroundConfig is memoized and contains all necessary dependencies
  }, [api, handleChange, handleSelect, moveMethod, chessgroundConfig]);

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
