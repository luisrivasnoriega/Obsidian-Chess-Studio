import {
  Accordion,
  ActionIcon,
  Badge,
  Box,
  Button,
  Code,
  Collapse,
  Divider,
  Group,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Skeleton,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  useMantineTheme,
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconBrain,
  IconGripVertical,
  IconPlayerPause,
  IconPlayerPlay,
  IconSettings,
  IconTargetArrow,
} from "@tabler/icons-react";
import { parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtom, useAtomValue } from "jotai";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { match } from "ts-pattern";
import { type BestMoves, buildHumanStrategicLiveReport, type HumanStrategicLiveResponse } from "@/bindings";
import { currentThemeIdAtom } from "@/features/themes/state/themeAtoms";
import {
  activeProfileHasPremiumAccessAtom,
  activeProfileIdAtom,
  activeProfilePremiumUsernameAtom,
  activeTabAtom,
  currentDbTypeAtom,
  currentThreatAtom,
  engineMovesFamily,
  engineProgressFamily,
  enginesAtom,
  lichessOptionsAtom,
  masterOptionsAtom,
  orionPlanApiKeyAtom,
  orionPlanProviderSignatureAtom,
  profilesAtom,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { chessopsError, positionFromFen, swapMove } from "@/utils/chessops";
import { buildEngineVariationCacheKey } from "@/utils/engineCacheKey";
import type { Engine } from "@/utils/engines";
import { consultOrionPlanFromAnalysis, ORION_PLAN_PROVIDER_SIGNATURE } from "@/utils/orionPlan";
import AnalysisRow from "./AnalysisRow";
import * as classes from "./BestMoves.css";
import EngineSettingsForm, { type Settings } from "./EngineSettingsForm";

export const arrowColors = [
  { strong: "blue", pale: "paleBlue" },
  { strong: "green", pale: "paleGreen" },
  { strong: "red", pale: "paleRed" },
  { strong: "yellow", pale: "yellow" }, // there's no paleYellow in chessground
];

interface BestMovesProps {
  id: number;
  engine: Engine;
  fen: string;
  moves: string[];
  halfMoves: number;
  dragHandleProps: any;
  orientation: "white" | "black";
}

type PlanSectionKey =
  | "POSITION_VERDICT"
  | "MAIN_PLAN"
  | "SECONDARY_PLANS"
  | "OPPONENT_COUNTERPLAY"
  | "PLAN_TRIGGERS"
  | "CANDIDATE_MOVES"
  | "CRITICAL_RISKS"
  | "PRACTICAL_ADVICE";

const PLAN_SECTION_ORDER: PlanSectionKey[] = [
  "POSITION_VERDICT",
  "MAIN_PLAN",
  "SECONDARY_PLANS",
  "OPPONENT_COUNTERPLAY",
  "PLAN_TRIGGERS",
  "CANDIDATE_MOVES",
  "CRITICAL_RISKS",
  "PRACTICAL_ADVICE",
];

const HUMAN_STRATEGIC_CACHE_LIMIT = 48;

function getStrategicCacheEntry(
  cache: Map<string, HumanStrategicLiveResponse>,
  key: string,
): HumanStrategicLiveResponse | null {
  const cached = cache.get(key) ?? null;
  if (!cached) return null;
  // Refresh insertion order for LRU behavior.
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setStrategicCacheEntry(
  cache: Map<string, HumanStrategicLiveResponse>,
  key: string,
  value: HumanStrategicLiveResponse,
) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > HUMAN_STRATEGIC_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function BestMovesComponent({ id, engine, fen, moves, halfMoves, dragHandleProps, orientation }: BestMovesProps) {
  const { t, i18n } = useTranslation();

  const activeTab = useAtomValue(activeTabAtom);
  const ev = useAtomValue(engineMovesFamily({ engine: engine.name, tab: activeTab! }));
  const progress = useAtomValue(engineProgressFamily({ engine: engine.name, tab: activeTab! }));
  const [, setEngines] = useAtom(enginesAtom);
  const [settings, setSettings2] = useAtom(
    tabEngineSettingsFamily({
      engineName: engine.name,
      defaultSettings: engine.settings ?? undefined,
      defaultGo: engine.go ?? undefined,
      tab: activeTab!,
    }),
  );

  useEffect(() => {
    if (settings.synced) {
      setSettings2((prev) => ({
        ...prev,
        go: engine.go || prev.go,
        settings: engine.settings || prev.settings,
      }));
    }
  }, [engine.settings, engine.go, settings.synced, setSettings2]);

  const setSettings = useCallback(
    (fn: (prev: Settings) => Settings) => {
      const newSettings = fn(settings);
      setSettings2(newSettings);
      if (newSettings.synced) {
        setEngines(async (prev) =>
          (await prev).map((o) =>
            o.name === engine.name ? { ...o, settings: newSettings.settings, go: newSettings.go } : o,
          ),
        );
      }
    },
    [engine, settings, setSettings2, setEngines],
  );

  const [settingsOn, toggleSettingsOn] = useToggle();
  const [threat, setThreat] = useAtom(currentThreatAtom);
  const theme = useMantineTheme();
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const profiles = useAtomValue(profilesAtom);
  const hasPremiumAccess = useAtomValue(activeProfileHasPremiumAccessAtom);
  const premiumUsername = useAtomValue(activeProfilePremiumUsernameAtom);
  const [orionPlanApiKey, setOrionPlanApiKey] = useAtom(orionPlanApiKeyAtom);
  const [orionPlanProviderSignature, setOrionPlanProviderSignature] = useAtom(orionPlanProviderSignatureAtom);
  const dbType = useAtomValue(currentDbTypeAtom);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const [apiKeyModalOpened, setApiKeyModalOpened] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState(orionPlanApiKey);
  const [planModalOpened, setPlanModalOpened] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [planText, setPlanText] = useState("");
  const [planPromptText, setPlanPromptText] = useState("");
  const canConsultPlan = hasPremiumAccess && Boolean(premiumUsername);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );
  const lichessToken = activeProfile?.lichessToken?.trim() || undefined;

  useEffect(() => {
    if (!apiKeyModalOpened) {
      setApiKeyDraft(orionPlanApiKey);
    }
  }, [apiKeyModalOpened, orionPlanApiKey]);

  useEffect(() => {
    localStorage.removeItem("orion-plan-api-key");
  }, []);

  useEffect(() => {
    if (orionPlanProviderSignature !== ORION_PLAN_PROVIDER_SIGNATURE) {
      if (orionPlanApiKey.trim().length > 0) {
        setOrionPlanApiKey("");
      }
      setOrionPlanProviderSignature(ORION_PLAN_PROVIDER_SIGNATURE);
    }
  }, [orionPlanProviderSignature, orionPlanApiKey, setOrionPlanApiKey, setOrionPlanProviderSignature]);

  const [pos, error] = positionFromFen(fen);
  if (pos) {
    for (const uci of moves) {
      const move = parseUci(uci);
      if (!move) {
        break;
      }
      pos.play(move);
    }
  }

  const isGameOver = pos?.isEnd() ?? false;
  const finalFen = useMemo(() => (pos ? makeFen(pos.toSetup()) : null), [pos]);

  const { searchingFen, searchingMoves } = useMemo(
    () =>
      match(threat)
        .with(true, () => ({
          searchingFen: swapMove(finalFen || INITIAL_FEN),
          searchingMoves: [],
        }))
        .with(false, () => ({
          searchingFen: fen,
          searchingMoves: moves,
        }))
        .exhaustive(),
    [fen, moves, threat, finalFen],
  );

  const searchingVariationCacheKey = useMemo(
    () => buildEngineVariationCacheKey(searchingFen, searchingMoves),
    [searchingFen, searchingMoves],
  );

  const engineVariations = useDeferredValue(
    useMemo(() => ev.get(searchingVariationCacheKey), [ev, searchingVariationCacheKey]),
  );
  const [humanStrategicReport, setHumanStrategicReport] = useState<HumanStrategicLiveResponse | null>(null);
  const [humanStrategicLoading, setHumanStrategicLoading] = useState(false);
  const humanStrategicCacheRef = useRef<Map<string, HumanStrategicLiveResponse>>(new Map());
  const strategicReportRequestRef = useRef(0);

  const humanStrategicKey = useMemo(() => {
    if (!settings.enabled || isGameOver || !engineVariations || engineVariations.length === 0) {
      return null;
    }

    const compactLines = engineVariations
      .slice(0, 6)
      .map((line) => `${line.multipv}:${line.depth}:${JSON.stringify(line.score.value)}:${line.uciMoves.join(" ")}`)
      .join("|");
    return `${searchingFen}|${searchingMoves.join(",")}|${compactLines}`;
  }, [settings.enabled, isGameOver, engineVariations, searchingFen, searchingMoves]);

  useEffect(() => {
    const requestId = strategicReportRequestRef.current + 1;
    strategicReportRequestRef.current = requestId;

    if (!humanStrategicKey || !engineVariations || engineVariations.length === 0) {
      setHumanStrategicReport(null);
      setHumanStrategicLoading(false);
      return;
    }

    const cached = getStrategicCacheEntry(humanStrategicCacheRef.current, humanStrategicKey);
    if (cached) {
      setHumanStrategicReport(cached);
      setHumanStrategicLoading(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      setHumanStrategicLoading(true);
      try {
        const result = await buildHumanStrategicLiveReport({
          fen: searchingFen,
          moves: searchingMoves,
          candidates: engineVariations.slice(0, 6),
          maxVariationPlies: 8,
          maxLines: 4,
        });

        if (strategicReportRequestRef.current !== requestId) {
          return;
        }

        if (result.status === "ok") {
          setStrategicCacheEntry(humanStrategicCacheRef.current, humanStrategicKey, result.data);
          setHumanStrategicReport(result.data);
        } else {
          setHumanStrategicReport(null);
        }
      } catch {
        if (strategicReportRequestRef.current !== requestId) {
          return;
        }
        setHumanStrategicReport(null);
      } finally {
        if (strategicReportRequestRef.current === requestId) {
          setHumanStrategicLoading(false);
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [humanStrategicKey, engineVariations, searchingFen, searchingMoves]);

  const buildFenTrail = useCallback((): string[] => {
    if (!finalFen) {
      return [];
    }
    const [linePos] = positionFromFen(fen);
    if (!linePos) {
      return [finalFen];
    }

    const trail: string[] = [makeFen(linePos.toSetup())];
    for (const uci of moves) {
      const move = parseUci(uci);
      if (!move) break;
      try {
        linePos.play(move);
        trail.push(makeFen(linePos.toSetup()));
      } catch {
        break;
      }
    }
    return trail;
  }, [fen, moves, finalFen]);

  const handleConsultPlan = useCallback(
    async (apiKeyOverride?: string) => {
      if (!finalFen || planLoading) {
        return;
      }

      if (!engineVariations || engineVariations.length === 0) {
        notifications.show({
          title: t("common.warning"),
          message: t("features.board.analysis.consultPlanNeedsEngine"),
          color: "yellow",
        });
        return;
      }

      const apiKey = (apiKeyOverride ?? orionPlanApiKey).trim();
      if (!apiKey) {
        setApiKeyDraft(orionPlanApiKey);
        setApiKeyModalOpened(true);
        return;
      }

      setPlanLoading(true);
      setPlanModalOpened(true);
      setPlanText("");
      setPlanPromptText("");

      try {
        const response = await consultOrionPlanFromAnalysis({
          apiKey,
          orientation,
          uiLanguage: i18n.resolvedLanguage || i18n.language,
          premiumUser: premiumUsername || undefined,
          rootFen: fen,
          finalFen,
          fenTrail: buildFenTrail(),
          gameMovesUci: moves,
          engineName: engine.name,
          engineGoJson: JSON.stringify(settings.go),
          engineSettingsJson: JSON.stringify(settings.settings),
          engineLinesJson: JSON.stringify(
            engineVariations.map((line) => ({
              multipv: line.multipv,
              depth: line.depth,
              nodes: line.nodes,
              nps: line.nps,
              score: line.score,
              uciMoves: line.uciMoves,
              sanMoves: line.sanMoves,
            })),
          ),
          dbType,
          lichessOptionsJson: JSON.stringify(lichessOptions),
          masterOptionsJson: JSON.stringify(masterOptions),
          lichessToken,
        });
        setPlanText(response.plan);
        setPlanPromptText(
          [
            "=== SYSTEM PROMPT ===",
            response.systemPrompt,
            "",
            "=== USER PROMPT ===",
            response.userPrompt,
            "",
            "=== PAYLOAD JSON ===",
            response.payloadJson,
          ].join("\n"),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const authError = /(401|403|unauthorized|forbidden|invalid api[- ]?key|api key)/i.test(message);
        if (authError) {
          setOrionPlanApiKey("");
          setApiKeyDraft("");
          setApiKeyModalOpened(true);
        }
        notifications.show({
          title: t("common.error"),
          message: authError
            ? t("features.board.analysis.consultPlanApiKeyInvalid")
            : t("features.board.analysis.consultPlanFailed", { error: message }),
          color: "red",
        });
      } finally {
        setPlanLoading(false);
      }
    },
    [
      finalFen,
      planLoading,
      engineVariations,
      orionPlanApiKey,
      fen,
      orientation,
      premiumUsername,
      engine.name,
      settings.go,
      settings.settings,
      moves,
      dbType,
      lichessOptions,
      masterOptions,
      lichessToken,
      i18n.language,
      i18n.resolvedLanguage,
      buildFenTrail,
      setOrionPlanApiKey,
      t,
    ],
  );

  const handleSaveApiKey = useCallback(() => {
    const trimmed = apiKeyDraft.trim();
    if (!trimmed) {
      return;
    }

    setOrionPlanApiKey(trimmed);
    setApiKeyModalOpened(false);
    void handleConsultPlan(trimmed);
  }, [apiKeyDraft, setOrionPlanApiKey, handleConsultPlan]);

  const planStructured = useMemo(() => {
    const raw = planText.trim();
    if (!raw) {
      return {
        sections: {} as Record<PlanSectionKey, string>,
        isStructured: false,
      };
    }

    const sections = {} as Record<PlanSectionKey, string>;
    const normalized = raw.replace(/\r/g, "");
    const headingRegex = /^##\s*([A-Z_]+)\s*$/gm;
    const matches = [...normalized.matchAll(headingRegex)];

    for (let i = 0; i < matches.length; i += 1) {
      const key = matches[i][1] as PlanSectionKey;
      if (!PLAN_SECTION_ORDER.includes(key)) continue;
      const start = (matches[i].index ?? 0) + matches[i][0].length;
      const end = i + 1 < matches.length ? (matches[i + 1].index ?? normalized.length) : normalized.length;
      const content = normalized.slice(start, end).trim();
      sections[key] = content;
    }

    const structuredCount = PLAN_SECTION_ORDER.filter((key) => (sections[key] ?? "").trim().length > 0).length;
    let isStructured = structuredCount >= 4;

    if (!isStructured) {
      const toReadable = (value: unknown, depth = 0): string => {
        if (value == null) return "";
        if (typeof value === "string") return value.trim();
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        if (Array.isArray(value)) {
          const lines = value
            .map((item) => {
              if (typeof item === "string") return `- ${item}`;
              if (item && typeof item === "object") {
                const move = (item as Record<string, unknown>).move;
                const purpose = (item as Record<string, unknown>).purpose;
                const fit = (item as Record<string, unknown>).whyThisFitsThePlan;
                if (typeof move === "string" || typeof purpose === "string" || typeof fit === "string") {
                  return `- Move: ${String(move ?? "-")} | Purpose: ${String(purpose ?? "-")} | Fit: ${String(fit ?? "-")}`;
                }
                const parts = Object.entries(item as Record<string, unknown>)
                  .map(([k, v]) => `${k}: ${toReadable(v, depth + 1)}`)
                  .join(" | ");
                return `- ${parts}`;
              }
              return `- ${String(item)}`;
            })
            .filter((line) => line.trim().length > 0);
          return lines.join("\n");
        }
        if (typeof value === "object") {
          const lines = Object.entries(value as Record<string, unknown>)
            .map(([k, v]) => {
              const humanKey = k.replace(/([A-Z])/g, " $1").replace(/^./, (ch) => ch.toUpperCase());
              return `${depth > 0 ? "-" : "-"} ${humanKey}: ${toReadable(v, depth + 1)}`;
            })
            .filter((line) => line.trim().length > 0);
          return lines.join("\n");
        }
        return "";
      };

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const pickField = (...keys: string[]) => {
          for (const key of keys) {
            if (Object.hasOwn(parsed, key) && parsed[key] != null) {
              return parsed[key];
            }
          }
          return undefined;
        };

        const mapped: Array<[PlanSectionKey, unknown]> = [
          ["POSITION_VERDICT", pickField("POSITION_VERDICT", "positionVerdict", "overview")],
          ["MAIN_PLAN", pickField("MAIN_PLAN", "mainPlan", "strategicPlan")],
          ["SECONDARY_PLANS", pickField("SECONDARY_PLANS", "secondaryPlans")],
          ["OPPONENT_COUNTERPLAY", pickField("OPPONENT_COUNTERPLAY", "opponentCounterplay")],
          ["PLAN_TRIGGERS", pickField("PLAN_TRIGGERS", "planTriggers")],
          ["CANDIDATE_MOVES", pickField("CANDIDATE_MOVES", "candidateMoves")],
          ["CRITICAL_RISKS", pickField("CRITICAL_RISKS", "criticalRisks", "tacticalAlerts")],
          ["PRACTICAL_ADVICE", pickField("PRACTICAL_ADVICE", "practicalAdvice", "practicalTips")],
        ];

        for (const [key, value] of mapped) {
          const readable = toReadable(value).trim();
          if (readable.length > 0) {
            sections[key] = readable;
          }
        }

        const mappedCount = PLAN_SECTION_ORDER.filter((key) => (sections[key] ?? "").trim().length > 0).length;
        isStructured = mappedCount >= 3;
      } catch {
        // keep non-structured fallback
      }
    }

    return {
      sections,
      isStructured,
    };
  }, [planText]);

  const sectionTitleByKey = useMemo(
    (): Record<PlanSectionKey, string> => ({
      POSITION_VERDICT: t("features.board.analysis.consultPlanSectionVerdict"),
      MAIN_PLAN: t("features.board.analysis.consultPlanSectionMainPlan"),
      SECONDARY_PLANS: t("features.board.analysis.consultPlanSectionSecondary"),
      OPPONENT_COUNTERPLAY: t("features.board.analysis.consultPlanSectionCounterplay"),
      PLAN_TRIGGERS: t("features.board.analysis.consultPlanSectionTriggers"),
      CANDIDATE_MOVES: t("features.board.analysis.consultPlanSectionMoves"),
      CRITICAL_RISKS: t("features.board.analysis.consultPlanSectionRisks"),
      PRACTICAL_ADVICE: t("features.board.analysis.consultPlanSectionAdvice"),
    }),
    [t],
  );

  const planDisplayText = useMemo(() => {
    if (planStructured.isStructured) {
      return PLAN_SECTION_ORDER.map((key) => {
        const content = planStructured.sections[key]?.trim();
        if (!content) return "";
        return `## ${sectionTitleByKey[key]}\n${content}`;
      })
        .filter(Boolean)
        .join("\n\n");
    }
    return planText.trim();
  }, [planStructured, sectionTitleByKey, planText]);

  const handleCopyPlan = useCallback(async () => {
    if (!planDisplayText.trim()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(planDisplayText);
      notifications.show({
        title: t("common.success"),
        message: t("features.board.analysis.consultPlanCopied"),
        color: "green",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notifications.show({
        title: t("common.error"),
        message: t("features.board.analysis.consultPlanFailed", { error: message }),
        color: "red",
      });
    }
  }, [planDisplayText, t]);

  const handleCopyPrompt = useCallback(async () => {
    if (!planPromptText.trim()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(planPromptText);
      notifications.show({
        title: t("common.success"),
        message: t("features.board.analysis.consultPlanPromptCopied"),
        color: "green",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notifications.show({
        title: t("common.error"),
        message: t("features.board.analysis.consultPlanFailed", { error: message }),
        color: "red",
      });
    }
  }, [planPromptText, t]);

  return (
    <>
      <Box style={{ display: "flex" }}>
        <Stack gap={0} py="1rem">
          <ActionIcon
            size="lg"
            variant={settings.enabled ? "filled" : "transparent"}
            color={id < 4 ? arrowColors[id].strong : theme.primaryColor}
            onClick={() => {
              setSettings((prev) => ({ ...prev, enabled: !prev.enabled }));
            }}
            ml={12}
          >
            {settings.enabled ? <IconPlayerPause size="1rem" /> : <IconPlayerPlay size="1rem" />}
          </ActionIcon>
        </Stack>
        <Accordion.Control>
          <EngineTop
            name={engine.name}
            engineVariations={engineVariations}
            isGameOver={isGameOver}
            enabled={settings.enabled}
            progress={progress}
            error={error}
          />
        </Accordion.Control>
        <ActionIcon.Group>
          <Tooltip label={t("analysis.checkOpponentThreat")}>
            <ActionIcon
              size="lg"
              onClick={() => setThreat(!threat)}
              disabled={!settings.enabled}
              variant="transparent"
              mt="auto"
              mb="auto"
            >
              <IconTargetArrow color={threat ? "red" : undefined} size="1rem" />
            </ActionIcon>
          </Tooltip>
          <ActionIcon size="lg" onClick={() => toggleSettingsOn()} mt="auto" mb="auto">
            <IconSettings size="1rem" />
          </ActionIcon>
          <ActionIcon
            size="lg"
            mr={8}
            mt="auto"
            mb="auto"
            style={{
              cursor: "grab",
            }}
            {...dragHandleProps}
          >
            <IconGripVertical size="1rem" />
          </ActionIcon>
        </ActionIcon.Group>
      </Box>
      <Collapse expanded={settingsOn} px={30} pb={15}>
        <EngineSettingsForm
          engine={engine}
          settings={settings}
          setSettings={setSettings}
          color={id < 4 ? arrowColors[id].strong : theme.primaryColor}
          remote={engine.type !== "local"}
        />
      </Collapse>
      {canConsultPlan && (
        <Box px={30} pb={10}>
          <Divider mb="xs" />
          <Button
            leftSection={<IconBrain size="1rem" />}
            variant="light"
            size="xs"
            loading={planLoading}
            disabled={!finalFen || !engineVariations || engineVariations.length === 0}
            onClick={() => void handleConsultPlan()}
          >
            {t("features.board.analysis.consultPlan")}
          </Button>
        </Box>
      )}

      <Progress
        value={isGameOver ? 0 : progress}
        animated={progress < 100 && settings.enabled && !isGameOver}
        size="xs"
        striped={progress < 100 && !settings.enabled}
        color={id < 4 ? arrowColors[id].strong : theme.primaryColor}
      />
      <Accordion.Panel pos="relative">
        <Table>
          <Table.Tbody>
            {error && (
              <Table.Tr>
                <Table.Td>
                  <Text ta="center" my="lg">
                    Invalid position: {chessopsError(error)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {isGameOver && (
              <Table.Tr>
                <Table.Td>
                  <Text ta="center" my="lg">
                    Game is over
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {engineVariations && engineVariations.length === 0 && !isGameOver && (
              <Table.Tr>
                <Table.Td>
                  <Text ta="center" my="lg">
                    No analysis available
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {!isGameOver &&
              !error &&
              !engineVariations &&
              (settings.enabled ? (
                [...Array(settings.settings.find((s) => s.name === "MultiPV")?.value ?? 1)].map((_, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>
                      <Skeleton height={35} radius="xl" p={5} />
                    </Table.Td>
                  </Table.Tr>
                ))
              ) : (
                <Table.Tr>
                  <Table.Td>
                    <Text ta="center" my="lg">
                      {t("features.board.analysis.inactiveEngine")}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            {!isGameOver &&
              !error &&
              finalFen &&
              engineVariations?.map((engineVariation, index) => {
                return (
                  <AnalysisRow
                    key={index}
                    engine={engine.name}
                    moves={engineVariation.sanMoves}
                    score={engineVariation.score}
                    halfMoves={halfMoves}
                    threat={threat}
                    fen={threat ? swapMove(finalFen) : finalFen}
                    orientation={orientation}
                  />
                );
              })}
          </Table.Tbody>
        </Table>
        {!isGameOver && !error && settings.enabled && (humanStrategicLoading || humanStrategicReport) && (
          <Box px="sm" pb="sm" pt="xs">
            <Divider mb="xs" />
            <Stack gap="xs">
              <Group justify="space-between" align="center">
                <Text size="sm" fw={700}>
                  {t("features.board.analysis.gmGuardrailTitle")}
                </Text>
                {humanStrategicLoading && (
                  <Text size="xs" c="dimmed">
                    {t("common.loading")}
                  </Text>
                )}
              </Group>

              {humanStrategicReport && (
                <>
                  <Text size="xs" c="dimmed">
                    {t("features.board.analysis.gmGuardrailRecommended", {
                      selected: humanStrategicReport.selectedSan,
                      best: humanStrategicReport.bestEngineSan,
                      drop: humanStrategicReport.lines.find((line) => line.isSelected)?.engineDropCp ?? 0,
                    })}
                  </Text>
                  <Stack gap="xs">
                    {humanStrategicReport.lines.map((line) => (
                      <Paper key={line.uci} withBorder p="xs" radius="sm">
                        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                          <Text size="sm" fw={600}>
                            {line.engineRank}. {line.san}
                          </Text>
                          <Badge
                            variant={line.isSelected ? "filled" : "light"}
                            color={line.isSelected ? "teal" : "gray"}
                          >
                            {t("features.board.analysis.gmGuardrailLineScore", {
                              score: line.strategicScore.toFixed(2),
                            })}
                          </Badge>
                        </Group>
                        <Text size="xs" mt={4}>
                          {line.commentShort}
                        </Text>
                        {line.commentLong && line.commentLong !== line.commentShort && (
                          <Text size="xs" c="dimmed" mt={2}>
                            {line.commentLong}
                          </Text>
                        )}
                      </Paper>
                    ))}
                  </Stack>
                </>
              )}
            </Stack>
          </Box>
        )}
      </Accordion.Panel>
      <Modal
        opened={apiKeyModalOpened}
        onClose={() => setApiKeyModalOpened(false)}
        title={t("features.board.analysis.consultPlanApiKeyTitle")}
        centered
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {t("features.board.analysis.consultPlanApiKeyDescription")}
          </Text>
          <TextInput
            label={t("features.board.analysis.consultPlanApiKeyLabel")}
            placeholder={t("features.board.analysis.consultPlanApiKeyPlaceholder")}
            type="password"
            value={apiKeyDraft}
            onChange={(event) => setApiKeyDraft(event.currentTarget.value)}
            autoFocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setApiKeyModalOpened(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSaveApiKey} disabled={apiKeyDraft.trim().length === 0}>
              {t("common.save")}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={planModalOpened}
        onClose={() => setPlanModalOpened(false)}
        title={t("features.board.analysis.consultPlanResult")}
        centered
        size="70rem"
      >
        <Tabs defaultValue="response">
          <Tabs.List>
            <Tabs.Tab value="response">{t("features.board.analysis.consultPlanTabResponse")}</Tabs.Tab>
            <Tabs.Tab value="prompt">{t("features.board.analysis.consultPlanTabPrompt")}</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="response" pt="sm">
            <Stack>
              {planLoading ? (
                <Text size="sm">{t("features.board.analysis.consultPlanLoading")}</Text>
              ) : planText.trim().length > 0 ? (
                <Paper withBorder p="md" radius="md">
                  <Group justify="space-between" mb="xs">
                    <Badge variant="light">{t("features.board.analysis.consultPlanReadable")}</Badge>
                    <Button variant="default" size="xs" onClick={() => void handleCopyPlan()}>
                      {t("features.board.analysis.consultPlanCopyResponse")}
                    </Button>
                  </Group>
                  <ScrollArea h={500} offsetScrollbars>
                    {planStructured.isStructured ? (
                      <Stack gap="md">
                        {PLAN_SECTION_ORDER.map((key) => {
                          const content = (planStructured.sections[key] ?? "").trim();
                          if (!content) return null;
                          return (
                            <Paper key={key} withBorder radius="md" p="sm">
                              <Text fw={700} mb={6}>
                                {sectionTitleByKey[key]}
                              </Text>
                              <div className={classes.planMarkdownRoot}>
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    p: ({ children }) => <p>{children}</p>,
                                    li: ({ children }) => <li>{children}</li>,
                                  }}
                                >
                                  {content}
                                </ReactMarkdown>
                              </div>
                            </Paper>
                          );
                        })}
                      </Stack>
                    ) : (
                      <div className={classes.planMarkdownRoot}>
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            p: ({ children }) => <p>{children}</p>,
                            li: ({ children }) => <li>{children}</li>,
                          }}
                        >
                          {planDisplayText}
                        </ReactMarkdown>
                      </div>
                    )}
                  </ScrollArea>
                </Paper>
              ) : (
                <Text size="sm" c="dimmed">
                  {t("features.board.analysis.consultPlanEmpty")}
                </Text>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="prompt" pt="sm">
            <Stack>
              {planLoading ? (
                <Text size="sm">{t("features.board.analysis.consultPlanLoading")}</Text>
              ) : planPromptText.trim().length > 0 ? (
                <>
                  <Group justify="flex-end">
                    <Button variant="default" size="xs" onClick={() => void handleCopyPrompt()}>
                      {t("features.board.analysis.consultPlanCopyPrompt")}
                    </Button>
                  </Group>
                  <ScrollArea h={420} offsetScrollbars>
                    <Text
                      size="xs"
                      ff="monospace"
                      style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.45 }}
                    >
                      {planPromptText}
                    </Text>
                  </ScrollArea>
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  {t("features.board.analysis.consultPlanEmpty")}
                </Text>
              )}
            </Stack>
          </Tabs.Panel>
        </Tabs>
      </Modal>
    </>
  );
}

function EngineTop({
  name,
  engineVariations,
  isGameOver,
  enabled,
  progress,
  error,
}: {
  name: string;
  engineVariations: BestMoves[] | undefined;
  isGameOver: boolean;
  enabled: boolean;
  progress: number;
  error: any;
}) {
  const { t } = useTranslation();
  const currentThemeId = useAtomValue(currentThemeIdAtom);
  const isAcademiaMaya = currentThemeId === "academia-maya";
  const isComputed = engineVariations && engineVariations.length > 0;
  const depth = isComputed ? engineVariations[0].depth : 0;

  return (
    <Group justify="space-between">
      <Group align="center">
        <Text fw="bold" fz="xl">
          {name}
        </Text>
        {enabled && !isGameOver && !error && !engineVariations && <Code fz="xs">{t("common.loading")}</Code>}
        {progress < 100 && enabled && !isGameOver && engineVariations && engineVariations.length > 0 && (
          <Tooltip label={t("analysis.engineSpeed")}>
            <Code fz="xs">{t("units.nodes", { nodes: isComputed ? engineVariations[0].nps : 0 })}</Code>
          </Tooltip>
        )}
      </Group>
      <Group gap="lg">
        {!isGameOver && engineVariations && engineVariations.length > 0 && (
          <>
            <Stack align="center" gap={0}>
              <Text
                size="0.7rem"
                tt="uppercase"
                fw={700}
                className={classes.subtitle}
                c={isAcademiaMaya ? "gray.3" : undefined}
              >
                Eval
              </Text>
              <Text fw="bold" fz="md">
                {t("units.score", { score: engineVariations[0].score.value, precision: 1 }) ?? 0}
              </Text>
            </Stack>
            <Stack align="center" gap={0}>
              <Text
                size="0.7rem"
                tt="uppercase"
                fw={700}
                className={classes.subtitle}
                c={isAcademiaMaya ? "gray.3" : undefined}
              >
                Depth
              </Text>
              <Text fw="bold" fz="md">
                {depth}
              </Text>
            </Stack>
          </>
        )}
      </Group>
    </Group>
  );
}

export default memo(BestMovesComponent, (prev, next) => {
  return (
    prev.id === next.id &&
    prev.engine === next.engine &&
    prev.fen === next.fen &&
    equal(prev.moves, next.moves) &&
    prev.halfMoves === next.halfMoves &&
    prev.orientation === next.orientation
  );
});
