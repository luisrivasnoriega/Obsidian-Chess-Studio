import { Badge, Group, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { hidePuzzleRatingAtom, maxPuzzlePlayerRatingAtom, puzzlePlayerRatingAtom } from "@/state/atoms";
import type { Puzzle } from "@/utils/puzzles";

interface PuzzleStatisticsProps {
  currentPuzzle?: Puzzle;
}

export const PuzzleStatistics = ({ currentPuzzle }: PuzzleStatisticsProps) => {
  const { t } = useTranslation();
  const [hideRating] = useAtom(hidePuzzleRatingAtom);
  const [playerRating] = useAtom(puzzlePlayerRatingAtom);
  const [maxPlayerRating, setMaxPlayerRating] = useAtom(maxPuzzlePlayerRatingAtom);
  const [showNewMax, setShowNewMax] = useState(false);
  const hideNewMaxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const displayRating = currentPuzzle?.completion === "incomplete" && hideRating ? "?" : currentPuzzle?.rating;

  // Check for new max rating
  useEffect(() => {
    if (hideNewMaxTimeoutRef.current) {
      clearTimeout(hideNewMaxTimeoutRef.current);
      hideNewMaxTimeoutRef.current = null;
    }
    if (playerRating > maxPlayerRating) {
      setMaxPlayerRating(playerRating);
      setShowNewMax(true);
      hideNewMaxTimeoutRef.current = setTimeout(() => {
        setShowNewMax(false);
        hideNewMaxTimeoutRef.current = null;
      }, 5000);
    }
    return () => {
      if (hideNewMaxTimeoutRef.current) {
        clearTimeout(hideNewMaxTimeoutRef.current);
        hideNewMaxTimeoutRef.current = null;
      }
    };
  }, [playerRating, maxPlayerRating, setMaxPlayerRating]);

  return (
    <Group justify="space-between">
      <div>
        <Text size="sm" c="dimmed">
          {t("features.puzzle.rating")}
        </Text>
        <Text fw={500} size="xl">
          {displayRating ? displayRating : "?"}
        </Text>
      </div>
      <div>
        <Text size="sm" c="dimmed">
          {t("features.puzzle.playerRating")}
        </Text>
        <Group gap="xs" align="center">
          <Text fw={500} size="xl">
            {playerRating.toFixed(0)}
          </Text>
          {showNewMax && (
            <Badge color="green" variant="filled" size="sm">
              {t("features.puzzle.newMax")}!
            </Badge>
          )}
        </Group>
      </div>
      <div>
        <Text size="sm" c="dimmed">
          {t("features.puzzle.maxRating")}
        </Text>
        <Text fw={500} size="xl">
          {maxPlayerRating.toFixed(0)}
        </Text>
      </div>
    </Group>
  );
};
