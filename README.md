<div align="center">
<!-- Logo -->
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio">
<img src="./src-tauri/icons/icon.png" alt="Obsidian Chess Studio Logo" width="120" />
</a>

<!-- Title & Tagline -->
<h1 align="center">Obsidian Chess Studio</h1>

<div>
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/releases"><strong>Download</strong></a> •
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/discussions"><strong>Discussions</strong></a> •
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/issues"><strong>Issues</strong></a>
</div>

<br />

<div>
<!-- Build & Quality -->
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/actions/workflows/test.yml">
<img src="https://img.shields.io/github/actions/workflow/status/luisrivasnoriega/Obsidian-Chess-Studio/test.yml?style=flat-square&logo=githubactions&logoColor=white&label=Build&labelColor=2d3748&color=success" alt="Build Status">
</a>
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/releases">
<img src="https://img.shields.io/github/v/release/luisrivasnoriega/Obsidian-Chess-Studio?style=flat-square&logo=semanticrelease&logoColor=white&label=Version&color=3b82f6&labelColor=2d3748" alt="Latest Release">
</a>
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/blob/main/LICENSE">
<img src="https://img.shields.io/github/license/luisrivasnoriega/Obsidian-Chess-Studio?style=flat-square&logo=gnu&logoColor=white&color=8b5cf6&labelColor=2d3748" alt="License">
</a>
<!-- Downloads & Activity -->
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/releases">
<img src="https://img.shields.io/github/downloads/luisrivasnoriega/Obsidian-Chess-Studio/total?style=flat-square&logo=github&logoColor=white&label=Downloads&color=success&labelColor=2d3748" alt="Total Downloads" />
</a>
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/stargazers">
<img src="https://img.shields.io/github/stars/luisrivasnoriega/Obsidian-Chess-Studio?style=flat-square&logo=starship&logoColor=white&label=Stars&color=3b82f6&labelColor=2d3748" alt="GitHub Stars">
</a>
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/network/members">
<img src="https://img.shields.io/github/forks/luisrivasnoriega/Obsidian-Chess-Studio?style=flat-square&logo=git&logoColor=white&label=Forks&color=8b5cf6&labelColor=2d3748" alt="GitHub Forks">
</a>
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/graphs/contributors">
<img src="https://img.shields.io/github/contributors/luisrivasnoriega/Obsidian-Chess-Studio?style=flat-square&logo=superuser&logoColor=white&label=Contributors&color=success&labelColor=2d3748" alt="Contributors">
</a>
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/discussions">
<img src="https://img.shields.io/github/discussions/luisrivasnoriega/Obsidian-Chess-Studio?style=flat-square&logo=github&logoColor=white&label=Discussions&color=3b82f6&labelColor=2d3748" alt="Discussions">
</a>
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/issues">
<img src="https://img.shields.io/github/issues/luisrivasnoriega/Obsidian-Chess-Studio?style=flat-square&logo=github&logoColor=white&label=Issues&color=8b5cf6&labelColor=2d3748" alt="Issues">
</a>
<img src="https://img.shields.io/github/last-commit/luisrivasnoriega/Obsidian-Chess-Studio?style=flat-square&logo=git&logoColor=white&label=Updated&color=success&labelColor=2d3748" alt="Last Commit">
<img src="https://img.shields.io/github/commit-activity/m/luisrivasnoriega/Obsidian-Chess-Studio?style=flat-square&logo=edgeimpulse&logoColor=white&label=Activity&color=success&labelColor=2d3748" alt="Monthly Activity">
<!-- Platform & Tech -->
<a href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio#supported-platforms">
<img src="https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux-3b82f6?style=flat-square&logo=tauri&logoColor=white&labelColor=2d3748" alt="Supported Platforms" />
</a>
<a href="https://www.docker.com/">
<img src="https://img.shields.io/badge/Docker-Ready-3b82f6?style=flat-square&logo=docker&logoColor=white&labelColor=2d3748" alt="Docker">
</a>
</div>

<br />
<br />

<a href="./screenshots/banner.png" target="_blank">
<img src="./screenshots/banner.png" alt="Obsidian Chess Studio GUI screenshot showcasing the main interface" width="85%" />
</a>
<p>
<em>Experience professional chess analysis with an intuitive, modern interface</em>
</p>
</div>

## Overview

**Obsidian Chess Studio** is a modern, open-source and cross-platform chess application designed for players who demand professional-grade analysis tools without the premium price tag. Built with Rust and Tauri for exceptional performance, it delivers advanced chess engine integration, game analysis, opening repertoire training, and more-all wrapped in an intuitive interface.

Whether you're preparing for tournaments, analyzing your games, or building opening repertoires with spaced repetition, Obsidian Chess Studio provides the tools you need in a fast, lightweight package.

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Installation](#installation)
  - [Download](#download)
  - [Quick Start](#quick-start)
- [Development](#development)
  - [Prerequisites](#prerequisites)
  - [Building from Source](#building-from-source)
  - [Docker Build](#docker-build)
- [Comparison](#comparison)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Translations](#translations)
- [Community](#community)
- [Privacy & Telemetry](#privacy--telemetry)
- [Changelog](#changelog)
- [License](#license)
- [Acknowledgments](#acknowledgments)

## Features

* Game Management - Store and analyze your games from lichess.org and chess.com
* Multi-Engine Analysis - Supports all UCI chess engines for deep position evaluation
* Repertoire Training - Prepare openings and train them with spaced repetition
* Engine & Database Management - Simple installation and management of engines and databases
* Position Search - Absolute or partial position search in your database
* Cross-Platform - Available on Windows, macOS, and Linux
* Customizable Interface - Tailor the app to your preferences

## Screenshots

<div>

<em>Play chess games and analyze them with powerful engine tools</em>

[<img src="./screenshots/play-game.png" alt="Play Game" width="320" />](./screenshots/play-game.png)
[<img src="./screenshots/analyze-game.png" alt="Analyze Game" width="320" />](./screenshots/analyze-game.png)  

---

<em>Solve puzzles and improve with guided learning</em>

[<img src="./screenshots/solve-puzzle.png" alt="Solve Puzzle" width="320" />](./screenshots/solve-puzzle.png)
[<img src="./screenshots/learn.png" alt="Learn" width="320" />](./screenshots/learn.png)  

---

<em>Flexible keybindings and appearance settings</em>

[<img src="./screenshots/keybindings.png" alt="Keybindings" width="320" />](./screenshots/keybindings.png)
[<img src="./screenshots/settings-appearance.png" alt="Settings Appearance" width="320" />](./screenshots/settings-appearance.png)  

</div>

## Installation

### Download

Prebuilt binaries are available for Windows, macOS, and Linux:

**[Download the latest release](https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/releases/latest)**

| Platform | Download |
|----------|----------|
| **Windows** | `.exe` |
| **macOS** | `.dmg` (Apple Silicon and Intel) |
| **Linux** | `.AppImage`, `.deb`, or `.rpm` |

### Quick Start

1. Download and install Obsidian Chess Studio for your platform
2. Launch the application
3. Import a game from Lichess or Chess.com (or load a PGN file)
4. Start analyzing with the built-in Stockfish engine
5. Use GitHub Issues/Discussions for support and feedback


## Development

### Prerequisites
Ensure you have the required tools installed for your platform:
- [Tauri prerequisites](https://tauri.app/start/prerequisites/)
- [pnpm package manager](https://pnpm.io/)

### Building from Source

1. **Clone the repository**:

   ```bash
   git clone git@github.com:luisrivasnoriega/Obsidian-Chess-Studio.git
   cd Obsidian-Chess-Studio
   ```

2. **Install dependencies using pnpm**:

   ```bash
   pnpm install
   ```

3. **Run in Development Mode**:

    Build and run the desktop application using Tauri:

    ```bash
    pnpm tauri dev
    ```

4. **Build for Production**:

    Build the application for production:

    ```bash
    pnpm tauri build
    ```

    The compiled application will be available at:

    ```bash
    src-tauri/target/release
    ```

### Docker Build

You can also build Obsidian Chess Studio using Docker (make sure [Docker](https://www.docker.com/) is installed and running):

1. **Build the Docker image**:

   ```bash
   docker build -t obsidian-chess-studio .
   ```

2. **Run the container**:

   ```bash
   docker run -d --name obsidian-chess-studio-app obsidian-chess-studio
   ```

3. **Copy the built binary from the container**:

   ```bash
   docker cp obsidian-chess-studio-app:/output/obsidian-chess-studio ./obsidian-chess-studio
   ```

The binary will be available in your current directory.

## Comparison

| Feature | Obsidian Chess Studio | ChessBase | Arena | Scid |
|---------|--------------|-----------|-------|------|
| **Price** | Free ✅ | $199+ ❌ | Free ✅ | Free ✅ |
| **Modern UI** | ✅ | ❌ | ❌ | ❌ |
| **Cross-platform** | ✅ | Windows only ❌ | Windows only ❌ | ✅ |
| **Open Source** | ✅ | ❌ | ❌ | ✅ |

## Roadmap

- [ ] **Web Version**
- [ ] **Mobile App**
- [ ] **Cloud Sync**

## Contributing

We welcome contributions of all kinds:

- **Code** - See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines
- **Translations** - Help localize the app (see [Translations](#translations) section below)
- **Bug Reports** - Open an [issue](https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/issues)
- **Feature Requests** - Start a [discussion](https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/discussions)
- **Star this repo** - It really helps us grow!

### Translations

Obsidian Chess Studio is for chess players **all around the world**! We're committed to making professional-grade chess analysis accessible in your language. Join our growing international community and help us reach **every chess player**, no matter where they are.

<!-- TRANSLATIONS_START -->
| Language  | Progress   | Link                        |
|-----------|----------|-----------------------------|
| 🇺🇸 **English US** | ✅ 100% | [View](./src/locales/en-US) |
| 🇸🇦 **العربية (Arabic)** | ✅ 100% | [View](./src/locales/ar) |
| 🇧🇾 **Беларуская (Belarusian)** | ✅ 100% | [View](./src/locales/be) |
| 🇩🇪 **Deutsch (German)** | ✅ 100% | [View](./src/locales/de) |
| 🇬🇧 **English UK** | ✅ 100% | [View](./src/locales/en-GB) |
| 🇪🇸 **Español (Spanish)** | ✅ 100% | [View](./src/locales/es) |
| 🇫🇷 **Français (French)** | ✅ 100% | [View](./src/locales/fr) |
| 🇦🇲 **Հայերեն (Armenian)** | ✅ 100% | [View](./src/locales/hy) |
| 🇮🇹 **Italiano (Italian)** | ✅ 100% | [View](./src/locales/it) |
| 🇯🇵 **日本語 (Japanese)** | ✅ 100% | [View](./src/locales/ja) |
| 🇳🇴 **Norsk (Norwegian Bokmål)** | ✅ 100% | [View](./src/locales/nb) |
| 🇵🇱 **Polski (Polish)** | ✅ 100% | [View](./src/locales/pl) |
| 🇵🇹 **Português (Portuguese)** | ✅ 100% | [View](./src/locales/pt) |
| 🇷🇺 **Русский (Russian)** | ✅ 100% | [View](./src/locales/ru) |
| 🇹🇷 **Türkçe (Turkish)** | ✅ 100% | [View](./src/locales/tr) |
| 🇺🇦 **Українська (Ukrainian)** | ✅ 100% | [View](./src/locales/uk) |
| 🇨🇳 **中文 (Chinese)** | ✅ 100% | [View](./src/locales/zh) |
<!-- TRANSLATIONS_END -->

Want to help translate? See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Privacy & Telemetry

Obsidian Chess Studio includes optional telemetry. Collected data includes:

- Application version, OS, and architecture
- Anonymized country code (via local detection or `ip-api.com`)
- Basic usage events

**No personal information, IP addresses, or game content is collected.** You can disable telemetry at any time in the settings.

## Changelog

For a list of recent changes, see the [Changelog](./CHANGELOG.md).

## License

Obsidian Chess Studio is licensed under the [GPL-3.0 License](./LICENSE).

## Acknowledgments

Special thanks to all contributors and the chess programming community.
