import { appDataDir } from "@tauri-apps/api/path";
import { getDefaultStore } from "jotai";
import { commands } from "@/bindings";
import { enginesAtom } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import { requiredEngineSettings } from "@/utils/engines";
import { unwrap } from "./unwrap";

/**
 * Auto-detects and registers bundled engines (e.g., Stockfish on Android)
 * that are included in the app assets but not yet in the engines storage.
 */
export async function autoRegisterBundledEngines(): Promise<void> {
  const log = await import("@tauri-apps/plugin-log").catch(() => null);
  const info: (msg: string) => Promise<void> | void = log?.info ?? ((msg) => console.log(msg));
  const warn: (msg: string) => Promise<void> | void = log?.warn ?? ((msg) => console.warn(msg));
  const logError: (msg: string) => Promise<void> | void = log?.error ?? ((msg) => console.error(msg));

  try {
    await info("Starting auto-registration of bundled engines");

    const store = getDefaultStore();
    const currentEngines = await store.get(enginesAtom);
    const localEngines = currentEngines.filter((e): e is LocalEngine => e.type === "local");
    info(`Current engines count: ${currentEngines.length}, local engines: ${localEngines.length}`);

    // Check for bundled Stockfish on Android
    const platform = await import("@tauri-apps/plugin-os").then((m) => m.platform());
    info(`Platform detected: ${platform}`);

    if (platform === "android") {
      const appDataDirPath = await appDataDir();
      info(`App data dir: ${appDataDirPath}`);

      // We register Stockfish using a logical path and rely on the backend resolver:
      // - app data dir: engines/stockfish
      // - nativeLibraryDir: libstockfish.so (copied from build into jniLibs)
      // This avoids fragile resourceDir paths and works even on devices that block exec in app data.
      const bundledStockfishPath = "engines/stockfish";

      if (bundledStockfishPath) {
        // Check if Stockfish is already registered
        const stockfishIndex = currentEngines.findIndex(
          (e) => e.type === "local" && e.name === "Stockfish" && (e as LocalEngine).version === "17.1",
        );
        const stockfishExists = stockfishIndex !== -1;

        if (!stockfishExists) {
          // Validate bundled engine availability via backend resolver.
          // Do NOT call `setFileAsExecutable` on Android with a logical path like `engines/stockfish`.
          // The backend will resolve this to a real executable path (native libs / filesDir) when spawning.
          //
          // Try to get engine config (with timeout fallback)
          let config: {
            name: string;
            options: { type: string; value: { name: string; default?: string | number | boolean | null } }[];
          } | null = null;
          try {
            config = unwrap(await commands.getEngineConfig(bundledStockfishPath)) as unknown as typeof config;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("Engine timeout")) {
              warn("Bundled Stockfish config detection timed out, using defaults");
              config = { name: "Stockfish", options: [] };
            } else {
              // If the bundled engine isn't actually available on this device/build, don't register a broken entry.
              warn(`Bundled Stockfish not available, skipping auto-registration: ${e}`);
              return;
            }
          }

          // Create engine entry with default settings
          const bundledEngine: LocalEngine = {
            type: "local",
            name: "Stockfish",
            version: "17.1",
            path: bundledStockfishPath,
            image: "https://upload.wikimedia.org/wikipedia/commons/3/3a/NewLogoSF.png",
            elo: 3635,
            installMethod: "bundled",
            loaded: true,
            settings:
              config && config.options.length > 0
                ? config.options
                    .filter((o) => requiredEngineSettings.includes(o.value.name))
                    .map((o) => {
                      let defaultValue: string | number | boolean = "";
                      switch (o.type) {
                        case "check":
                          defaultValue = o.value.default ?? false;
                          break;
                        case "spin":
                          defaultValue = Number(o.value.default ?? 0);
                          break;
                        case "combo":
                        case "string":
                          defaultValue = o.value.default ?? "";
                          break;
                        default:
                          defaultValue = "";
                      }
                      return {
                        name: o.value.name,
                        value: defaultValue,
                      };
                    })
                : [
                    { name: "MultiPV", value: "1" },
                    { name: "Threads", value: 1 },
                    { name: "Hash", value: 64 },
                  ],
          };

          // Add to engines storage
          await store.set(enginesAtom, [...currentEngines, bundledEngine]);
          info(`Auto-registered bundled Stockfish engine at: ${bundledStockfishPath}`);
        } else {
          // Migrate old absolute path (e.g. /data/user/0/.../files/engines/stockfish) to logical path.
          const existing = currentEngines[stockfishIndex] as LocalEngine;
          if (existing.installMethod === "bundled" && existing.path !== bundledStockfishPath) {
            const updated = [...currentEngines];
            updated[stockfishIndex] = { ...existing, path: bundledStockfishPath };
            await store.set(enginesAtom, updated);
            info(`Updated bundled Stockfish path to: ${bundledStockfishPath}`);
          } else {
            info("Stockfish already registered, skipping auto-registration");
          }
        }
      } else {
        warn("Bundled Stockfish not found");
      }
    } else {
      info(`Skipping bundled engine auto-registration (platform: ${platform})`);
    }
  } catch (error) {
    await logError(`Failed to auto-register bundled engines: ${error}`);
    // Don't throw - this is a non-critical initialization step
  }
}
