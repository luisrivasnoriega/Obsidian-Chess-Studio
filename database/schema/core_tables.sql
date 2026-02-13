-- Core database schema for Obsidian Chess Studio
-- Contains the main table definitions for chess game storage

-- Info table: WITHOUT ROWID for better performance (Name is primary key)
CREATE TABLE Info (
    Name TEXT PRIMARY KEY NOT NULL,
    Value TEXT
) WITHOUT ROWID;

-- Events table: Cannot use WITHOUT ROWID with AUTOINCREMENT
-- AUTOINCREMENT requires rowid, so we keep standard table structure
CREATE TABLE Events (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT UNIQUE,
    EventType TEXT,
    Location TEXT,
    StartDate TEXT,
    EndDate TEXT,
    TimeControl TEXT
);

-- Sites table: Cannot use WITHOUT ROWID with AUTOINCREMENT
-- AUTOINCREMENT requires rowid, so we keep standard table structure
CREATE TABLE Sites (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT UNIQUE
);

-- Players table: MUST remain a rowid table.
-- We rely on SQLite's implicit rowid assignment when inserting without specifying ID.
CREATE TABLE Players (
    ID INTEGER PRIMARY KEY,
    Name TEXT UNIQUE,
    Elo INTEGER
);

CREATE TABLE Games (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    EventID INTEGER,
    SiteID INTEGER,
    Date TEXT,
    UTCTime TEXT,
    Round INTEGER,
    WhiteID INTEGER,
    WhiteElo INTEGER,
    BlackID INTEGER,
    BlackElo INTEGER,
    WhiteMaterial INTEGER,
    BlackMaterial INTEGER,
    Result INTEGER,
    Termination TEXT,
    TimeControl TEXT,
    ECO TEXT,
    PlyCount INTEGER,
    FEN TEXT,
    Moves BLOB,
    PawnHome BLOB,
    FOREIGN KEY(EventID) REFERENCES Events,
    FOREIGN KEY(SiteID) REFERENCES Sites,
    FOREIGN KEY(WhiteID) REFERENCES Players,
    FOREIGN KEY(BlackID) REFERENCES Players
);

-- Prevent duplicate games across repeated imports.
-- Matches the same criteria used by database/queries/games/delete_duplicates.sql
CREATE UNIQUE INDEX IF NOT EXISTS Games_Dedupe_UQ
ON Games (EventID, SiteID, Round, WhiteID, BlackID, Moves, Date, UTCTime);
