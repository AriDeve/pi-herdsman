import {
  getAgentDir,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";

/** Only persisted inspection; never opens a SessionManager or owns its writer. */
export interface ForeignSessionSnapshot {
  getEntries(): SessionEntry[];
  getHeader(): SessionHeader;
  getSessionId(): string;
  getCwd(): string;
}

function sessionHeader(
  entries: readonly (SessionHeader | SessionEntry)[],
): SessionHeader {
  const header = entries[0];
  if (
    header?.type !== "session" ||
    typeof header.id !== "string" ||
    !header.id.trim()
  )
    throw new Error("Invalid persisted session header");
  return header;
}

/** Read only the physical title/header prefix, including large workspace headers. */
export function readForeignSessionHeader(
  path: string,
): SessionHeader | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.allocUnsafe(4096);
    const decoder = new StringDecoder("utf8");
    const limit = 1024 * 1024;
    let content = "";
    let length = 0;
    while (length < limit) {
      const bytes = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, limit - length),
        length,
      );
      if (bytes === 0)
        return length === 0
          ? undefined
          : sessionHeader(parseSessionEntries(content + decoder.end()));
      length += bytes;
      content += decoder.write(buffer.subarray(0, bytes));
      const firstNewline = content.indexOf("\n");
      if (firstNewline >= 0) {
        const physical: unknown = JSON.parse(content.slice(0, firstNewline));
        if (
          typeof physical !== "object" ||
          physical === null ||
          !("type" in physical)
        )
          throw new Error("Invalid persisted session header");
        if (physical.type !== "title")
          return sessionHeader(
            parseSessionEntries(content.slice(0, firstNewline + 1)),
          );
      }
      const secondNewline =
        firstNewline < 0 ? -1 : content.indexOf("\n", firstNewline + 1);
      if (secondNewline >= 0)
        return sessionHeader(
          parseSessionEntries(content.slice(0, secondNewline + 1)),
        );
    }
    if (readSync(fd, buffer, 0, 1, length) !== 0)
      throw new Error("Session header exceeds 1 MiB read limit");
    return sessionHeader(parseSessionEntries(content + decoder.end()));
  } finally {
    closeSync(fd);
  }
}

export function inspectSessionFile(path: string): ForeignSessionSnapshot {
  // Native parsing folds the fixed title slot and preserves persisted blob refs.
  // These consumers inspect metadata/usage/text, not inline image payloads.
  const content = readFileSync(path, "utf8");
  const first: unknown = JSON.parse(
    content.slice(
      0,
      content.indexOf("\n") < 0 ? content.length : content.indexOf("\n"),
    ),
  );
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    (first.type !== "session" && first.type !== "title")
  )
    throw new Error("Invalid persisted session header");
  const parsed = parseSessionEntries(content);
  const header = sessionHeader(parsed);
  const entries = parsed.filter(
    (entry): entry is SessionEntry => entry.type !== "session",
  );
  return {
    getEntries: () => [...entries],
    getHeader: () => header,
    getSessionId: () => header.id,
    getCwd: () => {
      if (typeof header.cwd !== "string" || !isAbsolute(header.cwd))
        throw new Error("Persisted session has no absolute cwd");
      return resolve(header.cwd);
    },
  };
}

/**
 * Prove a custom entry and its active native ancestry are readable from disk.
 * appendEntry's return is not proof: OMP may retain a failed write in memory.
 * This uses the caller-selected native branch, never the file's last branch.
 */
export function assertPersistedCustomEntry(
  snapshot: ForeignSessionSnapshot,
  sessionId: string,
  branch: readonly SessionEntry[],
  customType: string,
  data: unknown,
): void {
  const fail = () => new Error("Native session persistence could not be verified");
  if (snapshot.getSessionId() !== sessionId || branch.length === 0) throw fail();
  const persisted = new Map(snapshot.getEntries().map(entry => [entry.id, entry]));
  let parentId: string | null = null;
  for (const entry of branch) {
    const stored = persisted.get(entry.id);
    if (!entry.id || entry.parentId !== parentId || !stored || stored.parentId !== entry.parentId)
      throw fail();
    parentId = entry.id;
  }
  const expected = branch.findLast(entry => entry.type === "custom" && entry.customType === customType && isDeepStrictEqual(entry.data, data));
  const stored = expected && persisted.get(expected.id);
  if (!stored || stored.type !== "custom" || stored.customType !== customType || !isDeepStrictEqual(stored.data, data))
    throw fail();
}

function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/** Resolve an exact native filename and header identity without directory migration. */
export function findSessionFileById(
  cwd: string,
  id: string,
): string | undefined {
  if (!id || id.includes("/") || id.includes("\\")) return undefined;
  const root = join(getAgentDir(), "sessions");
  const expectedCwd = canonicalCwd(cwd);
  let match: string | undefined;
  let buckets: Dirent[];
  try {
    buckets = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const directory = join(root, bucket.name);
    for (const filename of readdirSync(directory)) {
      if (!filename.endsWith(`_${id}.jsonl`)) continue;
      const path = join(directory, filename);
      try {
        const header = readForeignSessionHeader(path);
        if (
          !header ||
          header.id !== id ||
          typeof header.cwd !== "string" ||
          !isAbsolute(header.cwd) ||
          canonicalCwd(header.cwd) !== expectedCwd
        )
          continue;
        const canonicalPath = realpathSync(path);
        if (match && match !== canonicalPath) return undefined;
        match = canonicalPath;
      } catch {
        // A missing, incomplete, or invalid foreign journal proves no identity.
      }
    }
  }
  return match;
}
