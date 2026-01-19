import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface UserStats {
  totalPoints: number;
  completionDates: string[];
}

interface UserStatsState {
  userStats: UserStats;
  setUserStats: (stats: Partial<UserStats>) => void;
}

export const useUserStatsStore = create<UserStatsState>()(
  persist(
    (set) => ({
      userStats: {
        totalPoints: 0,
        completionDates: [],
      },
      setUserStats: (stats) =>
        set((state) => {
          const _todayISO = new Date().toISOString();
          const prev = state.userStats;

          const updated: UserStats = {
            ...prev,
            ...stats,
            completionDates: stats.completionDates
              ? Array.from(new Set([...(prev.completionDates || []), ...stats.completionDates]))
              : prev.completionDates,
          } as UserStats;

          return { userStats: updated };
        }),
    }),
    {
      name: "user-stats-store",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
