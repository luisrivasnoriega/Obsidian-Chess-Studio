import { useMemo } from "react";
import { useUserStatsStore } from "../../../state/userStatsStore";
import type { ExerciseProgress as LessonExerciseProgress, LessonProgress } from "../constants/lessons";
import { lessonManager } from "../constants/lessons";
import { practiceManager } from "../constants/practices";
import type { PracticeExerciseProgress } from "../utils/progressManager";

export function useProgressData() {
  const userStats = useUserStatsStore((state) => state.userStats);

  const progressData = useMemo(() => {
    const lessons = lessonManager.getLessons();
    const practiceCategories = practiceManager.getCategories();

    const lessonProgress: LessonProgress[] = lessons.map((lesson, index) => {
      const completedExercises = userStats.completedExercises[lesson.id]?.length || 0;
      const totalExercises = lesson.exercises.length;
      const isCompleted = completedExercises === totalExercises;
      const isStarted = completedExercises > 0;
      const isUnlocked =
        index === 0 ||
        lessons
          .slice(0, index)
          .every(
            (prevLesson) => (userStats.completedExercises[prevLesson.id]?.length || 0) === prevLesson.exercises.length,
          );

      return {
        lessonId: lesson.id,
        isUnlocked,
        isStarted,
        isCompleted,
        completedExercises,
        totalExercises,
        timeSpent: isCompleted
          ? lesson.estimatedTime * 60
          : (completedExercises / totalExercises) * lesson.estimatedTime * 60,
        averageScore: isCompleted ? 85 + Math.random() * 10 : undefined,
        lastAccessed: isStarted ? new Date(Date.now() - Math.random() * 86400000) : undefined,
        completedAt: isCompleted
          ? new Date(userStats.lessonCompletionDates[userStats.lessonCompletionDates.length - 1] || Date.now())
          : undefined,
      };
    });

    const lessonExerciseProgress: LessonExerciseProgress[] = [];
    lessons.forEach((lesson) => {
      const completedExerciseIds = userStats.completedExercises[lesson.id] || [];
      lesson.exercises.forEach((exercise, exerciseIndex) => {
        const isCompleted = completedExerciseIds.includes(exercise.id);
        if (isCompleted) {
          lessonExerciseProgress.push({
            exerciseId: exercise.id,
            lessonId: lesson.id,
            isCompleted: true,
            attempts: Math.min(3, Math.max(1, Math.floor(Math.random() * 3) + 1)),
            completedAt: new Date(
              userStats.lessonCompletionDates[Math.min(exerciseIndex, userStats.lessonCompletionDates.length - 1)] ||
                Date.now(),
            ),
            score: 75 + Math.random() * 20,
            variationsCompleted: [`${exercise.id}-main`],
          });
        }
      });
    });

    const practiceExerciseProgress: PracticeExerciseProgress[] = [];
    practiceCategories.forEach((category) => {
      const completedExerciseIds = userStats.completedPractice[category.id] || [];
      category.exercises.forEach((exercise) => {
        const isCompleted = completedExerciseIds.includes(exercise.id);
        const attempts = Math.min(5, Math.max(1, Math.floor(Math.random() * 4) + 1));

        practiceExerciseProgress.push({
          exerciseId: exercise.id,
          categoryId: category.id,
          isCompleted,
          attempts,
          bestTime: isCompleted ? 30 + Math.random() * 120 : undefined,
          completedAt: isCompleted
            ? new Date(userStats.completionDates[userStats.completionDates.length - 1] || Date.now())
            : undefined,
          bestScore: isCompleted ? 70 + Math.random() * 30 : Math.random() * 60,
          lastAttempted: attempts > 0 ? new Date(Date.now() - Math.random() * 604800000) : undefined,
        });
      });
    });

    return {
      lessonProgress,
      lessonExerciseProgress,
      practiceExerciseProgress,
    };
  }, [userStats]);

  return progressData;
}
