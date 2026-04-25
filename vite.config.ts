/// <reference types="vitest" />
import { resolve } from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const isDebug = !!process.env.TAURI_ENV_DEBUG;
const _isProdBuild = !isDebug;

const devHost = process.env.TAURI_DEV_HOST;
const disableHmrOverlay = true;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [tanstackRouter(), react(), vanillaExtractPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // For `tauri android dev`, the CLI often sets `TAURI_DEV_HOST` to a LAN IP.
    // Binding to `0.0.0.0` keeps the server reachable via both LAN and localhost
    // (adb reverse friendly when the device can't reach the LAN).
    // For desktop `tauri dev`, bind to 127.0.0.1 so it matches `tauri.conf.json`'s devUrl
    // and avoids "Waiting for your frontend dev server to start on http://127.0.0.1:1420/..."
    // when Vite would otherwise bind to IPv6 localhost only.
    host: devHost ? "0.0.0.0" : "127.0.0.1",
    // Keep HMR on localhost so it works with `adb reverse tcp:1421 tcp:1421`.
    // Disable the Vite HMR error overlay so React error boundaries can render
    // a copyable component stack (critical for debugging crash loops in Tauri).
    hmr: devHost
      ? {
          protocol: "ws",
          host: "127.0.0.1",
          port: 1421,
          overlay: !disableHmrOverlay,
        }
      : { overlay: !disableHmrOverlay },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      strict: false,
    },
  },
  build: {
    // Always minify for tauri build; keep inline sourcemap only for debug
    minify: "esbuild",
    sourcemap: isDebug ? "inline" : false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  resolve: {
    alias: [{ find: "@", replacement: resolve(__dirname, "./src") }],
  },
  test: {
    environment: "jsdom",
    env: { TZ: "UTC" },
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    teardownTimeout: 120_000, // 2 min
    reporters: ["default", "hanging-process"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      exclude: ["**/node_modules/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"],
    },
  },
});
