CREATE TABLE IF NOT EXISTS profile_sync (
  user_id TEXT PRIMARY KEY,
  current_revision TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_device TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_revisions (
  revision TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by_device TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_revisions_user_created_at
ON profile_revisions (user_id, created_at DESC);
