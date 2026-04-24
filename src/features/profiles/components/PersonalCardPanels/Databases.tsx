import { Paper, Progress, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerGameInfo } from "@/bindings";
import { events } from "@/bindings";
import { playerStatsCommands } from "@/bindings/playerStats";
import { sessionsAtom } from "@/state/atoms";
import { getAccountKey } from "@/utils/accountKeys";
import type { Session } from "@/utils/session";
import { unwrap } from "@/utils/unwrap";
import PersonalPlayerCard from "../PersonalCard";
import { PanelLoadingState } from "./PanelLoadingState";

interface PersonalInfo {
  session: Session;
  info: PlayerGameInfo | null;
}

export function buildSessionsSignature(sessions: Session[]): string {
  return sessions
    .map((s) => `${s.profileId ?? ""}:${s.lichess?.username ?? ""}:${s.chessCom?.username ?? ""}`)
    .sort()
    .join("|");
}

export function getPersonalInfoQueryKey(profileIdOrName: string, sessionsSignature: string) {
  return ["personalInfo", profileIdOrName, sessionsSignature] as const;
}

export async function fetchPersonalInfoForProfile(input: {
  effectiveProfileId: string;
  sessions: Session[];
}): Promise<PersonalInfo[]> {
  const playerSessions = input.sessions.filter(
    (s) => s.profileId === input.effectiveProfileId && (s.lichess?.username || s.chessCom?.username),
  );

  const accountKeys = Array.from(
    new Set(
      playerSessions.flatMap((session) => {
        const accountKey = session.lichess
          ? getAccountKey("lichess", session.lichess.username)
          : session.chessCom
            ? getAccountKey("chesscom", session.chessCom.username)
            : null;
        return accountKey ? [accountKey] : [];
      }),
    ),
  );

  if (accountKeys.length === 0) return [];

  const info = await invoke<PlayerGameInfo>("get_profile_accounts_game_info", {
    profileId: input.effectiveProfileId,
    accountKeys,
  });

  return [
    {
      session: playerSessions[0]!,
      info,
    },
  ];
}

export function computePersonalInfoSignature(personalInfo: PersonalInfo[] | undefined | null): string | null {
  if (!personalInfo || personalInfo.length === 0) return null;
  const totalSites = personalInfo.reduce((acc, p) => acc + (p.info?.site_stats_data?.length ?? 0), 0);
  const totalGames = personalInfo.reduce(
    (acc, p) => acc + (p.info?.site_stats_data ?? []).reduce((sum, s) => sum + (s.data?.length ?? 0), 0),
    0,
  );
  return `${totalSites}:${totalGames}`;
}

export function getMergedPlayerInfoQueryKey(personalInfoSignature: string) {
  return ["mergedPlayerInfo", personalInfoSignature] as const;
}

export async function fetchMergedPlayerInfo(personalInfo: PersonalInfo[]): Promise<PlayerGameInfo | null> {
  if (personalInfo.length === 0) return null;
  if (personalInfo.length === 1) return personalInfo[0]?.info ?? null;
  const allSiteStats = personalInfo.flatMap((i) => i.info?.site_stats_data ?? []);
  const merged = unwrap(await playerStatsCommands.mergePlayerSiteStats(allSiteStats));
  return { site_stats_data: merged };
}

function Databases({
  initialPlayer,
  profileId,
  visibleTabs,
  showPlayerSelector = true,
}: {
  initialPlayer?: string;
  profileId?: string;
  visibleTabs?: Array<"overview" | "ratings" | "openings" | "stats">;
  showPlayerSelector?: boolean;
}) {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionsAtom);

  const profilesByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      const playerName = s.player || s.lichess?.username || s.chessCom?.username || "";
      if (!playerName) continue;
      if (!s.profileId) continue;
      if (!map.has(playerName)) map.set(playerName, s.profileId);
    }
    return map;
  }, [sessions]);

  const players = Array.from(
    new Set(sessions.map((s) => s.player || s.lichess?.username || s.chessCom?.username || "")),
  ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const [name, setName] = useState("");
  useEffect(() => {
    if (sessions.length === 0) return;
    const fallback = sessions[0].player || sessions[0].lichess?.username || sessions[0].chessCom?.username || "";
    const next = initialPlayer && players.includes(initialPlayer) ? initialPlayer : fallback;
    setName(next);
  }, [initialPlayer, players, sessions]);

  // Create stable session signature to avoid unnecessary re-renders
  const sessionSignature = useMemo(() => {
    return buildSessionsSignature(sessions);
  }, [sessions]);

  const {
    data: personalInfo,
    isLoading,
    isFetching,
    error,
  } = useQuery<PersonalInfo[]>({
    queryKey: getPersonalInfoQueryKey(profileId ?? name, sessionSignature),
    queryFn: async () => {
      const effectiveProfileId = profileId ?? profilesByName.get(name) ?? null;
      if (!effectiveProfileId) return [];

      return fetchPersonalInfoForProfile({ effectiveProfileId, sessions });
    },
    // We want tab switches to be instant. We explicitly invalidate these queries
    // when sync imports new games.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: (profileId != null || !!name) && sessions.length > 0,
  });

  // Create stable signature for merged info to avoid unnecessary re-computations
  const personalInfoSignature = useMemo(() => {
    return computePersonalInfoSignature(personalInfo);
  }, [personalInfo]);

  const { data: mergedInfo } = useQuery<PlayerGameInfo | null>({
    queryKey: personalInfoSignature ? getMergedPlayerInfoQueryKey(personalInfoSignature) : ["mergedPlayerInfo", null],
    queryFn: async () => {
      if (!personalInfo || personalInfo.length === 0) return null;
      return fetchMergedPlayerInfo(personalInfo);
    },
    enabled: !!personalInfo && personalInfo.length > 0 && personalInfoSignature !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const unlisten = events.databaseProgress.listen((e) => {
      setProgress(e.payload.progress);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const _hasPanelData = !!mergedInfo;
  const showInitialPlayerShell = !!personalInfo && personalInfo.length > 0;
  const effectiveProfileId = profileId ?? profilesByName.get(name) ?? undefined;

  // Only show blocking loader if we don't have personalInfo yet
  // Once we have personalInfo, PersonalPlayerCard will handle its own loading states
  const shouldShowBlockingLoader = (isLoading || isFetching) && !showInitialPlayerShell && progress === 0;

  return (
    <>
      {isLoading && progress > 0 && progress < 100 && (
        <Stack align="center" justify="center" h="80%">
          <Text ta="center" fw="bold" my="auto" fz="lg">
            {t("common.loadingGames", { defaultValue: "Loading games..." })}
          </Text>

          <Progress value={progress} />
        </Stack>
      )}
      {error && (
        <Text ta="center">
          {t("accounts.databaseLoadError")} {error.message}
        </Text>
      )}
      {shouldShowBlockingLoader ? (
        <PanelLoadingState isLoading={isLoading} isFetching={isFetching} hasData={false} />
      ) : personalInfo && personalInfo.length === 0 ? (
        <Paper
          h="100%"
          shadow="sm"
          p="md"
          withBorder
          style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
        >
          <Stack>
            <Text ta="center" fw="bold" my="auto" fz="lg">
              No databases found
            </Text>
          </Stack>
        </Paper>
      ) : showInitialPlayerShell ? (
        <PersonalPlayerCard
          name={name}
          setName={setName}
          info={{
            site_stats_data: mergedInfo?.site_stats_data ?? [],
          }}
          visibleTabs={visibleTabs}
          showPlayerSelector={showPlayerSelector}
          profileId={effectiveProfileId}
          // Keep the sidebar + layout visible immediately; panels will show their own loaders.
          isLoading={isLoading || isFetching || !mergedInfo}
        />
      ) : null}
    </>
  );
}

export default Databases;
