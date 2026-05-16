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
  try {
    const store = getDefaultStore();
    const currentEngines = await store.get(enginesAtom);

    // Check for bundled Stockfish on Android
    const platform = await import("@tauri-apps/plugin-os").then((m) => m.platform());

    if (platform === "android") {
      // We register Stockfish using a logical path and rely on the backend resolver:
      // - app data dir: engines/stockfish
      // - nativeLibraryDir: libstockfish.so (copied from build into jniLibs)
      // This avoids fragile resourceDir paths and works even on devices that block exec in app data.
      const bundledStockfishPath = "engines/stockfish";

      if (bundledStockfishPath) {
        // Check if Stockfish is already registered
        const stockfishIndex = currentEngines.findIndex(
          (e) => e.type === "local" && e.name === "Stockfish" && (e as LocalEngine).installMethod === "bundled",
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
              config = { name: "Stockfish", options: [] };
            } else {
              // If the bundled engine isn't actually available on this device/build, don't register a broken entry.
              return;
            }
          }

          // Create engine entry with default settings
          const bundledEngine: LocalEngine = {
            type: "local",
            name: "Stockfish",
            version: "18",
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
        } else {
          // Migrate old absolute path (e.g. /data/user/0/.../files/engines/stockfish) to logical path.
          const existing = currentEngines[stockfishIndex] as LocalEngine;
          const needsPathMigration = existing.installMethod === "bundled" && existing.path !== bundledStockfishPath;
          const needsVersionMigration = existing.version !== "18";
          if (needsPathMigration || needsVersionMigration) {
            const updated = [...currentEngines];
            updated[stockfishIndex] = { ...existing, path: bundledStockfishPath, version: "18" };
            await store.set(enginesAtom, updated);
          }
        }
      }
    }
  } catch {
    // Don't throw - this is a non-critical initialization step
  }
}
