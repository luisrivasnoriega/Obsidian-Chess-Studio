const CONFIG_STORAGE_KEY = "ocs-profile-cloud-sync-config";
const STATE_STORAGE_PREFIX = "ocs-profile-cloud-sync-state";
const DEVICE_ID_STORAGE_KEY = "ocs-profile-cloud-sync-device-id";
const MAGIC = new Uint8Array([0x4f, 0x43, 0x53, 0x53, 0x59, 0x4e, 0x43, 0x31]);
const KDF_ITERATIONS = 150_000;

export const PROFILE_CLOUD_SYNC_TARGET = {
  profileName: "Isabella",
  lichessUsername: "bethfisher94",
  userId: "bethfisher94",
} as const;

export type ProfileCloudSyncConfig = {
  endpoint: string;
  userId: string;
  syncSecret: string;
  deviceId: string;
  authToken?: string;
};

export type ProfileCloudRemoteState = {
  userId: string;
  currentRevision: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  updatedAt: string;
  updatedByDevice: string;
};

export type ProfileCloudLocalState = {
  userId: string;
  profileId: string;
  revision: string;
  sha256: string;
  syncedAt: string;
  deviceId: string;
};

export type ProfileCloudSyncResult =
  | { status: "uploaded"; state: ProfileCloudRemoteState }
  | { status: "downloaded"; state: ProfileCloudRemoteState; packageJson: string }
  | { status: "unchanged"; state: ProfileCloudRemoteState }
  | { status: "conflict"; state: ProfileCloudRemoteState; localSha256: string; localRevision: string | null };

type EncryptedContainerHeader = {
  version: 1;
  alg: "AES-256-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  compression: "gzip" | "none";
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type ProfileCloudSyncTargetProfile = {
  id: string;
  name: string;
};

type ProfileCloudSyncTargetSession = {
  profileId?: string;
  lichess?: {
    username: string;
  };
};

function normalizeTargetValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function isProfileCloudSyncTarget(
  profile: ProfileCloudSyncTargetProfile | null | undefined,
  sessions: ProfileCloudSyncTargetSession[],
): boolean {
  if (!profile) return false;
  if (normalizeTargetValue(profile.name) !== normalizeTargetValue(PROFILE_CLOUD_SYNC_TARGET.profileName)) {
    return false;
  }

  return sessions.some(
    (session) =>
      session.profileId === profile.id &&
      normalizeTargetValue(session.lichess?.username) ===
        normalizeTargetValue(PROFILE_CLOUD_SYNC_TARGET.lichessUsername),
  );
}

function assertProfilePackageIsCloudSyncTarget(packageJson: string): void {
  const parsed = JSON.parse(packageJson) as {
    profile?: ProfileCloudSyncTargetProfile;
    sessions?: ProfileCloudSyncTargetSession[];
  } | null;

  const rawSessions = parsed?.sessions;
  const sessions = Array.isArray(rawSessions) ? rawSessions : [];
  if (!isProfileCloudSyncTarget(parsed?.profile, sessions)) {
    throw new Error(
      `Cloud sync is currently limited to profile ${PROFILE_CLOUD_SYNC_TARGET.profileName} linked to Lichess account ${PROFILE_CLOUD_SYNC_TARGET.lichessUsername}.`,
    );
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function getUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Ignore serialization errors.
  }
  return "Unknown error.";
}

function wrapCloudSyncError(phase: string, error: unknown): Error {
  const message = getUnknownErrorMessage(error);
  return new Error(message.startsWith(`${phase}:`) ? message : `${phase}: ${message}`);
}

function randomRevisionSuffix(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveKey(config: ProfileCloudSyncConfig, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(config.syncSecret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bytesToArrayBuffer(salt),
      iterations: KDF_ITERATIONS,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function compressPayload(bytes: Uint8Array): Promise<{ bytes: Uint8Array; compression: "gzip" | "none" }> {
  return { bytes, compression: "none" };
}

async function decompressPayload(bytes: Uint8Array, compression: "gzip" | "none"): Promise<Uint8Array> {
  if (compression === "none") return bytes;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This WebView cannot decompress cloud profile payloads.");
  }
  const stream = new Blob([bytesToArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function packEncryptedContainer(header: EncryptedContainerHeader, ciphertext: Uint8Array): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const out = new Uint8Array(MAGIC.length + 4 + headerBytes.length + ciphertext.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, headerBytes.length, false);
  out.set(headerBytes, MAGIC.length + 4);
  out.set(ciphertext, MAGIC.length + 4 + headerBytes.length);
  return out;
}

function unpackEncryptedContainer(container: Uint8Array): { header: EncryptedContainerHeader; ciphertext: Uint8Array } {
  if (container.length < MAGIC.length + 4) {
    throw new Error("Invalid cloud profile payload.");
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (container[i] !== MAGIC[i]) {
      throw new Error("Invalid cloud profile payload.");
    }
  }
  const headerLength = new DataView(container.buffer, container.byteOffset, container.byteLength).getUint32(
    MAGIC.length,
    false,
  );
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > container.length) {
    throw new Error("Invalid cloud profile payload.");
  }
  const header = JSON.parse(textDecoder.decode(container.subarray(headerStart, headerEnd))) as EncryptedContainerHeader;
  return { header, ciphertext: container.subarray(headerEnd) };
}

async function encryptPackageJson(
  packageJson: string,
  config: ProfileCloudSyncConfig,
): Promise<{ encrypted: Uint8Array; sha256: string }> {
  const plainBytes = textEncoder.encode(packageJson);
  const sha256 = await sha256Hex(plainBytes);
  const compressed = await compressPayload(plainBytes);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(config, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
      key,
      bytesToArrayBuffer(compressed.bytes),
    ),
  );
  const encrypted = packEncryptedContainer(
    {
      version: 1,
      alg: "AES-256-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      compression: compressed.compression,
    },
    ciphertext,
  );
  return { encrypted, sha256 };
}

async function decryptPackageJson(container: Uint8Array, config: ProfileCloudSyncConfig): Promise<string> {
  const { header, ciphertext } = unpackEncryptedContainer(container);
  if (header.version !== 1 || header.alg !== "AES-256-GCM" || header.kdf !== "PBKDF2-SHA256") {
    throw new Error("Unsupported cloud profile payload.");
  }
  const key = await deriveKey(config, base64ToBytes(header.salt));
  const plainCompressed = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesToArrayBuffer(base64ToBytes(header.iv)) },
      key,
      bytesToArrayBuffer(ciphertext),
    ),
  );
  const plain = await decompressPayload(plainCompressed, header.compression);
  return textDecoder.decode(plain);
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

function cloudSyncUserId(): string {
  return PROFILE_CLOUD_SYNC_TARGET.userId;
}

function apiUrl(config: ProfileCloudSyncConfig, path: string, query: Record<string, string | null | undefined> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value.length > 0) {
      params.set(key, value);
    }
  }
  const suffix = params.toString() ? `${path}?${params.toString()}` : path;
  return `${normalizeEndpoint(config.endpoint)}${suffix}`;
}

function authHeaders(config: ProfileCloudSyncConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.authToken?.trim()) {
    headers.Authorization = `Bearer ${config.authToken.trim()}`;
  }
  return headers;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(raw || `Cloud sync request failed (${response.status}).`);
  }
  return JSON.parse(raw) as T;
}

export function generateProfileCloudDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = `ocs-${bytesToBase64(bytes).replace(/[+/=]/g, "").toLowerCase()}`;
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  return id;
}

export function loadProfileCloudSyncConfig(): ProfileCloudSyncConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) ?? "{}") as Partial<ProfileCloudSyncConfig>;
    return {
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : "",
      userId: cloudSyncUserId(),
      syncSecret: typeof parsed.syncSecret === "string" ? parsed.syncSecret : "",
      deviceId:
        typeof parsed.deviceId === "string" && parsed.deviceId ? parsed.deviceId : generateProfileCloudDeviceId(),
      authToken: typeof parsed.authToken === "string" ? parsed.authToken : "",
    };
  } catch {
    return {
      endpoint: "",
      userId: cloudSyncUserId(),
      syncSecret: "",
      deviceId: generateProfileCloudDeviceId(),
      authToken: "",
    };
  }
}

export function saveProfileCloudSyncConfig(config: ProfileCloudSyncConfig): void {
  localStorage.setItem(
    CONFIG_STORAGE_KEY,
    JSON.stringify({
      endpoint: normalizeEndpoint(config.endpoint),
      userId: cloudSyncUserId(),
      syncSecret: config.syncSecret,
      deviceId: config.deviceId.trim() || generateProfileCloudDeviceId(),
      authToken: config.authToken?.trim() ?? "",
    }),
  );
}

export function validateProfileCloudSyncConfig(config: ProfileCloudSyncConfig): void {
  if (!config.endpoint.trim()) throw new Error("Cloud sync endpoint is required.");
  if (!config.syncSecret.trim()) throw new Error("Cloud sync key is required.");
  if (!config.deviceId.trim()) throw new Error("Cloud sync device ID is required.");
}

function localStateKey(profileId: string): string {
  return `${STATE_STORAGE_PREFIX}:${cloudSyncUserId()}:${profileId}`;
}

export function loadProfileCloudLocalState(profileId: string): ProfileCloudLocalState | null {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(localStateKey(profileId)) ?? "null",
    ) as ProfileCloudLocalState | null;
    return parsed?.profileId === profileId && parsed.userId === cloudSyncUserId() ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProfileCloudLocalState(
  config: ProfileCloudSyncConfig,
  profileId: string,
  state: ProfileCloudRemoteState,
): void {
  localStorage.setItem(
    localStateKey(profileId),
    JSON.stringify({
      userId: cloudSyncUserId(),
      profileId,
      revision: state.currentRevision,
      sha256: state.sha256,
      syncedAt: new Date().toISOString(),
      deviceId: config.deviceId.trim(),
    } satisfies ProfileCloudLocalState),
  );
}

export async function getProfileCloudState(config: ProfileCloudSyncConfig): Promise<ProfileCloudRemoteState | null> {
  validateProfileCloudSyncConfig(config);
  try {
    const response = await fetch(apiUrl(config, "/sync/profile/state", { userId: cloudSyncUserId() }), {
      method: "GET",
      headers: authHeaders(config),
    });
    if (response.status === 404) {
      return null;
    }
    return readJsonResponse<ProfileCloudRemoteState>(response);
  } catch (error) {
    throw wrapCloudSyncError("Load cloud profile state", error);
  }
}

async function uploadEncryptedProfile(input: {
  config: ProfileCloudSyncConfig;
  profileId: string;
  packageJson: string;
  baseRevision: string | null;
}): Promise<ProfileCloudRemoteState> {
  assertProfilePackageIsCloudSyncTarget(input.packageJson);
  const { encrypted, sha256 } = await encryptPackageJson(input.packageJson, input.config);
  const revision = `rev_${Date.now()}_${randomRevisionSuffix()}`;
  try {
    const response = await fetch(apiUrl(input.config, "/sync/profile/upload", { userId: cloudSyncUserId() }), {
      method: "POST",
      headers: {
        ...authHeaders(input.config),
        "content-type": "application/octet-stream",
        "x-ocs-base-revision": input.baseRevision ?? "",
        "x-ocs-device-id": input.config.deviceId.trim(),
        "x-ocs-revision": revision,
        "x-ocs-sha256": sha256,
        "x-ocs-size-bytes": String(encrypted.byteLength),
      },
      body: new Blob([bytesToArrayBuffer(encrypted)], { type: "application/octet-stream" }),
    });
    const state = await readJsonResponse<ProfileCloudRemoteState>(response);
    saveProfileCloudLocalState(input.config, input.profileId, state);
    return state;
  } catch (error) {
    throw wrapCloudSyncError("Upload cloud profile", error);
  }
}

export async function uploadProfilePackageToCloud(input: {
  config: ProfileCloudSyncConfig;
  profileId: string;
  packageJson: string;
}): Promise<ProfileCloudRemoteState> {
  const remote = await getProfileCloudState(input.config);
  return uploadEncryptedProfile({
    ...input,
    baseRevision: remote?.currentRevision ?? null,
  });
}

export async function downloadProfilePackageFromCloud(input: {
  config: ProfileCloudSyncConfig;
}): Promise<{ state: ProfileCloudRemoteState; packageJson: string }> {
  const state = await getProfileCloudState(input.config);
  if (!state) {
    throw new Error("No cloud profile has been uploaded yet.");
  }
  let encrypted: Uint8Array;
  try {
    const response = await fetch(apiUrl(input.config, "/sync/profile/download", { userId: cloudSyncUserId() }), {
      method: "GET",
      headers: authHeaders(input.config),
    });
    if (!response.ok) {
      throw new Error((await response.text()) || `Cloud sync download failed (${response.status}).`);
    }
    encrypted = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw wrapCloudSyncError("Download cloud profile payload", error);
  }

  let packageJson: string;
  try {
    packageJson = await decryptPackageJson(encrypted, input.config);
  } catch (error) {
    throw wrapCloudSyncError("Decrypt cloud profile payload", error);
  }

  try {
    assertProfilePackageIsCloudSyncTarget(packageJson);
  } catch (error) {
    throw wrapCloudSyncError("Validate cloud profile package", error);
  }

  const plainSha256 = await sha256Hex(textEncoder.encode(packageJson));
  if (!timingSafeStringEqual(plainSha256, state.sha256)) {
    throw new Error("Downloaded cloud profile failed integrity verification.");
  }
  return { state, packageJson };
}

export async function syncProfilePackageWithCloud(input: {
  config: ProfileCloudSyncConfig;
  profileId: string;
  packageJson: string;
}): Promise<ProfileCloudSyncResult> {
  validateProfileCloudSyncConfig(input.config);
  assertProfilePackageIsCloudSyncTarget(input.packageJson);
  const localSha256 = await sha256Hex(textEncoder.encode(input.packageJson));
  const remote = await getProfileCloudState(input.config);
  const localState = loadProfileCloudLocalState(input.profileId);

  if (!remote) {
    const state = await uploadEncryptedProfile({ ...input, baseRevision: null });
    return { status: "uploaded", state };
  }

  if (timingSafeStringEqual(remote.sha256, localSha256)) {
    saveProfileCloudLocalState(input.config, input.profileId, remote);
    return { status: "unchanged", state: remote };
  }

  const localChanged = localState?.sha256 !== localSha256;
  const remoteChanged = localState ? localState.revision !== remote.currentRevision : true;

  if (!localChanged && remoteChanged) {
    const downloaded = await downloadProfilePackageFromCloud(input);
    return { status: "downloaded", ...downloaded };
  }

  if (localChanged && !remoteChanged) {
    const state = await uploadEncryptedProfile({ ...input, baseRevision: remote.currentRevision });
    return { status: "uploaded", state };
  }

  return {
    status: "conflict",
    state: remote,
    localSha256,
    localRevision: localState?.revision ?? null,
  };
}
