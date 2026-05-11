import { notifications } from "@mantine/notifications";
import { save } from "@tauri-apps/plugin-dialog";
import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPuzzleVariantsDirectory, getVariantsDirectory } from "@/features/variants/utils/profileDir";
import { activeProfileIdAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { getMoveText } from "@/utils/chess";
import { createFile } from "@/utils/files";
import { formatDateToPGN } from "@/utils/format";
import { buildPuzzleVariantSourceTags, PUZZLE_VARIANTS_TAG } from "@/utils/puzzleVariantMetadata";
import { generatePuzzleVariantsFromTree, type PuzzleTreeNodeDto } from "@/utils/puzzleVariants";
import type { Tab } from "@/utils/tabs";
import type { TreeNode } from "@/utils/treeReducer";

type UseVariantsPuzzleGenerationArgs = {
  store: TreeStore;
  currentTab: Tab | undefined;
  boardOrientation: string;
};

export function useVariantsPuzzleGeneration({ store, currentTab, boardOrientation }: UseVariantsPuzzleGenerationArgs) {
  const { t } = useTranslation();
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const [puzzleModalOpened, setPuzzleModalOpened] = useState(false);
  const [puzzleDepth, setPuzzleDepth] = useState(1);
  const [maxPuzzleDepth, setMaxPuzzleDepth] = useState(1);

  const getVariantBaseName = useCallback(() => {
    if (currentTab?.source?.type === "file" && currentTab.source.path) {
      const parts = currentTab.source.path.split(/[/\\]/);
      const name = parts.pop() ?? "puzzles";
      return name.replace(/\.pgn$/i, "") || "puzzles";
    }
    return "puzzles";
  }, [currentTab?.source]);

  const openPuzzleModal = useCallback(
    (maxDepth: number) => {
      if (maxDepth < 1) {
        notifications.show({
          title: t("common.error"),
          message: t("errors.puzzleVariantsNeedSystemMove"),
          color: "red",
        });
        return;
      }

      setMaxPuzzleDepth(maxDepth);
      setPuzzleDepth((currentDepth) => Math.min(currentDepth, maxDepth));
      setPuzzleModalOpened(true);
    },
    [t],
  );

  const generatePuzzles = useCallback(
    async (selectedDepth: number) => {
      try {
        const root = store.getState().root;
        const puzzleColor: "white" | "black" = boardOrientation === "black" ? "black" : "white";
        const puzzleVariantsDir = await getPuzzleVariantsDirectory(activeProfileId);
        const variantsDir = await getVariantsDirectory(activeProfileId);

        const variantName = getVariantBaseName();
        const baseName = `puzzle-variants-${variantName}-d${selectedDepth}-${formatDateToPGN(new Date())}`;
        const filePath = await save({
          defaultPath: `${puzzleVariantsDir}/${baseName}.pgn`,
          filters: [{ name: "PGN", extensions: ["pgn"] }],
        });

        if (!filePath) return;

        const fileName =
          filePath
            .replace(/\.pgn$/, "")
            .split(/[/\\]/)
            .pop() || baseName;
        const tags = [
          PUZZLE_VARIANTS_TAG,
          ...buildPuzzleVariantSourceTags({
            profileId: activeProfileId,
            variantsDir,
            variantPath: currentTab?.source?.type === "file" ? currentTab.source.path : null,
          }),
          `variant:${variantName}`,
          `depth:${selectedDepth}`,
          `orientation:${puzzleColor}`,
        ];

        const mainlineNodes: TreeNode[] = [];
        let currentNode = root;
        const maxMainlinePlies = 80;
        while (mainlineNodes.length < maxMainlinePlies && currentNode.children.length > 0) {
          const child = currentNode.children.find((candidate) => candidate.san) ?? currentNode.children[0];
          if (!child?.san) break;
          mainlineNodes.push(child);
          currentNode = child;
        }

        const mainline = mainlineNodes
          .map((move, index) =>
            getMoveText(move, {
              glyphs: false,
              comments: false,
              extraMarkups: false,
              isFirst: index === 0 || move.halfMoves % 2 === 0,
            }),
          )
          .join("")
          .trim();

        if (mainline) {
          tags.push(`mainline:${mainline}`);
        }

        const toDto = (node: TreeNode): PuzzleTreeNodeDto => ({
          fen: node.fen,
          san: node.san ?? null,
          children: node.children.map(toDto),
        });

        const result = await generatePuzzleVariantsFromTree({
          root: toDto(root),
          orientation: puzzleColor,
          selectedDepth,
        });

        await createFile({
          filename: fileName,
          filetype: "puzzle",
          tags,
          pgn: result.pgn,
          dir: puzzleVariantsDir,
        });

        try {
          window.dispatchEvent(new Event("puzzles:updated"));
          window.dispatchEvent(new Event("puzzle-variants:updated"));
        } catch {}

        notifications.show({
          title: t("common.save"),
          message: t("common.puzzlesGeneratedSuccessfully", { count: result.count }),
          color: "green",
        });
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("common.failedToGeneratePuzzles"),
          color: "red",
        });
      }
    },
    [activeProfileId, boardOrientation, currentTab, getVariantBaseName, store, t],
  );

  return {
    puzzleModalOpened,
    closePuzzleModal: () => setPuzzleModalOpened(false),
    puzzleDepth,
    maxPuzzleDepth,
    setPuzzleDepth,
    openPuzzleModal,
    generatePuzzles,
  };
}

export type VariantsPuzzleGeneration = ReturnType<typeof useVariantsPuzzleGeneration>;
