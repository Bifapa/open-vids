import { cpus, freemem, platform, release } from "node:os";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { execSync } from "node:child_process";
import { getSystemTotalMb } from "@hyperframes/engine";

// Local host/environment facts for doctor, preflight, and render diagnostics.
// No network, no persistence, no external reporting — values are computed on
// demand and consumed in-process only.

/** Convert bytes to whole megabytes. */
export function bytesToMb(bytes: number): number {
  return Math.trunc(bytes / (1024 * 1024));
}

export interface HostInfo {
  os_release: string;
  cpu_count: number;
  cpu_model: string | null;
  cpu_speed: number | null;
  memory_total_mb: number;
  is_docker: boolean;
  is_ci: boolean;
  ci_name: string | null;
  is_wsl: boolean;
  is_tty: boolean;
}

let cached: HostInfo | null = null;

/** Collect host facts. Cached after first call (static values only). */
export function getHostInfo(): HostInfo {
  if (cached) return cached;
  const cpuInfo = cpus();
  const firstCpu = cpuInfo[0] ?? null;
  cached = {
    os_release: release(),
    cpu_count: cpuInfo.length,
    cpu_model: firstCpu?.model?.trim() ?? null,
    cpu_speed: firstCpu?.speed ?? null,
    memory_total_mb: getSystemTotalMb(),
    is_docker: detectDocker(),
    is_ci: detectCI(),
    ci_name: getCIName(),
    is_wsl: detectWSL(),
    is_tty: Boolean(process.stdout?.isTTY),
  };
  return cached;
}

/** Test-only: drop the cached snapshot so the next read re-samples. */
export function __resetHostInfoForTests(): void {
  cached = null;
}

export function detectWSL(): boolean {
  if (platform() !== "linux") return false;
  try {
    const osRelease = release().toLowerCase();
    if (osRelease.includes("microsoft") || osRelease.includes("wsl")) return true;
    const procVersion = readFileSync("/proc/version", "utf-8").toLowerCase();
    return procVersion.includes("microsoft") || procVersion.includes("wsl");
  } catch {
    return false;
  }
}

function detectDocker(): boolean {
  try {
    if (existsSync("/.dockerenv")) return true;
    if (platform() === "linux") {
      const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
      if (cgroup.includes("docker") || cgroup.includes("containerd")) return true;
    }
  } catch {
    // Ignore — not in Docker
  }
  return false;
}

type CIProvider =
  | { name: string | null; envVar: string; mode: "truthy" }
  | { name: string | null; envVar: string; mode: "presence" };

const CI_PROVIDERS: CIProvider[] = [
  { name: "github_actions", envVar: "GITHUB_ACTIONS", mode: "truthy" },
  { name: "gitlab_ci", envVar: "GITLAB_CI", mode: "truthy" },
  { name: "circleci", envVar: "CIRCLECI", mode: "truthy" },
  { name: "jenkins", envVar: "JENKINS_URL", mode: "presence" },
  { name: "buildkite", envVar: "BUILDKITE", mode: "truthy" },
  { name: "travis", envVar: "TRAVIS", mode: "truthy" },
  { name: null, envVar: "CONTINUOUS_INTEGRATION", mode: "truthy" },
  { name: null, envVar: "CI", mode: "truthy" },
];

function matchesProvider(p: CIProvider): boolean {
  const v = process.env[p.envVar];
  if (p.mode === "presence") return v != null;
  return v === "true" || v === "1";
}

function detectCI(): boolean {
  return CI_PROVIDERS.some(matchesProvider);
}

function getCIName(): string | null {
  for (const provider of CI_PROVIDERS) {
    if (provider.name && matchesProvider(provider)) return provider.name;
  }
  return detectCI() ? "unknown" : null;
}

/**
 * Get /dev/shm size in MB (Linux only). Chrome uses shared memory heavily;
 * small container defaults cause crashes.
 */
export function getShmSizeMb(): number | null {
  if (platform() !== "linux") return null;
  try {
    const stats = statfsSync("/dev/shm");
    return bytesToMb(stats.bsize * stats.blocks);
  } catch {
    return null;
  }
}

/** Get available disk space in MB at a given path. */
export function getFreeDiskMb(path: string = "."): number | null {
  try {
    const stats = statfsSync(path);
    return bytesToMb(stats.bsize * stats.bavail);
  } catch {
    return null;
  }
}

/**
 * Get available memory in MB, accounting for OS-level page caching.
 *
 * `os.freemem()` on macOS returns only truly free pages — ignoring
 * inactive/purgeable/speculative pages that the kernel reclaims on demand.
 * Linux exposes the correct value via `MemAvailable` in /proc/meminfo.
 */
export function getAvailableMemoryMb(): number {
  const fallback = bytesToMb(freemem());

  if (platform() === "darwin") {
    try {
      const raw = execSync("vm_stat", { encoding: "utf-8", timeout: 5000 });
      const pageSize = parseInt(raw.match(/page size of (\d+)/)?.[1] ?? "0", 10);
      if (!pageSize) return fallback;

      const pages = (key: string) =>
        parseInt(raw.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? "0", 10);

      const available =
        (pages("Pages free") +
          pages("Pages inactive") +
          pages("Pages purgeable") +
          pages("Pages speculative")) *
        pageSize;

      return available > 0 ? bytesToMb(available) : fallback;
    } catch {
      return fallback;
    }
  }

  if (platform() === "linux") {
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf-8");
      const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (match) {
        return Math.trunc(parseInt(match[1]!, 10) / 1024);
      }
      return fallback;
    } catch {
      return fallback;
    }
  }

  return fallback;
}
