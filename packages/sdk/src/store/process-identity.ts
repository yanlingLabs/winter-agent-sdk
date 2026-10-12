import { readFileSync } from "node:fs";

/** Linux kernel evidence, not a caller's wall-clock timestamp or a host PID. */
export interface LeaseProcessIdentity { bootId: string; startTicks: string }
export type LeaseIdentityProbe = (pid: number) => LeaseProcessIdentity | null;

export function parseLinuxProcessIdentity(boot: string, stat: string): LeaseProcessIdentity | null {
  const bootId = boot.trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(bootId)) return null;
  // comm (field2) may itself contain spaces or ')'; starttime is field22.
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const startTicks = stat.slice(close + 1).trim().split(/\s+/)[19];
  if (startTicks === undefined || !/^\d+$/.test(startTicks)) return null;
  return { bootId: bootId.toLowerCase(), startTicks };
}

export const readLinuxProcessIdentity: LeaseIdentityProbe = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    return parseLinuxProcessIdentity(readFileSync("/proc/sys/kernel/random/boot_id", "utf8"), readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch { return null; } // missing/unreadable identity is unknown, not proof of death
};
export function sameLeaseProcessIdentity(a: LeaseProcessIdentity, b: LeaseProcessIdentity): boolean {
  return a.bootId === b.bootId && a.startTicks === b.startTicks;
}
export const defaultLeaseIdentityProbe = (): LeaseIdentityProbe | undefined => process.platform === "linux" ? readLinuxProcessIdentity : undefined;
