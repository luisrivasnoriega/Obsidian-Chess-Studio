import type { ReactNode } from "react";

export enum DifficultyLevel {
  BEGINNER = "beginner",
  INTERMEDIATE = "intermediate",
  ADVANCED = "advanced",
}

export enum LessonGroup {
  FUNDAMENTALS = "fundamentals",
  PIECE_MOVEMENT = "piece-movement",
  SPECIAL_MOVES = "special-moves",
  TACTICS = "tactics",
  ENDGAMES = "endgames",
  OPENINGS = "openings",
  STRATEGY = "strategy",
}

export interface LocalizedContent {
  readonly [languageCode: string]: string;
}

export interface LocalizedContentWithFallback {
  readonly default: string;
  readonly localized?: LocalizedContent;
}

export interface ExerciseVariation {
  readonly id?: string;
  readonly fen: string;
  readonly correctMoves: readonly string[];
  readonly description?: LocalizedContentWithFallback;
  readonly hints?: readonly LocalizedContentWithFallback[];
  readonly timeLimit?: number;
  readonly points?: number;
}

export interface ExerciseMetadata {
  readonly id: string;
  readonly title: LocalizedContentWithFallback;
  readonly description: LocalizedContentWithFallback;
  readonly difficulty?: DifficultyLevel;
  readonly tags?: readonly string[];
  readonly estimatedTime?: number;
  readonly points?: number;
  readonly prerequisites?: readonly string[];
  readonly order: number;
  readonly isOptional?: boolean;
  readonly version?: string;
}

export interface ExerciseGameData {
  readonly variations: readonly ExerciseVariation[];
  readonly fen?: string;
  readonly correctMoves?: readonly string[];
  readonly allowedMoves?: readonly string[];
  readonly evaluationMode?: "exact" | "best" | "good";
}

export interface LessonExercise extends ExerciseMetadata {
  readonly gameData: ExerciseGameData;
  readonly disabled?: boolean;
}

export interface LessonMetadata {
  readonly id: string;
  readonly group: LessonGroup;
  readonly title: LocalizedContentWithFallback;
  readonly description: LocalizedContentWithFallback;
  readonly difficulty: DifficultyLevel;
  readonly estimatedTime: number;
  readonly order: number;
  readonly iconName?: string;
  readonly color?: string;
  readonly tags?: readonly string[];
  readonly prerequisites?: readonly string[];
  readonly isLocked?: boolean;
  readonly version?: string;
  readonly author?: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface LessonContent {
  readonly introduction: LocalizedContentWithFallback;
  readonly theory?: LocalizedContentWithFallback;
  readonly summary?: LocalizedContentWithFallback;
  readonly keyPoints?: readonly LocalizedContentWithFallback[];
  readonly resources?: readonly {
    readonly title: LocalizedContentWithFallback;
    readonly url: string;
    readonly type: "video" | "article" | "book" | "game";
  }[];
}

export interface Lesson extends LessonMetadata {
  readonly content: LessonContent;
  readonly exercises: readonly LessonExercise[];
  readonly fen?: string;
}

export interface GroupConfig {
  readonly label: LocalizedContentWithFallback;
  readonly description: LocalizedContentWithFallback;
  readonly order: number;
  readonly iconName?: string;
  readonly color?: string;
}

export interface UIConfig {
  readonly groups: Record<LessonGroup, GroupConfig>;
  readonly icons: Record<string, ReactNode>;
  readonly colors: Record<string, string>;
  readonly themes?: Record<string, Record<string, string>>;
}

export interface ExerciseProgress {
  readonly exerciseId: string;
  readonly lessonId: string;
  readonly isCompleted: boolean;
  readonly attempts: number;
  readonly bestTime?: number;
  readonly lastAttempted?: Date;
  readonly completedAt?: Date;
  readonly score?: number;
  readonly variationsCompleted: readonly string[];
}

export interface LessonProgress {
  readonly lessonId: string;
  readonly isUnlocked: boolean;
  readonly isStarted: boolean;
  readonly isCompleted: boolean;
  readonly completedExercises: number;
  readonly totalExercises: number;
  readonly timeSpent: number;
  readonly averageScore?: number;
  readonly lastAccessed?: Date;
  readonly completedAt?: Date;
}

export const lessonData: readonly Lesson[] = [
  {
    id: "chess-pieces",
    group: LessonGroup.PIECE_MOVEMENT,
    title: { default: "Chess Pieces" },
    description: { default: "Learn how each chess piece moves and captures on the board." },
    difficulty: DifficultyLevel.BEGINNER,
    estimatedTime: 10,
    order: 1,
    iconName: "chess-piece",
    color: "blue",
    tags: ["pieces", "movement", "fundamentals"],
    content: {
      introduction: {
        default: "Each chess piece moves in a unique way. Understanding how pieces move is the foundation of chess.",
      },
      theory: {
        default:
          "The pawn moves forward one square, but captures diagonally. The knight moves in an L-shape. The bishop moves diagonally. The rook moves horizontally and vertically. The queen combines the power of the bishop and rook. The king moves one square in any direction.",
      },
      keyPoints: [
        { default: "Each piece has its own unique movement pattern" },
        { default: "Pawns are the only pieces that move differently than they capture" },
        { default: "The knight is the only piece that can jump over other pieces" },
        { default: "The queen is the most powerful piece, combining rook and bishop moves" },
      ],
    },
    fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    exercises: [
      {
        id: "rook-movement",
        title: { default: "The Rook" },
        description: { default: "Learn how the rook moves in straight lines" },
        order: 1,
        tags: ["rook", "linear-movement"],
        gameData: {
          variations: [
            {
              id: "rook-center",
              fen: "8/8/8/8/4R3/8/8/8 w - - 0 1",
              correctMoves: [
                "e4e5",
                "e4e6",
                "e4e7",
                "e4e8",
                "e4e3",
                "e4e2",
                "e4e1",
                "e4d4",
                "e4c4",
                "e4b4",
                "e4a4",
                "e4f4",
                "e4g4",
                "e4h4",
              ],
              description: { default: "Move the rook to any valid square" },
              hints: [
                { default: "Rooks move in straight lines - horizontally and vertically" },
                { default: "Try moving along the rank (horizontal) or file (vertical)" },
              ],
            },
          ],
        },
      },
      {
        id: "bishop-movement",
        title: { default: "The Bishop" },
        description: { default: "Learn how the bishop moves diagonally" },
        order: 2,
        tags: ["bishop", "diagonal-movement"],
        gameData: {
          variations: [
            {
              id: "bishop-center",
              fen: "8/8/8/8/4B3/8/8/8 w - - 0 1",
              correctMoves: [
                "e4d5",
                "e4c6",
                "e4b7",
                "e4a8",
                "e4f5",
                "e4g6",
                "e4h7",
                "e4d3",
                "e4c2",
                "e4b1",
                "e4f3",
                "e4g2",
                "e4h1",
              ],
              description: { default: "Move the bishop to any valid square" },
              hints: [
                { default: "Bishops move diagonally only" },
                { default: "This bishop can move to any diagonal square from its current position" },
              ],
            },
          ],
        },
      },
      {
        id: "queen-movement",
        title: { default: "The Queen" },
        description: { default: "The queen combines rook and bishop movements" },
        order: 3,
        tags: ["queen", "combined-movement"],
        prerequisites: ["rook-movement", "bishop-movement"],
        gameData: {
          variations: [
            {
              id: "queen-center",
              fen: "8/8/8/8/4Q3/8/8/8 w - - 0 1",
              correctMoves: [
                "e4e5",
                "e4e6",
                "e4e7",
                "e4e8",
                "e4e3",
                "e4e2",
                "e4e1",
                "e4d4",
                "e4c4",
                "e4b4",
                "e4a4",
                "e4f4",
                "e4g4",
                "e4h4",

                "e4d5",
                "e4c6",
                "e4b7",
                "e4a8",
                "e4f5",
                "e4g6",
                "e4h7",
                "e4d3",
                "e4c2",
                "e4b1",
                "e4f3",
                "e4g2",
                "e4h1",
              ],
              description: { default: "Move the queen using either rook or bishop movement" },
              hints: [
                { default: "The queen combines the power of rook and bishop" },
                { default: "It can move in any straight line - horizontal, vertical, or diagonal" },
              ],
            },
          ],
        },
      },
      {
        id: "king-movement",
        title: { default: "The King" },
        description: { default: "The most important piece - protect it at all costs" },
        order: 4,
        tags: ["king", "limited-movement"],
        gameData: {
          variations: [
            {
              id: "king-center",
              fen: "8/8/8/8/4K3/8/8/8 w - - 0 1",
              correctMoves: ["e4e5", "e4e3", "e4d4", "e4f4", "e4d5", "e4f5", "e4d3", "e4f3"],
              description: { default: "Move the king to any adjacent square" },
              hints: [
                { default: "The king moves one square in any direction" },
                { default: "The king is the most important piece - losing it means losing the game" },
              ],
            },
          ],
        },
      },
      {
        id: "knight-movement",
        title: { default: "The Knight" },
        description: { default: "Learn the unique L-shaped movement" },
        order: 5,
        tags: ["knight", "l-shape"],
        gameData: {
          variations: [
            {
              id: "knight-center",
              fen: "8/8/8/8/4N3/8/8/8 w - - 0 1",
              correctMoves: ["e4d6", "e4f6", "e4c5", "e4g5", "e4c3", "e4g3", "e4d2", "e4f2"],
              description: { default: "Move the knight in its unique L-shape" },
              hints: [
                { default: "Knights move in an L-shape: 2 squares in one direction, then 1 square perpendicular" },
                { default: "Knights are the only pieces that can jump over other pieces" },
              ],
            },
          ],
        },
      },
      {
        id: "pawn-movement",
        title: { default: "The Pawn" },
        description: { default: "Learn basic pawn movement" },
        order: 6,
        tags: ["pawn", "forward-movement"],
        gameData: {
          variations: [
            {
              id: "pawn-advance",
              fen: "8/8/8/8/4P3/8/8/8 w - - 0 1",
              correctMoves: ["e4e5"],
              description: { default: "Move the pawn forward one square" },
              hints: [
                { default: "Pawns move forward one square at a time" },
                { default: "Pawns cannot move backwards" },
              ],
            },
          ],
        },
      },
    ],
  },
  {
    id: "fundamentals",
    group: LessonGroup.FUNDAMENTALS,
    title: { default: "Chess Fundamentals" },
    description: { default: "Learn the basic rules and checkmate patterns." },
    difficulty: DifficultyLevel.BEGINNER,
    estimatedTime: 15,
    order: 2,
    iconName: "foundation",
    color: "green",
    tags: ["fundamentals", "checkmate", "rules"],
    prerequisites: ["chess-pieces"],
    content: {
      introduction: {
        default: "Now that you know how pieces move, let's learn the fundamental concepts of chess.",
      },
      theory: {
        default:
          "Checkmate is the ultimate goal in chess. It occurs when the king is in check and has no legal moves to escape. In this lesson, you'll learn some basic checkmate patterns and essential rules.",
      },
      keyPoints: [
        { default: "Checkmate is the goal - trap the enemy king with no escape" },
        { default: "Capturing enemy pieces gives you material advantage" },
        { default: "Always keep your king safe from attacks" },
        { default: "Learn to recognize check and how to escape it" },
      ],
    },
    fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    exercises: [
      {
        id: "capture",
        title: { default: "Capturing Pieces" },
        description: { default: "Learn to capture enemy pieces" },
        order: 1,
        tags: ["capture", "tactics"],
        gameData: {
          variations: [
            {
              id: "capture-bishop",
              fen: "8/8/2k5/8/3n4/6Q1/5B2/4K3 w - - 0 1",
              correctMoves: ["f2d4"],
              description: { default: "Capture the enemy knight with your bishop" },
              hints: [
                { default: "Look for enemy pieces you can capture" },
                { default: "The bishop on f2 can capture the knight on d4" },
              ],
            },
            {
              id: "capture-knight",
              fen: "8/8/2k5/8/2b5/Q3N3/8/4K3 w - - 0 1",
              correctMoves: ["e3c4"],
              description: { default: "Capture the enemy bishop with your knight" },
              hints: [
                { default: "Knights move in an L-shape" },
                { default: "The knight can jump to c4 and capture the bishop" },
              ],
            },
          ],
        },
      },
      {
        id: "protection",
        title: { default: "Protecting Pieces" },
        description: { default: "Learn to keep your pieces safe" },
        order: 2,
        tags: ["protection", "defense"],
        gameData: {
          variations: [
            {
              id: "protect-knight",
              fen: "8/8/5k1b/8/8/2K1N3/Q7/8 w - - 0 1",
              correctMoves: ["e3c4", "e3g4", "c2d1", "c2f2"],
              description: { default: "Move your knight to safety or protect it" },
              hints: [
                { default: "The knight on e3 is attacked by the bishop on h6" },
                { default: "Either move the knight to safety or protect it with another piece" },
              ],
            },
          ],
        },
      },
      {
        id: "check-in-one",
        title: { default: "Giving Check" },
        description: { default: "Learn to attack the enemy king" },
        order: 3,
        tags: ["check", "attack"],
        gameData: {
          variations: [
            {
              id: "queen-check",
              fen: "8/8/8/5k2/1Q6/8/8/2K5 w - - 0 1",
              correctMoves: ["b4b5"],
              description: { default: "Give check to the enemy king" },
              hints: [
                { default: "Check means attacking the enemy king" },
                { default: "Move your queen to attack the king on f5" },
              ],
            },
          ],
        },
      },
      {
        id: "out-of-check",
        title: { default: "Escaping Check" },
        description: { default: "Learn to defend your king" },
        order: 4,
        tags: ["check", "defense", "king-safety"],
        gameData: {
          variations: [
            {
              id: "king-escape",
              fen: "8/8/8/2r1k3/8/8/8/2K5 b - - 0 1",
              correctMoves: ["c1b1", "c1b2", "c1d1", "c1d2"],
              description: { default: "Move your king out of check" },
              hints: [
                { default: "Your king is in check from the rook on c5" },
                { default: "Move the king to a safe square" },
              ],
            },
            {
              id: "block-check",
              fen: "8/8/8/2r1k3/8/Q7/8/2K5 w - - 0 1",
              correctMoves: ["a3c5"],
              description: { default: "Block the check by capturing the attacking piece" },
              hints: [
                { default: "You can escape check by capturing the attacking piece" },
                { default: "Your queen can capture the rook giving check" },
              ],
            },
          ],
        },
      },
      {
        id: "mate-in-one",
        title: { default: "Checkmate in One" },
        description: { default: "Deliver checkmate to win the game" },
        order: 5,
        tags: ["checkmate", "tactics"],
        prerequisites: ["check-in-one", "out-of-check"],
        gameData: {
          variations: [
            {
              id: "queen-mate",
              fen: "7k/6pp/8/8/8/2Q5/8/K7 w - - 0 1",
              correctMoves: ["c3c8"],
              description: { default: "Deliver checkmate with your queen" },
              hints: [
                { default: "Checkmate means the king is in check and cannot escape" },
                { default: "Move your queen to c8 to deliver checkmate" },
              ],
            },
          ],
        },
      },
    ],
  },
  {
    id: "intermediate",
    group: LessonGroup.SPECIAL_MOVES,
    title: { default: "Special Moves" },
    description: { default: "Learn castling, en passant, and stalemate rules." },
    difficulty: DifficultyLevel.INTERMEDIATE,
    estimatedTime: 20,
    order: 3,
    iconName: "special",
    color: "orange",
    tags: ["special-moves", "rules"],
    prerequisites: ["fundamentals"],
    content: {
      introduction: {
        default: "Chess has several special moves and rules that are important to understand.",
      },
      theory: {
        default:
          "Castling allows you to safely tuck your king away while developing your rook. En passant is a special pawn capture. Stalemate occurs when a player has no legal moves but isn't in check - resulting in a draw.",
      },
      keyPoints: [
        { default: "Castling helps keep your king safe in the opening" },
        { default: "En passant prevents pawns from 'sneaking past' enemy pawns" },
        { default: "Stalemate is a draw - avoid it when you're winning!" },
        { default: "Understanding these rules is essential for competitive play" },
      ],
    },
    fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    exercises: [
      {
        id: "castling",
        title: { default: "Castling" },
        description: { default: "Learn the special king and rook move" },
        order: 1,
        tags: ["castling", "king-safety"],
        gameData: {
          variations: [
            {
              id: "kingside-castle",
              fen: "r1bqkbnr/ppp2ppp/2np4/4p3/4P3/3B1N2/PPPP1PPP/RNBQK2R w KQkq - 0 1",
              correctMoves: ["e1g1"],
              description: { default: "Castle kingside to safety" },
              hints: [
                { default: "Castling moves the king 2 squares toward the rook" },
                { default: "The rook jumps to the other side of the king" },
              ],
            },
          ],
        },
      },
      {
        id: "en-passant",
        title: { default: "En Passant" },
        description: { default: "Learn the special pawn capture" },
        order: 2,
        tags: ["en-passant", "pawn-capture"],
        gameData: {
          variations: [
            {
              id: "en-passant-capture",
              fen: "rnbqkbnr/p1p1pppp/1p6/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 1",
              correctMoves: ["e5d6"],
              description: { default: "Capture the pawn en passant" },
              hints: [
                { default: "En passant captures the pawn that just moved two squares" },
                { default: "Move to the square the enemy pawn 'passed over'" },
              ],
            },
          ],
        },
      },
      {
        id: "stalemate",
        title: { default: "Avoiding Stalemate" },
        description: { default: "Understand how stalemate works" },
        order: 3,
        tags: ["stalemate", "endgame"],
        gameData: {
          variations: [
            {
              id: "avoid-stalemate",
              fen: "k7/8/5B2/8/8/3K4/8/1R6 w - - 0 1",
              correctMoves: ["f6d4", "f6e5", "f6g5", "f6h4", "f6g7", "f6e7"],
              description: { default: "Move your bishop to avoid stalemate" },
              hints: [
                { default: "Don't move the bishop to squares that would create stalemate" },
                { default: "Keep some legal moves available for the enemy king" },
              ],
            },
          ],
        },
      },
    ],
  },
  {
    id: "advanced",
    group: LessonGroup.TACTICS,
    title: { default: "Advanced Tactics" },
    description: { default: "Master complex tactical patterns and combinations." },
    difficulty: DifficultyLevel.ADVANCED,
    estimatedTime: 30,
    order: 4,
    iconName: "tactics",
    color: "purple",
    tags: ["advanced", "tactics", "combinations"],
    prerequisites: ["intermediate"],
    content: {
      introduction: {
        default: "Advanced tactics separate good players from great players.",
      },
      theory: {
        default:
          "Advanced tactics involve complex combinations of multiple tactical motifs. These include deflection, decoy, clearance, interference, and zwischenzug (intermediate move). Recognizing these patterns will significantly improve your calculation abilities and overall chess strength.",
      },
      keyPoints: [
        { default: "Calculate variations deeply and accurately" },
        { default: "Look for forcing moves: checks, captures, and threats" },
        { default: "Consider your opponent's defensive resources" },
        { default: "Practice pattern recognition to spot tactics quickly" },
      ],
    },
    fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    exercises: [
      {
        id: "piece-value",
        title: { default: "Understanding Piece Values" },
        description: { default: "Learn when trades are favorable" },
        order: 1,
        tags: ["piece-value", "trades"],
        gameData: {
          variations: [
            {
              id: "favorable-trade",
              fen: "k7/8/1q1b4/2P5/8/2QK4/8/8 w - - 0 1",
              correctMoves: ["c5b6"],
              description: { default: "Make a favorable trade" },
              hints: [
                { default: "Consider the relative values of the pieces" },
                { default: "Trading a pawn for a queen is an excellent trade!" },
              ],
            },
          ],
        },
      },
    ],
  },
] as const;

export class LessonDataManager {
  private static instance: LessonDataManager;

  private constructor(private data: readonly Lesson[]) {}

  static getInstance(data: readonly Lesson[] = lessonData): LessonDataManager {
    if (!LessonDataManager.instance) {
      LessonDataManager.instance = new LessonDataManager(data);
    }
    return LessonDataManager.instance;
  }

  getLessons(): readonly Lesson[] {
    return this.data;
  }

  getLessonsByGroup(group: LessonGroup): readonly Lesson[] {
    return this.data.filter((lesson) => lesson.group === group);
  }

  getLessonsByDifficulty(difficulty: DifficultyLevel): readonly Lesson[] {
    return this.data.filter((lesson) => lesson.difficulty === difficulty);
  }

  getLessonsByTags(tags: readonly string[]): readonly Lesson[] {
    return this.data.filter((lesson) => tags.some((tag) => lesson.tags?.includes(tag)));
  }

  getUnlockedLessons(completedLessonIds: readonly string[]): readonly Lesson[] {
    return this.data.filter(
      (lesson) => !lesson.prerequisites || lesson.prerequisites.every((prereq) => completedLessonIds.includes(prereq)),
    );
  }

  getLessonById(id: string): Lesson | undefined {
    return this.data.find((lesson) => lesson.id === id);
  }

  getExerciseById(exerciseId: string): { exercise: LessonExercise; lesson: Lesson } | undefined {
    for (const lesson of this.data) {
      const exercise = lesson.exercises.find((ex) => ex.id === exerciseId);
      if (exercise) {
        return { exercise, lesson };
      }
    }
    return undefined;
  }

  getNextLesson(currentLessonId: string): Lesson | undefined {
    const currentIndex = this.data.findIndex((lesson) => lesson.id === currentLessonId);
    return currentIndex >= 0 && currentIndex < this.data.length - 1 ? this.data[currentIndex + 1] : undefined;
  }

  getPreviousLesson(currentLessonId: string): Lesson | undefined {
    const currentIndex = this.data.findIndex((lesson) => lesson.id === currentLessonId);
    return currentIndex > 0 ? this.data[currentIndex - 1] : undefined;
  }

  getStatistics() {
    const totalExercises = this.data.reduce((sum, lesson) => sum + lesson.exercises.length, 0);
    const lessonsByDifficulty = {
      [DifficultyLevel.BEGINNER]: this.getLessonsByDifficulty(DifficultyLevel.BEGINNER).length,
      [DifficultyLevel.INTERMEDIATE]: this.getLessonsByDifficulty(DifficultyLevel.INTERMEDIATE).length,
      [DifficultyLevel.ADVANCED]: this.getLessonsByDifficulty(DifficultyLevel.ADVANCED).length,
    };

    return {
      totalLessons: this.data.length,
      totalExercises,
      lessonsByDifficulty,
      groups: Object.keys(LessonGroup).length,
      averageEstimatedTime: this.data.reduce((sum, lesson) => sum + lesson.estimatedTime, 0) / this.data.length,
    };
  }

  searchLessons(query: string): readonly Lesson[] {
    const lowerQuery = query.toLowerCase();
    return this.data.filter(
      (lesson) =>
        lesson.title.default.toLowerCase().includes(lowerQuery) ||
        lesson.description.default.toLowerCase().includes(lowerQuery) ||
        lesson.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery)),
    );
  }

  validateLessons(): readonly string[] {
    const errors: string[] = [];

    const lessonIds = this.data.map((lesson) => lesson.id);
    const duplicateLessonIds = lessonIds.filter((id, index) => lessonIds.indexOf(id) !== index);
    if (duplicateLessonIds.length > 0) {
      errors.push(`Duplicate lesson IDs: ${duplicateLessonIds.join(", ")}`);
    }

    for (const lesson of this.data) {
      if (lesson.prerequisites) {
        for (const prereqId of lesson.prerequisites) {
          if (!lessonIds.includes(prereqId)) {
            errors.push(`Lesson ${lesson.id} has invalid prerequisite: ${prereqId}`);
          }
        }
      }
    }

    return errors;
  }
}

export const uiConfig: UIConfig = {
  groups: {
    [LessonGroup.FUNDAMENTALS]: {
      label: { default: "Fundamentals" },
      description: { default: "Essential chess knowledge" },
      order: 1,
      iconName: "foundation",
      color: "blue",
    },
    [LessonGroup.PIECE_MOVEMENT]: {
      label: { default: "Piece Movement" },
      description: { default: "Learn how each piece moves" },
      order: 2,
      iconName: "chess-piece",
      color: "green",
    },
    [LessonGroup.SPECIAL_MOVES]: {
      label: { default: "Special Moves" },
      description: { default: "Castling, en passant, and more" },
      order: 3,
      iconName: "special",
      color: "orange",
    },
    [LessonGroup.TACTICS]: {
      label: { default: "Tactics" },
      description: { default: "Tactical patterns and combinations" },
      order: 4,
      iconName: "tactics",
      color: "red",
    },
    [LessonGroup.ENDGAMES]: {
      label: { default: "Endgames" },
      description: { default: "Essential endgame knowledge" },
      order: 5,
      iconName: "endgame",
      color: "purple",
    },
    [LessonGroup.OPENINGS]: {
      label: { default: "Openings" },
      description: { default: "Opening principles and theory" },
      order: 6,
      iconName: "opening",
      color: "yellow",
    },
    [LessonGroup.STRATEGY]: {
      label: { default: "Strategy" },
      description: { default: "Positional understanding" },
      order: 7,
      iconName: "strategy",
      color: "indigo",
    },
  },
  icons: {},
  colors: {
    blue: "#3b82f6",
    green: "#10b981",
    orange: "#f59e0b",
    red: "#ef4444",
    purple: "#8b5cf6",
    yellow: "#eab308",
    indigo: "#6366f1",
  },
};

export const lessons = lessonData;

export const lessonManager = LessonDataManager.getInstance();
