const fs = require("node:fs");
const path = require("node:path");

function normalizeTag(tagOrVersion) {
  const v = String(tagOrVersion ?? "").trim();
  if (!v) throw new Error("Missing version/tag argument.");
  return v.startsWith("v") ? v.slice(1) : v;
}

function assertSemver(version) {
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semver.test(version)) throw new Error(`Invalid version: "${version}"`);
}

function replaceFirst(text, pattern, replacer) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`Pattern not found: ${pattern}`);
  return text.slice(0, match.index) + replacer(match) + text.slice(match.index + match[0].length);
}

function updatePackageJson(repoRoot, version) {
  const file = path.join(repoRoot, "package.json");
  const original = fs.readFileSync(file, "utf8");
  const next = replaceFirst(original, /"version"\s*:\s*"([^"]+)"/m, () => `"version": "${version}"`);
  fs.writeFileSync(file, next, "utf8");
}

function updateTauriConf(repoRoot, version) {
  const file = path.join(repoRoot, "src-tauri", "tauri.conf.json");
  const original = fs.readFileSync(file, "utf8");
  const next = replaceFirst(original, /"version"\s*:\s*"([^"]+)"/m, () => `"version": "${version}"`);
  fs.writeFileSync(file, next, "utf8");
}

function updateCargoToml(repoRoot, version) {
  const file = path.join(repoRoot, "src-tauri", "Cargo.toml");
  const original = fs.readFileSync(file, "utf8");

  const packageSection = /^\[package\][\s\S]*?(?=^\[|Z)/m;
  const sectionMatch = packageSection.exec(original);
  if (!sectionMatch) throw new Error("Cargo.toml missing [package] section.");

  const section = sectionMatch[0];
  const updatedSection = replaceFirst(section, /^version\s*=\s*"([^"]+)"/m, () => `version = "${version}"`);

  const next =
    original.slice(0, sectionMatch.index) +
    updatedSection +
    original.slice(sectionMatch.index + sectionMatch[0].length);
  fs.writeFileSync(file, next, "utf8");
}

function main() {
  const rawArg = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
  const version = normalizeTag(rawArg);
  assertSemver(version);

  const repoRoot = process.cwd();
  updatePackageJson(repoRoot, version);
  updateTauriConf(repoRoot, version);
  updateCargoToml(repoRoot, version);

  // eslint-disable-next-line no-console
  console.log(`Updated version to ${version}`);
}

main();
