import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function stripEnvForDesktopDev(env) {
  const nextEnv = { ...env };

  // When working on Android, developers often export these variables.
  // They can unintentionally force Cargo/Tauri into an Android target for desktop runs.
  const keysToUnset = [
    "CARGO_BUILD_TARGET",
    "TAURI_CLI_TARGET",
    "TAURI_DEV_TARGET",
    "TAURI_PLATFORM",
    "TAURI_TARGET_TRIPLE",
    "TAURI_TARGET",
  ];

  for (const key of keysToUnset) {
    delete nextEnv[key];
  }

  return nextEnv;
}

const args = process.argv.slice(2);

// We want:
// - `pnpm tauri dev` => desktop dev (do not inherit Android target env vars)
// - `pnpm tauri android dev` => Android dev (keep env as-is)
const isAndroidCommand = args[0] === "android";

const here = path.dirname(fileURLToPath(import.meta.url));
const tauriBin = path.resolve(
  here,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);

const spawnCommand =
  process.platform === "win32"
    ? {
        cmd: process.env.ComSpec ?? "cmd.exe",
        argv: ["/d", "/s", "/c", tauriBin, ...args],
      }
    : { cmd: tauriBin, argv: args };

let child;
try {
  child = spawn(spawnCommand.cmd, spawnCommand.argv, {
    stdio: "inherit",
    env: isAndroidCommand ? process.env : stripEnvForDesktopDev(process.env),
  });
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    `Failed to start Tauri CLI (cmd=${spawnCommand.cmd}): ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

child.on("error", (err) => {
  // Keep the error actionable; this usually means node_modules are not installed.
  // eslint-disable-next-line no-console
  console.error(`Failed to run Tauri CLI at ${tauriBin}: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
