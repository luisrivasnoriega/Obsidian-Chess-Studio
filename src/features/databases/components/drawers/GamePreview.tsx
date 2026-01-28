import { Box, Group, Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useContext, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Chessground } from "@/components/Chessground";
import GameNotation from "@/components/GameNotation";
import MoveControls from "@/components/MoveControls";
import OpeningName from "@/components/OpeningName";
import { TreeStateContext, TreeStateProvider } from "@/components/TreeStateContext";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { parsePGN } from "@/utils/chess";
import { type GameHeaders, getNodeAtPath, type TreeState } from "@/utils/treeReducer";

function GamePreviewWrapper({
  pgn,
  headers,
  hideControls,
  showOpening,
}: {
  pgn: string;
  headers?: GameHeaders;
  hideControls?: boolean;
  showOpening?: boolean;
}) {
  const { data: parsedGame } = useQuery({
    queryKey: ["parse-pgn", pgn, headers?.fen],
    queryFn: async () => {
      return await parsePGN(pgn, headers?.fen);
    },
    staleTime: Infinity,
  });

  return (
    <>
      {parsedGame && <GamePreview key={pgn} game={parsedGame} hideControls={hideControls} showOpening={showOpening} />}
    </>
  );
}

function GamePreview({
  game,
  hideControls,
  showOpening,
}: {
  game: TreeState;
  hideControls?: boolean;
  showOpening?: boolean;
}) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [boardHeight, setBoardHeight] = useState(0);
  const { layout } = useResponsiveLayout();

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;

    let rafId = 0;

    const measure = (height: number) => {
      const h = Math.floor(height);
      setBoardHeight((current) => (current === h ? current : h));
    };

    const rect = el.getBoundingClientRect();
    measure(rect.height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { height } = entry.contentRect;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => measure(height));
    });

    observer.observe(el);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  // Calculate board dimensions based on layout flags
  const boardStyle = {
    width: layout.gameNotationUnderBoard ? "100%" : "400px",
    minWidth: "200px",
    maxWidth: "600px",
    aspectRatio: layout.chessBoard.maintainAspectRatio ? "1:1" : undefined,
    touchAction: layout.chessBoard.touchOptimized ? "manipulation" : "auto",
  };

  return (
    <TreeStateProvider initial={game}>
      {showOpening && <OpeningName />}
      {!layout.gameNotationUnderBoard ? (
        <Group align="start" grow style={{ overflow: "hidden", height: "100%" }}>
          <Stack ref={boardRef} style={boardStyle} gap="xs" flex={1}>
            <PreviewBoard />
            <MoveControls readOnly />
          </Stack>
          {!hideControls && (
            <Stack style={{ height: boardHeight > 0 ? boardHeight : undefined }} gap="xs" flex={1}>
              <GameNotation />
            </Stack>
          )}
        </Group>
      ) : (
        <Stack style={{ overflow: "hidden", height: "100%" }}>
          <Stack ref={boardRef} style={boardStyle} gap="xs" flex={1}>
            <PreviewBoard />
            <MoveControls readOnly />
          </Stack>
          {!hideControls && (
            <Stack gap="xs" flex={1}>
              <GameNotation />
            </Stack>
          )}
        </Stack>
      )}
    </TreeStateProvider>
  );
}

function PreviewBoardContent({ store }: { store: any }) {
  const { layout } = useResponsiveLayout();

  const goToNext = useStore(store, (s: any) => s.goToNext);
  const goToPrevious = useStore(store, (s: any) => s.goToPrevious);
  const root = useStore(store, (s: any) => s.root);
  const position = useStore(store, (s: any) => s.position);
  const headers = useStore(store, (s: any) => s.headers);

  if (!root) return null;

  const node = getNodeAtPath(root, position);
  const fen = node.fen;

  // Enhanced touch interaction for mobile
  const handleWheel = (e: React.WheelEvent) => {
    if (e.deltaY > 0) {
      goToNext();
    } else {
      goToPrevious();
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (layout.chessBoard.touchOptimized) {
      // Prevent default touch behavior for better chess piece interaction
      e.preventDefault();
    }
  };

  return (
    <Box
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      style={{
        touchAction: layout.chessBoard.touchOptimized ? "manipulation" : "auto",
        userSelect: "none", // Prevent text selection on touch devices
      }}
    >
      <Chessground
        coordinates={false}
        viewOnly={true}
        fen={fen}
        orientation={headers.orientation || "white"}
        // Enhanced touch interaction for mobile
        selectable={{
          enabled: layout.chessBoard.touchOptimized,
        }}
      />
    </Box>
  );
}

function PreviewBoard() {
  const store = useContext(TreeStateContext);

  if (!store) return null;

  return <PreviewBoardContent store={store} />;
}

export default GamePreviewWrapper;
