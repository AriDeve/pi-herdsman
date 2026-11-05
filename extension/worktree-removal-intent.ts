import { isAbsolute } from "node:path";

export const REMOVAL_INTENT_ENTRY = "pi-herdsman-worktree-removal";
export type RemovalTarget = {
  repoKey: string;
  branch: string;
  assignmentId: string;
  piSessionFile: string;
  checkoutPath: string;
};
export type RemovalRequest = RemovalTarget & {
  version: 1;
  phase: "request";
  requestId: string;
  sessionId: string;
  createdAt: number;
};
export type RemovalOutcome = "approved" | "cancelled" | "dismissed" | "left";
export function sameRemovalTarget(a: RemovalTarget, b: RemovalTarget): boolean {
  return a.repoKey === b.repoKey && a.branch === b.branch && a.assignmentId === b.assignmentId && a.piSessionFile === b.piSessionFile && a.checkoutPath === b.checkoutPath;
}

// Only the caller's active native branch is replayed. Records are review intent,
// never restored Manager authority or a deletion transaction.
// Unsupported or malformed non-authority records are ignored, not interpreted.
// They cannot create/resolve intent or disable native status and role recovery.
export function removalIntents(entries: readonly unknown[], sessionId: string): RemovalRequest[] {
  const pending = new Map<string, RemovalRequest>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (record.type !== "custom" || record.customType !== REMOVAL_INTENT_ENTRY) continue;
    const data = record.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const value = data as Record<string, unknown>;
    if (value.sessionId !== sessionId) continue;
    const request = value.phase === "request";
    const keys = request ? ["version", "phase", "requestId", "sessionId", "createdAt", "repoKey", "branch", "assignmentId", "piSessionFile", "checkoutPath"] : ["version", "phase", "requestId", "sessionId", "outcome"];
    if (value.version !== 1 || (!request && value.phase !== "resolution") || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || [value.requestId, value.sessionId].some(v => typeof v !== "string" || !v.trim())) continue;
    if (request) {
      if ([value.repoKey, value.piSessionFile, value.checkoutPath].some(v => typeof v !== "string" || v.includes("\0") || !isAbsolute(v)) || [value.branch, value.assignmentId].some(v => typeof v !== "string" || !v.trim()) || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) continue;
    } else if (typeof value.outcome !== "string" || !["approved", "cancelled", "dismissed", "left"].includes(value.outcome)) continue;
    if (request) {
      const next = value as RemovalRequest;
      // A new current target replaces the prior intent for this branch.
      pending.set(`${next.repoKey}\0${next.branch}`, next);
    } else {
      for (const [key, current] of pending) if (current.requestId === value.requestId) pending.delete(key);
    }
  }
  return [...pending.values()];
}
