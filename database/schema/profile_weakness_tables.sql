-- Profile-only weakness model tables for Obsidian Chess Studio.
-- These tables persist per-game extracted features and aggregated weakness snapshots.

CREATE TABLE IF NOT EXISTS WeaknessGameFeatures (
    GameID INTEGER PRIMARY KEY NOT NULL,
    ModelVersion INTEGER NOT NULL DEFAULT 1,
    ComputedAt TEXT NOT NULL,
    OpeningFamily TEXT,
    TimeControlBucket TEXT,
    ColorPlayed TEXT,
    PlyBucketFeaturesJson TEXT NOT NULL DEFAULT '{}',
    FeaturesJson TEXT NOT NULL DEFAULT '{}',
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (GameID) REFERENCES Games(ID) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS WeaknessGameFeatures_OpeningFamily_idx
    ON WeaknessGameFeatures(OpeningFamily);

CREATE INDEX IF NOT EXISTS WeaknessGameFeatures_TimeControlBucket_idx
    ON WeaknessGameFeatures(TimeControlBucket);

CREATE INDEX IF NOT EXISTS WeaknessGameFeatures_ColorPlayed_idx
    ON WeaknessGameFeatures(ColorPlayed);

CREATE TABLE IF NOT EXISTS WeaknessSignalSnapshot (
    SnapshotKey TEXT NOT NULL,
    SignalKey TEXT NOT NULL,
    ModelVersion INTEGER NOT NULL DEFAULT 1,
    GeneratedAt TEXT NOT NULL,
    FiltersJson TEXT NOT NULL DEFAULT '{}',
    Title TEXT NOT NULL DEFAULT '',
    TriggerText TEXT NOT NULL DEFAULT '',
    AttackPlan TEXT NOT NULL DEFAULT '',
    Score REAL NOT NULL DEFAULT 0,
    Severity REAL NOT NULL DEFAULT 0,
    Confidence REAL NOT NULL DEFAULT 0,
    Controllability REAL NOT NULL DEFAULT 0,
    Recency REAL NOT NULL DEFAULT 0,
    Support INTEGER NOT NULL DEFAULT 0,
    NEff REAL,
    ImpactJson TEXT NOT NULL DEFAULT '{}',
    TriggerJson TEXT NOT NULL DEFAULT '{}',
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (SnapshotKey, SignalKey)
);

CREATE INDEX IF NOT EXISTS WeaknessSignalSnapshot_SnapshotKeyScore_idx
    ON WeaknessSignalSnapshot(SnapshotKey, Score);

CREATE TABLE IF NOT EXISTS WeaknessEvidence (
    SnapshotKey TEXT NOT NULL,
    SignalKey TEXT NOT NULL,
    EvidenceRank INTEGER NOT NULL DEFAULT 0,
    GameID INTEGER,
    PlyFrom INTEGER,
    PlyTo INTEGER,
    EvidenceText TEXT NOT NULL DEFAULT '',
    EvidenceJson TEXT NOT NULL DEFAULT '{}',
    CreatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (SnapshotKey, SignalKey, EvidenceRank),
    FOREIGN KEY (SnapshotKey, SignalKey)
        REFERENCES WeaknessSignalSnapshot(SnapshotKey, SignalKey)
        ON DELETE CASCADE,
    FOREIGN KEY (GameID)
        REFERENCES Games(ID)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS WeaknessEvidence_GameID_idx
    ON WeaknessEvidence(GameID);
