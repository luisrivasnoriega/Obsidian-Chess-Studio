import { fetch } from "@tauri-apps/plugin-http";

const VERIFICATION_BASE_URL =
  "https://ocsverification20260122235102-bjhggaeuffg9cwdz.eastus-01.azurewebsites.net/api/OCS_Verification";

export type Platform = "Lichess" | "Chesscom";

async function readBool(response: Response): Promise<boolean> {
  // ASP.NET typically returns JSON boolean (true/false). But we handle text too.
  const text = (await response.text()).trim();

  if (text === "true") return true;
  if (text === "false") return false;

  // If it ever returns JSON like "true" (quoted) or { ... }, try JSON parse.
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "boolean") return parsed;
    if (typeof parsed === "string") return parsed.toLowerCase().trim() === "true";
    if (typeof parsed === "number") return parsed === 1;
  } catch {
    // ignore
  }

  // If we can't parse, treat as failure-safe false.
  return false;
}

/**
 * Verifies if an account can be added without credentials
 * Backend semantics: returns true if (platform|user) DOES NOT exist, false if it exists.
 */
export async function verifyAccount(platform: Platform, user: string): Promise<boolean> {
  const url =
    `${VERIFICATION_BASE_URL}/verify?Platform=${encodeURIComponent(platform)}` + `&User=${encodeURIComponent(user)}`;

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) return false;

  return await readBool(response);
}

/**
 * Validates user credentials
 * Your backend Validate uses the SAME mechanism:
 * - returns false if (user|password) exists
 * - returns true if it does not exist
 *
 * But "valid credentials" should be true ONLY when the pair exists,
 * so we INVERT the server result.
 */
export async function validateCredentials(user: string, password: string): Promise<boolean> {
  const url =
    `${VERIFICATION_BASE_URL}/validate?User=${encodeURIComponent(user)}` + `&Password=${encodeURIComponent(password)}`;

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) return false;

  const serverSaysAllowed = await readBool(response);
  // Pair exists => serverSaysAllowed = false => valid credentials = true
  return !serverSaysAllowed;
}
