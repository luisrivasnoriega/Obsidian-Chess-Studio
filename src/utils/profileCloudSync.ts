import { invoke } from "@tauri-apps/api/core";

const LEGACY_CONFIG_STORAGE_KEY = "ocs-profile-cloud-sync-config";
const LEGACY_STATE_STORAGE_PREFIX = "ocs-profile-cloud-sync-state";
const LEGACY_DEVICE_ID_STORAGE_KEY = "ocs-profile-cloud-sync-device-id";

export const PROFILE_CLOUD_SYNC_TARGET = {
  profileName: "Isabella",
  platform: "lichess",
  username: "bethfisher94",
  userId: "bethfisher94",
} as const satisfies ProfileCloudSyncTarget;

export type ProfileCloudSyncPlatform = "lichess" | "chesscom";

export type ProfileCloudSyncTarget = {
  profileName: string;
  platform: ProfileCloudSyncPlatform;
  username: string;
  userId: string;
};

export const PROFILE_CLOUD_SYNC_TARGETS = [
  PROFILE_CLOUD_SYNC_TARGET,
  {
    profileName: "Kevin",
    platform: "chesscom",
    username: "kevin09877",
    userId: "kevin09877",
  },
] as const satisfies readonly ProfileCloudSyncTarget[];

export type ProfileCloudRemoteState = {
  userId: string;
  currentRevision: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  updatedAt: string;
  updatedByDevice: string;
};

export type ProfileCloudSyncResult =
  | { status: "uploaded"; state: ProfileCloudRemoteState }
  | { status: "downloaded"; state: ProfileCloudRemoteState; packageJson: string }
  | { status: "unchanged"; state: ProfileCloudRemoteState }
  | { status: "conflict"; state: ProfileCloudRemoteState; localSha256: string; localRevision: string | null };

export type ProfileCloudSyncStatus = {
  configured: boolean;
  missing: string[];
};

type ProfileCloudSyncTargetProfile = {
  id: string;
  name: string;
};

type ProfileCloudSyncTargetSession = {
  profileId?: string;
  lichess?: {
    username: string;
  };
  chessCom?: {
    username: string;
  };
};

function normalizeTargetValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function targetSessionUsername(session: ProfileCloudSyncTargetSession, target: ProfileCloudSyncTarget): string | null {
  if (target.platform === "lichess") return session.lichess?.username ?? null;
  return session.chessCom?.username ?? null;
}

export function profileCloudSyncPlatformLabel(target: ProfileCloudSyncTarget): string {
  return target.platform === "chesscom" ? "Chess.com" : "Lichess";
}

export function describeProfileCloudSyncTarget(target: ProfileCloudSyncTarget): string {
  return `${target.profileName} / ${profileCloudSyncPlatformLabel(target)} ${target.username}`;
}

export function getProfileCloudSyncTarget(
  profile: ProfileCloudSyncTargetProfile | null | undefined,
  sessions: ProfileCloudSyncTargetSession[],
): ProfileCloudSyncTarget | null {
  if (!profile) return null;

  return (
    PROFILE_CLOUD_SYNC_TARGETS.find((target) => {
      if (normalizeTargetValue(profile.name) !== normalizeTargetValue(target.profileName)) {
        return false;
      }
      return sessions.some(
        (session) =>
          session.profileId === profile.id &&
          normalizeTargetValue(targetSessionUsername(session, target)) === normalizeTargetValue(target.username),
      );
    }) ?? null
  );
}

export function isProfileCloudSyncTarget(
  profile: ProfileCloudSyncTargetProfile | null | undefined,
  sessions: ProfileCloudSyncTargetSession[],
): boolean {
  return getProfileCloudSyncTarget(profile, sessions) !== null;
}

export function clearLegacyProfileCloudSyncStorage(): void {
  localStorage.removeItem(LEGACY_CONFIG_STORAGE_KEY);
  localStorage.removeItem(LEGACY_DEVICE_ID_STORAGE_KEY);
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(`${LEGACY_STATE_STORAGE_PREFIX}:`)) {
      localStorage.removeItem(key);
    }
  }
}

export async function getProfileCloudSyncStatus(): Promise<ProfileCloudSyncStatus> {
  return await invoke<ProfileCloudSyncStatus>("profile_cloud_sync_status");
}

export async function saveProfileCloudLocalState(
  targetUserId: string,
  profileId: string,
  state: ProfileCloudRemoteState,
): Promise<void> {
  await invoke("profile_cloud_sync_save_local_state", {
    targetUserId,
    profileId,
    state,
  });
}

export async function uploadProfilePackageToCloud(input: {
  targetUserId: string;
  profileId: string;
  packageJson: string;
}): Promise<ProfileCloudRemoteState> {
  return await invoke<ProfileCloudRemoteState>("profile_cloud_sync_upload", input);
}

export async function downloadProfilePackageFromCloud(input: {
  targetUserId: string;
}): Promise<{ state: ProfileCloudRemoteState; packageJson: string }> {
  return await invoke<{ state: ProfileCloudRemoteState; packageJson: string }>("profile_cloud_sync_download", input);
}

export async function syncProfilePackageWithCloud(input: {
  targetUserId: string;
  profileId: string;
  packageJson: string;
}): Promise<ProfileCloudSyncResult> {
  return await invoke<ProfileCloudSyncResult>("profile_cloud_sync_sync", input);
}
