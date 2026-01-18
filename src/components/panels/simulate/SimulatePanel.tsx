import {
  Accordion,
  Button,
  Card,
  Group,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue, useSetAtom } from "jotai";
import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { EngineOption, PlayerQuery } from "@/bindings";
import { commands } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import { activeProfileIdAtom, currentTabSelectedAtom, enginesAtom, profilesAtom, sessionsAtom } from "@/state/atoms";
import { reportSettingsAtom } from "@/state/reportSettings";
import { getAccountKey } from "@/utils/accountKeys";
import { parsePGN } from "@/utils/chess";
import { getProfileDbPath } from "@/utils/profileDb";
import { getNodeAtPath } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

type PlannerBuildPgnResponse = { pgn: string };

function requireContext<T>(value: T | null | undefined, name: string): T {
  if (value == null) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function SimulatePanel() {
  const { t } = useTranslation();
  const store = requireContext(useContext(TreeStateContext), "TreeStateContext");
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const currentNode = getNodeAtPath(root, position);
  const setTreeState = useStore(store, (s) => s.setState);
  const setCurrentTabSelected = useSetAtom(currentTabSelectedAtom);

  const engines = useAtomValue(enginesAtom);
  const profiles = useAtomValue(profilesAtom);
  const sessions = useAtomValue(sessionsAtom);
  const reportSettings = useAtomValue(reportSettingsAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);

  const localEngines = useMemo(() => engines.filter((e) => e.type === "local"), [engines]);

  const [enginePath, setEnginePath] = useState<string | null>(() => {
    if (!localEngines.length) return null;
    if (reportSettings.engine && localEngines.some((e) => e.path === reportSettings.engine)) {
      return reportSettings.engine;
    }
    return localEngines[0]?.path ?? null;
  });

  useEffect(() => {
    if (!localEngines.length) {
      setEnginePath(null);
      return;
    }
    if (!enginePath || !localEngines.some((e) => e.path === enginePath)) {
      setEnginePath(localEngines[0]?.path ?? null);
    }
  }, [enginePath, localEngines]);

  const [opponentProfileId, setOpponentProfileId] = useState<string | null>(null);
  useEffect(() => {
    if (!opponentProfileId && profiles.length > 0) {
      const firstNonActive = profiles.find((p) => p.id !== activeProfileId) ?? null;
      if (firstNonActive) setOpponentProfileId(firstNonActive.id);
    }
  }, [activeProfileId, opponentProfileId, profiles]);

  const selectedEngine = useMemo(() => {
    if (!enginePath) return null;
    return localEngines.find((e) => e.path === enginePath) ?? null;
  }, [enginePath, localEngines]);

  const opponentProfile = useMemo(
    () => profiles.find((p) => p.id === opponentProfileId) ?? null,
    [opponentProfileId, profiles],
  );

  const opponentAccountKeys = useMemo(() => {
    if (!opponentProfileId) return [];
    const out: string[] = [];
    for (const s of sessions) {
      if (s.profileId !== opponentProfileId) continue;
      const lichess = s.lichess?.username ?? null;
      const chessCom = s.chessCom?.username ?? null;
      if (lichess) out.push(getAccountKey("lichess", lichess));
      if (chessCom) out.push(getAccountKey("chesscom", chessCom));
    }
    return out.filter((v, idx) => out.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === idx);
  }, [opponentProfileId, sessions]);

  const { data: opponentDbPath } = useQuery({
    queryKey: ["simulateOpponentDbPath", opponentProfileId],
    queryFn: async () => (opponentProfileId ? await getProfileDbPath(opponentProfileId) : null),
    enabled: !!opponentProfileId,
    staleTime: Infinity,
  });

  const opponentPlayerIdQuery = useQuery({
    queryKey: [
      "simulateOpponentPlayerId",
      opponentProfileId,
      opponentDbPath,
      opponentProfile?.name,
      opponentAccountKeys,
    ],
    queryFn: async () => {
      if (!opponentProfileId || !opponentDbPath) return null;

      const candidates = [...opponentAccountKeys, opponentProfile?.name ?? null]
        .map((s) => (s ?? "").trim())
        .filter((s) => s.length > 0);

      const opts: PlayerQuery["options"] = {
        skipCount: true,
        page: 1,
        pageSize: 10,
        sort: "id",
        direction: "asc",
      };

      for (const name of candidates) {
        const q: PlayerQuery = { options: opts, name, range: null };
        const res = unwrap(await commands.getPlayers(opponentDbPath, q));
        const rows = res.data ?? [];
        const exact = rows.find((p) => (p.name ?? "").trim().toLowerCase() === name.toLowerCase()) ?? null;
        if (exact) return exact.id ?? null;
        if (rows.length > 0 && rows[0]?.id != null) return rows[0].id;
      }

      // Last fallback: pick the first player row (best-effort).
      const q: PlayerQuery = {
        options: { skipCount: true, page: 1, pageSize: 1, sort: "id", direction: "asc" },
        name: null,
        range: null,
      };
      const res = unwrap(await commands.getPlayers(opponentDbPath, q));
      return res.data?.[0]?.id ?? null;
    },
    enabled: !!opponentDbPath,
    staleTime: 30_000,
  });

  const [ourColor, setOurColor] = useState<"white" | "black">("white");
  const [timeControl, setTimeControl] = useState("300+0");
  const [ourElo, setOurElo] = useState<number>(1500);

  const [startFen, setStartFen] = useState("startpos");
  useEffect(() => {
    if (!startFen || startFen === "startpos") {
      setStartFen(currentNode?.fen || "startpos");
    }
  }, [currentNode?.fen, startFen]);

  // Default preset tuned for "large opponent DB" (tens of thousands of games):
  // - prioritize realistic opponent coverage, keep pruning sane, and keep engine eval affordable.
  const [horizonPlies, setHorizonPlies] = useState<number>(18);
  const [opponentTopK, setOpponentTopK] = useState<number>(5);
  const [maxNodes, setMaxNodes] = useState<number>(8000);
  const [minBranchProb, setMinBranchProb] = useState<number>(0.01);

  const [ourMultipv, setOurMultipv] = useState<number>(3);
  const [candidateDepth, setCandidateDepth] = useState<number>(16);
  const [quickDepth, setQuickDepth] = useState<number>(12);
  const [backoffK, setBackoffK] = useState<number>(60);
  const [smoothingAlpha, setSmoothingAlpha] = useState<number>(0.2);

  const [running, setRunning] = useState(false);

  const engineOptions: EngineOption[] = useMemo(() => {
    return selectedEngine?.type === "local"
      ? (selectedEngine.settings ?? [])
          .filter((s) => s?.name && s.name !== "MultiPV" && s.value != null)
          .map((s) => ({ name: s.name, value: String(s.value ?? "") }))
      : [];
  }, [selectedEngine]);

  const onUseCurrentPosition = () => {
    setStartFen(currentNode?.fen || "startpos");
  };

  const onRun = async () => {
    if (!enginePath) {
      notifications.show({
        title: t("common.error"),
        message: t("profiles.simulate.errors.noEngine"),
        color: "red",
      });
      return;
    }
    if (!opponentProfileId) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.simulate.errors.noOpponentProfile"),
        color: "red",
      });
      return;
    }
    const opponentPlayerId = opponentPlayerIdQuery.data;
    if (!opponentPlayerId || !Number.isFinite(opponentPlayerId)) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.simulate.errors.noOpponentResolved"),
        color: "red",
      });
      return;
    }

    setRunning(true);
    try {
      const resp = await invoke<PlannerBuildPgnResponse>("planner_build_variant_pgn", {
        req: {
          // Train + plan from the opponent profile DB.
          profileId: opponentProfileId,
          enginePath,
          uciOptions: engineOptions,
          ctx: {
            matchStartUtcMs: Date.now(),
            timeControl,
            ourElo,
            targetPlayerId: opponentPlayerId,
            ourColor,
            startFen,
          },
          opts: {
            horizonPlies: horizonPlies as unknown as bigint,
            opponentTopK: opponentTopK as unknown as bigint,
            minBranchProb,
            maxNodes: maxNodes as unknown as bigint,
            ourMultipv: ourMultipv as unknown as bigint,
            quickEvalLimits: { depth: quickDepth, timeMs: null },
            candidateLimits: { depth: candidateDepth, timeMs: null },
            backoffK,
            smoothingAlpha,
          },
        },
      });

      const nextPgn = (resp.pgn ?? "").trim();
      if (!nextPgn) {
        notifications.show({
          title: t("common.error"),
          message: t("errors.failedToGeneratePgn"),
          color: "red",
        });
        return;
      }

      const tree = await parsePGN(nextPgn);
      tree.position = [];
      setTreeState(tree);
      setCurrentTabSelected("info");
    } catch (e) {
      notifications.show({
        title: t("common.error"),
        message: e instanceof Error ? e.message : String(e),
        color: "red",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card withBorder p="sm" radius="md" h="100%" style={{ overflow: "hidden" }}>
      <Stack h="100%" gap="sm" style={{ minHeight: 0 }}>
        <Stack gap={2}>
          <Text fw={700}>{t("features.board.tabs.simulate")}</Text>
          <Text size="sm" c="dimmed">
            {t("profiles.simulate.desc")}
          </Text>
        </Stack>

        <ScrollArea style={{ flex: 1 }} offsetScrollbars>
          <Stack gap="sm">
            <Group grow>
              <Select
                label={t("features.board.simulate.opponentProfile")}
                placeholder={t("features.board.simulate.opponentProfilePlaceholder")}
                value={opponentProfileId}
                onChange={(v) => setOpponentProfileId(v)}
                data={profiles
                  .filter((p) => p.id !== activeProfileId)
                  .map((p) => ({ value: p.id, label: p.name || `Profile ${p.id}` }))}
                searchable
                clearable
              />
              <Select
                label={t("profiles.simulate.engine")}
                placeholder={t("profiles.simulate.enginePlaceholder")}
                value={enginePath}
                onChange={(v) => setEnginePath(v)}
                data={localEngines.map((e) => ({ value: e.path, label: e.name }))}
                clearable={false}
              />
            </Group>

            {opponentProfileId && (
              <Text size="sm" c="dimmed">
                {t("features.board.simulate.resolvedOpponent", {
                  defaultValue: "Resolved opponent player id: {{id}}",
                  id: opponentPlayerIdQuery.data ?? "-",
                })}
              </Text>
            )}

            <Group grow>
              <TextInput
                label={t("profiles.simulate.timeControl")}
                value={timeControl}
                onChange={(e) => setTimeControl(e.currentTarget.value)}
              />
              <NumberInput
                label={t("profiles.simulate.ourElo")}
                value={ourElo}
                onChange={(v) => setOurElo(Number(v) || 0)}
              />
              <Select
                label={t("chess.player")}
                data={[
                  { value: "white", label: t("chess.white") },
                  { value: "black", label: t("chess.black") },
                ]}
                value={ourColor}
                onChange={(v) => setOurColor((v as "white" | "black") ?? "white")}
              />
            </Group>

            <Group align="end">
              <Textarea
                style={{ flex: 1 }}
                label={t("profiles.simulate.startFen")}
                value={startFen}
                onChange={(e) => setStartFen(e.currentTarget.value)}
                autosize
                minRows={2}
                maxRows={3}
              />
              <Button variant="light" onClick={onUseCurrentPosition}>
                {t("features.board.simulate.useCurrentPosition")}
              </Button>
            </Group>

            <Accordion variant="separated">
              <Accordion.Item value="planner">
                <Accordion.Control>{t("profiles.simulate.plannerSettings")}</Accordion.Control>
                <Accordion.Panel>
                  <Group grow>
                    <NumberInput
                      label={t("profiles.simulate.horizonPlies")}
                      value={horizonPlies}
                      onChange={(v) => setHorizonPlies(Number(v) || 1)}
                      min={1}
                      max={80}
                    />
                    <NumberInput
                      label={t("profiles.simulate.opponentTopK")}
                      value={opponentTopK}
                      onChange={(v) => setOpponentTopK(Number(v) || 1)}
                      min={1}
                      max={8}
                    />
                    <NumberInput
                      label={t("profiles.simulate.maxNodes")}
                      value={maxNodes}
                      onChange={(v) => setMaxNodes(Number(v) || 1)}
                      min={10}
                      max={50_000}
                    />
                    <NumberInput
                      label={t("profiles.simulate.minBranchProb")}
                      value={minBranchProb}
                      onChange={(v) => setMinBranchProb(Number(v) || 0)}
                      min={0}
                      max={1}
                      step={0.01}
                      decimalScale={3}
                    />
                  </Group>
                </Accordion.Panel>
              </Accordion.Item>

              <Accordion.Item value="engine">
                <Accordion.Control>{t("profiles.simulate.engineSettings")}</Accordion.Control>
                <Accordion.Panel>
                  <Group grow>
                    <NumberInput
                      label={t("profiles.simulate.ourMultiPv")}
                      value={ourMultipv}
                      onChange={(v) => setOurMultipv(Number(v) || 1)}
                      min={1}
                      max={8}
                    />
                    <NumberInput
                      label={t("profiles.simulate.candidateDepth")}
                      value={candidateDepth}
                      onChange={(v) => setCandidateDepth(Number(v) || 1)}
                      min={1}
                      max={30}
                    />
                    <NumberInput
                      label={t("profiles.simulate.quickDepth")}
                      value={quickDepth}
                      onChange={(v) => setQuickDepth(Number(v) || 1)}
                      min={1}
                      max={30}
                    />
                  </Group>
                </Accordion.Panel>
              </Accordion.Item>

              <Accordion.Item value="model">
                <Accordion.Control>{t("profiles.simulate.modelSettings")}</Accordion.Control>
                <Accordion.Panel>
                  <Group grow>
                    <NumberInput
                      label={t("profiles.simulate.backoffK")}
                      value={backoffK}
                      onChange={(v) => setBackoffK(Number(v) || 1)}
                      min={1}
                      max={500}
                    />
                    <NumberInput
                      label={t("profiles.simulate.smoothingAlpha")}
                      value={smoothingAlpha}
                      onChange={(v) => setSmoothingAlpha(Number(v) || 0)}
                      min={0}
                      max={10}
                      step={0.1}
                      decimalScale={2}
                    />
                  </Group>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </Stack>
        </ScrollArea>

        <Group justify="flex-end">
          <Button onClick={onRun} loading={running} disabled={running}>
            {t("profiles.simulate.run")}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

export default SimulatePanel;
