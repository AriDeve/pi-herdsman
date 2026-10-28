import { contentText } from "@earendil-works/pi-ai";

export const RESPONSE_CHUNK_MAX_BYTES = 12 * 1024;
export const RESPONSE_CHUNK_MAX_LINES = 1000;
export const RESPONSE_PAGE_SIZE = 20;
const PREVIEW_CHARACTERS = 160;

export interface RecoverableResponse {
  id: string;
  text: string;
  timestamp: string;
}

interface Entry {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  customType?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/** Visible assistant text only: thinking, tool calls, and non-assistant history are never read. */
function visibleResponse(entry: Entry): RecoverableResponse | undefined {
  if (
    entry.type !== "message" ||
    entry.message?.role !== "assistant" ||
    typeof entry.id !== "string"
  )
    return undefined;
  const text = contentText(entry.message.content as never, "");
  return text.trim()
    ? {
        id: entry.id,
        text,
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      }
    : undefined;
}

/** Every visible assistant response persisted in the session file, in file order. */
export function sessionResponses(
  entries: readonly Entry[],
): RecoverableResponse[] {
  return entries.flatMap((entry) => visibleResponse(entry) ?? []);
}

/**
 * Responses between the accepted-request marker and the selected response,
 * following persisted parent links. Later continuation or branching cannot
 * change this chain; any broken link fails closed.
 */
export function assignmentResponses(
  entries: readonly Entry[],
  markerId: string,
  selectedId: string,
): RecoverableResponse[] {
  const byId = new Map<string, Entry>();
  for (const entry of entries)
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  const chain: Entry[] = [];
  let cursor = byId.get(selectedId);
  while (cursor && cursor.id !== markerId) {
    if (chain.length > byId.size) return [];
    // Another accepted-request marker means the span crosses an assignment boundary.
    if (
      cursor.type === "custom" &&
      cursor.customType === "pi-herdsman-agent-required-evidence"
    )
      return [];
    chain.push(cursor);
    cursor =
      typeof cursor.parentId === "string"
        ? byId.get(cursor.parentId)
        : undefined;
  }
  if (!cursor || !chain.length) return [];
  const responses = chain.reverse().flatMap((e) => visibleResponse(e) ?? []);
  return responses.at(-1)?.id === selectedId ? responses : [];
}

export function responseSummary(
  response: RecoverableResponse,
  index: number,
  selectedId?: string,
) {
  const points = Array.from(response.text.replace(/\s+/gu, " "));
  return {
    id: response.id,
    index,
    timestamp: response.timestamp,
    characters: Array.from(response.text).length,
    preview:
      points.length > PREVIEW_CHARACTERS
        ? `${points.slice(0, PREVIEW_CHARACTERS).join("")}…`
        : points.join(""),
    ...(response.id === selectedId ? { selected: true } : {}),
  };
}

/**
 * One bounded chunk by Unicode code point. Offsets count code points, so a
 * chunk never splits a character and next_offset resumes exactly.
 */
export function responseChunk(
  text: string,
  offset: number,
): { text: string; total: number; nextOffset?: number } {
  const points = Array.from(text);
  let bytes = 0;
  let lines = 1;
  let end = offset;
  while (end < points.length) {
    const point = points[end]!;
    const size = Buffer.byteLength(point, "utf8");
    const line = point === "\n" ? 1 : 0;
    if (
      end > offset &&
      (bytes + size > RESPONSE_CHUNK_MAX_BYTES ||
        lines + line > RESPONSE_CHUNK_MAX_LINES)
    )
      break;
    bytes += size;
    lines += line;
    end++;
  }
  return {
    text: points.slice(offset, end).join(""),
    total: points.length,
    ...(end < points.length ? { nextOffset: end } : {}),
  };
}
