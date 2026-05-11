import type { Piece } from "@lichess-org/chessground/types";
import { useToggle } from "@mantine/hooks";
import type { Platform } from "@tauri-apps/plugin-os";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { currentPracticeTabAtom, currentTabAtom, currentTabSelectedAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import type { VariantsBoardState } from "./types";

export function useVariantsBoardState(store: TreeStore): VariantsBoardState {
  const [editingMode, toggleEditingMode] = useToggle();
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const [viewPawnStructure, setViewPawnStructure] = useState(false);
  const [platform, setPlatform] = useState<Platform | null>(() => {
    if (typeof navigator === "undefined") return null;
    return /Android/i.test(navigator.userAgent) ? "android" : null;
  });
  const [currentTab, setCurrentTab] = useAtom(currentTabAtom);
  const [currentTabSelected, setCurrentTabSelected] = useAtom(currentTabSelectedAtom);
  const practiceTabSelected = useAtomValue(currentPracticeTabAtom);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const { layout } = useResponsiveLayout();

  const dirty = useStore(store, (s) => s.dirty);
  const boardOrientation = useStore(store, (s) => s.headers.orientation || "white");
  const is960 = useStore(store, (s) => s.headers.variant === "Chess960");
  const currentFen = useStore(store, (s) => s.currentNode().fen);

  useEffect(() => {
    let cancelled = false;
    void import("@tauri-apps/plugin-os")
      .then((m) => m.platform())
      .then((nextPlatform) => {
        if (!cancelled) setPlatform(nextPlatform);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const showRepertoirePanels =
    currentTab?.source?.type === "file" &&
    (currentTab.source.metadata?.type === "repertoire" || currentTab.source.metadata?.type === "variants");
  const isPuzzle = currentTab?.source?.type === "file" && currentTab.source.metadata?.type === "puzzle";

  return {
    boardRef,
    currentTab,
    setCurrentTab,
    currentTabSelected,
    setCurrentTabSelected,
    dirty,
    editingMode,
    toggleEditingMode,
    selectedPiece,
    setSelectedPiece,
    viewPawnStructure,
    setViewPawnStructure,
    isAndroid: platform === "android",
    isMobileLayout: layout.chessBoard.layoutType === "mobile",
    showRepertoirePanels,
    isPuzzle,
    practicing: currentTabSelected === "practice" && practiceTabSelected === "train",
    boardOrientation,
    is960,
    currentFen,
  };
}
