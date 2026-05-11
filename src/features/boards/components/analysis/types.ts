import type { Piece } from "@lichess-org/chessground/types";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Tab } from "@/utils/tabs";

export type AnalysisBoardState = {
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
  isRepertoire: boolean;
  isPuzzle: boolean;
  practicing: boolean;
};

export type AnalysisBoardFileActions = {
  saveFile: (showNotification?: boolean) => Promise<boolean>;
  reloadBoard: () => Promise<void>;
};

export type AnalysisBoardCommands = {
  clearShapes: () => void;
  copyFen: () => Promise<void>;
  copyPgn: () => Promise<void>;
  deleteCurrentVariation: () => void;
  exportGame: () => Promise<void>;
  flipBoard: () => void;
  pasteFen: () => Promise<void>;
  promoteCurrentVariation: () => void;
  resetPosition: () => void;
  setAnnotation: (annotation: "!!" | "!" | "!?" | "?!" | "?" | "??") => void;
  setupPosition: () => void;
  stopAllEngines: () => void;
  toggleEngine: () => void;
  changeTabType: () => void;
};
