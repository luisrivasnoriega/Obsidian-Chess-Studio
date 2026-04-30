import { Button, Checkbox, Group, Modal, NumberInput, Select, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import equal from "fast-deep-equal";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { analyzeGameHumanStrategicReport, commands, type HumanMoveNarrative, type MoveAnalysis } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import { detectProfileBookErrorPlies } from "@/features/boards/utils/postGameReview";
import { enginesAtom, referenceDbAtom } from "@/state/atoms";
import { reportSettingsAtom } from "@/state/reportSettings";
import type { Annotation } from "@/utils/annotation";
import { parsePGN } from "@/utils/chess";
import type { LocalEngine } from "@/utils/engines";
import { saveProfileGameAnalysisStats } from "@/utils/profileGameAnalysisStats";
import type { TreeNode } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

const BASIC_ANNOTATIONS = new Set(["??", "?", "?!", "!?", "!", "!!", "Best"]);
const BOOK_ERROR_ANNOTATION: Annotation = "BookError";
const openingFenCache = new Map<string, boolean>();

export function countTreeComments(node: TreeNode): number {
  let count = 0;
  const stack: TreeNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.comment && current.comment.trim().length > 0) {
      count += 1;
    }
    if (current.children?.length) {
      for (const child of current.children) {
        stack.push(child);
      }
    }
  }
  return count;
}

function getMainlineNodes(root: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  let current = root;
  while (current.children.length > 0) {
    const next = current.children[0];
    if (!next) break;
    out.push(next);
    current = next;
  }
  return out;
}

async function isOpeningFen(fen: string): Promise<boolean> {
  const cached = openingFenCache.get(fen);
  if (cached !== undefined) return cached;

  try {
    const res = await commands.getOpeningFromFen(fen);
    if (res.status === "ok" && !!res.data) {
      openingFenCache.set(fen, true);
      return true;
    }
  } catch {
    // ignore
  }

  try {
    const resInfo = await commands.getOpeningInfoFromFen(fen);
    if (resInfo.status === "ok" && !!resInfo.data) {
      openingFenCache.set(fen, true);
      return true;
    }
  } catch {
    // ignore
  }

  openingFenCache.set(fen, false);
  return false;
}

async function collectOpeningFensFromMainline(root: TreeNode): Promise<Set<string>> {
  const openingFens = new Set<string>();
  const mainline = getMainlineNodes(root);

  for (const node of mainline) {
    if (await isOpeningFen(node.fen)) {
      openingFens.add(node.fen);
    }
  }

  return openingFens;
}

function _countMainlineComments(root: TreeNode): number {
  let count = 0;
  for (const node of getMainlineNodes(root)) {
    if (node.comment && node.comment.trim().length > 0) {
      count += 1;
    }
  }
  return count;
}

function verdictToAnnotation(verdict: HumanMoveNarrative["verdict"]): Annotation | null {
  switch (verdict) {
    case "Best":
      return "Best";
    case "Great":
      return "!";
    case "Practical":
      return "!?";
    case "Interesting":
      return "!?";
    case "Dubious":
      return "?!";
    case "Mistake":
      return "?";
    case "Blunder":
      return "??";
    default:
      return null;
  }
}

export function injectHumanNarrativesIntoMainline(root: TreeNode, narratives: HumanMoveNarrative[]): number {
  if (!narratives.length) return 0;

  const mainline = getMainlineNodes(root);
  let injected = 0;

  for (const narrative of narratives) {
    const plyIndex = Math.max(0, narrative.ply - 1);
    const node = mainline[plyIndex];
    if (!node) continue;

    const longComment = (narrative.commentLong ?? "").trim();
    const shortComment = (narrative.commentShort ?? "").trim();
    const text = longComment || shortComment;

    if (text.length > 0) {
      if (!node.comment || node.comment.trim().length === 0) {
        node.comment = text;
        injected += 1;
      } else if (!node.comment.includes(text)) {
        node.comment = `${node.comment.trim()} ${text}`.trim();
        injected += 1;
      }
    }

    const annotation = verdictToAnnotation(narrative.verdict);
    if (annotation) {
      const nonBasic = node.annotations.filter((item) => !BASIC_ANNOTATIONS.has(item));
      node.annotations = [...nonBasic, annotation];
    }
  }

  return injected;
}

function clearBookErrorAnnotations(root: TreeNode): void {
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.annotations.includes(BOOK_ERROR_ANNOTATION)) {
      node.annotations = node.annotations.filter((annotation) => annotation !== BOOK_ERROR_ANNOTATION);
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
}

function applyBookErrorAnnotationsToMainline(root: TreeNode, errorPlies: number[]): void {
  if (errorPlies.length === 0) return;
  const mainline = getMainlineNodes(root);
  const target = new Set(errorPlies);
  for (let ply = 0; ply < mainline.length; ply += 1) {
    if (!target.has(ply)) {
      continue;
    }
    const node = mainline[ply];
    if (!node.annotations.includes(BOOK_ERROR_ANNOTATION)) {
      node.annotations = [...node.annotations, BOOK_ERROR_ANNOTATION];
    }
  }
}

function ReportModal({
  tab,
  initialFen,
  originalPgn,
  moves,
  is960,
  profileId,
  profileDbGameId,
  reportingMode,
  toggleReportingMode,
  setInProgress,
  inProgress,
}: {
  tab: string;
  initialFen: string;
  originalPgn: string;
  moves: string[];
  is960: boolean;
  profileId: string | null;
  profileDbGameId: number | null;
  reportingMode: boolean;
  toggleReportingMode: () => void;
  setInProgress: (progress: boolean) => void;
  inProgress: boolean;
}) {
  const { t } = useTranslation();

  const referenceDb = useAtomValue(referenceDbAtom);
  const engines = useAtomValue(enginesAtom);
  const localEngines = engines.filter((e): e is LocalEngine => e.type === "local");
  const store = useContext(TreeStateContext)!;
  const addAnalysis = useStore(store, (s) => s.addAnalysis);
  const setTreeState = useStore(store, (s) => s.setState);
  const setReportProgress = useStore(store, (s) => s.setReportProgress);
  const setReportCompleted = useStore(store, (s) => s.setReportCompleted);

  const [reportSettings, setReportSettings] = useAtom(reportSettingsAtom);
  const analysisEngineRef = useRef<{ engine: string; tab: string } | null>(null);
  const runGuardRef = useRef(false);

  const form = useForm({
    initialValues: {
      ...reportSettings,
      novelty: reportSettings.novelty ?? true,
      reversed: reportSettings.reversed ?? true,
      humanStrategic: reportSettings.humanStrategic ?? false,
      goMode: reportSettings.goMode ?? { t: "Time", c: 500 },
    },
    validate: {
      engine: (value) => {
        if (!value) return t("features.board.analysis.engineRequired");
      },
      novelty: (value) => {
        if (value && !referenceDb) return t("features.board.analysis.refDBRequired");
      },
    },
  });

  // Store previous values to prevent infinite loop
  const prevLocalEnginesRef = useRef(localEngines);
  const prevReportSettingsRef = useRef(reportSettings);

  useEffect(() => {
    const localEnginesChanged = !equal(prevLocalEnginesRef.current, localEngines);
    const reportSettingsChanged = !equal(prevReportSettingsRef.current, reportSettings);

    // Only update if something actually changed
    if (!localEnginesChanged && !reportSettingsChanged) {
      return;
    }

    prevLocalEnginesRef.current = localEngines;
    prevReportSettingsRef.current = reportSettings;

    const engine =
      localEngines.length === 0
        ? ""
        : !reportSettings.engine || !localEngines.some((l) => l.path === reportSettings.engine)
          ? (localEngines[0]?.path ?? "")
          : reportSettings.engine;

    // Only update form if engine actually changed
    if (engine !== form.values.engine) {
      form.setValues({
        novelty: reportSettings.novelty ?? true,
        reversed: reportSettings.reversed ?? true,
        humanStrategic: reportSettings.humanStrategic ?? false,
        goMode: reportSettings.goMode ?? { t: "Time", c: 500 },
        engine,
      });
    }
  }, [localEngines, reportSettings, form]);

  const handleStop = async () => {
    if (analysisEngineRef.current) {
      try {
        await commands.stopEngine(analysisEngineRef.current.engine, analysisEngineRef.current.tab);
      } catch {}
      analysisEngineRef.current = null;
      setInProgress(false);
    }
  };

  async function analyze() {
    if (runGuardRef.current || inProgress || analysisEngineRef.current) {
      return;
    }
    runGuardRef.current = true;
    setReportSettings(form.values);
    setReportCompleted(false);
    setReportProgress(0);
    setInProgress(true);
    toggleReportingMode();
    const engine = localEngines.find((e) => e.path === form.values.engine);
    const engineSettings = (engine?.settings ?? []).map((s) => ({
      ...s,
      value: s.value?.toString() ?? "",
    }));

    if (is960 && !engineSettings.find((o) => o.name === "UCI_Chess960")) {
      engineSettings.push({ name: "UCI_Chess960", value: "true" });
    }

    const reversedForRun = form.values.humanStrategic ? false : form.values.reversed;

    const analysisId = `report_${tab}`;
    analysisEngineRef.current = { engine: form.values.engine, tab: analysisId };
    const strategicPgnStorageKey = `${tab}_humanStrategicAnnotatedPgn`;
    const strategicSummaryStorageKey = `${tab}_humanStrategicReportSummary`;

    if (typeof window !== "undefined") {
      sessionStorage.removeItem(strategicPgnStorageKey);
      sessionStorage.removeItem(strategicSummaryStorageKey);
    }

    try {
      let resolvedAnalysis: MoveAnalysis[];
      let strategicPgn: string | null = null;
      let strategicSummary: string | null = null;

      if (form.values.humanStrategic) {
        const humanResult = unwrap(
          await analyzeGameHumanStrategicReport({
            id: analysisId,
            engine: form.values.engine,
            goMode: form.values.goMode,
            options: {
              annotateNovelties: form.values.novelty,
              fen: initialFen,
              referenceDb,
              reversed: reversedForRun,
              moves,
            },
            uciOptions: engineSettings,
            originalPgn,
          }),
        );
        resolvedAnalysis = humanResult.analysis;
        strategicPgn = humanResult.annotatedPgn;
        strategicSummary = JSON.stringify(humanResult.summary);
        if (import.meta.env.DEV) {
          console.debug("[human-report] backend result", {
            tab,
            annotatedPgnLength: strategicPgn.length,
            narratives: humanResult.narratives?.length ?? 0,
            analysisItems: resolvedAnalysis.length,
          });
        }
      } else {
        resolvedAnalysis = unwrap(
          await commands.analyzeGame(
            analysisId,
            form.values.engine,
            form.values.goMode,
            {
              annotateNovelties: form.values.novelty,
              fen: initialFen,
              referenceDb,
              reversed: reversedForRun,
              moves,
            },
            engineSettings,
          ),
        );
      }

      let openingFensCache: Set<string> | null = null;
      const getOpeningFens = async () => {
        if (openingFensCache) return openingFensCache;
        openingFensCache = await collectOpeningFensFromMainline(store.getState().root);
        return openingFensCache;
      };

      let bookErrorPlies: number[] = [];
      try {
        const orientation = store.getState().headers.orientation;
        const humanColor = orientation === "white" || orientation === "black" ? orientation : null;
        const effectiveProfileId =
          profileId ?? (typeof window !== "undefined" ? localStorage.getItem("activeProfileId") : null);
        bookErrorPlies = await detectProfileBookErrorPlies({
          profileId: effectiveProfileId,
          initialFen,
          moves,
          humanColor,
        });
      } catch {
        // Keep analysis flow resilient if variants-book detection fails.
      }

      if (analysisEngineRef.current) {
        if (typeof window !== "undefined" && strategicPgn) {
          sessionStorage.setItem(strategicPgnStorageKey, strategicPgn);
          if (strategicSummary) {
            sessionStorage.setItem(strategicSummaryStorageKey, strategicSummary);
          }
        }

        if (form.values.humanStrategic && strategicPgn) {
          try {
            const parsed = await parsePGN(strategicPgn);
            clearBookErrorAnnotations(parsed.root);
            applyBookErrorAnnotationsToMainline(parsed.root, bookErrorPlies);
            if (import.meta.env.DEV) {
              console.debug("[human-report] parsed strategic PGN", {
                tab,
                strategicPgnLength: strategicPgn.length,
              });
            }
            parsed.report = store.getState().report;
            setTreeState(parsed);
          } catch {
            try {
              const fallback = await parsePGN(originalPgn);
              clearBookErrorAnnotations(fallback.root);
              applyBookErrorAnnotationsToMainline(fallback.root, bookErrorPlies);
              if (import.meta.env.DEV) {
                console.debug("[human-report] fallback to original PGN", {
                  tab,
                  originalPgnLength: originalPgn.length,
                });
              }
              fallback.report = store.getState().report;
              setTreeState(fallback);
            } catch {
              if (import.meta.env.DEV) {
                console.debug("[human-report] parse fallback failed, using addAnalysis", {
                  tab,
                  analysisItems: resolvedAnalysis.length,
                });
              }
              addAnalysis(resolvedAnalysis, { openingFens: await getOpeningFens() });

              const current = store.getState();
              const nextState = {
                dirty: current.dirty,
                position: [...current.position],
                headers: structuredClone(current.headers),
                root: structuredClone(current.root),
                report: structuredClone(current.report),
              };
              clearBookErrorAnnotations(nextState.root);
              applyBookErrorAnnotationsToMainline(nextState.root, bookErrorPlies);
              setTreeState(nextState);
            }
          }
        } else {
          addAnalysis(resolvedAnalysis, { openingFens: await getOpeningFens() });

          const current = store.getState();
          const nextState = {
            dirty: current.dirty,
            position: [...current.position],
            headers: structuredClone(current.headers),
            root: structuredClone(current.root),
            report: structuredClone(current.report),
          };
          clearBookErrorAnnotations(nextState.root);
          applyBookErrorAnnotationsToMainline(nextState.root, bookErrorPlies);
          setTreeState(nextState);
        }

        // Persist derived analysis stats into the profile DB (only when this tab is bound to a profile DB game).
        if (profileId && profileDbGameId != null) {
          saveProfileGameAnalysisStats({
            profileId,
            gameId: profileDbGameId,
            initialFen,
            moves,
            analysis: resolvedAnalysis,
          }).catch(() => {
            // best-effort
          });
        }
      }
    } catch {
    } finally {
      analysisEngineRef.current = null;
      setInProgress(false);
      runGuardRef.current = false;
    }
  }

  return (
    <Modal
      opened={reportingMode}
      onClose={() => toggleReportingMode()}
      title={t("features.board.analysis.generateReport")}
    >
      <form onSubmit={form.onSubmit(() => analyze())}>
        <Stack>
          <Select
            allowDeselect={false}
            withAsterisk
            label={t("common.engine")}
            placeholder="Pick one"
            data={
              localEngines.map((engine) => {
                return {
                  value: engine.path,
                  label: engine.name,
                };
              }) ?? []
            }
            {...form.getInputProps("engine")}
          />
          <Group wrap="nowrap">
            <Select
              allowDeselect={false}
              comboboxProps={{
                position: "bottom",
                middlewares: { flip: false, shift: false },
              }}
              data={[
                { label: t("chess.goMode.depth"), value: "Depth" },
                { label: t("features.board.analysis.time"), value: "Time" },
                { label: t("chess.goMode.nodes"), value: "Nodes" },
              ]}
              value={form.values.goMode.t}
              onChange={(v) => {
                const newGo = form.values.goMode;
                newGo.t = v as "Depth" | "Time" | "Nodes";
                form.setFieldValue("goMode", newGo);
              }}
            />
            <NumberInput
              min={1}
              value={form.values.goMode.c as number}
              onChange={(v) =>
                form.setFieldValue("goMode", {
                  ...(form.values.goMode as any),
                  c: (v || 1) as number,
                })
              }
            />
          </Group>

          <Checkbox
            label={t("features.board.analysis.reversed")}
            description={t("features.board.analysis.reversedDesc")}
            disabled={form.values.humanStrategic}
            {...form.getInputProps("reversed", { type: "checkbox" })}
          />

          <Checkbox
            label={t("features.board.analysis.annotateNovelties")}
            description={t("features.board.analysis.annotateNoveltiesDesc")}
            {...form.getInputProps("novelty", { type: "checkbox" })}
          />

          <Checkbox
            label={t("features.board.analysis.humanStrategicReport")}
            description={t("features.board.analysis.humanStrategicReportDesc")}
            {...form.getInputProps("humanStrategic", { type: "checkbox" })}
          />

          <Group justify="right">
            {inProgress ? (
              <Button variant="filled" color="red" onClick={handleStop}>
                {t("keybindings.stopEngine")}
              </Button>
            ) : (
              <Button type="submit">{t("features.board.analysis.analyze")}</Button>
            )}
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export default memo(ReportModal);
