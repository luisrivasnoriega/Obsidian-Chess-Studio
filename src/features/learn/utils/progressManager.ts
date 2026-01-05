import type { ExerciseProgress as LessonExerciseProgress, LessonProgress } from "../constants/lessons";
import { lessonManager } from "../constants/lessons";
import { practiceManager } from "../constants/practices";

export interface PracticeExerciseProgress {
  readonly exerciseId: string;
  readonly categoryId: string;
  readonly isCompleted: boolean;
  readonly bestTime?: number;
  readonly attempts: number;
  readonly lastAttempted?: Date;
  readonly completedAt?: Date;
  readonly bestScore?: number;
  readonly score?: number;
}

export interface ProgressStats {
  readonly totalLessonsUnlocked: number;
  readonly totalLessonsCompleted: number;
  readonly totalExercisesCompleted: number;
  readonly totalPointsEarned: number;
  readonly currentStreak: number;
  readonly averageScore: number;
  readonly estimatedTimeSpent: number;
  readonly difficultyBreakdown: {
    readonly beginner: { completed: number; total: number };
    readonly intermediate: { completed: number; total: number };
    readonly advanced: { completed: number; total: number };
  };
}

export interface Recommendation {
  readonly type: "lesson" | "practice";
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly reason: string;
  readonly difficulty: string;
  readonly estimatedTime: number;
  readonly priority: "high" | "medium" | "low";
}

export interface Achievement {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly unlockedAt: Date;
  readonly category: "lessons" | "practice" | "streak" | "speed" | "accuracy";
}

export class ProgressManager {
  private static instance: ProgressManager;

  private constructor() {}

  static getInstance(): ProgressManager {
    if (!ProgressManager.instance) {
      ProgressManager.instance = new ProgressManager();
    }
    return ProgressManager.instance;
  }

  calculateStats(
    lessonProgress: readonly LessonProgress[],
    lessonExerciseProgress: readonly LessonExerciseProgress[],
    practiceExerciseProgress: readonly PracticeExerciseProgress[],
  ): ProgressStats {
    const lessons = lessonManager.getLessons();
    const practiceCategories = practiceManager.getCategories();

    const difficultyStats = {
      beginner: { completed: 0, total: 0 },
      intermediate: { completed: 0, total: 0 },
      advanced: { completed: 0, total: 0 },
    };

    let totalPointsEarned = 0;
    let totalTimeSpent = 0;
    let totalScoreSum = 0;
    let scoredExercises = 0;

    for (const lesson of lessons) {
      difficultyStats[lesson.difficulty].total++;

      const progress = lessonProgress.find((p) => p.lessonId === lesson.id);
      if (progress?.isCompleted) {
        difficultyStats[lesson.difficulty].completed++;
        totalTimeSpent += progress.timeSpent / 60;

        if (progress.averageScore) {
          totalScoreSum += progress.averageScore;
          scoredExercises++;
        }
      }
    }

    for (const category of practiceCategories) {
      for (const exercise of category.exercises) {
        difficultyStats[exercise.difficulty].total++;

        const progress = practiceExerciseProgress.find((p) => p.exerciseId === exercise.id);
        if (progress?.isCompleted) {
          difficultyStats[exercise.difficulty].completed++;
          totalPointsEarned += exercise.points;

          if (progress.bestScore) {
            totalScoreSum += progress.bestScore;
            scoredExercises++;
          }
        }
      }
    }

    const completedLessons = lessonProgress.filter((p) => p.isCompleted).length;
    const currentStreak = Math.min(completedLessons, 7);

    return {
      totalLessonsUnlocked: lessonProgress.filter((p) => p.isUnlocked).length,
      totalLessonsCompleted: lessonProgress.filter((p) => p.isCompleted).length,
      totalExercisesCompleted:
        lessonExerciseProgress.filter((p) => p.isCompleted).length +
        practiceExerciseProgress.filter((p) => p.isCompleted).length,
      totalPointsEarned,
      currentStreak,
      averageScore: scoredExercises > 0 ? totalScoreSum / scoredExercises : 0,
      estimatedTimeSpent: totalTimeSpent,
      difficultyBreakdown: difficultyStats,
    };
  }

  generateRecommendations(
    lessonProgress: readonly LessonProgress[],
    lessonExerciseProgress: readonly LessonExerciseProgress[],
    practiceExerciseProgress: readonly PracticeExerciseProgress[],
  ): readonly Recommendation[] {
    const recommendations: Recommendation[] = [];
    const completedLessonIds = lessonProgress.filter((p) => p.isCompleted).map((p) => p.lessonId);
    const unlockedLessons = lessonManager.getUnlockedLessons(completedLessonIds);
    const completedExerciseIds = practiceExerciseProgress.filter((p) => p.isCompleted).map((p) => p.exerciseId);
    const unlockedExercises = practiceManager.getUnlockedExercises(completedExerciseIds);

    for (const lesson of unlockedLessons.slice(0, 3)) {
      const isStarted = lessonProgress.find((p) => p.lessonId === lesson.id)?.isStarted;

      recommendations.push({
        type: "lesson",
        id: lesson.id,
        title: lesson.title.default,
        description: lesson.description.default,
        reason: isStarted ? "Continue your progress" : "Next in your learning path",
        difficulty: lesson.difficulty,
        estimatedTime: lesson.estimatedTime,
        priority: isStarted ? "high" : "medium",
      });
    }

    const weakAreas = this.identifyWeakAreas(lessonExerciseProgress, practiceExerciseProgress);
    const relevantPractices = unlockedExercises
      .filter((exercise) => exercise.tags?.some((tag) => weakAreas.includes(tag)))
      .slice(0, 2);

    for (const exercise of relevantPractices) {
      recommendations.push({
        type: "practice",
        id: exercise.id,
        title: exercise.title,
        description: exercise.description,
        reason: "Strengthen identified weak areas",
        difficulty: exercise.difficulty,
        estimatedTime: Math.ceil(exercise.timeLimit / 60),
        priority: "medium",
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  checkAchievements(currentStats: ProgressStats, previousStats?: ProgressStats): readonly Achievement[] {
    const newAchievements: Achievement[] = [];
    const now = new Date();

    if (currentStats.totalLessonsCompleted >= 1 && (previousStats?.totalLessonsCompleted ?? 0) === 0) {
      newAchievements.push({
        id: "first-lesson",
        title: "First Steps",
        description: "Completed your first lesson",
        icon: "🎓",
        unlockedAt: now,
        category: "lessons",
      });
    }

    if (
      currentStats.difficultyBreakdown.beginner.completed === currentStats.difficultyBreakdown.beginner.total &&
      currentStats.difficultyBreakdown.beginner.total > 0
    ) {
      newAchievements.push({
        id: "beginner-master",
        title: "Beginner Master",
        description: "Completed all beginner lessons",
        icon: "🌟",
        unlockedAt: now,
        category: "lessons",
      });
    }

    if (currentStats.averageScore >= 95) {
      newAchievements.push({
        id: "perfectionist",
        title: "Perfectionist",
        description: "Maintained 95%+ average score",
        icon: "💎",
        unlockedAt: now,
        category: "accuracy",
      });
    }

    if (currentStats.currentStreak >= 7) {
      newAchievements.push({
        id: "week-streak",
        title: "Dedicated Learner",
        description: "7-day learning streak",
        icon: "🔥",
        unlockedAt: now,
        category: "streak",
      });
    }

    if (currentStats.totalPointsEarned >= 100 && (previousStats?.totalPointsEarned ?? 0) < 100) {
      newAchievements.push({
        id: "century",
        title: "Century Club",
        description: "Earned 100 points",
        icon: "💯",
        unlockedAt: now,
        category: "practice",
      });
    }

    return newAchievements;
  }

  private identifyWeakAreas(
    lessonExerciseProgress: readonly LessonExerciseProgress[],
    _practiceExerciseProgress: readonly PracticeExerciseProgress[],
  ): string[] {
    const weakAreas: string[] = [];
    const lessons = lessonManager.getLessons();

    for (const lesson of lessons) {
      const exerciseProgresses = lessonExerciseProgress.filter((p) => p.lessonId === lesson.id);
      const avgAttempts = exerciseProgresses.reduce((sum, p) => sum + p.attempts, 0) / exerciseProgresses.length;
      const avgScore = exerciseProgresses.reduce((sum, p) => sum + (p.score ?? 0), 0) / exerciseProgresses.length;

      if (avgAttempts > 3 || avgScore < 70) {
        if (lesson.tags) {
          weakAreas.push(...lesson.tags);
        }
      }
    }

    const counts = weakAreas.reduce(
      (acc, area) => {
        acc[area] = (acc[area] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([area]) => area);
  }

  calculateAdaptiveDifficulty(
    exerciseProgress: readonly (LessonExerciseProgress | PracticeExerciseProgress)[],
  ): "easier" | "maintain" | "harder" {
    const recentProgress = exerciseProgress
      .filter((p) => p.lastAttempted && p.lastAttempted.getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000)
      .slice(-10);

    if (recentProgress.length < 3) return "maintain";

    const avgAttempts = recentProgress.reduce((sum, p) => sum + p.attempts, 0) / recentProgress.length;
    const avgScore = recentProgress.reduce((sum, p) => sum + (p.score ?? 0), 0) / recentProgress.length;

    if (avgAttempts <= 1.5 && avgScore >= 85) {
      return "harder";
    } else if (avgAttempts >= 3 || avgScore < 60) {
      return "easier";
    }

    return "maintain";
  }

  exportProgress(
    lessonProgress: readonly LessonProgress[],
    lessonExerciseProgress: readonly LessonExerciseProgress[],
    practiceExerciseProgress: readonly PracticeExerciseProgress[],
  ): string {
    const exportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      lessonProgress,
      lessonExerciseProgress,
      practiceExerciseProgress,
      stats: this.calculateStats(lessonProgress, lessonExerciseProgress, practiceExerciseProgress),
    };

    return JSON.stringify(exportData, null, 2);
  }

  importProgress(exportedData: string): {
    lessonProgress: readonly LessonProgress[];
    lessonExerciseProgress: readonly LessonExerciseProgress[];
    practiceExerciseProgress: readonly PracticeExerciseProgress[];
  } {
    try {
      const data = JSON.parse(exportedData);

      if (!data.version || !data.lessonProgress || !data.lessonExerciseProgress || !data.practiceExerciseProgress) {
        throw new Error("Invalid export data format");
      }

      return {
        lessonProgress: data.lessonProgress,
        lessonExerciseProgress: data.lessonExerciseProgress,
        practiceExerciseProgress: data.practiceExerciseProgress,
      };
    } catch (error) {
      throw new Error(`Failed to import progress data: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
}

export const progressManager = ProgressManager.getInstance();
