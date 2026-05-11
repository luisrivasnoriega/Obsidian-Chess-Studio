import { useHotkeys } from "@mantine/hooks";
import { useAtomValue } from "jotai";
import { keyMapAtom } from "@/state/keybindings";
import type { VariantsBoardCommands } from "./types";

export function useVariantsBoardHotkeys(commands: VariantsBoardCommands) {
  const keyMap = useAtomValue(keyMapAtom);

  useHotkeys([
    [keyMap.COPY_FEN.keys, commands.copyFen],
    [keyMap.COPY_PGN.keys, commands.copyPgn],
    [keyMap.FLIP_BOARD.keys, commands.flipBoard],
  ]);
}
