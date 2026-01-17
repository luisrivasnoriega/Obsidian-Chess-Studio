import {
  Accordion,
  Button,
  Card,
  Code,
  CopyButton,
  Divider,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { makeSan } from "chessops/san";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type BookEdge,
  type BookNode,
  commands,
  type EngineOption,
  type PlayerQuery,
  type VariantBook,
} from "@/bindings";
import { playerStatsCommands } from "@/bindings/playerStats";
import { enginesAtom, type Profile, profilesAtom, sessionsAtom } from "@/state/atoms";
import { reportSettingsAtom } from "@/state/reportSettings";
import { getAccountKey } from "@/utils/accountKeys";
import { parseSanOrUci, positionFromFen } from "@/utils/chessops";
import { createSiteStatsSignature } from "@/utils/playerStats";
import { getProfileDbPath } from "@/utils/profileDb";
import { unwrap } from "@/utils/unwrap";
import {
  buildSessionsSignature,
  computePersonalInfoSignature,
  fetchMergedPlayerInfo,
  fetchPersonalInfoForProfile,
  getMergedPlayerInfoQueryKey,
  getPersonalInfoQueryKey,
} from "./Databases";

type Props = {
  profileId?: string;
};

export default function SimulatePanel({ profileId }: Props) {
  const { t } = useTranslation();
  const engines = useAtomValue(enginesAtom);
  const profiles = useAtomValue(profilesAtom);
  const reportSettings = useAtomValue(reportSettingsAtom);
  const sessions = useAtomValue(sessionsAtom);

  // "Engine actual a nivel UI": reuse the same engine selection as Analysis Report (report-settings).
  const { selectedEngine, selectedEnginePath } = useMemo(() => {
    const localEngines = engines.filter((e) => e.type === "local");
    const desiredPath =
      localEngines.length === 0
        ? null
        : !reportSettings.engine || !localEngines.some((l) => l.path === reportSettings.engine)
          ? localEngines[0]?.path
          : reportSettings.engine;

    const engine = desiredPath ? (localEngines.find((e) => e.path === desiredPath) ?? null) : null;
    return { selectedEngine: engine, selectedEnginePath: desiredPath };
  }, [engines, reportSettings.engine]);

  const [opponentProfileId, setOpponentProfileId] = useState<string | null>(null);

  const [ourColor, setOurColor] = useState<"white" | "black">("white");
  const [startFen, setStartFen] = useState("startpos");
  const [timeControl, setTimeControl] = useState("300+0");

  const [horizonPlies, setHorizonPlies] = useState<number>(12);
  const [opponentTopK, setOpponentTopK] = useState<number>(3);
  const [maxNodes, setMaxNodes] = useState<number>(800);
  const [minBranchProb, setMinBranchProb] = useState<number>(0.01);

  const [ourMultipv, setOurMultipv] = useState<number>(3);
  const [candidateDepth, setCandidateDepth] = useState<number>(14);
  const [quickDepth, setQuickDepth] = useState<number>(10);
  const [backoffK, setBackoffK] = useState<number>(50);
  const [smoothingAlpha, setSmoothingAlpha] = useState<number>(0.5);

  const [result, setResult] = useState<VariantBook | null>(null);
  const [running, setRunning] = useState(false);

  const bookView = useMemo(() => {
    if (!result) return null;

    const nodes = (result.nodes ?? []) as BookNode[];
    const edges = (result.edges ?? []) as BookEdge[];
    const rootId = result.rootNodeId as bigint;

    const nodeById = new Map<bigint, BookNode>();
    for (const n of nodes) nodeById.set(n.id as bigint, n);

    const edgesByFrom = new Map<bigint, BookEdge[]>();
    for (const e of edges) {
      const from = e.from as bigint;
      const list = edgesByFrom.get(from) ?? [];
      list.push(e);
      edgesByFrom.set(from, list);
    }

    for (const list of edgesByFrom.values()) {
      list.sort((a, b) => {
        // Our move first, then opponent moves by prob desc
        if (a.kind !== b.kind) return a.kind === "ourMove" ? -1 : 1;
        if (a.kind === "opponentMove") return (b.prob ?? 0) - (a.prob ?? 0);
        return 0;
      });
    }

    const rootNode = nodeById.get(rootId) ?? null;

    const edgeSan = (edge: BookEdge): string => {
      const fromNode = nodeById.get(edge.from as bigint);
      if (!fromNode) return edge.uci;
      const [pos] = positionFromFen(fromNode.fen);
      if (!pos) return edge.uci;
      const mv = parseSanOrUci(pos, edge.uci);
      if (!mv) return edge.uci;
      const san = makeSan(pos, mv);
      return san && san !== "--" ? san : edge.uci;
    };

    const formatLine = (sanMoves: string[]): string => {
      if (!rootNode) return sanMoves.join(" ");
      const startTurn = rootNode.sideToMove;
      let ply = 0;
      let moveNo = 1;
      const parts: string[] = [];
      for (const san of sanMoves) {
        const isWhiteMove = (startTurn === "white" && ply % 2 === 0) || (startTurn === "black" && ply % 2 === 1);
        if (isWhiteMove) {
          parts.push(`${moveNo}.`);
        } else if (ply === 0 && startTurn === "black") {
          parts.push(`${moveNo}...`);
        }
        parts.push(san);
        ply += 1;
        if (isWhiteMove === false) moveNo += 1;
      }
      return parts.join(" ");
    };

    type Line = { sanLine: string; reachProb: number; ev: number | null; ply: number };

    const maxLines = 50;
    const maxDepth = Number(rootNode?.plyFromRoot ?? BigInt(0)) + 30; // safety

    const lines: Line[] = [];
    const walk = (nodeId: bigint, sanAcc: string[], reachProb: number, evAcc: number | null) => {
      if (lines.length >= maxLines) return;
      const node = nodeById.get(nodeId);
      if (!node) return;
      const ply = Number(node.plyFromRoot ?? BigInt(0));
      if (ply >= maxDepth) {
        lines.push({ sanLine: formatLine(sanAcc), reachProb, ev: evAcc, ply });
        return;
      }

      const outgoing = edgesByFrom.get(nodeId) ?? [];
      if (outgoing.length === 0) {
        lines.push({ sanLine: formatLine(sanAcc), reachProb, ev: evAcc, ply });
        return;
      }

      for (const e of outgoing) {
        const san = edgeSan(e);
        const nextReach = e.kind === "opponentMove" ? reachProb * (e.prob ?? 0) : reachProb;
        const nextEv = e.kind === "ourMove" ? (evAcc ?? 0) + (e.evCpFromOurPerspective ?? 0) : evAcc;
        walk(e.to as bigint, [...sanAcc, san], nextReach, nextEv);
        if (e.kind === "ourMove") {
          // Typically only one; keep deterministic and avoid enumerating multiple lines on our move.
          break;
        }
        if (lines.length >= maxLines) break;
      }
    };

    walk(rootId, [], 1.0, null);

    lines.sort((a, b) => b.reachProb - a.reachProb);

    // Tree view (recursive render data)
    type TreeEdge = { to: bigint; label: string; meta: string };
    const tree = (nodeId: bigint, _depth: number): { id: bigint; edges: TreeEdge[] } => {
      const outgoing = edgesByFrom.get(nodeId) ?? [];
      const edgesView: TreeEdge[] = outgoing.map((e) => {
        const label = edgeSan(e);
        const meta =
          e.kind === "opponentMove"
            ? `p=${(e.prob ?? 0).toFixed(3)}`
            : e.evCpFromOurPerspective != null
              ? `ev=${Math.round(e.evCpFromOurPerspective)}cp`
              : "";
        return { to: e.to as bigint, label, meta };
      });
      return { id: nodeId, edges: edgesView };
    };

    return {
      rootId,
      rootNode,
      nodesCount: nodes.length,
      edgesCount: edges.length,
      lines,
      tree,
    };
  }, [result]);

  const opponentProfileOptions = useMemo(() => {
    const list = (profiles ?? []).filter((p: Profile) => p.id !== profileId);
    return list.map((p) => ({ value: p.id, label: p.name }));
  }, [profiles, profileId]);

  const opponentProfile = useMemo(() => {
    if (!opponentProfileId) return null;
    return profiles.find((p) => p.id === opponentProfileId) ?? null;
  }, [profiles, opponentProfileId]);

  // Resolve opponent profile DB path (so we can query its Players table).
  const opponentDbPathQuery = useQuery({
    enabled: Boolean(opponentProfileId),
    queryKey: ["simulateOpponentDbPath", opponentProfileId],
    queryFn: async () => {
      if (!opponentProfileId) return null;
      return await getProfileDbPath(opponentProfileId);
    },
    staleTime: 60_000,
  });

  // Resolve opponent "main player id" from the opponent profile's linked accounts.
  // This avoids requiring you to have faced the opponent before.
  const opponentPlayerIdQuery = useQuery({
    enabled: Boolean(opponentProfileId) && Boolean(opponentDbPathQuery.data),
    queryKey: ["simulateOpponentPlayerId", opponentProfileId, opponentDbPathQuery.data, sessions.length],
    queryFn: async () => {
      const dbPath = opponentDbPathQuery.data;
      if (!dbPath) return null;
      if (!opponentProfileId) return null;

      const linked = sessions.filter((s) => s.profileId === opponentProfileId);
      const keys = linked
        .map((s) => {
          if (s.lichess?.username) return getAccountKey("lichess", s.lichess.username);
          if (s.chessCom?.username) return getAccountKey("chesscom", s.chessCom.username);
          return null;
        })
        .filter((k): k is string => Boolean(k));

      // Prefer the first linked account; if there are multiple, we keep it deterministic.
      for (const accountKey of keys) {
        const res = await commands.getPlayers(dbPath, {
          options: { skipCount: true, page: 1, pageSize: 10, sort: "id", direction: "asc" },
          name: accountKey,
          range: null,
        } satisfies PlayerQuery);
        const data = unwrap(res).data ?? [];
        const exact =
          data.find((p) => (p.name ?? "").trim().toLowerCase() === accountKey.trim().toLowerCase()) ?? data[0] ?? null;
        if (exact) return exact.id;
      }

      // Fallback: try by profile name (best-effort).
      const byName = (opponentProfile?.name ?? "").trim();
      if (byName) {
        const res = await commands.getPlayers(dbPath, {
          options: { skipCount: true, page: 1, pageSize: 10, sort: "id", direction: "asc" },
          name: byName,
          range: null,
        } satisfies PlayerQuery);
        const data = unwrap(res).data ?? [];
        const exact =
          data.find((p) => (p.name ?? "").trim().toLowerCase() === byName.trim().toLowerCase()) ?? data[0] ?? null;
        if (exact) return exact.id;
      }

      // Last fallback: pick the first player row.
      const res = await commands.getPlayers(dbPath, {
        options: { skipCount: true, page: 1, pageSize: 1, sort: "id", direction: "asc" },
        name: null,
        range: null,
      } satisfies PlayerQuery);
      const data = unwrap(res).data ?? [];
      return data[0]?.id ?? null;
    },
    staleTime: 15_000,
  });

  // Derive "our elo" from the active profile's ratings for the selected time control bucket.
  const sessionsSignature = useMemo(() => buildSessionsSignature(sessions), [sessions]);
  const personalInfoQuery = useQuery({
    enabled: Boolean(profileId) && sessions.length > 0,
    queryKey: profileId ? getPersonalInfoQueryKey(profileId, sessionsSignature) : ["personalInfo", null],
    queryFn: async () => {
      if (!profileId) return [];
      return await fetchPersonalInfoForProfile({ effectiveProfileId: profileId, sessions });
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const personalSig = useMemo(() => computePersonalInfoSignature(personalInfoQuery.data), [personalInfoQuery.data]);
  const mergedInfoQuery = useQuery({
    enabled: Boolean(personalSig),
    queryKey: personalSig ? getMergedPlayerInfoQueryKey(personalSig) : ["mergedPlayerInfo", null],
    queryFn: async () => {
      if (!personalInfoQuery.data) return null;
      return await fetchMergedPlayerInfo(personalInfoQuery.data);
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const siteStatsData = mergedInfoQuery.data?.site_stats_data ?? [];
  const statsSig = useMemo(() => createSiteStatsSignature(siteStatsData), [siteStatsData]);
  const sidebarModelQuery = useQuery({
    enabled: statsSig.games > 0,
    queryKey: ["playerSidebarModel", statsSig.key],
    queryFn: async () => unwrap(await playerStatsCommands.calculatePlayerSidebarModel(siteStatsData)),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const derivedOurElo = useMemo(() => {
    const model = sidebarModelQuery.data ?? null;
    if (!model?.elo) return null;

    const baseSeconds = Number.parseInt(timeControl.split("+")[0] ?? "", 10);
    const speed =
      Number.isFinite(baseSeconds) && baseSeconds >= 0
        ? baseSeconds <= 180
          ? "bullet"
          : baseSeconds <= 600
            ? "blitz"
            : baseSeconds <= 1800
              ? "rapid"
              : "rapid"
        : "rapid";

    const values: number[] = [];
    for (const block of model.elo) {
      for (const row of block.rows ?? []) {
        const raw = (row as any)[speed] as string | undefined;
        const n = raw ? Number.parseInt(raw.replace(/\D/g, ""), 10) : NaN;
        if (Number.isFinite(n)) values.push(n);
      }
    }
    if (values.length === 0) return null;
    return Math.max(...values);
  }, [sidebarModelQuery.data, timeControl]);

  const effectiveOurElo = derivedOurElo ?? 1500;

  const buildRequest = (): { uciOptions: EngineOption[]; targetPlayerId: number } | null => {
    if (!profileId) {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: t("profiles.selectProfile", { defaultValue: "Select profile" }),
        color: "red",
      });
      return null;
    }
    if (!selectedEnginePath) {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: t("profiles.simulate.errors.noEngine", { defaultValue: "Select a local engine in Analysis first." }),
        color: "red",
      });
      return null;
    }
    if (!opponentProfileId) {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: t("profiles.simulate.errors.noOpponentProfile", { defaultValue: "Select an opponent profile." }),
        color: "red",
      });
      return null;
    }
    const pid = opponentPlayerIdQuery.data;
    if (pid == null || !Number.isFinite(pid)) {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: t("profiles.simulate.errors.noOpponentResolved", {
          defaultValue: "Could not resolve the opponent in that profile database.",
        }),
        color: "red",
      });
      return null;
    }

    // Use current engine settings (minus MultiPV; planner manages MultiPV itself).
    const uciOptions: EngineOption[] =
      selectedEngine?.type === "local"
        ? (selectedEngine.settings ?? [])
            .filter((s) => s?.name && s.name !== "MultiPV" && s.value != null)
            .map((s) => ({ name: s.name, value: String(s.value ?? "") }))
        : [];
    return { uciOptions, targetPlayerId: pid };
  };

  const onRun = async () => {
    const built = buildRequest();
    if (!built || !opponentProfileId || !selectedEnginePath) return;

    setRunning(true);
    setResult(null);
    try {
      const res = await commands.plannerBuildVariantBook({
        // Train the model using the opponent profile DB + analysis.
        profileId: opponentProfileId,
        enginePath: selectedEnginePath,
        uciOptions: built.uciOptions,
        ctx: {
          matchStartUtcMs: Date.now(),
          timeControl,
          ourElo: effectiveOurElo,
          targetPlayerId: built.targetPlayerId,
          ourColor,
          startFen,
        },
        // Note: specta types for usize map to bigint in TS. We pass numbers here;
        // tauri invoke serializes them fine and Rust receives them as integers.
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
      } as any);
      setResult(unwrap(res));
    } catch (e) {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: e instanceof Error ? e.message : String(e),
        color: "red",
      });
    } finally {
      setRunning(false);
    }
  };

  if (!profileId) {
    return (
      <Text size="sm" c="dimmed">
        {t("profiles.selectProfile", { defaultValue: "Select profile" })}
      </Text>
    );
  }

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="sm">
        <Text fw={700}>{t("profiles.tabs.simulate", { defaultValue: "Simulate" })}</Text>
        <Text size="sm" c="dimmed">
          {t("profiles.simulate.desc", {
            defaultValue:
              "Build a personalized plan against a specific opponent using your analyzed games and Stockfish.",
          })}
        </Text>

        <Divider />

        <TextInput
          label={t("profiles.simulate.engine", { defaultValue: "Engine" })}
          value={
            selectedEngine?.name ? `${selectedEngine.name} (${selectedEnginePath ?? ""})` : (selectedEnginePath ?? "")
          }
          placeholder={t("profiles.simulate.enginePlaceholder", {
            defaultValue: "Select a local engine in Analysis first.",
          })}
          readOnly
        />

        <Select
          label={t("profiles.simulate.opponent", { defaultValue: "Opponent" })}
          placeholder={t("profiles.simulate.opponentPlaceholder", { defaultValue: "Select a profile..." })}
          data={opponentProfileOptions}
          value={opponentProfileId}
          onChange={(v) => {
            setOpponentProfileId(v);
          }}
          searchable
          nothingFoundMessage={t("common.noRecordsFound", { defaultValue: "No records found" })}
          clearable
        />

        <Group grow>
          <SegmentedControl
            data={[
              { value: "white", label: t("chess.white", { defaultValue: "White" }) },
              { value: "black", label: t("chess.black", { defaultValue: "Black" }) },
            ]}
            value={ourColor}
            onChange={(v) => setOurColor(v as "white" | "black")}
          />
          <TextInput
            label={t("profiles.simulate.timeControl", { defaultValue: "Time control" })}
            value={timeControl}
            onChange={(e) => setTimeControl(e.currentTarget.value)}
          />
        </Group>

        <Group grow>
          <TextInput
            label={t("profiles.simulate.ourElo", { defaultValue: "Our Elo" })}
            value={derivedOurElo != null ? String(derivedOurElo) : ""}
            placeholder={t("profiles.simulate.ourEloPlaceholder", { defaultValue: "Not available" })}
            readOnly
          />
          <TextInput
            label={t("profiles.simulate.startFen", { defaultValue: "Start FEN" })}
            value={startFen}
            onChange={(e) => setStartFen(e.currentTarget.value)}
            placeholder="startpos"
          />
        </Group>

        <Accordion variant="contained">
          <Accordion.Item value="planner">
            <Accordion.Control>
              {t("profiles.simulate.plannerSettings", { defaultValue: "Planner settings" })}
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="sm">
                <Text size="sm" fw={600}>
                  {t("profiles.simulate.horizonPlies", { defaultValue: "Horizon (plies)" })}: {horizonPlies}
                </Text>
                <Slider min={4} max={24} step={1} value={horizonPlies} onChange={setHorizonPlies} />

                <Group grow>
                  <NumberInput
                    label={t("profiles.simulate.opponentTopK", { defaultValue: "Opponent top-K" })}
                    value={opponentTopK}
                    onChange={(v) => setOpponentTopK(Number(v) || 1)}
                    min={1}
                    max={12}
                  />
                  <NumberInput
                    label={t("profiles.simulate.maxNodes", { defaultValue: "Max nodes" })}
                    value={maxNodes}
                    onChange={(v) => setMaxNodes(Number(v) || 1)}
                    min={50}
                    max={10_000}
                  />
                </Group>

                <NumberInput
                  label={t("profiles.simulate.minBranchProb", { defaultValue: "Min branch probability" })}
                  value={minBranchProb}
                  onChange={(v) => setMinBranchProb(Number(v) || 0)}
                  min={0}
                  max={1}
                  step={0.001}
                  decimalScale={4}
                />
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>

          <Accordion.Item value="engine">
            <Accordion.Control>
              {t("profiles.simulate.engineSettings", { defaultValue: "Engine settings" })}
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="sm">
                <Group grow>
                  <NumberInput
                    label={t("profiles.simulate.ourMultiPv", { defaultValue: "Our MultiPV" })}
                    value={ourMultipv}
                    onChange={(v) => setOurMultipv(Number(v) || 1)}
                    min={1}
                    max={8}
                  />
                  <NumberInput
                    label={t("profiles.simulate.candidateDepth", { defaultValue: "Candidate depth" })}
                    value={candidateDepth}
                    onChange={(v) => setCandidateDepth(Number(v) || 1)}
                    min={1}
                    max={30}
                  />
                  <NumberInput
                    label={t("profiles.simulate.quickDepth", { defaultValue: "Quick eval depth" })}
                    value={quickDepth}
                    onChange={(v) => setQuickDepth(Number(v) || 1)}
                    min={1}
                    max={30}
                  />
                </Group>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>

          <Accordion.Item value="model">
            <Accordion.Control>
              {t("profiles.simulate.modelSettings", { defaultValue: "Model settings" })}
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="sm">
                <NumberInput
                  label={t("profiles.simulate.backoffK", { defaultValue: "Backoff K" })}
                  value={backoffK}
                  onChange={(v) => setBackoffK(Number(v) || 1)}
                  min={1}
                  max={500}
                />
                <NumberInput
                  label={t("profiles.simulate.smoothingAlpha", { defaultValue: "Smoothing α" })}
                  value={smoothingAlpha}
                  onChange={(v) => setSmoothingAlpha(Number(v) || 0)}
                  min={0}
                  max={10}
                  step={0.1}
                  decimalScale={2}
                />
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>

        <Group justify="flex-end">
          <Button onClick={onRun} loading={running} disabled={running}>
            {t("profiles.simulate.run", { defaultValue: "Build plan" })}
          </Button>
        </Group>

        {result && (
          <>
            <Divider />
            <Text size="sm" fw={600}>
              {t("profiles.simulate.result", { defaultValue: "Result" })}
            </Text>
            <Text size="sm" c="dimmed">
              {t("profiles.simulate.resultSummary", {
                defaultValue: "Nodes: {{nodes}}, Edges: {{edges}}",
                nodes: result.nodes?.length ?? 0,
                edges: result.edges?.length ?? 0,
              })}
            </Text>

            {bookView && (
              <>
                <Divider />
                <Stack gap="xs">
                  <Group justify="space-between" align="flex-end">
                    <Text size="sm" fw={600}>
                      {t("profiles.simulate.bestLine", { defaultValue: "Best line (copy)" })}
                    </Text>
                    <CopyButton value={(bookView.lines?.[0]?.sanLine ?? "").trim()} timeout={1200}>
                      {({ copied, copy }) => (
                        <Button size="xs" variant="light" onClick={copy} disabled={!bookView.lines?.[0]?.sanLine}>
                          {copied
                            ? t("common.copied", { defaultValue: "Copied" })
                            : t("common.copy", { defaultValue: "Copy" })}
                        </Button>
                      )}
                    </CopyButton>
                  </Group>
                  <Textarea
                    value={(bookView.lines?.[0]?.sanLine ?? "").trim()}
                    placeholder={t("profiles.simulate.bestLinePlaceholder", {
                      defaultValue: "Run simulate to generate a line.",
                    })}
                    autosize
                    minRows={2}
                    maxRows={6}
                    readOnly
                  />

                  <Text size="sm" fw={600}>
                    {t("profiles.simulate.topLines", { defaultValue: "Top lines" })}
                  </Text>
                  {(bookView.lines ?? []).slice(0, 10).map((l, idx) => (
                    <Text key={`${idx}-${l.sanLine}`} size="sm">
                      <Code>{l.sanLine || t("profiles.simulate.emptyLine", { defaultValue: "(empty)" })}</Code>{" "}
                      <Text span c="dimmed">
                        p={l.reachProb.toFixed(3)}
                        {l.ev != null ? ` · ev≈${Math.round(l.ev)}cp` : ""}
                      </Text>
                    </Text>
                  ))}
                </Stack>
              </>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
