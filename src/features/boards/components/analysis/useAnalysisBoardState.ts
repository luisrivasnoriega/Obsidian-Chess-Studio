import type { Piece } from "@lichess-org/chessground/types";
import { useToggle } from "@mantine/hooks";
import { useAtom, useAtomValue } from "jotai";
import { useRef, useState } from "react";
import { useStore } from "zustand";
import { currentPracticeTabAtom, currentTabAtom, currentTabSelectedAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import type { AnalysisBoardState } from "./types";

export function useAnalysisBoardState(store: TreeStore): AnalysisBoardState {
  const [editingMode, toggleEditingMode] = useToggle();
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const [viewPawnStructure, setViewPawnStructure] = useState(false);
  const [currentTab, setCurrentTab] = useAtom(currentTabAtom);
  const [currentTabSelected, setCurrentTabSelected] = useAtom(currentTabSelectedAtom);
  const practiceTabSelected = useAtomValue(currentPracticeTabAtom);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const dirty = useStore(store, (s) => s.dirty);

  const isRepertoire = currentTab?.source?.type === "file" && currentTab.source.metadata.type === "repertoire";
  const isPuzzle = currentTab?.source?.type === "file" && currentTab.source.metadata.type === "puzzle";
  const practicing = currentTabSelected === "practice" && practiceTabSelected === "train";

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
    isRepertoire,
    isPuzzle,
    practicing,
  };
}
