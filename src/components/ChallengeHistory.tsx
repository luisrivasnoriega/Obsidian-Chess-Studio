import { ActionIcon, Group, Stack, Text } from "@mantine/core";
import { IconCheck, IconDots, IconX } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { match } from "ts-pattern";
import { hidePuzzleRatingAtom } from "@/state/atoms";
import type { Completion } from "@/utils/puzzles";

type Challenge = {
  completion: Completion;
  label?: string;
  index?: number;
};

function ChallengeHistory({
  challenges,
  select,
  current,
  maxItems,
}: {
  challenges: Challenge[];
  select: (i: number) => void;
  current: number;
  maxItems?: number;
}) {
  const hideRating = useAtomValue(hidePuzzleRatingAtom);
  const visibleChallenges = maxItems && maxItems > 0 ? challenges.slice(-maxItems) : challenges;

  return (
    <Group>
      {visibleChallenges.map((p, i) => {
        const challengeIndex = typeof p.index === "number" ? p.index : i;
        const isCurrent = challengeIndex === current;
        const uniqueKey = `${challengeIndex}-${p.label ?? ""}-${p.completion}`;
        return match(p.completion)
          .with("correct", () => (
            <Stack key={uniqueKey} gap={0}>
              <ActionIcon
                onClick={() => {
                  select(challengeIndex);
                }}
                variant="light"
                color="green"
                style={{ border: isCurrent ? "2px solid green" : "none" }}
              >
                <IconCheck color="green" />
              </ActionIcon>
              {p.label ? (
                <Text ta="center" fz="xs" c="green">
                  {p.label}
                </Text>
              ) : null}
            </Stack>
          ))
          .with("incorrect", () => (
            <Stack key={uniqueKey} gap={0}>
              <ActionIcon
                onClick={() => select(challengeIndex)}
                variant="light"
                color="red"
                style={{ border: isCurrent ? "2px solid red" : "none" }}
              >
                <IconX color="red" />
              </ActionIcon>
              {p.label ? (
                <Text ta="center" fz="xs" c="red">
                  {p.label}
                </Text>
              ) : null}
            </Stack>
          ))
          .with("incomplete", () => (
            <Stack key={uniqueKey} gap={0}>
              <ActionIcon
                onClick={() => select(challengeIndex)}
                variant="light"
                color="yellow"
                style={{ border: isCurrent ? "2px solid yellow" : "none" }}
              >
                <IconDots color="yellow" />
              </ActionIcon>
              {p.label ? (
                <Text ta="center" fz="xs" c="yellow">
                  {hideRating ? "?" : p.label}
                </Text>
              ) : null}
            </Stack>
          ))
          .exhaustive();
      })}
    </Group>
  );
}

export default ChallengeHistory;
