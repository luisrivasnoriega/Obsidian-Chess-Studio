import { useHotkeys } from "@mantine/hooks";
import { useAtomValue } from "jotai";
import { keyMapAtom } from "@/state/keybindings";
import type { AnalysisBoardCommands, AnalysisBoardFileActions, AnalysisBoardState } from "./types";

type UseAnalysisBoardHotkeysArgs = {
  commands: AnalysisBoardCommands;
  isRepertoire: boolean;
  saveFile: AnalysisBoardFileActions["saveFile"];
  setCurrentTabSelected: AnalysisBoardState["setCurrentTabSelected"];
};

export function useAnalysisBoardHotkeys({
  commands,
  isRepertoire,
  saveFile,
  setCurrentTabSelected,
}: UseAnalysisBoardHotkeysArgs) {
  const keyMap = useAtomValue(keyMapAtom);

  useHotkeys([
    [
      keyMap.SAVE_FILE.keys,
      () => {
        void saveFile();
      },
    ],
    [keyMap.CLEAR_SHAPES.keys, () => commands.clearShapes()],
    [
      keyMap.COPY_FEN.keys,
      () => {
        void commands.copyFen();
      },
    ],
    [
      keyMap.COPY_PGN.keys,
      () => {
        void commands.copyPgn();
      },
    ],
    [
      keyMap.PASTE_FEN.keys,
      () => {
        void commands.pasteFen();
      },
    ],
    [
      keyMap.EXPORT_GAME.keys,
      () => {
        void commands.exportGame();
      },
    ],
    [keyMap.FLIP_BOARD.keys, () => commands.flipBoard()],
    [keyMap.RESET_POSITION.keys, () => commands.resetPosition()],
    [keyMap.SETUP_POSITION.keys, () => commands.setupPosition()],
    [keyMap.PROMOTE_VARIATION.keys, () => commands.promoteCurrentVariation()],
    [keyMap.DELETE_VARIATION.keys, () => commands.deleteCurrentVariation()],
  ]);

  useHotkeys([
    [keyMap.ANNOTATION_BRILLIANT.keys, () => commands.setAnnotation("!!")],
    [keyMap.ANNOTATION_GOOD.keys, () => commands.setAnnotation("!")],
    [keyMap.ANNOTATION_INTERESTING.keys, () => commands.setAnnotation("!?")],
    [keyMap.ANNOTATION_DUBIOUS.keys, () => commands.setAnnotation("?!")],
    [keyMap.ANNOTATION_MISTAKE.keys, () => commands.setAnnotation("?")],
    [keyMap.ANNOTATION_BLUNDER.keys, () => commands.setAnnotation("??")],
    [
      keyMap.PRACTICE_TAB.keys,
      () => {
        if (isRepertoire) {
          setCurrentTabSelected("practice");
        }
      },
    ],
    [keyMap.ANALYSIS_TAB.keys, () => setCurrentTabSelected("analysis")],
    [keyMap.DATABASE_TAB.keys, () => setCurrentTabSelected("database")],
    [keyMap.ANNOTATE_TAB.keys, () => setCurrentTabSelected("annotate")],
    [keyMap.INFO_TAB.keys, () => setCurrentTabSelected("info")],
    [
      keyMap.TOGGLE_ALL_ENGINES.keys,
      (e) => {
        commands.toggleEngine();
        e.preventDefault();
      },
    ],
    [keyMap.TOGGLE_ENGINE.keys, () => commands.toggleEngine()],
    [keyMap.STOP_ENGINE.keys, () => commands.stopAllEngines()],
  ]);
}
