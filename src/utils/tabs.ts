import { save } from "@tauri-apps/plugin-dialog";
import { INITIAL_FEN } from "chessops/fen";
import { z } from "zod";
import type { StoreApi } from "zustand";
import { commands } from "@/bindings";
import { createDefaultFileInfoMetadata, fileMetadataSchema } from "@/features/files/utils/file";
import type { TreeStoreState } from "@/state/store/tree";
import { getFileNameWithoutExtension, isTempImportFile } from "@/utils/files";
import { setTabState } from "@/utils/tabStateStorage";
import { unwrap } from "@/utils/unwrap";
import { getMoveText, getPGNFromReportView, parsePGN } from "./chess";
import { formatDateToPGN } from "./format";
import type { GameHeaders, TreeNode, TreeState } from "./treeReducer";

const dbGameMetadataSchema = z.object({
  type: z.literal("db"),
  db: z.string(),
  id: z.number(),
});
export type DbGameMetadata = z.infer<typeof dbGameMetadataSchema>;

const entitySourceMetadataSchema = z.union([fileMetadataSchema, dbGameMetadataSchema]);

export type EntitySourceMetadata = z.infer<typeof entitySourceMetadataSchema>;

export const analysisInitialConfigSchema = z.object({
  analysisTab: z.string().optional(),
  analysisSubTab: z.string().optional(),
  notationView: z.enum(["variations", "repertoire", "report"]).optional(),
});
export type AnalysisInitialConfig = z.infer<typeof analysisInitialConfigSchema>;

export const analysisNavigationContextSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("local"),
    localGameId: z.string(),
    profileId: z.string().nullish(),
  }),
  z.object({
    source: z.literal("chesscom"),
    gameKey: z.string(),
    accountUsername: z.string().nullish(),
    profileId: z.string().nullish(),
    profileDbGameId: z.string().nullish(),
  }),
  z.object({
    source: z.literal("lichess"),
    gameKey: z.string(),
    accountUsername: z.string().nullish(),
    profileId: z.string().nullish(),
    profileDbGameId: z.string().nullish(),
  }),
  z.object({
    source: z.literal("chessbase"),
    gameKey: z.string(),
    profileId: z.string().nullish(),
    profileDbGameId: z.string().nullish(),
  }),
]);
export type AnalysisNavigationContext = z.infer<typeof analysisNavigationContextSchema>;

const tabMetaSchema = z
  .object({
    timeControl: z
      .object({
        seconds: z.number(),
        increment: z.number(),
      })
      .optional(),
    initialConfig: analysisInitialConfigSchema.optional(),
    analysisContext: analysisNavigationContextSchema.optional(),
  })
  .optional();

export const tabSchema = z.object({
  name: z.string(),
  value: z.string(),
  type: z.enum(["new", "play", "analysis", "puzzles", "profiles", "database", "route"]),
  gameNumber: z.number().nullish(),
  source: entitySourceMetadataSchema.nullish(),
  route: z.string().optional(),
  meta: tabMetaSchema,
});

export type Tab = z.infer<typeof tabSchema>;

export function removeAnalysisInitialConfigField(tab: Tab, field: keyof AnalysisInitialConfig): Tab {
  const initialConfig = tab.meta?.initialConfig;
  if (!initialConfig || !(field in initialConfig)) return tab;

  const nextInitialConfig = { ...initialConfig };
  delete nextInitialConfig[field];

  const nextMeta = { ...(tab.meta ?? {}) };
  if (Object.keys(nextInitialConfig).length > 0) {
    nextMeta.initialConfig = nextInitialConfig;
  } else {
    delete nextMeta.initialConfig;
  }

  return {
    ...tab,
    meta: Object.keys(nextMeta).length > 0 ? nextMeta : undefined,
  };
}

export function setAnalysisContextProfileGameIds(
  tab: Tab,
  profileId: string | null,
  profileDbGameId: string | null,
): Tab {
  const analysisContext = tab.meta?.analysisContext;
  if (!analysisContext) return tab;

  const nextAnalysisContext =
    analysisContext.source === "local"
      ? {
          ...analysisContext,
          profileId,
        }
      : {
          ...analysisContext,
          profileId,
          profileDbGameId,
        };

  return {
    ...tab,
    meta: {
      ...(tab.meta ?? {}),
      analysisContext: nextAnalysisContext,
    },
  };
}

export function genID() {
  function S4() {
    return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
  }
  return S4() + S4();
}

export function getLegacyAnalysisInitialConfig(tabId: string): AnalysisInitialConfig | null {
  if (typeof window === "undefined" || !tabId) return null;
  try {
    const raw = sessionStorage.getItem(`${tabId}_initialConfig`);
    if (!raw) return null;
    const parsed = analysisInitialConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function getLegacyAnalysisNavigationContext(tabId: string): AnalysisNavigationContext | null {
  if (typeof window === "undefined" || !tabId) return null;
  try {
    const localGameId = sessionStorage.getItem(`${tabId}_localGameId`);
    if (localGameId) {
      return {
        source: "local",
        localGameId,
        profileId: sessionStorage.getItem(`${tabId}_profileId`),
      };
    }

    const chessComGameUrl = sessionStorage.getItem(`${tabId}_chessComGameUrl`);
    if (chessComGameUrl) {
      return {
        source: "chesscom",
        gameKey: chessComGameUrl,
        accountUsername: sessionStorage.getItem(`${tabId}_chessComUsername`),
        profileId: sessionStorage.getItem(`${tabId}_profileId`),
        profileDbGameId: sessionStorage.getItem(`${tabId}_profileDbGameId`),
      };
    }

    const lichessGameId = sessionStorage.getItem(`${tabId}_lichessGameId`);
    if (lichessGameId) {
      return {
        source: "lichess",
        gameKey: lichessGameId,
        accountUsername: sessionStorage.getItem(`${tabId}_lichessUsername`),
        profileId: sessionStorage.getItem(`${tabId}_profileId`),
        profileDbGameId: sessionStorage.getItem(`${tabId}_profileDbGameId`),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function createTab({
  tab,
  setTabs,
  setActiveTab,
  pgn,
  headers,
  srcInfo,
  gameNumber,
  position,
  initialAnalysisTab,
  initialAnalysisSubTab,
  initialNotationView,
  analysisContext,
  autoActivate = true,
}: {
  tab: Omit<Tab, "value">;
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  setActiveTab: React.Dispatch<React.SetStateAction<string | null>>;
  pgn?: string;
  headers?: GameHeaders;
  srcInfo?: EntitySourceMetadata;
  gameNumber?: number;
  position?: number[];
  initialAnalysisTab?: string;
  initialAnalysisSubTab?: string;
  initialNotationView?: "variations" | "repertoire" | "report";
  analysisContext?: AnalysisNavigationContext;
  autoActivate?: boolean;
}) {
  const id = genID();
  const explicitOrientation =
    headers?.orientation === "white" ? "white" : headers?.orientation === "black" ? "black" : undefined;

  if (pgn !== undefined) {
    const pgnFenMatch = pgn.match(/\[FEN\s+"([^"]+)"\]/i);
    const pgnFen = pgnFenMatch?.[1]?.trim();
    const hasSetupTag = /\[SetUp\s+"1"\]/i.test(pgn);
    const initialFenForParse =
      pgnFen && pgnFen.length > 0 ? pgnFen : hasSetupTag && headers?.fen ? headers.fen : undefined;

    const countMainlineMoves = (node: TreeNode): number => {
      let count = 0;
      let cur: TreeNode | undefined = node;
      while (cur && cur.children.length > 0) {
        cur = cur.children[0];
        count++;
      }
      return count;
    };

    // For variants files, parse as normal PGN (with variations) but display in variants view
    // Don't use isVariantsMode for parsing - that's only for special PGNs where all sequences are variations
    let tree = await parsePGN(pgn, initialFenForParse, false);
    const firstParseMoves = countMainlineMoves(tree.root);

    // Fallback for imported profile rows where PGN may omit SetUp/FEN tags but we still have
    // a known initial FEN in headers (from DB).
    if (firstParseMoves === 0 && headers?.fen && (!pgnFen || pgnFen.length === 0)) {
      const retryTree = await parsePGN(pgn, headers.fen, false);
      const retryMoves = countMainlineMoves(retryTree.root);
      if (retryMoves > firstParseMoves) {
        tree = retryTree;
      }
    }

    // If headers are provided, only merge them if the parsed PGN headers are incomplete
    // This preserves complete headers from saved PGNs (like game.pgn) while allowing
    // updates for PGNs that were reconstructed from moves
    if (headers) {
      const parsedHeaders = tree.headers;
      // Check if parsed headers are complete (not just default values)
      const hasCompleteHeaders =
        parsedHeaders.event &&
        parsedHeaders.event !== "?" &&
        parsedHeaders.site &&
        parsedHeaders.site !== "?" &&
        parsedHeaders.white &&
        parsedHeaders.white !== "?" &&
        parsedHeaders.black &&
        parsedHeaders.black !== "?";

      if (hasCompleteHeaders) {
        // PGN has complete headers, preserve them (especially FEN which is the initial position)
        // Only update fields that are explicitly provided and missing in parsed headers
        tree.headers = {
          ...parsedHeaders,
          // Preserve FEN from parsed headers (it's the initial FEN from PGN)
          fen: parsedHeaders.fen,
          // For dashboard/game-table opens, orientation is derived from active player's color.
          // Always honor explicitly provided orientation instead of parser defaults.
          orientation: explicitOrientation ?? parsedHeaders.orientation,
          // Only override if provided and missing in parsed headers
          time_control: parsedHeaders.time_control || headers.time_control,
          variant: parsedHeaders.variant || headers.variant,
        };
      } else {
        // PGN headers are incomplete, merge with provided headers
        // But always preserve FEN from parsed headers if it exists
        tree.headers = {
          ...parsedHeaders,
          ...headers,
          fen: parsedHeaders.fen || headers.fen,
          orientation: explicitOrientation ?? parsedHeaders.orientation,
        };
      }
      if (explicitOrientation) {
        tree.headers.orientation = explicitOrientation;
      }
    }

    // Apply requested board position regardless of header merge path.
    // This is required for deep-link navigation (e.g. coverage graph -> go to variant).
    if (position) {
      tree.position = [...position];
    }
    setTabState(id, JSON.stringify({ version: 0, state: tree }));
  }

  const initialConfig: AnalysisInitialConfig = {};
  if (initialAnalysisTab || initialAnalysisSubTab || initialNotationView) {
    if (initialAnalysisTab) {
      initialConfig.analysisTab = initialAnalysisTab;
    }
    if (initialAnalysisSubTab) {
      initialConfig.analysisSubTab = initialAnalysisSubTab;
    }
    if (initialNotationView) {
      initialConfig.notationView = initialNotationView;
    }
  }
  const hasInitialConfig = Object.keys(initialConfig).length > 0;
  const meta =
    tab.meta || hasInitialConfig || analysisContext
      ? {
          ...tab.meta,
          ...(hasInitialConfig ? { initialConfig } : {}),
          ...(analysisContext ? { analysisContext } : {}),
        }
      : undefined;

  setTabs((prev) => {
    if (prev.length === 0 || (prev.length === 1 && prev[0].type === "new" && tab.type !== "new")) {
      return [
        {
          ...tab,
          value: id,
          source: srcInfo,
          gameNumber,
          meta,
        },
      ];
    }
    return [
      ...prev,
      {
        ...tab,
        value: id,
        source: srcInfo,
        gameNumber,
        meta,
      },
    ];
  });
  if (autoActivate) {
    setActiveTab(id);
  }
  return id;
}

export async function saveToFile({
  dir,
  tab,
  setCurrentTab,
  store,
  setTabs,
  isVariantsFile = false,
}: {
  dir: string;
  tab: Tab | undefined;
  setCurrentTab: React.Dispatch<React.SetStateAction<Tab>>;
  store: StoreApi<TreeStoreState>;
  setTabs?: React.Dispatch<React.SetStateAction<Tab[]>>;
  isVariantsFile?: boolean;
}): Promise<boolean> {
  let filePath: string;
  if (tab?.source?.type === "file" && !isTempImportFile(tab?.source?.path)) {
    filePath = tab.source.path;
  } else {
    const userChoice = await save({
      defaultPath: `${dir}/analyze-game-${formatDateToPGN(new Date())}.pgn`,
      filters: [
        {
          name: "PGN",
          extensions: ["pgn"],
        },
      ],
    });
    if (userChoice === null) return false;
    filePath = userChoice;
    const fileName = await getFileNameWithoutExtension(filePath);
    const tempSourcePath = tab?.source?.type === "file" && isTempImportFile(tab.source.path) ? tab.source.path : null;

    // If this is a variants file, create the .info file with type "variants"
    if (isVariantsFile) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const infoPath = filePath.replace(".pgn", ".info");
      await writeTextFile(infoPath, JSON.stringify(createDefaultFileInfoMetadata("variants"), null, 2));
    }

    setCurrentTab((prev) => {
      return {
        ...prev,
        source: {
          ...(prev.source ?? {
            type: "file",
            numGames: 1,
            metadata: isVariantsFile
              ? createDefaultFileInfoMetadata("variants")
              : createDefaultFileInfoMetadata("game"),
          }),
          name: fileName,
          path: filePath,
          lastModified: Date.now(),
        },
      };
    });

    // If we are saving a temp import file, write the entire multi-game PGN to the chosen path
    // (replacing the current game with the latest store state).
    if (tempSourcePath) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const count = unwrap(await commands.countPgnGames(tempSourcePath));
      const games = unwrap(await commands.readGames(tempSourcePath, 0, Math.max(0, count - 1)));
      const gameIndex = tab?.gameNumber || 0;
      const updatedGame = `${getPGNFromReportView(store.getState().root, {
        headers: store.getState().headers,
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
      })}\n\n`;
      // Be defensive: if parsing yielded 0 games (or gameNumber is out of range),
      // ensure we still write a non-empty PGN file.
      if (games.length === 0) {
        games.push(updatedGame);
      } else if (gameIndex >= 0 && gameIndex < games.length) {
        games[gameIndex] = updatedGame;
      } else if (gameIndex === games.length) {
        // Append as a new game at the end (0-based indexing)
        games.push(updatedGame);
      } else {
        // Out-of-range: clamp to last game to avoid writing an empty file
        games[games.length - 1] = updatedGame;
      }

      const combined = games.join("");
      await writeTextFile(filePath, combined.trim().length > 0 ? combined : `${updatedGame}`);
      store.getState().save();
      return true;
    }
  }
  try {
    await commands.countPgnGames(filePath);
  } catch {
    // Ignore offset warm-up errors; writeGame will still attempt the write.
  }

  await commands.writeGame(
    filePath,
    tab?.gameNumber || 0,
    `${getPGNFromReportView(store.getState().root, {
      headers: store.getState().headers,
      comments: true,
      extraMarkups: true,
      glyphs: true,
      variations: true,
    })}\n\n`,
  );
  store.getState().save();

  // For variants files, update tab name (but not metadata - that's done in buildVariantsTree)
  const shouldUpdateTabName =
    isVariantsFile || (tab?.source?.type === "file" && tab.source.metadata?.type === "variants");

  if (shouldUpdateTabName && setTabs && tab?.value) {
    const fileName = await getFileNameWithoutExtension(filePath);
    const tabValue = tab.value;
    setTabs((prev) => prev.map((t) => (t.value === tabValue ? { ...t, name: fileName } : t)));
  }
  return true;
}

export async function saveTab(
  tab: Tab,
  store: StoreApi<TreeStoreState>,
  setTabs?: React.Dispatch<React.SetStateAction<Tab[]>>,
) {
  if (tab.source?.type === "file") {
    // Generate PGN from the report view structure (matches what's displayed in the report view)
    const pgn = `${getPGNFromReportView(store.getState().root, {
      headers: store.getState().headers,
      comments: true,
      extraMarkups: true,
      glyphs: true,
      variations: true,
    })}\n\n`;

    try {
      await commands.countPgnGames(tab.source.path);
    } catch {
      // Ignore offset warm-up errors; writeGame will still attempt the write.
    }

    await commands.writeGame(tab.source.path, tab?.gameNumber || 0, pgn);

    // For variants files, update tab name only
    // Metadata (opening, fen, depth, database, engine, etc.) is updated in buildVariantsTree
    if (tab.source.metadata?.type === "variants") {
      const fileName = tab.source.name;
      if (setTabs) {
        setTabs((prev) => prev.map((t) => (t.value === tab.value ? { ...t, name: fileName } : t)));
      }
    }
  } else if (tab.source?.type === "db") {
    const headers = store.getState().headers;
    // Generate PGN from the report view structure (matches what's displayed in the report view)
    const moves = `${getPGNFromReportView(store.getState().root, {
      headers: headers,
      comments: true,
      extraMarkups: true,
      glyphs: true,
      variations: true,
    })}\n\n`;

    await commands.updateGame(tab.source.db, tab.source.id, {
      ...headers,
      moves,
    });
  }
}

// Helper function to generate PGN for a single variation (without headers)
function _getVariationPGN(
  node: TreeNode,
  {
    comments,
    extraMarkups,
    glyphs,
    variations,
    isFirst = false,
  }: {
    comments: boolean;
    extraMarkups: boolean;
    glyphs: boolean;
    variations: boolean;
    isFirst?: boolean;
  },
): string {
  let pgn = "";

  // Get the move text for this node (getMoveText handles move numbers and formatting)
  if (node.san) {
    pgn += getMoveText(node, {
      glyphs,
      comments,
      extraMarkups,
      isFirst,
    });
  }

  // Continue with the main line (first child)
  if (node.children.length > 0) {
    pgn += _getVariationPGN(node.children[0], {
      comments,
      extraMarkups,
      glyphs,
      variations,
      isFirst: false,
    });
  }

  // Add sub-variations
  if (variations && node.children.length > 1) {
    for (let i = 1; i < node.children.length; i++) {
      const subVariation = node.children[i];
      const subVariationPGN = _getVariationPGN(subVariation, {
        comments,
        extraMarkups,
        glyphs,
        variations,
        isFirst: true,
      });
      pgn += ` (${subVariationPGN})`;
    }
  }

  return pgn.trim();
}

// Helper function to generate PGN headers text
function _getPgnHeadersText(headers: GameHeaders): string {
  let text = `[Event "${headers.event || "?"}"]\n`;
  text += `[Site "${headers.site || "?"}"]\n`;
  text += `[Date "${headers.date || "????.??.??"}"]\n`;
  text += `[Round "${headers.round || "?"}"]\n`;
  text += `[White "${headers.white || "?"}"]\n`;
  text += `[Black "${headers.black || "?"}"]\n`;
  text += `[Result "${headers.result || "*"}"]\n`;

  if (headers.white_elo) {
    text += `[WhiteElo "${headers.white_elo}"]\n`;
  }
  if (headers.black_elo) {
    text += `[BlackElo "${headers.black_elo}"]\n`;
  }
  if (headers.start && headers.start.length > 0) {
    text += `[Start "${JSON.stringify(headers.start)}"]\n`;
  }
  if (headers.orientation) {
    text += `[Orientation "${headers.orientation}"]\n`;
  }
  if (headers.time_control) {
    text += `[TimeControl "${headers.time_control}"]\n`;
  }
  if (headers.white_time_control) {
    text += `[WhiteTimeControl "${headers.white_time_control}"]\n`;
  }
  if (headers.black_time_control) {
    text += `[BlackTimeControl "${headers.black_time_control}"]\n`;
  }
  if (headers.eco) {
    text += `[ECO "${headers.eco}"]\n`;
  }
  if (headers.variant) {
    text += `[Variant "${headers.variant}"]\n`;
  }
  if (headers.fen && headers.fen !== INITIAL_FEN) {
    text += `[SetUp "1"]\n`;
    text += `[FEN "${headers.fen}"]\n`;
  }

  return text;
}

export async function reloadTab(tab: Tab): Promise<TreeState | undefined> {
  let tree: TreeState | undefined;

  if (tab.source?.type === "file") {
    const game = unwrap(await commands.readGames(tab.source.path, 0, 0))[0];

    // For variants files, parse as normal PGN (with variations) but display in variants view
    // Don't use isVariantsMode for parsing - that's only for special PGNs where all sequences are variations
    tree = await parsePGN(game, undefined, false);
  } else if (tab.source?.type === "db") {
    const game = unwrap(await commands.getGame(tab.source.db, tab.source.id));

    tree = await parsePGN(game.moves);
    tree.headers = game;
  }

  if (tree != null) {
    setTabState(tab.value, JSON.stringify({ version: 0, state: tree }));
    return tree;
  }
}
