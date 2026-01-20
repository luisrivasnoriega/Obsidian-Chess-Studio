-- BULK INSERT OPTIMIZED SQLite PRAGMAs
-- These settings maximize insert performance during bulk imports
-- WARNING: These are aggressive settings - only use during controlled bulk imports

-- Disable journal for maximum speed (no rollback capability during bulk)
PRAGMA journal_mode = OFF;

-- Keep synchronous NORMAL for safety (user requirement)
PRAGMA synchronous = NORMAL;

-- Disable foreign key checks during bulk insert (re-enable after)
PRAGMA foreign_keys = OFF;

-- Store temporary tables/indexes in memory
PRAGMA temp_store = MEMORY;

-- Use memory-mapped I/O (1GB for large imports)
PRAGMA mmap_size = 1073741824;

-- Increase cache size to 200MB (negative = KB)
PRAGMA cache_size = -200000;

-- Exclusive locking mode (prevents other connections)
PRAGMA locking_mode = EXCLUSIVE;

-- Disable change counting overhead
PRAGMA count_changes = OFF;
