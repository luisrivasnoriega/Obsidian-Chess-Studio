import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { Platform } from "@tauri-apps/plugin-os";
import { z } from "zod";

import { type BestMoves, commands, type EngineOptions, type GoMode } from "@/bindings";
import { isInstallMethodSupported } from "./packageManager";
import { unwrap } from "./unwrap";

export const requiredEngineSettings = ["MultiPV", "Threads", "Hash"];

const STOCKFISH_18_RELEASE_TAG = "sf_18";
const stockfish18Url = (fileName: string) =>
  `https://github.com/official-stockfish/Stockfish/releases/download/${STOCKFISH_18_RELEASE_TAG}/${fileName}`;

// Stockfish 18 official build matrix (used for download/install).
// Keys must match the backend command `get_preferred_stockfish_build_key`.
const STOCKFISH_18_BUILDS: Record<
  string,
  {
    fileName: string;
    // Path inside the extracted archive passed to `download_engine`.
    engineRelPath: string;
  }
> = {
  // Windows x86_64
  "windows-x86-64-avx512icl": {
    fileName: "stockfish-windows-x86-64-avx512icl.zip",
    engineRelPath: "stockfish/stockfish-windows-x86-64-avx512icl.exe",
  },
  "windows-x86-64-vnni512": {
    fileName: "stockfish-windows-x86-64-vnni512.zip",
    engineRelPath: "stockfish/stockfish-windows-x86-64-vnni512.exe",
  },
  "windows-x86-64-avx512": {
    fileName: "stockfish-windows-x86-64-avx512.zip",
    engineRelPath: "stockfish/stockfish-windows-x86-64-avx512.exe",
  },
  "windows-x86-64-avxvnni": {
    fileName: "stockfish-windows-x86-64-avxvnni.zip",
    engineRelPath: "stockfish/stockfish-windows-x86-64-avxvnni.exe",
  },
  "windows-x86-64-bmi2": {
    fileName: "stockfish-windows-x86-64-bmi2.zip",
    engineRelPath: "stockfish/stockfish-windows-x86-64-bmi2.exe",
  },
  "windows-x86-64-avx2": {
    fileName: "stockfish-windows-x86-64-avx2.zip",
    engineRelPath: "stockfish/stockfish-windows-x86-64-avx2.exe",
  },
  "windows-x86-64-sse41-popcnt": {
    fileName: "stockfish-windows-x86-64-sse41-popcnt.zip",
    engineRelPath: "stockfish/stockfish-windows-x86-64-sse41-popcnt.exe",
  },
  "windows-x86-64": {
    fileName: "stockfish-windows-x86-64.zip",
    engineRelPath: "stockfish/stockfish-windows-x86-64.exe",
  },

  // Windows ARM64
  "windows-armv8": {
    fileName: "stockfish-windows-armv8.zip",
    engineRelPath: "stockfish/stockfish-windows-armv8.exe",
  },
  "windows-armv8-dotprod": {
    fileName: "stockfish-windows-armv8-dotprod.zip",
    engineRelPath: "stockfish/stockfish-windows-armv8-dotprod.exe",
  },

  // Linux x86_64 (Ubuntu builds)
  "linux-x86-64-avx512icl": {
    fileName: "stockfish-ubuntu-x86-64-avx512icl.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-x86-64-avx512icl",
  },
  "linux-x86-64-vnni512": {
    fileName: "stockfish-ubuntu-x86-64-vnni512.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-x86-64-vnni512",
  },
  "linux-x86-64-avx512": {
    fileName: "stockfish-ubuntu-x86-64-avx512.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-x86-64-avx512",
  },
  "linux-x86-64-avxvnni": {
    fileName: "stockfish-ubuntu-x86-64-avxvnni.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-x86-64-avxvnni",
  },
  "linux-x86-64-bmi2": {
    fileName: "stockfish-ubuntu-x86-64-bmi2.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-x86-64-bmi2",
  },
  "linux-x86-64-avx2": {
    fileName: "stockfish-ubuntu-x86-64-avx2.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-x86-64-avx2",
  },
  "linux-x86-64-sse41-popcnt": {
    fileName: "stockfish-ubuntu-x86-64-sse41-popcnt.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-x86-64-sse41-popcnt",
  },
  "linux-x86-64": {
    fileName: "stockfish-ubuntu-x86-64.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-x86-64",
  },

  // Linux ARM
  "linux-armv7": {
    fileName: "stockfish-ubuntu-armv7.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-armv7",
  },
  "linux-armv7-neon": {
    fileName: "stockfish-ubuntu-armv7-neon.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-armv7-neon",
  },
  "linux-armv8": {
    fileName: "stockfish-ubuntu-armv8.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-armv8",
  },
  "linux-armv8-dotprod": {
    fileName: "stockfish-ubuntu-armv8-dotprod.tar",
    engineRelPath: "stockfish/stockfish-ubuntu-armv8-dotprod",
  },

  // macOS
  "macos-m1-apple-silicon": {
    fileName: "stockfish-macos-m1-apple-silicon.tar",
    engineRelPath: "stockfish/stockfish-macos-m1-apple-silicon",
  },
  "macos-x86-64-bmi2": {
    fileName: "stockfish-macos-x86-64-bmi2.tar",
    engineRelPath: "stockfish/stockfish-macos-x86-64-bmi2",
  },
  "macos-x86-64-avx2": {
    fileName: "stockfish-macos-x86-64-avx2.tar",
    engineRelPath: "stockfish/stockfish-macos-x86-64-avx2",
  },
  "macos-x86-64-sse41-popcnt": {
    fileName: "stockfish-macos-x86-64-sse41-popcnt.tar",
    engineRelPath: "stockfish/stockfish-macos-x86-64-sse41-popcnt",
  },
  "macos-x86-64": {
    fileName: "stockfish-macos-x86-64.tar",
    engineRelPath: "stockfish/stockfish-macos-x86-64",
  },

  // Android builds (OCS prefers bundled install on Android, but we keep the routes here for completeness)
  "android-armv8": {
    fileName: "stockfish-android-armv8.tar",
    engineRelPath: "stockfish/stockfish-android-armv8",
  },
  "android-armv8-dotprod": {
    fileName: "stockfish-android-armv8-dotprod.tar",
    engineRelPath: "stockfish/stockfish-android-armv8-dotprod",
  },
  "android-armv7": {
    fileName: "stockfish-android-armv7.tar",
    engineRelPath: "stockfish/stockfish-android-armv7",
  },
  "android-armv7-neon": {
    fileName: "stockfish-android-armv7-neon.tar",
    engineRelPath: "stockfish/stockfish-android-armv7-neon",
  },
};

/**
 * IMPORTANT:
 * - `bmi2` is used as a 2-way CPU switch in Obsidian Chess Studio (OCS) (bmi2 compatible vs not).
 * - For engines that offer AVX/AVX2 vs SSE builds, we map:
 *    bmi2=true  -> faster build (AVX/AVX2)
 *    bmi2=false -> safer build (SSE/SSE2/ancient)
 * - For engines that don't have CPU variants, duplicate entries (bmi2 true/false) with same build.
 */
const ENGINES = [
  // ---------------------------
  // RubiChess
  // ---------------------------
  {
    name: "RubiChess",
    version: "20240817",
    os: "windows",
    bmi2: true,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_rubi.png",
    installMethod: "download" as const,
    downloadLink: "https://github.com/Matthies/RubiChess/releases/download/20240817/RubiChess-20240817.zip",
    path: "RubiChess-20240817/windows/RubiChess-20240817_x86-64-avx2.exe",
    elo: 3600,
    downloadSize: 31417660,
  },
  {
    name: "RubiChess",
    version: "20240817",
    os: "windows",
    bmi2: false,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_rubi.png",
    installMethod: "download" as const,
    downloadLink: "https://github.com/Matthies/RubiChess/releases/download/20240817/RubiChess-20240817.zip",
    path: "RubiChess-20240817/windows/RubiChess-20240817_x86-64-modern.exe",
    elo: 3600,
    downloadSize: 31417660,
  },
  {
    name: "RubiChess",
    version: "20240817",
    os: "linux",
    bmi2: true,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_rubi.png",
    installMethod: "download" as const,
    downloadLink: "https://github.com/Matthies/RubiChess/releases/download/20240817/RubiChess-20240817.zip",
    path: "RubiChess-20240817/linux/RubiChess-20240817_x86-64-avx2",
    elo: 3600,
    downloadSize: 31417660,
  },
  {
    name: "RubiChess",
    version: "20240817",
    os: "linux",
    bmi2: false,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_rubi.png",
    installMethod: "download" as const,
    downloadLink: "https://github.com/Matthies/RubiChess/releases/download/20240817/RubiChess-20240817.zip",
    path: "RubiChess-20240817/linux/RubiChess-20240817_x86-64-modern",
    elo: 3600,
    downloadSize: 31417660,
  },

  // ---------------------------
  // Dragon (Komodo)
  // ---------------------------
  {
    name: "Dragon by Komodo",
    version: "1",
    os: "windows",
    bmi2: true,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_dragon.png",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/dragon.zip",
    path: "dragon_05e2a7/Windows/dragon-64bit-avx2.exe",
    elo: 3533,
    downloadSize: 85049133,
  },
  {
    name: "Dragon by Komodo",
    version: "1",
    os: "windows",
    bmi2: false,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_dragon.png",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/dragon.zip",
    path: "dragon_05e2a7/Windows/dragon-64bit.exe",
    elo: 3533,
    downloadSize: 85049133,
  },
  {
    name: "Dragon by Komodo",
    version: "1",
    os: "linux",
    bmi2: true,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_dragon.png",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/dragon.zip",
    path: "dragon_05e2a7/Linux/dragon-linux-avx2",
    elo: 3533,
    downloadSize: 85049133,
  },
  {
    name: "Dragon by Komodo",
    version: "1",
    os: "linux",
    bmi2: false,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_dragon.png",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/dragon.zip",
    path: "dragon_05e2a7/Linux/dragon-linux",
    elo: 3533,
    downloadSize: 85049133,
  },
  {
    name: "Dragon by Komodo",
    version: "1",
    os: "macos",
    bmi2: true,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_dragon.png",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/dragon.zip",
    path: "dragon_05e2a7/OSX/dragon-avx2-osx",
    elo: 3533,
    downloadSize: 85049133,
  },
  {
    name: "Dragon by Komodo",
    version: "1",
    os: "macos",
    bmi2: false,
    image: "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_dragon.png",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/dragon.zip",
    path: "dragon_05e2a7/OSX/dragon-osx",
    elo: 3533,
    downloadSize: 85049133,
  },

  // ---------------------------
  // Komodo 14
  // ---------------------------
  {
    name: "Komodo",
    version: "14",
    os: "windows",
    bmi2: true,
    image: "https://images.chesscomfiles.com/uploads/v1/images_users/tiny_mce/ColinStapczynski/php2OzLMj.jpeg",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/komodo-14.zip",
    path: "komodo-14_224afb/Windows/komodo-14.1-64bit-bmi2.exe",
    elo: 3479,
    downloadSize: 9745847,
  },
  {
    name: "Komodo",
    version: "14",
    os: "windows",
    bmi2: false,
    image: "https://images.chesscomfiles.com/uploads/v1/images_users/tiny_mce/ColinStapczynski/php2OzLMj.jpeg",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/komodo-14.zip",
    path: "komodo-14_224afb/Windows/komodo-14.1-64bit.exe",
    elo: 3479,
    downloadSize: 9745847,
  },
  {
    name: "Komodo",
    version: "14",
    os: "linux",
    bmi2: true,
    image: "https://images.chesscomfiles.com/uploads/v1/images_users/tiny_mce/ColinStapczynski/php2OzLMj.jpeg",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/komodo-14.zip",
    path: "komodo-14_224afb/Linux/komodo-14.1-linux-bmi2",
    elo: 3479,
    downloadSize: 9745847,
  },
  {
    name: "Komodo",
    version: "14",
    os: "linux",
    bmi2: false,
    image: "https://images.chesscomfiles.com/uploads/v1/images_users/tiny_mce/ColinStapczynski/php2OzLMj.jpeg",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/komodo-14.zip",
    path: "komodo-14_224afb/Linux/komodo-14.1-linux",
    elo: 3479,
    downloadSize: 9745847,
  },
  {
    name: "Komodo",
    version: "14",
    os: "macos",
    bmi2: true,
    image: "https://images.chesscomfiles.com/uploads/v1/images_users/tiny_mce/ColinStapczynski/php2OzLMj.jpeg",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/komodo-14.zip",
    path: "komodo-14_224afb/OSX/komodo-14.1-64-bmi2-osx",
    elo: 3479,
    downloadSize: 9745847,
  },
  {
    name: "Komodo",
    version: "14",
    os: "macos",
    bmi2: false,
    image: "https://images.chesscomfiles.com/uploads/v1/images_users/tiny_mce/ColinStapczynski/php2OzLMj.jpeg",
    installMethod: "download" as const,
    downloadLink: "https://komodochess.com/pub/komodo-14.zip",
    path: "komodo-14_224afb/OSX/komodo-14.1-64-osx",
    elo: 3479,
    downloadSize: 9745847,
  },

  // ---------------------------
  // Leela Chess Zero (Lc0)
  // ---------------------------
  {
    name: "Leela Chess Zero (Auto)",
    version: "0.32.1",
    os: "windows",
    bmi2: true,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-onnx-dml.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero (Auto)",
    version: "0.32.1",
    os: "windows",
    bmi2: false,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-onnx-dml.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero (CUDA 12)",
    version: "0.32.1",
    os: "windows",
    bmi2: true,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink:
      "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-gpu-nvidia-cuda12.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero (CUDA 12)",
    version: "0.32.1",
    os: "windows",
    bmi2: false,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink:
      "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-gpu-nvidia-cuda12.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero (CUDNN)",
    version: "0.32.1",
    os: "windows",
    bmi2: true,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink:
      "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-gpu-nvidia-cudnn.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero (CUDNN)",
    version: "0.32.1",
    os: "windows",
    bmi2: false,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink:
      "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-gpu-nvidia-cudnn.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero (ONNX-DML)",
    version: "0.32.1",
    os: "windows",
    bmi2: true,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-onnx-dml.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero (ONNX-DML)",
    version: "0.32.1",
    os: "windows",
    bmi2: false,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-onnx-dml.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero (DNNL)",
    version: "0.32.1",
    os: "windows",
    bmi2: true,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-cpu-dnnl.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero (DNNL)",
    version: "0.32.1",
    os: "windows",
    bmi2: false,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-cpu-dnnl.zip",
    path: "lc0/lc0.exe",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero",
    version: "0.30.0",
    os: "macos",
    bmi2: true,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "brew" as const,
    brewPackage: "lc0",
    path: "/opt/homebrew/bin/lc0",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero",
    version: "0.30.0",
    os: "macos",
    bmi2: false,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "brew" as const,
    brewPackage: "lc0",
    path: "/opt/homebrew/bin/lc0",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero",
    version: "0.30.0",
    os: "linux",
    bmi2: true,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "package" as const,
    packageCommand: "sudo apt-get install lc0",
    path: "/usr/bin/lc0",
    elo: 3440,
  },
  {
    name: "Leela Chess Zero",
    version: "0.30.0",
    os: "linux",
    bmi2: false,
    image: "https://lczero.org/images/logo.svg",
    installMethod: "package" as const,
    packageCommand: "sudo apt-get install lc0",
    path: "/usr/bin/lc0",
    elo: 3440,
  },

  // ============================================================
  // EXTRA ENGINES (descarga directa desde sus sitios)
  // ============================================================

  // ---------------------------
  // Koivisto 8.0 (direct binary)
  // ---------------------------
  {
    name: "Koivisto",
    version: "8.0",
    os: "windows",
    bmi2: true,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/Luecx/Koivisto/releases/download/v8.0/Koivisto_8.0-x64-windows-avx2.exe",
    path: "koivisto/Koivisto_8.0-x64-windows-avx2.exe",
    elo: 3500,
  },
  {
    name: "Koivisto",
    version: "8.0",
    os: "windows",
    bmi2: false,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/Luecx/Koivisto/releases/download/v8.0/Koivisto_8.0-x64-windows-sse2.exe",
    path: "koivisto/Koivisto_8.0-x64-windows-sse2.exe",
    elo: 3500,
  },
  // Koivisto (Linux AVX2)
  {
    name: "Koivisto",
    version: "8.0",
    os: "linux",
    bmi2: true,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/Luecx/Koivisto/releases/download/v8.0/Koivisto_8.0-x64-linux-avx2",
    path: "koivisto/Koivisto_8.0-x64-linux-avx2",
    elo: 3500,
  },

  // Clover (Windows-only release binary)
  {
    name: "Clover",
    version: "9.1",
    os: "windows",
    bmi2: true,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/lucametehau/CloverEngine/releases/download/v9.1/Clover.9.1-avx2.exe",
    path: "clover/Clover.9.1-avx2.exe",
    elo: 0,
  },

  // Obsidian (Windows-only release binary)
  {
    name: "Obsidian",
    version: "16.0",
    os: "windows",
    bmi2: true,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/gab8192/Obsidian/releases/download/v16.0/Obsidian_16.0_avx2.exe",
    path: "obsidian/Obsidian_16.0_avx2.exe",
    elo: 0,
  },

  // Berserk (Windows-only release binary)
  {
    name: "Berserk",
    version: "13",
    os: "windows",
    bmi2: true,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/jhonnold/berserk/releases/download/13/berserk-13-avx2.exe",
    path: "berserk/berserk-13-avx2.exe",
    elo: 0,
  },

  {
    name: "Koivisto",
    version: "8.0",
    os: "linux",
    bmi2: false,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://github.com/Luecx/Koivisto/releases/download/v8.0/Koivisto_8.0-x64-linux-sse2",
    path: "koivisto/Koivisto_8.0-x64-linux-sse2",
    elo: 3500,
  },

  // ---------------------------
  // Wasp 6.50 (direct binary) — useful for human-strength levels
  // ---------------------------
  {
    name: "Wasp",
    version: "6.50",
    os: "windows",
    bmi2: true,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://www.waspchess.com/wasp_downloads/Wasp_6.50/Wasp650-windows-avx.exe",
    path: "wasp/Wasp650-windows-avx.exe",
    elo: 2900,
  },
  {
    name: "Wasp",
    version: "6.50",
    os: "windows",
    bmi2: false,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://www.waspchess.com/wasp_downloads/Wasp_6.50/Wasp650-windows.exe",
    path: "wasp/Wasp650-windows.exe",
    elo: 2900,
  },
  {
    name: "Wasp",
    version: "6.50",
    os: "linux",
    bmi2: true,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://www.waspchess.com/wasp_downloads/Wasp_6.50/Wasp650-linux-avx",
    path: "wasp/Wasp650-linux-avx",
    elo: 2900,
  },
  {
    name: "Wasp",
    version: "6.50",
    os: "linux",
    bmi2: false,
    image: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Chess_icon.svg",
    installMethod: "download" as const,
    downloadLink: "https://www.waspchess.com/wasp_downloads/Wasp_6.50/Wasp650-linux",
    path: "wasp/Wasp650-linux",
    elo: 2900,
  },
];

const goModeSchema: z.ZodSchema<GoMode> = z.union([
  z.object({ t: z.literal("Depth"), c: z.number() }),
  z.object({ t: z.literal("Time"), c: z.number() }),
  z.object({ t: z.literal("Nodes"), c: z.number() }),
  z.object({ t: z.literal("Infinite") }),
]);

const engineSettingsSchema = z.array(
  z.object({
    name: z.string(),
    value: z.string().or(z.number()).or(z.boolean()).nullable(),
  }),
);

export type EngineSettings = z.infer<typeof engineSettingsSchema>;

const localEngineSchema = z.object({
  type: z.literal("local"),
  name: z.string(),
  version: z.string(),
  path: z.string(),
  image: z.string().nullish(),
  elo: z.number().nullish(),

  installMethod: z.enum(["download", "brew", "package", "bundled"]).nullish(),
  downloadSize: z.number().nullish(),
  downloadLink: z.string().nullish(),
  brewPackage: z.string().nullish(),
  packageCommand: z.string().nullish(),

  loaded: z.boolean().nullish(),
  go: goModeSchema.nullish(),
  enabled: z.boolean().nullish(),
  settings: engineSettingsSchema.nullish(),
});

export type LocalEngine = z.infer<typeof localEngineSchema>;

const remoteEngineSchema = z.object({
  type: z.enum(["chessdb", "lichess"]),
  name: z.string(),
  url: z.string(),
  image: z.string().nullish(),
  loaded: z.boolean().nullish(),
  enabled: z.boolean().nullish(),
  go: goModeSchema.nullish(),
  settings: engineSettingsSchema.nullish(),
});

export type RemoteEngine = z.infer<typeof remoteEngineSchema>;

export const engineSchema = z.union([localEngineSchema, remoteEngineSchema]);
export type Engine = z.infer<typeof engineSchema>;

export function stopEngine(engine: LocalEngine, tab: string): Promise<void> {
  return commands.stopEngine(engine.path, tab).then((r) => {
    unwrap(r);
  });
}

export function killEngine(engine: LocalEngine, tab: string): Promise<void> {
  return commands.killEngine(engine.path, tab).then((r) => {
    unwrap(r);
  });
}

export function getBestMoves(
  engine: LocalEngine,
  tab: string,
  goMode: GoMode,
  options: EngineOptions,
): Promise<[number, BestMoves[]] | null> {
  return commands.getBestMoves(engine.name, engine.path, tab, goMode, options).then((r) => unwrap(r));
}

async function createDefaultStockfishEngine(
  normalizedOs: "windows" | "macos" | "linux" | "android" | "ios" | null,
  bmi2: boolean,
) {
  if (!normalizedOs) return null;

  // iOS: no official Stockfish binary route in our installer.
  if (normalizedOs === "ios") return null;

  const base = {
    name: "Stockfish",
    version: "18",
    image: "https://upload.wikimedia.org/wikipedia/commons/3/3a/NewLogoSF.png",
    elo: 3635,
  };

  if (normalizedOs === "android") {
    // Safer default for broad device compatibility (dotprod is not universally available).
    return {
      ...base,
      os: "android",
      bmi2: false,
      installMethod: "bundled" as const,
      path: "engines/stockfish",
    };
  }

  let key: string | null = null;
  try {
    key = await invoke<string>("get_preferred_stockfish_build_key");
  } catch {
    key = null;
  }

  const fallbackKey =
    normalizedOs === "windows"
      ? bmi2
        ? "windows-x86-64-avx2"
        : "windows-x86-64-sse41-popcnt"
      : normalizedOs === "linux"
        ? bmi2
          ? "linux-x86-64-avx2"
          : "linux-x86-64-sse41-popcnt"
        : normalizedOs === "macos"
          ? bmi2
            ? "macos-x86-64-avx2"
            : "macos-x86-64-sse41-popcnt"
          : null;

  const selectedKey = (key && STOCKFISH_18_BUILDS[key] ? key : fallbackKey) ?? null;
  if (!selectedKey) return null;

  const build = STOCKFISH_18_BUILDS[selectedKey];
  if (!build) return null;

  return {
    ...base,
    os: normalizedOs,
    bmi2,
    installMethod: "download" as const,
    downloadLink: stockfish18Url(build.fileName),
    path: build.engineRelPath,
  };
}

export function useDefaultEngines(os: Platform | undefined, opened: boolean) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["default-engines", os],
    queryFn: async () => {
      const bmi2: boolean = await commands.isBmi2Compatible();
      const normalizedOs = normalizeEngineOs(os);
      const shouldFilterByBmi2 = normalizedOs === "windows" || normalizedOs === "macos" || normalizedOs === "linux";
      const osMatches = normalizedOs
        ? ENGINES.filter((e) => e.os === normalizedOs && (!shouldFilterByBmi2 || e.bmi2 === bmi2))
        : [];
      const androidDefault =
        normalizedOs === "android" ? (osMatches.find((engine) => engine.bmi2 === false) ?? osMatches[0]) : null;
      const availableEngines =
        osMatches.length > 0 || normalizedOs !== null
          ? androidDefault
            ? [androidDefault]
            : osMatches
          : ENGINES.filter((e) => e.installMethod === "download" && e.bmi2 === bmi2);

      // Stockfish 18: keep the full route matrix in TS, but let the backend pick the right build.
      const stockfish = await createDefaultStockfishEngine(normalizedOs, bmi2);
      const enginesWithStockfish = stockfish
        ? [stockfish, ...availableEngines.filter((e) => e.name !== "Stockfish")]
        : availableEngines;

      const supportedEngines = await Promise.all(
        enginesWithStockfish.map(async (engine) => {
          const isSupported = await isInstallMethodSupported(engine.installMethod || "download");
          return isSupported ? engine : null;
        }),
      );

      const filtered = supportedEngines.filter((engine): engine is NonNullable<typeof engine> => engine !== null);

      // Keep the engine list in TS, but delegate hardware detection to the backend.
      // For Lc0 on Windows we only show "Auto" + the recommended variant for this GPU.
      let preferredLc0Name: string | null = null;
      try {
        preferredLc0Name = await invoke<string | null>("get_preferred_lc0_engine_name");
      } catch {
        preferredLc0Name = null;
      }

      const lc0AutoName = "Leela Chess Zero (Auto)";
      const lc0VariantPrefix = "Leela Chess Zero (";
      const lc0FallbackName = normalizedOs === "windows" ? "Leela Chess Zero (ONNX-DML)" : "Leela Chess Zero (DNNL)";
      return filtered.filter((e) => {
        if (!e.name.startsWith(lc0VariantPrefix)) return true;
        // Hide the "Auto" entry; only show the recommended build for the detected hardware.
        if (e.name === lc0AutoName) return false;
        const targetName = preferredLc0Name ?? lc0FallbackName;
        return e.name === targetName;
      });
    },
    enabled: opened && !!os,
    staleTime: Infinity,
  });

  return {
    defaultEngines: data,
    error,
    isLoading,
  };
}

function normalizeEngineOs(os: Platform | undefined): "windows" | "macos" | "linux" | "android" | "ios" | null {
  if (!os) return null;

  switch (os) {
    case "windows":
    case "macos":
    case "linux":
    case "android":
    case "ios":
      return os;
    default:
      return null;
  }
}
