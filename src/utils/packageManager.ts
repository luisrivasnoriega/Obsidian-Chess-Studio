import { commands } from "@/bindings";
import { unwrap } from "./unwrap";

export type InstallMethod = "download" | "brew" | "package" | "bundled";

export interface PackageManagerStatus {
  brew: boolean;
  apt: boolean;
  dnf: boolean;
  pacman: boolean;
}

let packageManagerStatusCache: PackageManagerStatus | null = null;

export async function getPackageManagerStatus(): Promise<PackageManagerStatus> {
  if (packageManagerStatusCache) {
    return packageManagerStatusCache;
  }

  const [brew, apt, dnf, pacman] = await Promise.all([
    commands
      .checkPackageManagerAvailable("brew")
      .then(unwrap)
      .catch(() => false),
    commands
      .checkPackageManagerAvailable("apt")
      .then(unwrap)
      .catch(() => false),
    commands
      .checkPackageManagerAvailable("dnf")
      .then(unwrap)
      .catch(() => false),
    commands
      .checkPackageManagerAvailable("pacman")
      .then(unwrap)
      .catch(() => false),
  ]);

  packageManagerStatusCache = { brew, apt, dnf, pacman };
  return packageManagerStatusCache;
}

export async function isInstallMethodSupported(method: InstallMethod): Promise<boolean> {
  switch (method) {
    case "download":
      return true;
    case "bundled":
      return true; // Bundled engines are always available if included in the app
    case "brew": {
      const status = await getPackageManagerStatus();
      return status.brew;
    }
    case "package": {
      const status = await getPackageManagerStatus();
      return status.apt || status.dnf || status.pacman;
    }
    default:
      return false;
  }
}

export function clearPackageManagerCache(): void {
  packageManagerStatusCache = null;
}
