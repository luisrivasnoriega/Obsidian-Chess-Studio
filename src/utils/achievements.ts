import { useUserStatsStore } from "@/state/userStatsStore";
import { countGamesOnDate } from "./gameRecords";
import { getTodayPuzzleCount } from "./puzzleStreak";

export type Achievement = {
  id: string;
  label: string;
};

export async function getAchievements(): Promise<Achievement[]> {
  const { userStats } = useUserStatsStore.getState();
  const todayPuzzles = getTodayPuzzleCount();
  const gamesToday = await countGamesOnDate();
  const totalPoints = userStats.totalPoints || 0;

  const list: Achievement[] = [];

  if (todayPuzzles >= 5) list.push({ id: "tactician", label: "Tactician" });
  if (gamesToday >= 2) list.push({ id: "grinder", label: "Grinder" });
  if (totalPoints >= 100) list.push({ id: "point-collector", label: "Point Collector" });

  return list;
}
