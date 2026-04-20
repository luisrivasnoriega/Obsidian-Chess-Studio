import type { Piece } from "@lichess-org/chessground/types";
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Center,
  Checkbox,
  Divider,
  Group,
  InputWrapper,
  Paper,
  Portal,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertCircle,
  IconArrowsExchange,
  IconCheck,
  IconCpu,
  IconPlus,
  IconPuzzle,
  IconUser,
  IconZoomCheck,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { save } from "@tauri-apps/plugin-dialog";
import { INITIAL_FEN } from "chessops/fen";
import { makeSan } from "chessops/san";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { commands, type GoMode, type Outcome } from "@/bindings";
import GameInfo from "@/components/GameInfo";
import MoveControls from "@/components/MoveControls";
import EngineSettingsForm from "@/components/panels/analysis/EngineSettingsForm";
import TimeInput from "@/components/TimeInput";
import { TreeStateContext } from "@/components/TreeStateContext";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  activeProfileIdAtom,
  activeTabAtom,
  currentGameStateAtom,
  currentPlayersAtom,
  type GameState,
  loadableEnginesAtom,
  profilesAtom,
  tabsAtom,
} from "@/state/atoms";
import { getMainLine, getMoveText, getPGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import type { TimeControlField } from "@/utils/clock";
import { getDocumentDir } from "@/utils/documentDir";
import type { LocalEngine } from "@/utils/engines";
import { createFile } from "@/utils/files";
import { formatDateToPGN } from "@/utils/format";
import { type GameRecord, saveGameRecord } from "@/utils/gameRecords";
import { getTabState as getTabStateRaw } from "@/utils/tabStateStorage";
import { createTab } from "@/utils/tabs";
import { type GameHeaders, type TreeNode, treeIteratorMainLine } from "@/utils/treeReducer";
import GameNotationWrapper from "./GameNotationWrapper";
import { useGameTime } from "./GameTimeContext";
import ResponsiveBoard from "./ResponsiveBoard";

// BoardGame is a generic game board component used for:
// - Playing games (human vs human, or via PlayVsEngineBoard wrapper for engine games)
// - Analysis mode (via BoardAnalysis component)
// - Variants and puzzles
// Engine-specific logic is handled by PlayVsEngineBoard, not here

const DEFAULT_TIME_CONTROL: TimeControlField = {
  seconds: 180_000,
  increment: 2_000,
};

const CLOCK_UPDATE_INTERVAL = 100; // ms

type ColorChoice = "white" | "random" | "black";

interface EnginesSelectProps {
  engine: LocalEngine | null;
  setEngine: (engine: LocalEngine | null) => void;
  engines: LocalEngine[];
  enginesState: string;
}

function EnginesSelect({ engine, setEngine, engines = [], enginesState }: EnginesSelectProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const engineOptions = useMemo(
    () => engines?.map((engine) => ({ label: engine.name, value: engine.path })),
    [engines],
  );

  const handleEngineChange = useCallback(
    (path: string | null) => {
      setEngine(engines?.find((engine) => engine.path === path) ?? null);
    },
    [engines, setEngine],
  );

  useEffect(() => {
    if (engines.length > 0 && engine === null) {
      setEngine(engines[0]);
    }
  }, [engine, engines, setEngine]);

  if (enginesState !== "loading" && engines.length === 0) {
    return (
      <Stack gap="md">
        <Alert icon={<IconAlertCircle size={16} />} title={t("game.noEnginesAvailable")} color="orange" variant="light">
          <Text size="sm">{t("game.noEnginesAvailableDesc")}</Text>
        </Alert>
        <Button variant="outline" size="sm" onClick={() => navigate({ to: "/engines" })}>
          {t("game.installEngine")}
        </Button>
      </Stack>
    );
  }

  return (
    <Suspense>
      <Select
        allowDeselect={false}
        data={engineOptions}
        value={engine?.path ?? ""}
        onChange={handleEngineChange}
        placeholder={t("game.selectEngine")}
      />
    </Suspense>
  );
}

export type OpponentSettings =
  | {
      type: "human";
      timeControl?: TimeControlField;
      /** Profile id for the human player (Play vs PC saves games to this profile's DB). */
      profileId?: string | null;
    }
  | {
      type: "engine";
      timeControl?: TimeControlField;
      engine: LocalEngine | null;
      go: GoMode;
      engineProfile?: "default" | "strategicHuman";
      /** When engine is Lc0, path to selected neural network (.pb.gz) for UCI WeightsFile. */
      lc0NetworkPath?: string;
      /** When engine is Lc0, search limit in nodes (default 1). */
      lc0Nodes?: number;
    };

function isLc0Engine(engine: LocalEngine): boolean {
  return engine.name.startsWith("Leela Chess Zero");
}

interface Lc0NetworkSelectProps {
  opponent: Extract<OpponentSettings, { type: "engine" }>;
  setOpponent: Dispatch<SetStateAction<OpponentSettings>>;
}

function Lc0NetworkSelect({ opponent, setOpponent }: Lc0NetworkSelectProps) {
  const { t } = useTranslation();
  const { data: lc0Networks = [], isLoading } = useQuery({
    queryKey: ["lc0-networks"],
    queryFn: async () => {
      const r = await commands.listLc0Networks();
      if (r.status === "error") throw new Error(r.error);
      return r.data;
    },
  });

  useEffect(() => {
    if (opponent.type === "engine" && lc0Networks.length > 0 && !opponent.lc0NetworkPath) {
      setOpponent((prev) =>
        prev.type === "engine"
          ? {
              ...prev,
              lc0NetworkPath: lc0Networks[0].path,
              timeControl: undefined,
              go: { t: "Nodes" as const, c: 1 },
              lc0Nodes: 1,
            }
          : prev,
      );
    }
  }, [opponent.type, opponent.lc0NetworkPath, lc0Networks, setOpponent]);

  const networkOptions = useMemo(() => {
    if (lc0Networks.length === 0) return [];
    const defaultLabel = t("game.lc0NetworkDefault");
    const first = lc0Networks[0];
    return [
      { value: first.path, label: `${defaultLabel} (${first.display_name})` },
      ...lc0Networks.slice(1).map((n) => ({ value: n.path, label: n.display_name })),
    ];
  }, [lc0Networks, t]);

  const value = opponent.type === "engine" ? (opponent.lc0NetworkPath ?? lc0Networks[0]?.path ?? "") : "";

  if (isLoading || lc0Networks.length === 0) return null;

  return (
    <Select
      label={t("game.lc0Network")}
      allowDeselect={false}
      data={networkOptions}
      value={value}
      onChange={(path) =>
        setOpponent((prev) => (prev.type === "engine" ? { ...prev, lc0NetworkPath: path ?? undefined } : prev))
      }
      placeholder={t("game.lc0Network")}
    />
  );
}

interface OpponentFormProps {
  sameTimeControl: boolean;
  opponent: OpponentSettings;
  setOpponent: Dispatch<SetStateAction<OpponentSettings>>;
  setOtherOpponent: Dispatch<SetStateAction<OpponentSettings>>;
  engines: LocalEngine[];
  enginesState: string;
  profiles: { id: string; name: string }[];
  activeProfileId: string | null;
}

function OpponentForm({
  sameTimeControl,
  opponent,
  setOpponent,
  setOtherOpponent,
  engines = [],
  enginesState,
  profiles,
  activeProfileId,
}: OpponentFormProps) {
  const { t } = useTranslation();

  const updateType = useCallback(
    (type: "engine" | "human") => {
      if (type === "human") {
        setOpponent((prev) => ({
          ...prev,
          type: "human",
          profileId: activeProfileId ?? undefined,
        }));
      } else {
        setOpponent((prev) => ({
          ...prev,
          type: "engine",
          engine: null,
          engineProfile: "default",
          go: { t: "Depth", c: 1 },
        }));
      }
    },
    [activeProfileId, setOpponent],
  );

  const opponentProfileId = opponent.type === "human" ? opponent.profileId : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: use opponentProfileId (not opponent.profileId) for type safety; profileId only exists when type is "human"
  useEffect(() => {
    if (opponent.type !== "human") return;
    if (opponent.profileId != null) return;
    if (profiles.length === 0 || !activeProfileId) return;
    setOpponent((prev) => (prev.type === "human" ? { ...prev, profileId: activeProfileId } : prev));
  }, [opponent.type, activeProfileId, profiles.length, setOpponent, opponentProfileId]);

  const updateTimeControl = useCallback(
    (timeControl: TimeControlField | undefined) => {
      setOpponent((prev) => ({ ...prev, timeControl }));
      if (sameTimeControl) {
        setOtherOpponent((prev) => ({ ...prev, timeControl }));
      }
    },
    [sameTimeControl, setOpponent, setOtherOpponent],
  );

  const handleTimeControlToggle = useCallback(
    (v: string) => {
      updateTimeControl(v === "time" ? DEFAULT_TIME_CONTROL : undefined);
    },
    [updateTimeControl],
  );

  const handleTimeChange = useCallback(
    (value: GoMode) => {
      const seconds = value.t === "Time" ? value.c : 0;
      setOpponent((prev) => ({
        ...prev,
        timeControl: {
          seconds,
          increment: prev.timeControl?.increment ?? 0,
        },
      }));
      if (sameTimeControl) {
        setOtherOpponent((prev) => ({
          ...prev,
          timeControl: {
            seconds,
            increment: prev.timeControl?.increment ?? 0,
          },
        }));
      }
    },
    [sameTimeControl, setOpponent, setOtherOpponent],
  );

  const handleIncrementChange = useCallback(
    (value: GoMode) => {
      const increment = value.t === "Time" ? value.c : 0;
      setOpponent((prev) => ({
        ...prev,
        timeControl: {
          seconds: prev.timeControl?.seconds ?? 0,
          increment,
        },
      }));
      if (sameTimeControl) {
        setOtherOpponent((prev) => ({
          ...prev,
          timeControl: {
            seconds: prev.timeControl?.seconds ?? 0,
            increment,
          },
        }));
      }
    },
    [sameTimeControl, setOpponent, setOtherOpponent],
  );

  return (
    <Stack flex={1}>
      <SegmentedControl
        data={[
          {
            value: "human",
            label: (
              <Center style={{ gap: 10 }}>
                <IconUser size={16} />
                <span>{t("board.human")}</span>
              </Center>
            ),
          },
          {
            value: "engine",
            label: (
              <Center style={{ gap: 10 }}>
                <IconCpu size={16} />
                <span>{t("common.engine")}</span>
                {enginesState !== "loading" && engines.length === 0 && (
                  <ThemeIcon size="xs" color="orange" variant="light">
                    <IconAlertCircle size={10} />
                  </ThemeIcon>
                )}
              </Center>
            ),
          },
        ]}
        value={opponent.type}
        onChange={(v) => updateType(v as "human" | "engine")}
      />

      {opponent.type === "human" && (
        <Select
          label={t("game.selectProfile")}
          placeholder={t("game.selectProfilePlaceholder")}
          data={profiles.map((p) => ({ value: p.id, label: p.name }))}
          value={opponent.profileId ?? null}
          onChange={(v) =>
            setOpponent((prev) => (prev.type === "human" ? { ...prev, profileId: v ?? undefined } : prev))
          }
          allowDeselect={false}
        />
      )}

      {opponent.type === "engine" && (
        <>
          <EnginesSelect
            engine={opponent.engine}
            setEngine={(engine) =>
              setOpponent((prev) => {
                if (prev.type !== "engine") return prev;
                return {
                  ...prev,
                  ...(engine?.go ? { go: engine.go } : {}),
                  engine,
                  engineProfile: prev.engineProfile ?? "default",
                  lc0NetworkPath: engine && isLc0Engine(engine) ? prev.lc0NetworkPath : undefined,
                  lc0Nodes: engine && isLc0Engine(engine) ? (prev.lc0Nodes ?? 1) : undefined,
                };
              })
            }
            engines={engines}
            enginesState={enginesState}
          />
          <Select
            label={t("game.enginePlayProfile")}
            value={opponent.engineProfile ?? "default"}
            onChange={(v) =>
              setOpponent((prev) =>
                prev.type === "engine"
                  ? { ...prev, engineProfile: (v as "default" | "strategicHuman" | null) ?? "default" }
                  : prev,
              )
            }
            allowDeselect={false}
            data={[
              { value: "default", label: t("game.enginePlayProfileDefault") },
              { value: "strategicHuman", label: t("game.enginePlayProfileStrategicHuman") },
            ]}
          />
          {opponent.engine && isLc0Engine(opponent.engine) && (
            <Lc0NetworkSelect opponent={opponent} setOpponent={setOpponent} />
          )}
        </>
      )}

      <Divider variant="dashed" label={t("game.timeSettings")} />
      <SegmentedControl
        data={[
          { value: "time", label: t("game.timeControl") },
          { value: "advanced", label: t("game.advanced") },
        ]}
        value={opponent.timeControl ? "time" : "advanced"}
        onChange={(v) => handleTimeControlToggle(v === "time" ? "time" : "advanced")}
      />
      <Group grow wrap="nowrap">
        {opponent.timeControl && (
          <>
            <InputWrapper label={t("game.time")}>
              <TimeInput defaultType="m" value={opponent.timeControl.seconds} setValue={handleTimeChange} />
            </InputWrapper>
            <InputWrapper label={t("game.increment")}>
              <TimeInput defaultType="s" value={opponent.timeControl.increment ?? 0} setValue={handleIncrementChange} />
            </InputWrapper>
          </>
        )}
      </Group>

      {opponent.type === "engine" && opponent.engine && !opponent.timeControl && (
        <Stack>
          <EngineSettingsForm
            engine={opponent.engine}
            remote={false}
            gameMode
            hideCores={isLc0Engine(opponent.engine)}
            settings={{
              go:
                opponent.engine != null && isLc0Engine(opponent.engine)
                  ? { t: "Nodes", c: opponent.lc0Nodes ?? 1 }
                  : opponent.go,
              settings: opponent.engine.settings || [],
              enabled: true,
              synced: false,
            }}
            setSettings={(fn) =>
              setOpponent((prev) => {
                if (prev.type === "human") return prev;
                const newSettings = fn({
                  go:
                    prev.engine && isLc0Engine(prev.engine) ? { t: "Nodes" as const, c: prev.lc0Nodes ?? 1 } : prev.go,
                  settings: prev.engine?.settings || [],
                  enabled: true,
                  synced: false,
                });
                const updated = { ...prev, ...newSettings };
                if (prev.engine && isLc0Engine(prev.engine) && newSettings.go?.t === "Nodes") {
                  updated.lc0Nodes = newSettings.go.c;
                }
                return updated;
              })
            }
            minimal={true}
          />
        </Stack>
      )}
    </Stack>
  );
}

export function useClockTimer(
  gameState: string,
  pos: any,
  whiteTime: number | null,
  blackTime: number | null,
  setWhiteTime: Dispatch<SetStateAction<number | null>>,
  setBlackTime: Dispatch<SetStateAction<number | null>>,
  players: any,
  setGameState: (state: GameState) => void,
  setResult: (result: Outcome) => void,
) {
  const [intervalId, setIntervalId] = useState<ReturnType<typeof setInterval> | null>(null);

  // Track previous turn to detect turn changes
  const prevTurnRef = useRef<"white" | "black" | null>(null);
  const incrementAppliedRef = useRef<string>("");
  const whiteTimeRef = useRef(whiteTime);
  const blackTimeRef = useRef(blackTime);

  // Keep refs in sync with state
  useEffect(() => {
    whiteTimeRef.current = whiteTime;
    blackTimeRef.current = blackTime;
  }, [whiteTime, blackTime]);

  // Clear interval and apply increment when turn changes
  useEffect(() => {
    if (gameState === "playing" && pos?.turn) {
      const currentTurn = pos.turn;
      const prevTurn = prevTurnRef.current;
      const turnKey = `${prevTurn}-${currentTurn}-${pos.fullmoves}`;

      // If turn changed, clear interval and apply increment
      if (prevTurn !== null && prevTurn !== currentTurn && incrementAppliedRef.current !== turnKey) {
        // Clear existing interval
        if (intervalId) {
          clearInterval(intervalId);
          setIntervalId(null);
        }

        // Apply increment to the player who just moved (previous turn)
        // Use refs to avoid dependency on whiteTime/blackTime
        if (prevTurn === "white" && whiteTimeRef.current !== null && pos.fullmoves > 1) {
          setWhiteTime((prev) => (prev ?? 0) + (players.white.timeControl?.increment ?? 0));
        } else if (prevTurn === "black" && blackTimeRef.current !== null) {
          setBlackTime((prev) => (prev ?? 0) + (players.black.timeControl?.increment ?? 0));
        }

        incrementAppliedRef.current = turnKey;
      }

      // Update previous turn
      prevTurnRef.current = currentTurn;
    }
  }, [gameState, pos?.turn, pos?.fullmoves, intervalId, players, setWhiteTime, setBlackTime]);

  useEffect(() => {
    if (gameState === "playing") {
      if (whiteTime !== null && whiteTime <= 0) {
        setWhiteTime(0);
        setGameState("gameOver");
        setResult("0-1");
      } else if (blackTime !== null && blackTime <= 0) {
        setBlackTime(0);
        setGameState("gameOver");
        setResult("1-0");
      }
    }
  }, [gameState, whiteTime, blackTime, setGameState, setResult, setWhiteTime, setBlackTime]);

  useEffect(() => {
    if (gameState !== "playing" && intervalId) {
      clearInterval(intervalId);
      setIntervalId(null);
    }
  }, [gameState, intervalId]);

  // Start timer for current turn
  // Optimize: Use refs to avoid re-creating interval on every render
  const posTurnRef = useRef(pos?.turn);
  useEffect(() => {
    posTurnRef.current = pos?.turn;
  }, [pos?.turn]);

  // Keep gameState in a ref to check it inside the interval callback
  const gameStateRef = useRef(gameState);
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  // Keep interval in a ref so we can clear it when pos changes without waiting for state.
  // This fixes the clock stopping after a move: we no longer depend on intervalId being null.
  const intervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (gameState === "playing" && pos) {
      if (intervalIdRef.current) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }

      const decrementTime = () => {
        if (gameStateRef.current !== "playing") {
          if (intervalIdRef.current) {
            clearInterval(intervalIdRef.current);
            intervalIdRef.current = null;
          }
          return;
        }

        const currentTurn = posTurnRef.current;
        if (currentTurn === "white" && whiteTimeRef.current !== null) {
          setWhiteTime((prev) => {
            const current = prev ?? 0;
            return current > 0 ? current - CLOCK_UPDATE_INTERVAL : 0;
          });
        } else if (currentTurn === "black" && blackTimeRef.current !== null) {
          setBlackTime((prev) => {
            const current = prev ?? 0;
            return current > 0 ? current - CLOCK_UPDATE_INTERVAL : 0;
          });
        }
      };

      const id = setInterval(decrementTime, CLOCK_UPDATE_INTERVAL);
      intervalIdRef.current = id;
      setIntervalId(id);
      return () => {
        clearInterval(id);
        intervalIdRef.current = null;
        setIntervalId((current) => (current === id ? null : current));
      };
    }
  }, [gameState, pos, setWhiteTime, setBlackTime]);
}

/**
 * BoardGame - Generic game board component for playing chess games.
 *
 * Responsibilities:
 * - Game setup UI (player selection, time controls, FEN input)
 * - Game state management (playing, gameOver, settingUp)
 * - Clock/timer management
 * - Move controls and game info display
 * - Human vs human gameplay
 *
 * Does NOT handle:
 * - Engine move requests/responses (handled by PlayVsEngineBoard)
 * - Analysis engine evaluation (handled by BoardAnalysis via EvalListener)
 *
 * When used via PlayVsEngineBoard, engine logic is added on top via useEngineMoves hook.
 */
function BoardGame() {
  const activeTab = useAtomValue(activeTabAtom);
  const profiles = useAtomValue(profilesAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const { t } = useTranslation();

  // Load saved game settings from localStorage
  const loadGameSettings = useCallback(() => {
    try {
      const saved = localStorage.getItem("boardGameSettings");
      if (saved) {
        const settings = JSON.parse(saved);
        const norm = (p: unknown): OpponentSettings => {
          if (!p || typeof p !== "object")
            return { type: "human", profileId: undefined, timeControl: DEFAULT_TIME_CONTROL };
          const o = p as Record<string, unknown>;
          if (o.type === "human") {
            const tc: TimeControlField =
              o.timeControl && typeof o.timeControl === "object" && "seconds" in o.timeControl
                ? (o.timeControl as TimeControlField)
                : DEFAULT_TIME_CONTROL;
            return {
              type: "human",
              profileId: typeof o.profileId === "string" ? o.profileId : undefined,
              timeControl: tc,
            };
          }
          const tc: TimeControlField | undefined =
            o.timeControl && typeof o.timeControl === "object" && "seconds" in o.timeControl
              ? (o.timeControl as TimeControlField)
              : undefined;
          return {
            type: "engine",
            timeControl: tc,
            engine: (o.engine as LocalEngine | null) ?? null,
            go: (o.go as GoMode) ?? { t: "Depth", c: 1 },
            engineProfile:
              o.engineProfile === "strategicHuman" || o.engineProfile === "default" ? o.engineProfile : "default",
            lc0NetworkPath: typeof o.lc0NetworkPath === "string" ? o.lc0NetworkPath : undefined,
            lc0Nodes: typeof o.lc0Nodes === "number" ? o.lc0Nodes : undefined,
          };
        };
        return {
          inputColor: settings.inputColor || "white",
          sameTimeControl: settings.sameTimeControl ?? true,
          customFen: settings.customFen || "",
          player1Settings: norm(settings.player1Settings) || {
            type: "human" as const,
            profileId: undefined,
            timeControl: DEFAULT_TIME_CONTROL,
          },
          player2Settings: norm(settings.player2Settings) || {
            type: "human" as const,
            profileId: undefined,
            timeControl: DEFAULT_TIME_CONTROL,
          },
        };
      }
    } catch (_e) {
      // Failed to load game settings
    }
    return {
      inputColor: "white" as ColorChoice,
      sameTimeControl: true,
      customFen: "",
      player1Settings: {
        type: "human" as const,
        profileId: undefined,
        timeControl: DEFAULT_TIME_CONTROL,
      },
      player2Settings: {
        type: "human" as const,
        profileId: undefined,
        timeControl: DEFAULT_TIME_CONTROL,
      },
    };
  }, []);

  // Save game settings to localStorage
  const saveGameSettings = useCallback(
    (settings: {
      inputColor: ColorChoice;
      sameTimeControl: boolean;
      customFen: string;
      player1Settings: OpponentSettings;
      player2Settings: OpponentSettings;
    }) => {
      try {
        localStorage.setItem("boardGameSettings", JSON.stringify(settings));
      } catch (_e) {
        // Failed to save game settings
      }
    },
    [],
  );

  const savedSettings = loadGameSettings();
  const [inputColor, setInputColor] = useState<ColorChoice>(savedSettings.inputColor);
  const [viewPawnStructure, setViewPawnStructure] = useState(false);
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const [sameTimeControl, setSameTimeControl] = useState(savedSettings.sameTimeControl);
  const [customFen, setCustomFen] = useState<string>(savedSettings.customFen);
  const [fenError, setFenError] = useState<string | null>(null);
  const [isApplyingFen, setIsApplyingFen] = useState(false);
  const fenInputRef = useRef<HTMLInputElement>(null);

  const cycleColor = useCallback(() => {
    setInputColor((prev) =>
      match(prev)
        .with("white", () => "black" as const)
        .with("black", () => "random" as const)
        .with("random", () => "white" as const)
        .exhaustive(),
    );
  }, []);

  const validateFen = useCallback(
    (fen: string) => {
      if (!fen.trim()) {
        setFenError(null);
        return true;
      }
      const [pos, err] = positionFromFen(fen);
      if (err || !pos) {
        setFenError(t("game.invalidFen") || "Invalid FEN position");
        return false;
      }
      setFenError(null);
      return true;
    },
    [t],
  );

  const [player1Settings, setPlayer1Settings] = useState<OpponentSettings>(savedSettings.player1Settings);
  const [player2Settings, setPlayer2Settings] = useState<OpponentSettings>(savedSettings.player2Settings);

  // Save settings with debounce (excluding when manually applying FEN)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Skip auto-save when manually applying FEN to avoid conflicts
    if (isApplyingFen) {
      return;
    }

    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      saveGameSettings({
        inputColor,
        sameTimeControl,
        customFen,
        player1Settings,
        player2Settings,
      });
      saveTimeoutRef.current = null;
    }, 300);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [inputColor, sameTimeControl, customFen, player1Settings, player2Settings, saveGameSettings, isApplyingFen]);

  const getPlayers = useCallback(() => {
    let white = inputColor === "white" ? player1Settings : player2Settings;
    let black = inputColor === "black" ? player1Settings : player2Settings;
    if (inputColor === "random") {
      white = Math.random() > 0.5 ? player1Settings : player2Settings;
      black = white === player1Settings ? player2Settings : player1Settings;
    }
    return { white, black };
  }, [inputColor, player1Settings, player2Settings]);

  const store = useContext(TreeStateContext)!;
  // Use selectors that extract only the values we need for memoization
  // This helps Zustand optimize re-renders by comparing primitive values
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);

  const setFen = useStore(store, (s) => s.setFen);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const setResult = useStore(store, (s) => s.setResult);
  const _appendMove = useStore(store, (s) => s.appendMove);

  const [tabs, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const boardRef = useRef(null);
  const [gameState, setGameState] = useAtom(currentGameStateAtom);
  const [players, setPlayers] = useAtom(currentPlayersAtom);

  const loadableEngines = useAtomValue(loadableEnginesAtom);
  const enginesState = loadableEngines.state;

  const engines = useMemo(() => {
    return enginesState === "hasData" ? loadableEngines.data.filter((e): e is LocalEngine => e.type === "local") : [];
  }, [loadableEngines, enginesState]);

  // Use GameTimeContext if available (from PlayVsEngineBoard), otherwise use local state
  const [localWhiteTime, setLocalWhiteTime] = useState<number | null>(null);
  const [localBlackTime, setLocalBlackTime] = useState<number | null>(null);

  // Try to use context, fallback to local state
  let whiteTime: number | null = localWhiteTime;
  let setWhiteTime: Dispatch<SetStateAction<number | null>> = setLocalWhiteTime;
  let blackTime: number | null = localBlackTime;
  let setBlackTime: Dispatch<SetStateAction<number | null>> = setLocalBlackTime;

  const gameTime = useGameTime();

  if (gameTime) {
    whiteTime = gameTime.whiteTime;
    setWhiteTime = gameTime.setWhiteTime;
    blackTime = gameTime.blackTime;
    setBlackTime = gameTime.setBlackTime;
  }

  const changeToAnalysisMode = useCallback(() => {
    setTabs((prev) => prev.map((tab) => (tab.value === activeTab ? { ...tab, type: "analysis" } : tab)));
  }, [activeTab, setTabs]);

  // Memoize expensive calculations based on stable primitive values (root.fen, variant)
  // This prevents recalculation during engine analysis when only scores/annotations change
  // Extract primitive values for stable dependency tracking
  const _rootFen = root.fen;
  const variant = headers.variant;

  // Use rootFen as dependency instead of entire root object to avoid recalculation
  // when only internal tree properties (scores, annotations) change during analysis
  // Note: We still need root in dependencies for treeIteratorMainLine, but rootFen helps
  // React optimize by providing a stable primitive value to compare
  const mainLine = useMemo(() => {
    return Array.from(treeIteratorMainLine(root));
  }, [root]); // Recalculate when root.fen changes (new position), not on every tree mutation

  const lastNode = useMemo(() => mainLine[mainLine.length - 1]?.node, [mainLine]);
  const _moves = useMemo(() => {
    return getMainLine(root, variant === "Chess960");
  }, [root, variant]); // Recalculate only when root.fen or variant changes

  // Use root and position to ensure pos updates when moves are made
  const _position = useStore(store, (s) => s.position);
  // Memoize position calculation - only recalculate when lastNode.fen changes
  const [pos, error] = useMemo(() => {
    if (!lastNode) return [null, null];
    return positionFromFen(lastNode.fen);
  }, [lastNode?.fen, lastNode]);

  const activeTabData = tabs?.find((tab) => tab.value === activeTab);

  useEffect(() => {
    if (activeTabData?.meta?.timeControl) {
      const { timeControl } = activeTabData.meta;
      setPlayer1Settings((prev) => ({ ...prev, timeControl }));
      setPlayer2Settings((prev) => ({ ...prev, timeControl }));
    }
  }, [activeTabData]);

  useEffect(() => {
    if (pos?.isEnd()) {
      setGameState("gameOver");
      // Ensure result is set so Play vs PC saves with correct outcome (safety if makeMove didn't set it)
      if (!headers.result || headers.result === "*") {
        if (pos.isCheckmate()) {
          setResult(pos.turn === "white" ? "0-1" : "1-0");
        } else if (pos.isStalemate() || pos.isInsufficientMaterial()) {
          setResult("1/2-1/2");
        }
      }
    }
  }, [pos, setGameState, setResult, headers.result]);

  // Engine moves logic is handled by PlayVsEngineBoard component, not here
  // This keeps BoardGame clean for other use cases (analysis, variants, puzzles)

  const movable = useMemo(() => {
    if (players.white.type === "human" && players.black.type === "human") return "turn";
    if (players.white.type === "human") return "white";
    if (players.black.type === "human") return "black";
    return "none";
  }, [players]);

  useClockTimer(gameState, pos, whiteTime, blackTime, setWhiteTime, setBlackTime, players, setGameState, setResult);

  useEffect(() => {
    if (gameState === "gameOver" && headers.result && headers.result !== "*") {
      saveGameSettings({
        inputColor,
        sameTimeControl,
        customFen,
        player1Settings,
        player2Settings,
      });
    }
  }, [gameState, headers, inputColor, sameTimeControl, customFen, player1Settings, player2Settings, saveGameSettings]);

  /**
   * Applies a specific FEN (string) to the tree, updates headers and saves settings.
   * Returns true if applied, false if the FEN was invalid.
   */
  const applyFenString = useCallback(
    (fenRaw: string): boolean => {
      const fenToUse = fenRaw.trim() || INITIAL_FEN;
      if (!validateFen(fenToUse)) {
        return false;
      }

      // Mark that we're manually applying FEN to skip auto-save
      setIsApplyingFen(true);

      // Save settings FIRST with the new FEN to prevent conflicts
      saveGameSettings({
        inputColor,
        sameTimeControl,
        customFen: fenToUse,
        player1Settings,
        player2Settings,
      });

      // Update input state
      setCustomFen(fenToUse);

      // Update board immediately - setFen updates the root tree directly
      // This triggers the board to re-render with the new position
      // NOTE: setFen will reset the tree, so only call it when we want to start fresh
      setFen(fenToUse);

      // Update headers - but DON'T pass fen here as setFen already updated the root
      // Passing fen here could cause setHeaders to reset the tree again if the logic changes
      // We update fen in headers separately to track the initial FEN
      setHeaders({ ...headers, fen: fenToUse, result: "*" });

      // Reset the flag after a short delay to allow the state to settle
      setTimeout(() => {
        setIsApplyingFen(false);
      }, 100);

      return true;
    },
    [
      headers,
      inputColor,
      sameTimeControl,
      player1Settings,
      player2Settings,
      setFen,
      setHeaders,
      validateFen,
      saveGameSettings,
    ],
  );

  const applyFen = useCallback(() => {
    // Read value directly from input to handle paste events correctly
    const inputValue = fenInputRef.current?.value || customFen;
    applyFenString(inputValue);
  }, [applyFenString, customFen]);

  const startGame = useCallback(() => {
    const newPlayers = getPlayers();
    if (newPlayers.white.type === "human" && !newPlayers.white.profileId) {
      notifications.show({
        title: t("common.error"),
        message: t("game.selectProfileRequired"),
        color: "red",
      });
      return;
    }
    if (newPlayers.black.type === "human" && !newPlayers.black.profileId) {
      notifications.show({
        title: t("common.error"),
        message: t("game.selectProfileRequired"),
        color: "red",
      });
      return;
    }

    // Kill any existing engines to start fresh (but don't wait)
    // Note: When used via PlayVsEngineBoard, engine logic is handled by that component
    if (activeTab) {
      // Kill engines asynchronously without blocking
      Promise.all([
        commands.killEngines(`${activeTab}white`).catch(() => {}),
        commands.killEngines(`${activeTab}black`).catch(() => {}),
        commands.killEngines(activeTab).catch(() => {}),
      ]).catch(() => {});
    }

    // Set game state to playing immediately
    setGameState("playing");

    if (newPlayers.white.timeControl) {
      setWhiteTime(newPlayers.white.timeControl.seconds);
    }

    if (newPlayers.black.timeControl) {
      setBlackTime(newPlayers.black.timeControl.seconds);
    }

    setPlayers(newPlayers);

    const humanWhiteName =
      newPlayers.white.type === "human"
        ? (profiles.find((p) => p.id === (newPlayers.white as Extract<OpponentSettings, { type: "human" }>).profileId)
            ?.name ?? "?")
        : null;
    const humanBlackName =
      newPlayers.black.type === "human"
        ? (profiles.find((p) => p.id === (newPlayers.black as Extract<OpponentSettings, { type: "human" }>).profileId)
            ?.name ?? "?")
        : null;
    const newHeaders: Partial<GameHeaders> = {
      white: (newPlayers.white.type === "human" ? humanWhiteName : newPlayers.white.engine?.name) ?? "?",
      black: (newPlayers.black.type === "human" ? humanBlackName : newPlayers.black.engine?.name) ?? "?",
      time_control: undefined,
      orientation:
        newPlayers.white.type === "human" && newPlayers.black.type === "engine"
          ? "white"
          : newPlayers.white.type === "engine" && newPlayers.black.type === "human"
            ? "black"
            : headers.orientation,
    };

    if (newPlayers.white.timeControl || newPlayers.black.timeControl) {
      if (sameTimeControl && newPlayers.white.timeControl) {
        newHeaders.time_control = `${newPlayers.white.timeControl.seconds / 1000}`;
        if (newPlayers.white.timeControl.increment) {
          newHeaders.time_control += `+${newPlayers.white.timeControl.increment / 1000}`;
        }
      } else {
        if (newPlayers.white.timeControl) {
          newHeaders.white_time_control = `${newPlayers.white.timeControl.seconds / 1000}`;
          if (newPlayers.white.timeControl.increment) {
            newHeaders.white_time_control += `+${newPlayers.white.timeControl.increment / 1000}`;
          }
        }
        if (newPlayers.black.timeControl) {
          newHeaders.black_time_control = `${newPlayers.black.timeControl.seconds / 1000}`;
          if (newPlayers.black.timeControl.increment) {
            newHeaders.black_time_control += `+${newPlayers.black.timeControl.increment / 1000}`;
          }
        }
      }
    }

    const fenToUse = customFen.trim() || INITIAL_FEN;
    if (!applyFenString(fenToUse)) {
      return; // don't start game if FEN is invalid
    }

    // IMPORTANT: Only update headers metadata, NOT the fen field
    // The tree and headers.fen were already updated by applyFenString
    // Passing fen here could cause setHeaders to reset the tree if there's a race condition
    // We update all other headers but preserve the fen that was set by applyFenString
    // Ensure result is set to "*" to indicate game is in progress
    setHeaders({ ...headers, ...newHeaders, result: "*" });

    setTabs((prev) =>
      prev.map((tab) => {
        const whiteName =
          newPlayers.white.type === "human" ? (humanWhiteName ?? "?") : (newPlayers.white.engine?.name ?? "?");
        const blackName =
          newPlayers.black.type === "human" ? (humanBlackName ?? "?") : (newPlayers.black.engine?.name ?? "?");
        return tab.value === activeTab ? { ...tab, name: `${whiteName} vs. ${blackName}` } : tab;
      }),
    );
  }, [
    activeTab,
    customFen,
    getPlayers,
    headers,
    applyFenString,
    sameTimeControl,
    setGameState,
    setHeaders,
    setPlayers,
    setTabs,
    setBlackTime,
    setWhiteTime,
    profiles,
    t,
  ]);

  const handleNewGame = useCallback(() => {
    // Cancel any pending debounced save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    // Save current settings immediately before resetting
    saveGameSettings({
      inputColor,
      sameTimeControl,
      customFen,
      player1Settings,
      player2Settings,
    });

    setGameState("settingUp");
    setWhiteTime(null);
    setBlackTime(null);
    setFenError(null);

    // Load saved settings after a brief delay to ensure save completed
    setTimeout(() => {
      const saved = loadGameSettings();

      setInputColor(saved.inputColor);
      setSameTimeControl(saved.sameTimeControl);
      setCustomFen(saved.customFen);
      setPlayer1Settings(saved.player1Settings);
      setPlayer2Settings(saved.player2Settings);

      const fenToUse = saved.customFen.trim() || INITIAL_FEN;
      const [p, err] = positionFromFen(fenToUse);

      if (!err && p) {
        setFen(fenToUse);
        setHeaders({ ...headers, fen: fenToUse, result: "*" });
      } else {
        setFen(INITIAL_FEN);
        setHeaders({ ...headers, fen: INITIAL_FEN, result: "*" });
        if (saved.customFen.trim()) {
          setFenError(t("game.invalidFen") || "Invalid FEN position");
        }
      }
    }, 50);
  }, [
    headers,
    inputColor,
    loadGameSettings,
    player1Settings,
    player2Settings,
    sameTimeControl,
    customFen,
    saveGameSettings,
    setFen,
    setGameState,
    setHeaders,
    setWhiteTime,
    t,
    setBlackTime,
  ]);

  const endGame = useCallback(async () => {
    // First, change game state to stop any ongoing engine requests
    setGameState("settingUp");

    // Stop all engines immediately - kill ALL instances comprehensively
    if (activeTab) {
      try {
        // Strategy 1: Kill all engines that start with the activeTab (Rust uses starts_with)
        // This should catch most instances
        await commands.killEngines(activeTab);

        // Strategy 2: Explicitly kill engines for known tab variants
        await Promise.all([
          commands.killEngines(`${activeTab}white`).catch(() => {}),
          commands.killEngines(`${activeTab}black`).catch(() => {}),
        ]);

        // Strategy 3: Kill engines individually by path for each known engine
        // This ensures we kill specific engine instances that might not match the pattern
        if (engines.length > 0) {
          const killPromises = engines.flatMap((engine) => [
            commands.killEngine(engine.path, `${activeTab}white`).catch(() => {}),
            commands.killEngine(engine.path, `${activeTab}black`).catch(() => {}),
            commands.killEngine(engine.path, activeTab).catch(() => {}),
          ]);
          await Promise.all(killPromises);
        }

        // Strategy 4: Also kill engines for players that might be engines
        const currentPlayers = getPlayers();
        if (currentPlayers.white.type === "engine" && currentPlayers.white.engine) {
          await Promise.all([
            commands.killEngine(currentPlayers.white.engine.path, `${activeTab}white`).catch(() => {}),
            commands.killEngine(currentPlayers.white.engine.path, activeTab).catch(() => {}),
          ]);
        }
        if (currentPlayers.black.type === "engine" && currentPlayers.black.engine) {
          await Promise.all([
            commands.killEngine(currentPlayers.black.engine.path, `${activeTab}black`).catch(() => {}),
            commands.killEngine(currentPlayers.black.engine.path, activeTab).catch(() => {}),
          ]);
        }
      } catch (_e) {
        // Failed to kill engines
      }
    }

    // Save the game record before resetting
    // Only save if there are moves in the game
    let savedPgn = ""; // Store PGN for use in creating analysis tab

    // CRITICAL: Check if we actually have moves to save
    const hasMoves = root.children.length > 0;

    if (hasMoves) {
      // Get the initial FEN from headers (set when game started)
      // This is more reliable than root.fen which may change if user navigates back
      const initialFen = headers.fen || root.fen;

      // CRITICAL: We need to traverse from the actual root, not from current position
      // The root should have the initial FEN, and all moves should be in root.children[0] chain

      // Extract all SAN moves from the main line by traversing root.children[0] recursively
      const sanMoves: string[] = [];
      let currentNode = root;
      let moveCount = 0;
      const MAX_MOVES = 500; // Safety limit to prevent infinite loops

      // Iterate through the main line manually to ensure we get all moves
      while (currentNode.children.length > 0 && moveCount < MAX_MOVES) {
        const child = currentNode.children[0]; // Always take the first child (main line)

        // Each node in the main line should have a SAN move
        if (child.san) {
          sanMoves.push(child.san);
          moveCount++;
        } else if (child.move) {
          // If a node doesn't have SAN, try to generate it from the move
          const [pos, posError] = positionFromFen(currentNode.fen);
          if (pos && !posError) {
            try {
              const san = makeSan(pos, child.move);
              if (san && san !== "--") {
                sanMoves.push(san);
                moveCount++;
              } else {
                // Don't break - continue to next move
                moveCount++;
              }
            } catch (_e) {
              // Don't break - continue to next move
              moveCount++;
            }
          } else {
            // Don't break - continue to next move
            moveCount++;
          }
        } else {
          // If node has neither SAN nor move, we've reached the end
          break;
        }

        currentNode = child;
      }

      // Get the last node for final FEN
      const mainLine = Array.from(treeIteratorMainLine(root));
      const _lastNode = mainLine[mainLine.length - 1].node;

      // Use current result or "*" if game was stopped early
      const gameResult = headers.result && headers.result !== "*" ? headers.result : "*";

      // Build PGN headers
      let pgn = `[Event "${headers.event || "Local Game"}"]\n`;
      pgn += `[Site "${headers.site || "Obsidian Chess Studio"}"]\n`;
      pgn += `[Date "${headers.date || new Date().toISOString().split("T")[0].replace(/-/g, ".")}"]\n`;
      pgn += `[Round "${headers.round || "?"}"]\n`;
      pgn += `[White "${headers.white || "?"}"]\n`;
      pgn += `[Black "${headers.black || "?"}"]\n`;
      pgn += `[Result "${gameResult}"]\n`;
      if (headers.time_control) {
        pgn += `[TimeControl "${headers.time_control}"]\n`;
      }
      if (headers.variant) {
        pgn += `[Variant "${headers.variant}"]\n`;
      }
      // Always include initial FEN if it's different from standard starting position
      // Use headers.fen which was set when the game started
      if (initialFen !== INITIAL_FEN) {
        pgn += `[SetUp "1"]\n`;
        pgn += `[FEN "${initialFen}"]\n`;
      }
      pgn += "\n";

      // Format moves in PGN format (pair white and black moves)
      if (sanMoves.length > 0) {
        const movePairs: string[] = [];
        for (let i = 0; i < sanMoves.length; i += 2) {
          const moveNumber = Math.floor(i / 2) + 1;
          const whiteMove = sanMoves[i];
          const blackMove = sanMoves[i + 1];

          if (blackMove) {
            movePairs.push(`${moveNumber}. ${whiteMove} ${blackMove}`);
          } else {
            movePairs.push(`${moveNumber}. ${whiteMove}`);
          }
        }
        pgn += `${movePairs.join(" ")} ${gameResult}`;
      } else {
        pgn += gameResult;
      }

      // Ensure PGN is not empty and has moves
      if (!pgn || pgn.trim().length === 0) {
        // PGN is empty, skipping save
      } else if (sanMoves.length === 0) {
        // PGN has no moves - still save the PGN even without moves
      } else {
        // Store PGN for use in creating analysis tab
        savedPgn = pgn.trim();
      }
    }

    // Create new tab with the game (without focusing it)
    // Use the manually constructed PGN we already built above to ensure consistency
    if (savedPgn && root.children.length > 0) {
      const currentActiveTab = activeTab;

      // Create the tab first
      const newTabId = await createTab({
        tab: {
          name: `${headers.white || "?"} vs ${headers.black || "?"}`,
          type: "analysis",
        },
        setTabs,
        setActiveTab,
        pgn: savedPgn,
        headers,
      });

      // Restore focus to current tab
      setActiveTab(currentActiveTab);

      // Get the PGN and FEN initial from the newly created tab
      // The tab stores its state in sessionStorage with the tab ID
      try {
        const tabStateJson = getTabStateRaw(newTabId);
        if (tabStateJson) {
          const tabState = JSON.parse(tabStateJson);
          if (tabState?.state) {
            const treeState = tabState.state;

            // Get PGN from the tree state using getPGN
            const tabPgn = getPGN(treeState.root, {
              headers: treeState.headers,
              comments: true,
              extraMarkups: true,
              glyphs: true,
              variations: true,
            });

            // Get initial FEN from the tree state root
            const tabInitialFen = treeState.root?.fen || treeState.headers?.fen;

            // Get the last node for final FEN
            const mainLine = Array.from(treeIteratorMainLine(treeState.root));
            const lastNode = mainLine[mainLine.length - 1].node;

            // Get UCI moves for the moves array (for backward compatibility)
            const uciMoves = getMainLine(treeState.root, treeState.headers?.variant === "Chess960");

            // Use current result or "*" if game was stopped early
            const gameResult =
              treeState.headers?.result && treeState.headers.result !== "*" ? treeState.headers.result : "*";

            // Save the game record with PGN and initial FEN from the tab
            const record: GameRecord = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              white: {
                type: players.white.type,
                name:
                  players.white.type === "human"
                    ? (profiles.find(
                        (p) => p.id === (players.white as Extract<OpponentSettings, { type: "human" }>).profileId,
                      )?.name ?? "?")
                    : players.white.engine?.name,
                engine: players.white.type === "engine" ? players.white.engine?.path : undefined,
              },
              black: {
                type: players.black.type,
                name:
                  players.black.type === "human"
                    ? (profiles.find(
                        (p) => p.id === (players.black as Extract<OpponentSettings, { type: "human" }>).profileId,
                      )?.name ?? "?")
                    : players.black.engine?.name,
                engine: players.black.type === "engine" ? players.black.engine?.path : undefined,
              },
              result: gameResult,
              timeControl:
                treeState.headers?.time_control ||
                `${treeState.headers?.white_time_control || ""},${treeState.headers?.black_time_control || ""}`,
              timestamp: Date.now(),
              moves: uciMoves, // UCI moves for backward compatibility
              variant: treeState.headers?.variant ?? undefined,
              fen: lastNode.fen, // Final FEN position
              initialFen: tabInitialFen !== INITIAL_FEN ? tabInitialFen : undefined, // Initial FEN from tab
              pgn: tabPgn, // Full PGN from tab
            };

            // Save the game record
            await saveGameRecord(record);
          }
        }
      } catch (_e) {
        // Failed to get data from tab, skip saving
      }
    }

    // Reset to new game
    handleNewGame();
  }, [
    activeTab,
    root,
    headers,
    players,
    setTabs,
    setActiveTab,
    setGameState,
    handleNewGame,
    engines,
    getPlayers,
    profiles.find,
  ]);

  const handleSameTimeControlChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const isChecked = e.target.checked;
      setSameTimeControl(isChecked);

      if (isChecked) {
        setPlayer2Settings((prev) => ({
          ...prev,
          timeControl: player1Settings.timeControl,
        }));
      }
    },
    [player1Settings.timeControl],
  );

  // Check if we're coming from a variants file
  const isFromVariants = activeTabData?.source?.type === "file" && activeTabData?.source?.metadata?.type === "variants";

  // Get board orientation (default to white if not set)
  const boardOrientation = headers.orientation || "white";

  // Generate puzzles from variants
  const generatePuzzles = useCallback(async () => {
    try {
      // Get document directory
      const documentDir = await getDocumentDir();

      // Open save dialog
      const filePath = await save({
        defaultPath: `${documentDir}/puzzles-${formatDateToPGN(new Date())}.pgn`,
        filters: [
          {
            name: "PGN",
            extensions: ["pgn"],
          },
        ],
      });

      if (!filePath) return;

      // Get filename without extension
      const fileName =
        filePath
          .replace(/\.pgn$/, "")
          .split(/[/\\]/)
          .pop() || `puzzles-${formatDateToPGN(new Date())}`;

      // Generate puzzles from the current tree
      // Each puzzle is based on a position where there are multiple variations (next moves)
      const puzzles: string[] = [];

      // Function to recursively find positions with variations
      const findPuzzlePositions = (node: TreeNode, depth = 0): void => {
        // Only consider positions where it's the turn of the puzzle color
        const [pos] = positionFromFen(node.fen);
        if (!pos) return;

        const currentTurn = pos.turn;
        const puzzleColor = boardOrientation === "white" ? "white" : "black";

        // If this position has multiple children (variations) and it's the puzzle color's turn
        if (node.children.length > 1 && currentTurn === puzzleColor) {
          // Create a puzzle from this position
          // Take the first variation as the solution (or any variation)
          const solutionVariation = node.children[0];

          // Get the solution moves (just the next move, or up to 2 moves if needed)
          let solutionMoves = "";
          if (solutionVariation.san) {
            solutionMoves = getMoveText(solutionVariation, {
              glyphs: false,
              comments: false,
              extraMarkups: false,
              isFirst: false,
            }).trim();

            // If there's a continuation, add it
            if (solutionVariation.children.length > 0 && solutionVariation.children[0].san) {
              const nextMove = getMoveText(solutionVariation.children[0], {
                glyphs: false,
                comments: false,
                extraMarkups: false,
                isFirst: false,
              }).trim();
              solutionMoves += ` ${nextMove}`;
            }
          }

          // Create puzzle PGN
          let puzzlePGN = `[FEN "${node.fen}"]\n`;
          puzzlePGN += `[Solution "${solutionMoves}"]\n`;
          puzzlePGN += `\n${solutionMoves}\n\n`;

          puzzles.push(puzzlePGN);
        }

        // Recursively check children (limit depth to avoid too many puzzles)
        if (depth < 10) {
          for (const child of node.children) {
            findPuzzlePositions(child, depth + 1);
          }
        }
      };

      // Start from root
      findPuzzlePositions(root);

      // If no puzzles found from variations, create puzzles from positions with at least one move
      if (puzzles.length === 0) {
        // Create puzzles from all positions where it's the puzzle color's turn
        const createPuzzlesFromPositions = (node: TreeNode, depth = 0): void => {
          const [pos] = positionFromFen(node.fen);
          if (!pos) return;

          const currentTurn = pos.turn;
          const puzzleColor = boardOrientation === "white" ? "white" : "black";

          // If it's the puzzle color's turn and there's at least one move
          if (currentTurn === puzzleColor && node.children.length > 0) {
            const solutionVariation = node.children[0];

            if (solutionVariation.san) {
              const solutionMoves = getMoveText(solutionVariation, {
                glyphs: false,
                comments: false,
                extraMarkups: false,
                isFirst: false,
              }).trim();

              let puzzlePGN = `[FEN "${node.fen}"]\n`;
              puzzlePGN += `[Solution "${solutionMoves}"]\n`;
              puzzlePGN += `\n${solutionMoves}\n\n`;

              puzzles.push(puzzlePGN);
            }
          }

          // Recursively check children
          if (depth < 10) {
            for (const child of node.children) {
              createPuzzlesFromPositions(child, depth + 1);
            }
          }
        };

        createPuzzlesFromPositions(root);
      }

      // Combine all puzzles into a single PGN string
      const puzzlesPGN = puzzles.join("");

      // Create the file with puzzle type
      await createFile({
        filename: fileName,
        filetype: "puzzle",
        pgn: puzzlesPGN,
        dir: documentDir,
      });

      notifications.show({
        title: t("common.save"),
        message: t("common.puzzlesGeneratedSuccessfully"),
        color: "green",
      });
    } catch (_error) {
      notifications.show({
        title: t("common.error"),
        message: t("common.failedToGeneratePuzzles"),
        color: "red",
      });
    }
  }, [root, boardOrientation, t]);

  const onePlayerIsEngine =
    (players.white.type === "engine" || players.black.type === "engine") && players.white.type !== players.black.type;

  const { layout } = useResponsiveLayout();
  const isMobileLayout = layout.chessBoard.layoutType === "mobile";

  const startGameDisabled =
    ((player1Settings.type === "engine" || player2Settings.type === "engine") && engines.length === 0) ||
    error !== null ||
    gameState !== "settingUp";

  if (isMobileLayout) {
    return (
      <ScrollArea h="100%">
        <Stack gap="md">
          <ResponsiveBoard
            dirty={false}
            editingMode={false}
            toggleEditingMode={() => undefined}
            viewOnly={gameState !== "playing"}
            disableVariations
            boardRef={boardRef}
            canTakeBack={onePlayerIsEngine}
            movable={movable}
            whiteTime={gameState === "playing" ? (whiteTime ?? undefined) : undefined}
            blackTime={gameState === "playing" ? (blackTime ?? undefined) : undefined}
            topBar={false}
            viewPawnStructure={viewPawnStructure}
            setViewPawnStructure={setViewPawnStructure}
            selectedPiece={selectedPiece}
            setSelectedPiece={setSelectedPiece}
            changeTabType={changeToAnalysisMode}
            currentTabType="play"
            startGame={startGame}
            endGame={endGame}
            gameState={gameState}
            startGameDisabled={error !== null}
          />
          <GameNotationWrapper topBar />
          {isFromVariants && (
            <Button leftSection={<IconPuzzle size={18} />} onClick={generatePuzzles} variant="light" fullWidth>
              {t("common.generatePuzzles")}
            </Button>
          )}
        </Stack>
      </ScrollArea>
    );
  }

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <ResponsiveBoard
          dirty={false}
          editingMode={false}
          toggleEditingMode={() => undefined}
          viewOnly={gameState !== "playing"}
          disableVariations
          boardRef={boardRef}
          canTakeBack={onePlayerIsEngine}
          movable={movable}
          whiteTime={gameState === "playing" ? (whiteTime ?? undefined) : undefined}
          blackTime={gameState === "playing" ? (blackTime ?? undefined) : undefined}
          topBar={false}
          viewPawnStructure={viewPawnStructure}
          setViewPawnStructure={setViewPawnStructure}
          selectedPiece={selectedPiece}
          setSelectedPiece={setSelectedPiece}
          changeTabType={changeToAnalysisMode}
          currentTabType="play"
          startGame={startGame}
          gameState={gameState}
          startGameDisabled={error !== null}
        />
      </Portal>
      <Portal target="#topRight" style={{ height: "100%", overflow: "hidden" }}>
        <Paper withBorder shadow="sm" p="md" h="100%">
          {gameState === "settingUp" && (
            <ScrollArea h="100%" offsetScrollbars>
              <Stack>
                <Group>
                  <Text flex={1} ta="center" fz="lg" fw="bold">
                    {match(inputColor)
                      .with("white", () => t("chess.white"))
                      .with("random", () => t("chess.random"))
                      .with("black", () => t("chess.black"))
                      .exhaustive()}
                  </Text>
                  <ActionIcon onClick={cycleColor}>
                    <IconArrowsExchange />
                  </ActionIcon>
                  <Text flex={1} ta="center" fz="lg" fw="bold">
                    {match(inputColor)
                      .with("white", () => t("chess.black"))
                      .with("random", () => t("chess.random"))
                      .with("black", () => t("chess.white"))
                      .exhaustive()}
                  </Text>
                </Group>
                <Box flex={1}>
                  <Group style={{ alignItems: "start" }}>
                    <OpponentForm
                      sameTimeControl={sameTimeControl}
                      opponent={player1Settings}
                      setOpponent={setPlayer1Settings}
                      setOtherOpponent={setPlayer2Settings}
                      engines={engines}
                      enginesState={enginesState}
                      profiles={profiles}
                      activeProfileId={activeProfileId}
                    />
                    <Divider orientation="vertical" />
                    <OpponentForm
                      sameTimeControl={sameTimeControl}
                      opponent={player2Settings}
                      setOpponent={setPlayer2Settings}
                      setOtherOpponent={setPlayer1Settings}
                      engines={engines}
                      enginesState={enginesState}
                      profiles={profiles}
                      activeProfileId={activeProfileId}
                    />
                  </Group>
                </Box>
                <Group justify="flex-start">
                  <Checkbox
                    label={t("game.sameTimeControl")}
                    checked={sameTimeControl}
                    onChange={handleSameTimeControlChange}
                  />
                </Group>
                <Divider label={t("game.startingPosition")} />
                <Stack gap="md">
                  <InputWrapper
                    label={t("game.fen")}
                    error={fenError}
                    description={t("game.fenDescription")}
                    styles={{
                      label: {
                        marginBottom: "0.25rem",
                      },
                      description: {
                        marginTop: "0.25rem",
                        marginBottom: "0.5rem",
                      },
                    }}
                  >
                    <Group gap="xs" wrap="nowrap" align="flex-end">
                      <TextInput
                        ref={fenInputRef}
                        style={{ flex: 1 }}
                        placeholder={INITIAL_FEN}
                        value={customFen}
                        radius="md"
                        size="sm"
                        variant="filled"
                        onChange={(e) => {
                          const newFen = e.target.value;
                          setCustomFen(newFen);
                          if (newFen.trim()) {
                            validateFen(newFen);
                          } else {
                            setFenError(null);
                          }
                        }}
                        onPaste={(e) => {
                          // Ensure state is updated immediately on paste
                          const pastedValue = e.clipboardData.getData("text");
                          setTimeout(() => {
                            setCustomFen(pastedValue);
                            if (pastedValue.trim()) {
                              validateFen(pastedValue);
                            } else {
                              setFenError(null);
                            }
                          }, 0);
                        }}
                        error={!!fenError}
                        styles={{
                          input: {
                            fontFamily: "monospace",
                            fontSize: "0.85rem",
                            whiteSpace: "nowrap",
                            overflowX: "auto",
                          },
                        }}
                      />
                      <ActionIcon
                        variant="light"
                        color="blue"
                        onClick={applyFen}
                        disabled={!!fenError || (!customFen.trim() && root.fen === INITIAL_FEN)}
                        title={t("game.applyFen")}
                        size="lg"
                      >
                        <IconCheck size={18} />
                      </ActionIcon>
                    </Group>
                  </InputWrapper>
                </Stack>
              </Stack>
            </ScrollArea>
          )}
          {(gameState === "playing" || gameState === "gameOver") && (
            <Stack h="100%">
              <Box flex={1}>
                <GameInfo headers={headers} />
              </Box>
              <Group grow>
                <Button onClick={handleNewGame} leftSection={<IconPlus />}>
                  {t("keybindings.newGame")}
                </Button>
                <Button variant="default" onClick={changeToAnalysisMode} leftSection={<IconZoomCheck />}>
                  {t("keybindings.analyzePosition")}
                </Button>
              </Group>
            </Stack>
          )}
        </Paper>
      </Portal>
      <GameNotationWrapper topBar>
        <Stack gap="xs">
          <MoveControls
            readOnly
            currentTabType="play"
            startGame={startGame}
            endGame={endGame}
            gameState={gameState}
            startGameDisabled={startGameDisabled}
          />
          {isFromVariants && (
            <Button leftSection={<IconPuzzle size={18} />} onClick={generatePuzzles} variant="light" fullWidth>
              {t("common.generatePuzzles")}
            </Button>
          )}
        </Stack>
      </GameNotationWrapper>
    </>
  );
}

export default BoardGame;
