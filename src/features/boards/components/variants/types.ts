import type { Piece } from "@lichess-org/chessground/types";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Tab } from "@/utils/tabs";

export type VariantsDbType = "local" | "lch_all" | "lch_master";
export type VariantsAnalysisMainTab =
  | "engines"
  | "build"
  | "practice"
  | "graph"
  | "annotate"
  | "info"
  | "report"
  | "logs";

export type VariantsDesktopPanel = "pgn" | "analysis" | "database";

export type VariantsBoardState = {
  boardRef: MutableRefObject<HTMLDivElement | null>;
  currentTab: Tab | undefined;
  setCurrentTab: Dispatch<SetStateAction<Tab>>;
  currentTabSelected: string;
  setCurrentTabSelected: Dispatch<SetStateAction<string>>;
  dirty: boolean;
  editingMode: boolean;
  toggleEditingMode: () => void;
  selectedPiece: Piece | null;
  setSelectedPiece: Dispatch<SetStateAction<Piece | null>>;
  viewPawnStructure: boolean;
  setViewPawnStructure: Dispatch<SetStateAction<boolean>>;
  isAndroid: boolean;
  isMobileLayout: boolean;
  showRepertoirePanels: boolean;
  isPuzzle: boolean;
  practicing: boolean;
  boardOrientation: string;
  is960: boolean;
  currentFen: string;
};

export type VariantsBoardFileActions = {
  saveFile: (showNotification?: boolean) => Promise<boolean>;
  reloadBoard: () => Promise<void>;
};

export type VariantsBoardCommands = {
  clearShapes: () => void;
  copyFen: () => Promise<void>;
  copyPgn: () => Promise<void>;
  flipBoard: () => void;
  changeTabType: () => void;
};
