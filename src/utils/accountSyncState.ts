import { invoke } from "@tauri-apps/api/core";

export type AccountSyncPlatform = "lichess" | "chesscom";

export type AccountSyncState = {
  account_key: string;
  platform: string;
  cursor_until_ms: number | null;
  since_ms?: number | null;
  mode?: string;
  total_batches: number;
  completed_batches: number;
  running: boolean;
  updated_at_ms: number;
};

export async function getAccountSyncState(input: {
  dbPath: string;
  accountKey: string;
  platform: AccountSyncPlatform;
}): Promise<AccountSyncState | null> {
  return await invoke<AccountSyncState | null>("get_account_sync_state", {
    dbPath: input.dbPath,
    accountKey: input.accountKey,
    platform: input.platform,
  });
}

export async function upsertAccountSyncState(input: { dbPath: string; state: AccountSyncState }): Promise<void> {
  await invoke("upsert_account_sync_state", {
    dbPath: input.dbPath,
    syncState: input.state,
  });
}

export async function markAccountSyncBatchComplete(input: {
  dbPath: string;
  accountKey: string;
  platform: AccountSyncPlatform;
  batchId: string;
  completedAtMs: number;
}): Promise<void> {
  await invoke("mark_account_sync_batch_complete", {
    dbPath: input.dbPath,
    accountKey: input.accountKey,
    platform: input.platform,
    batchId: input.batchId,
    completedAtMs: input.completedAtMs,
  });
}

export async function listAccountSyncCompletedBatches(input: {
  dbPath: string;
  accountKey: string;
  platform: AccountSyncPlatform;
}): Promise<string[]> {
  return await invoke<string[]>("list_account_sync_completed_batches", {
    dbPath: input.dbPath,
    accountKey: input.accountKey,
    platform: input.platform,
  });
}
