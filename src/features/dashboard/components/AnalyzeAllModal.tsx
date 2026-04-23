import { Button, Group, Modal, NumberInput, Progress, Radio, Select, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface AnalyzeAllConfig {
  timeMs: number;
  analyzeMode: "all" | "unanalyzed";
  enginePath: string;
}

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
  engineOptions: Array<{ value: string; label: string }>;
  initialEnginePath?: string | null;
}

export function AnalyzeAllModal({
  opened,
  onClose,
  onAnalyze,
  gameCount,
  unanalyzedGameCount,
  analyzeMode = "unanalyzed",
  engineOptions,
  initialEnginePath,
}: AnalyzeAllModalProps) {
  const { t } = useTranslation();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const stopAnalysisRef = useRef<(() => Promise<void>) | null>(null);
  const progressRef = useRef({ current: 0, total: 0 });
  const runIdRef = useRef(0);
  const closeTimeoutRef = useRef<number | null>(null);
  const wasOpenedRef = useRef(false);

  const counts = useMemo(() => {
    const total = Math.max(0, Number.isFinite(gameCount) ? gameCount : 0);
    const rawUnanalyzed =
      unanalyzedGameCount == null ? total : Math.max(0, Number.isFinite(unanalyzedGameCount) ? unanalyzedGameCount : 0);
    const unanalyzed = Math.min(total, rawUnanalyzed);
    const analyzed = Math.max(0, total - unanalyzed);
    return { total, unanalyzed, analyzed };
  }, [gameCount, unanalyzedGameCount]);

  const form = useForm<AnalyzeAllConfig>({
    initialValues: {
      timeMs: 1500,
      analyzeMode: analyzeMode,
      enginePath: initialEnginePath ?? engineOptions[0]?.value ?? "",
    },
  });

  // Calculate the actual game count based on selected mode - use useMemo to update when form values change
  const actualGameCount = useMemo(() => {
    return form.values.analyzeMode === "unanalyzed" ? counts.unanalyzed : counts.total;
  }, [form.values.analyzeMode, counts]);

  const clearCloseTimeout = useCallback(() => {
    if (closeTimeoutRef.current != null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  const handleSubmit = async () => {
    if (isAnalyzing) return;
    clearCloseTimeout();
    setSubmitError(null);
    setIsStopping(false);
    stopAnalysisRef.current = null;
    const normalizedTimeMs = Math.max(1, Math.round(Number(form.values.timeMs) || 0));
    const countToAnalyze = form.values.analyzeMode === "unanalyzed" ? counts.unanalyzed : counts.total;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setIsAnalyzing(true);
    setProgress({ current: 0, total: countToAnalyze });
    progressRef.current = { current: 0, total: countToAnalyze };
    cancelledRef.current = false;

    try {
      const result = await onAnalyze(
        {
          timeMs: normalizedTimeMs,
          analyzeMode: form.values.analyzeMode,
          enginePath: form.values.enginePath,
        },
        (current, total) => {
          if (runIdRef.current !== runId) return;
          setProgress({ current, total });
          progressRef.current = { current, total };
        },
        () => cancelledRef.current,
      );
      if (runIdRef.current !== runId) return;
      // Store the stop function if provided
      if (result && typeof result === "object" && "stop" in result) {
        stopAnalysisRef.current = result.stop;
      }
    } catch (e) {
      if (runIdRef.current !== runId) return;
      const msg = String(e);
      setSubmitError(msg);
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: t("features.dashboard.analysisUnexpectedError", {
          defaultValue: "Analyze all failed before starting. {{error}}",
          error: msg,
        }),
        color: "red",
      });
    } finally {
      if (runIdRef.current === runId) {
        setIsAnalyzing(false);
        setIsStopping(false);
        stopAnalysisRef.current = null;
        const latestProgress = progressRef.current;
        if (!cancelledRef.current && latestProgress.current === latestProgress.total && latestProgress.total > 0) {
          // Analysis complete, close modal after a short delay
          closeTimeoutRef.current = window.setTimeout(() => {
            onClose();
            setProgress({ current: 0, total: 0 });
            progressRef.current = { current: 0, total: 0 };
            closeTimeoutRef.current = null;
          }, 1000);
        } else if (cancelledRef.current) {
          // Analysis was cancelled, reset progress
          setProgress({ current: 0, total: 0 });
          progressRef.current = { current: 0, total: 0 };
        }
      }
    }
  };

  const handleStop = async () => {
    if (!isAnalyzing || isStopping) return;
    cancelledRef.current = true;
    setIsStopping(true);
    // Stop all active engines immediately
    if (stopAnalysisRef.current) {
      try {
        await stopAnalysisRef.current();
      } catch {
        // Ignore errors when stopping
      }
    }
  };

  // Reset when closed only if there is no active run; keep state alive for background analysis.
  useEffect(() => {
    const wasOpened = wasOpenedRef.current;
    wasOpenedRef.current = opened;

    if (!opened) {
      clearCloseTimeout();
      setSubmitError(null);
      if (isAnalyzing) {
        return;
      }
      runIdRef.current += 1;
      setProgress({ current: 0, total: 0 });
      progressRef.current = { current: 0, total: 0 };
      setIsStopping(false);
      cancelledRef.current = false;
      stopAnalysisRef.current = null;
    } else {
      clearCloseTimeout();
      // Reset form only on open transition to avoid render loops.
      if (!isAnalyzing && !wasOpened) {
        form.setValues({
          timeMs: 1500,
          analyzeMode: analyzeMode,
          enginePath: initialEnginePath ?? engineOptions[0]?.value ?? "",
        });
      }
    }
    return () => {
      clearCloseTimeout();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, isAnalyzing, analyzeMode, initialEnginePath, engineOptions, clearCloseTimeout, form.setValues]);

  return (
    <Modal opened={opened} onClose={onClose} title={t("features.dashboard.analyzeAllGames")} size="md">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t(`features.dashboard.selectAnalysisDepth_${actualGameCount === 1 ? "one" : "other"}`, {
              count: actualGameCount,
            })}
          </Text>

          <Select
            withAsterisk
            label={t("features.dashboard.analyzeAllEngineLabel", { defaultValue: "Engine" })}
            placeholder={t("features.dashboard.analyzeAllEnginePlaceholder", { defaultValue: "Pick one" })}
            data={engineOptions}
            allowDeselect={false}
            disabled={isAnalyzing}
            {...form.getInputProps("enginePath")}
          />

          {engineOptions.length === 0 && (
            <Text size="sm" c="red">
              {t("features.dashboard.noEngineAvailableMessage", {
                defaultValue: "Please install an engine first in the Engines page.",
              })}
            </Text>
          )}

          {submitError && (
            <Text size="sm" c="red">
              {submitError}
            </Text>
          )}

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

          <NumberInput
            withAsterisk
            label={t("features.dashboard.analysisDepth")}
            min={1}
            step={100}
            allowNegative={false}
            allowDecimal={false}
            thousandSeparator={false}
            disabled={isAnalyzing}
            {...form.getInputProps("timeMs")}
          />
          <Text size="xs" c="dimmed">
            {t("features.dashboard.analysisDepthHelp", {
              defaultValue:
                "Milliseconds per move for the engine. Higher values usually improve accuracy but take longer.",
            })}
          </Text>

          {isAnalyzing && (
            <Stack gap="xs" mt="md">
              <Progress value={progress.total > 0 ? (progress.current / progress.total) * 100 : 0} />
              <Text size="sm" c="dimmed" ta="center">
                {t("features.dashboard.analyzingGames", { current: progress.current, total: progress.total })}
              </Text>
            </Stack>
          )}

          <Group justify="flex-end" mt="md">
            {isAnalyzing ? (
              <Button variant="filled" color="red" onClick={handleStop} loading={isStopping} disabled={isStopping}>
                {t("features.dashboard.stopAnalysis")}
              </Button>
            ) : (
              <>
                <Button variant="subtle" onClick={onClose} disabled={isAnalyzing}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  loading={isAnalyzing}
                  disabled={
                    isAnalyzing ||
                    isStopping ||
                    engineOptions.length === 0 ||
                    !form.values.enginePath ||
                    !form.values.timeMs
                  }
                  onClick={() => void handleSubmit()}
                >
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
