export interface Env {
  PROFILE_SYNC_BUCKET: R2Bucket;
  PROFILE_SYNC_DB: D1Database;
  SYNC_AUTH_TOKEN?: string;
}

type ProfileSyncRow = {
  user_id: string;
  current_revision: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
  updated_at: string;
  updated_by_device: string;
};

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const ALLOWED_USER_ID = "bethfisher94";

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...init.headers,
    },
  });
}

function text(value: string, init: ResponseInit = {}) {
  return new Response(value, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...corsHeaders(),
      ...init.headers,
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,x-ocs-base-revision,x-ocs-device-id,x-ocs-revision,x-ocs-sha256,x-ocs-size-bytes",
  };
}

function requireAuth(request: Request, env: Env): Response | null {
  const expected = env.SYNC_AUTH_TOKEN?.trim();
  if (!expected) return null;
  const actual = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (actual === expected) return null;
  return text("Unauthorized", { status: 401 });
}

function required(value: string | null, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function requireAllowedUser(userId: string): Response | null {
  if (userId.trim().toLowerCase() === ALLOWED_USER_ID) return null;
  return text("This sync endpoint is limited to bethfisher94", { status: 403 });
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function toState(row: ProfileSyncRow) {
  return {
    userId: row.user_id,
    currentRevision: row.current_revision,
    objectKey: row.object_key,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    updatedAt: row.updated_at,
    updatedByDevice: row.updated_by_device,
  };
}

async function getState(env: Env, userId: string): Promise<ProfileSyncRow | null> {
  return env.PROFILE_SYNC_DB.prepare(
    `SELECT user_id, current_revision, object_key, sha256, size_bytes, updated_at, updated_by_device
     FROM profile_sync
     WHERE user_id = ?`,
  )
    .bind(userId)
    .first<ProfileSyncRow>();
}

async function handleState(request: Request, env: Env) {
  const auth = requireAuth(request, env);
  if (auth) return auth;

  const url = new URL(request.url);
  const userId = required(url.searchParams.get("userId"), "userId");
  const allowed = requireAllowedUser(userId);
  if (allowed) return allowed;

  const state = await getState(env, userId);
  if (!state) {
    return text("Not found", { status: 404 });
  }
  return json(toState(state));
}

async function handleDownload(request: Request, env: Env) {
  const auth = requireAuth(request, env);
  if (auth) return auth;

  const url = new URL(request.url);
  const userId = required(url.searchParams.get("userId"), "userId");
  const allowed = requireAllowedUser(userId);
  if (allowed) return allowed;

  const state = await getState(env, userId);
  if (!state) {
    return text("Not found", { status: 404 });
  }

  const object = await env.PROFILE_SYNC_BUCKET.get(state.object_key);
  if (!object) {
    return text("Object not found", { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      ...corsHeaders(),
      "content-type": "application/octet-stream",
      "x-ocs-revision": state.current_revision,
      "x-ocs-sha256": state.sha256,
      "x-ocs-size-bytes": String(state.size_bytes),
      etag: object.httpEtag,
    },
  });
}

async function handleUpload(request: Request, env: Env) {
  const auth = requireAuth(request, env);
  if (auth) return auth;

  const url = new URL(request.url);
  const userId = required(url.searchParams.get("userId"), "userId");
  const allowed = requireAllowedUser(userId);
  if (allowed) return allowed;

  const revision = required(request.headers.get("x-ocs-revision"), "x-ocs-revision");
  const sha256 = required(request.headers.get("x-ocs-sha256"), "x-ocs-sha256");
  const deviceId = required(request.headers.get("x-ocs-device-id"), "x-ocs-device-id");
  const baseRevision = request.headers.get("x-ocs-base-revision")?.trim() || null;
  const declaredSize = Number.parseInt(request.headers.get("x-ocs-size-bytes") ?? "0", 10);

  if (!Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > MAX_UPLOAD_BYTES) {
    return text("Invalid upload size", { status: 413 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength !== declaredSize) {
    return text("Upload size mismatch", { status: 400 });
  }

  const current = await getState(env, userId);
  if ((current?.current_revision ?? null) !== baseRevision) {
    return json(
      {
        error: "conflict",
        current: current ? toState(current) : null,
      },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const objectKey = `users/${safeSegment(userId)}/profile/revisions/${safeSegment(revision)}.ocs-profile.enc`;
  await env.PROFILE_SYNC_BUCKET.put(objectKey, body, {
    httpMetadata: {
      contentType: "application/octet-stream",
    },
    customMetadata: {
      userId,
      revision,
      sha256,
      deviceId,
      createdAt: now,
    },
  });

  await env.PROFILE_SYNC_DB.prepare(
    `INSERT INTO profile_revisions
       (revision, user_id, object_key, sha256, size_bytes, created_at, created_by_device)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(revision, userId, objectKey, sha256, declaredSize, now, deviceId)
    .run();

  if (current) {
    const result = await env.PROFILE_SYNC_DB.prepare(
      `UPDATE profile_sync
       SET current_revision = ?, object_key = ?, sha256 = ?, size_bytes = ?, updated_at = ?, updated_by_device = ?
       WHERE user_id = ? AND current_revision = ?`,
    )
      .bind(revision, objectKey, sha256, declaredSize, now, deviceId, userId, baseRevision)
      .run();

    if (result.meta.changes === 0) {
      return json({ error: "conflict", current: await getState(env, userId) }, { status: 409 });
    }
  } else {
    await env.PROFILE_SYNC_DB.prepare(
      `INSERT INTO profile_sync
         (user_id, current_revision, object_key, sha256, size_bytes, updated_at, updated_by_device)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(userId, revision, objectKey, sha256, declaredSize, now, deviceId)
      .run();
  }

  const next = await getState(env, userId);
  return json(toState(next!));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/sync/profile/state") {
        return await handleState(request, env);
      }
      if (request.method === "GET" && url.pathname === "/sync/profile/download") {
        return await handleDownload(request, env);
      }
      if (request.method === "POST" && url.pathname === "/sync/profile/upload") {
        return await handleUpload(request, env);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }
      return text("Not found", { status: 404 });
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), { status: 400 });
    }
  },
};
