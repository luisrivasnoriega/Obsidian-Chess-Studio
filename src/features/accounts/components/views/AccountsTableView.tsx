import {
  ActionIcon,
  Badge,
  Group,
  Image,
  Paper,
  ScrollArea,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconCheck,
  IconCircle,
  IconCircleCheck,
  IconDownload,
  IconEdit,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { remove } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseInfo } from "@/bindings";
import { commands } from "@/bindings";
import type { SortState } from "@/components/GenericHeader";
import { sessionsAtom } from "@/state/atoms";
import { downloadChessCom, getChessComAccount, getStats } from "@/utils/chess.com/api";
import { capitalize, parseDate } from "@/utils/format";
import { downloadLichess, getLichessAccount } from "@/utils/lichess/api";
import { getAccountFideId, saveMainAccount } from "@/utils/mainAccount";
import type { Session } from "@/utils/session";

import { getProfileDbPath, profileDbFilename } from "@/utils/profileDb";
import { getAccountSyncStateFromProfileDb } from "@/utils/profileGameSync";
import { unwrap } from "@/utils/unwrap";
import { getAccountPgnPath } from "@/utils/accountPgnPaths";
import { getAccountKey } from "@/utils/accountKeys";
import { rewritePgnAccountTags } from "@/utils/pgnAccountTags";
import LichessLogo from "../LichessLogo";

interface AccountsTableViewProps {
  databases: DatabaseInfo[];
  setDatabases: React.Dispatch<React.SetStateAction<DatabaseInfo[]>>;
  query?: string;
  sortBy?: SortState;
  isLoading?: boolean;
  platformFilter?: "all" | "lichess" | "chesscom";
  onOpenPlayerDatabases?: (playerName: string) => void;
}

type StatItem = { value: number; label: string; diff?: number };
type PlayerSessions = { name: string; sessions: Session[] };

type Row = {
  key: string | number;
  name: string;
  username: string;
  type: "lichess" | "chesscom";
  stats: StatItem[];
  totalGames: number;
  downloadedGames: number;
  percentage: number;
  updatedAt?: number;
  session: Session;
  database: DatabaseInfo | null;
};

function AccountsTableView({
  databases,
  setDatabases,
  query = "",
  sortBy = { field: "name", direction: "asc" },
  isLoading = false,
  platformFilter = "all",
  onOpenPlayerDatabases,
}: AccountsTableViewProps) {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionsAtom);
  const [, setSessions] = useAtom(sessionsAtom);

  const filteredSessions = useMemo(() => {
    if (platformFilter === "lichess") {
      return sessions.filter((s) => !!s.lichess);
    }
    if (platformFilter === "chesscom") {
      return sessions.filter((s) => !!s.chessCom);
    }
    return sessions;
  }, [platformFilter, sessions]);

  const [mainAccount, setMainAccount] = useState<string | null>(null);
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [downloadedCounts, setDownloadedCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const stored = localStorage.getItem("mainAccount");
    setMainAccount(stored);
  }, []);

  useEffect(() => {
    if (mainAccount) {
      localStorage.setItem("mainAccount", mainAccount);
      // Load FIDE ID for this account if it exists
      getAccountFideId(mainAccount)
        .then((fideId) => {
          // Also save to new JSON format with FIDE ID if it exists
          saveMainAccount({ name: mainAccount, fideId: fideId || undefined }).catch(() => {});
        })
        .catch(() => {
          // If no FIDE ID, just save the account name
          saveMainAccount({ name: mainAccount }).catch(() => {});
        });
    }
  }, [mainAccount]);

  // Memoize rating calculation function to avoid recreation on every render
  const bestRatingForSession = useCallback((s: Session): number => {
    if (s.lichess?.account?.perfs) {
      const p = s.lichess.account.perfs;
      const ratings = [p.bullet?.rating, p.blitz?.rating, p.rapid?.rating, p.classical?.rating].filter(
        (x): x is number => typeof x === "number",
      );
      if (ratings.length) return Math.max(...ratings);
    }
    if (s.chessCom?.stats) {
      const arr = getStats(s.chessCom.stats);
      if (arr.length) return Math.max(...arr.map((a) => a.value));
    }
    return -1;
  }, []);

  // Memoize player names extraction
  const playerNames = useMemo<string[]>(
    () =>
      Array.from(
        new Set(
          filteredSessions
            .map((s) => s.player ?? s.lichess?.username ?? s.chessCom?.username)
            .filter((n): n is string => typeof n === "string" && n.length > 0),
        ),
      ),
    [filteredSessions],
  );

  // Memoize player sessions grouping
  const playerSessions = useMemo<PlayerSessions[]>(
    () =>
      playerNames.map((name) => ({
        name,
        sessions: filteredSessions.filter(
          (s) => s.player === name || s.lichess?.username === name || s.chessCom?.username === name,
        ),
      })),
    [filteredSessions, playerNames],
  );

  const handleDownload = useCallback(
    async (row: Row) => {
      const profileId = row.session.profileId;
      if (!profileId) return;

      const profileDbPath = await getProfileDbPath(profileId);
      const accountKey = getAccountKey(row.type, row.username);
      const { lastGameDate, count } = await getAccountSyncStateFromProfileDb(profileDbPath, accountKey);

      const appDir = await appDataDir();
      const pgnPath = await getAccountPgnPath({
        appDataDir: appDir,
        profileId,
        platform: row.type,
        username: row.username,
      });
      const downloadId = `${row.type}_${profileId}_${row.username}`;

      if (row.type === "lichess") {
        const token = row.session.lichess?.accessToken;
        const gamesToDownload = Math.max(0, row.totalGames - count);
        await downloadLichess(row.username, lastGameDate, gamesToDownload, () => {}, token, pgnPath, downloadId);
      } else {
        await downloadChessCom(row.username, lastGameDate, pgnPath, downloadId);
      }

      await rewritePgnAccountTags(pgnPath, row.type, row.username);
      unwrap(
        await commands.convertPgn(pgnPath, profileDbPath, lastGameDate ? lastGameDate / 1000 : null, row.name, null),
      );
      try {
        const { count: nextCount } = await getAccountSyncStateFromProfileDb(profileDbPath, accountKey);
        setDownloadedCounts((prev) => ({
          ...prev,
          [`${profileId}:${accountKey}`]: nextCount,
        }));
      } catch {}

      // Refresh database list so counts are updated in the table.
      try {
        const { getDatabases } = await import("@/utils/db");
        setDatabases(await getDatabases());
      } catch {}
    },
    [setDatabases],
  );

  useEffect(() => {
    let cancelled = false;
    const loadCounts = async () => {
      const entries = await Promise.all(
        filteredSessions.map(async (session) => {
          const type = session.lichess ? "lichess" : "chesscom";
          const username = session.lichess?.username ?? session.chessCom?.username ?? "";
          const profileId = session.profileId;
          const key = `${profileId ?? "no-profile"}:${getAccountKey(type, username)}`;
          if (!profileId || !username) return [key, 0] as const;
          const profileDbPath = await getProfileDbPath(profileId);
          const { count } = await getAccountSyncStateFromProfileDb(
            profileDbPath,
            getAccountKey(type, username),
          );
          return [key, count] as const;
        }),
      );
      if (cancelled) return;
      setDownloadedCounts(Object.fromEntries(entries));
    };
    loadCounts().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filteredSessions, databases]);

  // Memoize filtered and sorted results
  const filteredAndSorted = useMemo<PlayerSessions[]>(() => {
    const q = query.trim().toLowerCase();
    return playerSessions
      .filter(({ name, sessions }) => {
        if (!q) return true;
        const usernames = sessions
          .map((s) => s.lichess?.username || s.chessCom?.username || "")
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return name.toLowerCase().includes(q) || usernames.includes(q);
      })
      .sort((a, b) => {
        let comparison = 0;
        if (sortBy.field === "name") {
          comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        } else if (sortBy.field === "elo") {
          const ra = a.sessions.map(bestRatingForSession).reduce((max, v) => (v > max ? v : max), -1);
          const rb = b.sessions.map(bestRatingForSession).reduce((max, v) => (v > max ? v : max), -1);
          comparison = ra - rb;
        }
        return sortBy.direction === "asc" ? comparison : -comparison;
      });
  }, [playerSessions, query, sortBy, bestRatingForSession]);

  const rows: Row[] = filteredAndSorted.flatMap(({ name, sessions: playerSessions }) =>
    playerSessions.map((session): Row => {
      const type = session.lichess ? "lichess" : "chesscom";
      const username = session.lichess?.username ?? session.chessCom?.username ?? "";
      const profileDb = session.profileId ? profileDbFilename(session.profileId) : null;
      let database = profileDb ? (databases.find((db) => db.filename === profileDb) ?? null) : null;
      if (!database && profileDb) {
        database = databases.find((db) => db.filename.toLowerCase() === profileDb.toLowerCase()) ?? null;
      }
      const accountKey = getAccountKey(type, username);
      const downloadKey = `${session.profileId ?? "no-profile"}:${accountKey}`;
      const downloadedGames = session.profileId
        ? downloadedCounts[downloadKey] ?? 0
        : database?.type === "success"
          ? database.game_count
          : 0;

      let totalGames = 0;
      const stats: StatItem[] = [];

      if (session.lichess?.account) {
        const account = session.lichess.account;
        totalGames = account.count?.all ?? 0;
        const speeds = ["bullet", "blitz", "rapid", "classical"] as const;
        if (account.perfs) {
          for (const speed of speeds) {
            const perf = account.perfs[speed];
            if (perf) {
              stats.push({
                value: perf.rating,
                label: speed,
                diff: perf.prog,
              });
            }
          }
        }
        // Ensure totalGames is at least equal to downloadedGames
        // This handles cases where account.count.all is outdated, incorrect, or unavailable
        // If we have downloaded games, the total should be at least equal to downloadedGames
        if (downloadedGames > 0) {
          totalGames = Math.max(totalGames, downloadedGames);
        }
      } else if (session.chessCom?.stats) {
        const chessComStats = Object.values(session.chessCom.stats ?? {}) as Array<{
          record?: { win: number; loss: number; draw: number };
        }>;
        for (const stat of chessComStats) {
          if (stat.record) {
            totalGames += stat.record.win + stat.record.loss + stat.record.draw;
          }
        }
        // For Chess.com, ensure totalGames is at least equal to downloadedGames
        // This prevents percentage > 100% when database has more games than reported in stats
        if (database && database.type === "success") {
          totalGames = Math.max(totalGames, downloadedGames, database.game_count ?? 0);
        } else if (totalGames === 0 && downloadedGames > 0) {
          // If no stats but we have downloaded games, use downloadedGames as minimum
          totalGames = downloadedGames;
        }
        stats.push(...getStats(session.chessCom.stats));
      } else if (downloadedGames > 0) {
        // If we have downloaded games but no account/stats info, use downloadedGames as total
        totalGames = downloadedGames;
      }

      // Calculate percentage: if totalGames is 0, return 0; otherwise calculate normally
      // Cap percentage at 100% to handle edge cases
      const percentage = totalGames === 0 ? 0 : Math.min(100, Math.max(0, (downloadedGames / totalGames) * 100));

      return {
        key: `${session.profileId ?? "no-profile"}:${type}:${session.lichess?.account.id ?? username}`,
        name,
        username,
        type: type as "lichess" | "chesscom",
        stats,
        totalGames,
        downloadedGames,
        percentage,
        updatedAt: session.updatedAt,
        session,
        database,
      };
    }),
  );

  async function handleReload(session: Session) {
    const profileId = session.profileId ?? null;
    if (session.lichess) {
      const account = await getLichessAccount({
        token: session.lichess.accessToken,
        username: session.lichess.username,
      });
      if (!account) return;
      const lichessUsername = session.lichess.username;
      const lichessAccessToken = session.lichess.accessToken;
      setSessions((sessions) =>
        sessions.map((s) =>
          (s.profileId ?? null) === profileId && s.lichess?.username === lichessUsername
            ? {
                ...s,
                lichess: {
                  account: account,
                  username: lichessUsername,
                  accessToken: lichessAccessToken,
                },
                updatedAt: Date.now(),
              }
            : s,
        ),
      );
    } else if (session.chessCom) {
      const stats = await getChessComAccount(session.chessCom.username);
      if (!stats) return;
      const chessComUsername = session.chessCom.username;
      setSessions((sessions) =>
        sessions.map((s) =>
          (s.profileId ?? null) === profileId && s.chessCom?.username === chessComUsername
            ? {
                ...s,
                chessCom: {
                  username: chessComUsername,
                  stats,
                },
                updatedAt: Date.now(),
              }
            : s,
        ),
      );
    }
  }

  async function handleRemove(session: Session) {
    const profileId = session.profileId ?? null;
    if (session.lichess) {
      const username = session.lichess.username;

      // Delete PGN file for this account (profile databases are shared)
      const dbDir = await appDataDir();
      const pgnPath = await getAccountPgnPath({
        appDataDir: dbDir,
        profileId,
        platform: "lichess",
        username,
      });
      const legacyPgnPath = await resolve(dbDir, "db", `${username}_lichess.pgn`);

      try {
        // Delete PGN file if it exists
        try {
          await remove(pgnPath);
        } catch {
          // PGN file might not exist, ignore
        }
        try {
          await remove(legacyPgnPath);
        } catch {}

        // Delete analyzed games for this account
        try {
          const { removeAnalyzedGamesForAccount } = await import("@/utils/analyzedGames");
          await removeAnalyzedGamesForAccount(username, "lichess");
        } catch {}
      } catch {}

      // Remove session
      setSessions((sessions) =>
        sessions.filter((s) => !((s.profileId ?? null) === profileId && s.lichess?.username === username)),
      );
    } else if (session.chessCom) {
      const username = session.chessCom.username;

      // Delete PGN file for this account (profile databases are shared)
      const dbDir = await appDataDir();
      const pgnPath = await getAccountPgnPath({
        appDataDir: dbDir,
        profileId,
        platform: "chesscom",
        username,
      });
      const legacyPgnPath = await resolve(dbDir, "db", `${username}_chesscom.pgn`);

      try {
        // Delete PGN file if it exists
        try {
          await remove(pgnPath);
        } catch {
          // PGN file might not exist, ignore
        }
        try {
          await remove(legacyPgnPath);
        } catch {}

        // Delete analyzed games for this account
        try {
          const { removeAnalyzedGamesForAccount } = await import("@/utils/analyzedGames");
          await removeAnalyzedGamesForAccount(username, "chesscom");
        } catch {}
      } catch {}

      // Remove session
      setSessions((sessions) =>
        sessions.filter((s) => !((s.profileId ?? null) === profileId && s.chessCom?.username === username)),
      );
    }
  }

  function handleSaveEdit(session: Session) {
    const profileId = session.profileId ?? null;
    const type = session.lichess ? "lichess" : "chesscom";
    const username = session.lichess?.username ?? session.chessCom?.username ?? "";
    setSessions((prev) =>
      prev.map((s) => {
        if ((s.profileId ?? null) !== profileId) return s;
        if (type === "lichess" && s.lichess?.username === username) {
          return { ...s, player: editValue };
        } else if (type === "chesscom" && s.chessCom?.username === username) {
          return { ...s, player: editValue };
        }
        return s;
      }),
    );
    setEditingAccount(null);
  }

  if (isLoading) {
    return (
      <Paper withBorder>
        <ScrollArea>
          <Stack gap="md">
            <Skeleton h="3rem" />
            <Skeleton h="3rem" />
            <Skeleton h="3rem" />
          </Stack>
        </ScrollArea>
      </Paper>
    );
  }

  return (
    <Paper withBorder>
      <ScrollArea>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Main</Table.Th>
              <Table.Th>Player</Table.Th>
              <Table.Th>Platform</Table.Th>
              <Table.Th>Username</Table.Th>
              <Table.Th>Ratings</Table.Th>
              <Table.Th>Games</Table.Th>
              <Table.Th>Downloaded</Table.Th>
              <Table.Th>Last Updated</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr
                key={row.key}
                onClick={() => onOpenPlayerDatabases?.(row.name)}
                style={{ cursor: onOpenPlayerDatabases ? "pointer" : "default" }}
              >
                <Table.Td>
                  <Tooltip
                    label={
                      mainAccount === row.name
                        ? t("accounts.accountCard.mainAccount")
                        : t("accounts.accountCard.setAsMainAccount")
                    }
                  >
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMainAccount(row.name);
                      }}
                      aria-label={
                        mainAccount === row.name
                          ? t("accounts.accountCard.mainAccount")
                          : t("accounts.accountCard.setAsMainAccount")
                      }
                    >
                      {mainAccount === row.name ? <IconCircleCheck /> : <IconCircle />}
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
                <Table.Td>
                  {editingAccount === `${row.type}_${row.session.profileId ?? "no-profile"}_${row.username}` ? (
                    <Group gap="xs">
                      <input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ padding: "0.25rem", fontSize: "0.875rem" }}
                      />
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="green"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSaveEdit(row.session);
                        }}
                      >
                        <IconCheck size="1rem" />
                      </ActionIcon>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingAccount(null);
                        }}
                      >
                        <IconX size="1rem" />
                      </ActionIcon>
                    </Group>
                  ) : (
                    <Group gap="xs">
                      <Text size="sm" fw={500}>
                        {row.name}
                      </Text>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingAccount(`${row.type}_${row.session.profileId ?? "no-profile"}_${row.username}`);
                          setEditValue(row.name);
                        }}
                      >
                        <IconEdit size="1rem" />
                      </ActionIcon>
                    </Group>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    {row.type === "lichess" ? (
                      <LichessLogo />
                    ) : (
                      <Image w="20px" h="20px" src="/chesscom.png" alt="chess.com" />
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{row.username}</Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    {row.stats.slice(0, 4).map((stat) => (
                      <Badge key={stat.label} size="sm" variant="light">
                        {capitalize(stat.label)}: {stat.value}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{row.totalGames}</Text>
                </Table.Td>
                <Table.Td>
                  <Stack gap="xs">
                    <Text size="sm">{row.downloadedGames}</Text>
                    <Text size="xs" c="dimmed">
                      {row.percentage.toFixed(1)}%
                    </Text>
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {t("formatters.dateFormat", {
                      date: parseDate(row.updatedAt),
                      interpolation: { escapeValue: false },
                    })}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Tooltip label={t("accounts.accountCard.updateStats")}>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleReload(row.session);
                        }}
                      >
                        <IconRefresh size="1rem" />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t("accounts.accountCard.downloadGames")}>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDownload(row);
                        }}
                      >
                        <IconDownload size="1rem" />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t("accounts.accountCard.removeAccount")}>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemove(row.session);
                        }}
                      >
                        <IconX size="1rem" />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Paper>
  );
}

export default AccountsTableView;
