import { Paper, Progress, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerGameInfo, SiteStatsData } from "@/bindings";
import { commands, events } from "@/bindings";
import { sessionsAtom } from "@/state/atoms";
import { getAccountKey } from "@/utils/accountKeys";
import { query_players } from "@/utils/db";
import { getProfileDbPath } from "@/utils/profileDb";
import type { Session } from "@/utils/session";
import { unwrap } from "@/utils/unwrap";
import PersonalPlayerCard from "./PersonalCard";

interface PersonalInfo {
  session: Session;
  info: PlayerGameInfo;
}

function Databases({
  initialPlayer,
  profileId,
  visibleTabs,
  showPlayerSelector = true,
}: {
  initialPlayer?: string;
  profileId?: string;
  visibleTabs?: Array<"overview" | "ratings" | "openings">;
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

  const {
    data: personalInfo,
    isLoading,
    error,
  } = useQuery<PersonalInfo[]>({
    queryKey: ["personalInfo", profileId ?? name, sessions],
    queryFn: async () => {
      const effectiveProfileId = profileId ?? profilesByName.get(name) ?? null;
      if (!effectiveProfileId) return [];
      const dbPath = await getProfileDbPath(effectiveProfileId);

      const playerSessions = sessions.filter(
        (s) => s.profileId === effectiveProfileId && (s.lichess?.username || s.chessCom?.username),
      );

      const results = await Promise.allSettled(
        playerSessions.map(async (session) => {
          const accountKey = session.lichess
            ? getAccountKey("lichess", session.lichess.username)
            : session.chessCom
              ? getAccountKey("chesscom", session.chessCom.username)
              : null;
          if (!accountKey) throw new Error("Session does not have an account key");

          const players = await query_players(dbPath, {
            name: accountKey,
            options: {
              pageSize: 200,
              direction: "asc",
              sort: "id",
              skipCount: false,
            },
          });
          const normalizedAccountKey = accountKey.trim().toLowerCase();
          const player =
            players.data.find((p) => (p.name ?? "").trim().toLowerCase() === normalizedAccountKey) ?? players.data[0];
          if (!player) throw new Error("Player not found in database");

          const info = unwrap(await commands.getPlayersGameInfo(dbPath, player.id));
          return { session, info };
        }),
      );
      return results
        .filter((r) => r.status === "fulfilled")
        .map((r) => (r as PromiseFulfilledResult<PersonalInfo>).value);
    },
    staleTime: 0,
    refetchOnMount: true,
    enabled: (profileId != null || !!name) && sessions.length > 0,
  });

  const mergedInfo = useMemo<PlayerGameInfo | null>(() => {
    if (!personalInfo || personalInfo.length === 0) return null;

    const mergedSiteStatsData: SiteStatsData[] = [];
    const byKey = new Map<string, SiteStatsData>();

    for (const entry of personalInfo.flatMap((i) => i.info.site_stats_data)) {
      const key = `${entry.site}:${entry.player}`;
      const existing = byKey.get(key);
      if (!existing) {
        const next: SiteStatsData = { site: entry.site, player: entry.player, data: [...entry.data] };
        byKey.set(key, next);
        mergedSiteStatsData.push(next);
        continue;
      }
      existing.data.push(...entry.data);
    }

    return { site_stats_data: mergedSiteStatsData };
  }, [personalInfo]);

  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const unlisten = events.databaseProgress.listen((e) => {
      setProgress(e.payload.progress);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <>
      {isLoading && progress > 0 && progress < 100 && (
        <Stack align="center" justify="center" h="80%">
          <Text ta="center" fw="bold" my="auto" fz="lg">
            {t("accounts.processingGames")}
          </Text>

          <Progress value={progress} />
        </Stack>
      )}
      {error && (
        <Text ta="center">
          {t("accounts.databaseLoadError")} {error.message}
        </Text>
      )}
      {personalInfo &&
        (personalInfo.length === 0 ? (
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
        ) : (
          <PersonalPlayerCard
            name={name}
            setName={setName}
            info={{
              site_stats_data: mergedInfo?.site_stats_data ?? [],
            }}
            visibleTabs={visibleTabs}
            showPlayerSelector={showPlayerSelector}
          />
        ))}
    </>
  );
}

export default Databases;
