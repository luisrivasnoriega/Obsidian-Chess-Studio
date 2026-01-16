import { Button, Group, Modal, Progress, Radio, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type AnalysisSpeed = "t500" | "t1000" | "t1500" | "t2500" | "t3500";

export interface AnalyzeAllConfig {
  speed: AnalysisSpeed;
  timeMs: number;
  analyzeMode: "all" | "unanalyzed";
}

const getAnalysisOptions = (): Record<AnalysisSpeed, { label: string; timeMs: number }> => ({
  t500: { label: "500 ms", timeMs: 500 },
  t1000: { label: "1000 ms", timeMs: 1000 },
  t1500: { label: "1500 ms", timeMs: 1500 },
  t2500: { label: "2500 ms", timeMs: 2500 },
  t3500: { label: "3500 ms", timeMs: 3500 },
});

interface AnalyzeAllModalProps {
  opened: boolean;
  onClose: () => void;
  onAnalyze: (
    config: AnalyzeAllConfig,
    onProgress: (current: number, total: number) => void,
    isCancelled: () => boolean,
  ) => Promise<{ stop: () => Promise<void> } | void>;
  gameCount: number;
  unanalyzedGameCount?: number;
  analyzeMode?: "all" | "unanalyzed";
}

export function AnalyzeAllModal({
  opened,
  onClose,
  onAnalyze,
  gameCount,
  unanalyzedGameCount,
  analyzeMode = "unanalyzed",
}: AnalyzeAllModalProps) {
  const { t } = useTranslation();
  const ANALYSIS_OPTIONS = getAnalysisOptions();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const cancelledRef = useRef(false);
  const stopAnalysisRef = useRef<(() => Promise<void>) | null>(null);

  const counts = useMemo(() => {
    const total = Math.max(0, Number.isFinite(gameCount) ? gameCount : 0);
    const rawUnanalyzed =
      unanalyzedGameCount == null ? total : Math.max(0, Number.isFinite(unanalyzedGameCount) ? unanalyzedGameCount : 0);
    const unanalyzed = Math.min(total, rawUnanalyzed);
    const analyzed = Math.max(0, total - unanalyzed);
    return { total, unanalyzed, analyzed };
  }, [gameCount, unanalyzedGameCount]);

  useEffect(() => {
    if (!opened) return;
    // #region agent log (debug)
    fetch("http://127.0.0.1:7242/ingest/05233578-039d-40ec-b565-a863091bb3cf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "H4",
        location: "src/features/dashboard/components/AnalyzeAllModal.tsx:opened",
        message: "AnalyzeAllModal opened with counts",
        data: { gameCount, unanalyzedGameCount, analyzeMode, counts },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const form = useForm<AnalyzeAllConfig>({
    initialValues: {
      speed: "t1000",
      timeMs: 1000,
      analyzeMode: analyzeMode,
    },
  });

  // Calculate the actual game count based on selected mode - use useMemo to update when form values change
  const actualGameCount = useMemo(() => {
    return form.values.analyzeMode === "unanalyzed" ? counts.unanalyzed : counts.total;
  }, [form.values.analyzeMode, counts]);

  const handleSubmit = async () => {
    const selectedOption = ANALYSIS_OPTIONS[form.values.speed];
    const countToAnalyze = form.values.analyzeMode === "unanalyzed" ? counts.unanalyzed : counts.total;
    setIsAnalyzing(true);
    setProgress({ current: 0, total: countToAnalyze });
    cancelledRef.current = false;

    try {
      const result = await onAnalyze(
        {
          speed: form.values.speed,
          timeMs: selectedOption.timeMs,
          analyzeMode: form.values.analyzeMode,
        },
        (current, total) => {
          setProgress({ current, total });
        },
        () => cancelledRef.current,
      );
      // Store the stop function if provided
      if (result && typeof result === "object" && "stop" in result) {
        stopAnalysisRef.current = result.stop;
      }
    } finally {
      setIsAnalyzing(false);
      if (!cancelledRef.current && progress.current === progress.total && progress.total > 0) {
        // Analysis complete, close modal after a short delay
        setTimeout(() => {
          onClose();
          setProgress({ current: 0, total: 0 });
        }, 1000);
      } else if (cancelledRef.current) {
        // Analysis was cancelled, reset progress
        setProgress({ current: 0, total: 0 });
      }
    }
  };

  const handleStop = async () => {
    cancelledRef.current = true;
    setIsAnalyzing(false);
    // Stop all active engines immediately
    if (stopAnalysisRef.current) {
      try {
        await stopAnalysisRef.current();
      } catch {
        // Ignore errors when stopping
      }
    }
  };

  // Reset progress and form when modal opens/closes
  useEffect(() => {
    if (!opened) {
      setProgress({ current: 0, total: 0 });
      setIsAnalyzing(false);
      cancelledRef.current = false;
      stopAnalysisRef.current = null;
    } else {
      // Reset form to initial values when modal opens
      form.setValues({
        speed: "t1000",
        timeMs: 1000,
        analyzeMode: analyzeMode,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, analyzeMode]);

  return (
    <Modal opened={opened} onClose={onClose} title={t("features.dashboard.analyzeAllGames")} size="md">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t(`features.dashboard.selectAnalysisDepth_${actualGameCount === 1 ? "one" : "other"}`, {
              count: actualGameCount,
            })}
          </Text>

          <Radio.Group
            label={t("features.dashboard.analyze")}
            {...form.getInputProps("analyzeMode")}
            disabled={isAnalyzing}
          >
            <Stack gap="xs">
              <Radio
                value="unanalyzed"
                label={t("features.dashboard.onlyUnanalyzedGamesWithCounts", {
                  defaultValue: "Only unanalyzed games ({{unanalyzed}} to analyze, {{analyzed}} already analyzed)",
                  unanalyzed: counts.unanalyzed,
                  analyzed: counts.analyzed,
                })}
              />
              <Radio value="all" label={t("features.dashboard.allGamesReanalyze")} />
            </Stack>
          </Radio.Group>

          <Radio.Group
            label={t("features.dashboard.analysisDepth")}
            {...form.getInputProps("speed")}
            disabled={isAnalyzing}
          >
            <Stack gap="xs">
              {Object.entries(ANALYSIS_OPTIONS).map(([key, option]) => (
                <Radio key={key} value={key} label={option.label} />
              ))}
            </Stack>
          </Radio.Group>

          {isAnalyzing && (
            <Stack gap="xs" mt="md">
              <Progress value={(progress.current / progress.total) * 100} />
              <Text size="sm" c="dimmed" ta="center">
                {t("features.dashboard.analyzingGames", { current: progress.current, total: progress.total })}
              </Text>
            </Stack>
          )}

          <Group justify="flex-end" mt="md">
            {isAnalyzing ? (
              <Button variant="filled" color="red" onClick={handleStop}>
                {t("features.dashboard.stopAnalysis")}
              </Button>
            ) : (
              <>
                <Button variant="subtle" onClick={onClose} disabled={isAnalyzing}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" loading={isAnalyzing} disabled={isAnalyzing}>
                  {t("features.dashboard.analyze")}
                </Button>
              </>
            )}
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
