import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  collectSessionUsage,
  readPersistedTranscript,
} from "./agent-controller.ts";
import {
  findSessionFileById,
  inspectSessionFile,
  readForeignSessionHeader,
} from "./foreign-session.ts";

// Also callable through OMP's extension loader, which supplies the native SDK.
export function checkForeignSessionInspection(): void {
  const directory = mkdtempSync(join(tmpdir(), "herdsman-foreign-session-"));
  const bucket = join(
    getAgentDir(),
    "sessions",
    `herdsman-test-${randomUUID()}`,
  );
  const id = randomUUID();
  const cwd = join(directory, "project");
  const alias = join(directory, "alias");
  const path = join(bucket, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const usage = {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 13,
    cost: {
      input: 0.07,
      output: 0.03,
      cacheRead: 0.01,
      cacheWrite: 0.01,
      total: 0.12,
    },
  };
  const blob = `blob:sha256:${"a".repeat(64)}`;
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp,
    cwd,
  };
  const entries = [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        timestamp: 0,
        content: [
          { type: "text", text: "Inspect this live assignment" },
          { type: "image", data: blob, mimeType: "image/png" },
        ],
      },
    },
    {
      type: "message",
      id: "assistant",
      parentId: "user",
      timestamp,
      message: {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4.1",
        content: [{ type: "text", text: "Persisted reply" }],
        usage,
        stopReason: "stop",
        timestamp: 1,
      },
    },
    {
      type: "model_usage",
      id: "accounting",
      parentId: "assistant",
      timestamp,
      purpose: "title",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4.1",
      usage,
      stopReason: "stop",
    },
  ];
  const slotRecord = {
    type: "title",
    v: 1,
    title: "Live assignment",
    source: "user",
    updatedAt: timestamp,
    pad: "",
  };
  slotRecord.pad = " ".repeat(
    255 - Buffer.byteLength(JSON.stringify(slotRecord)),
  );
  const slot = JSON.stringify(slotRecord) + "\n";
  const content =
    slot +
    [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") +
    "\n";
  const originalOpen = SessionManager.open;
  let writerCalls = 0;
  SessionManager.open = () => {
    writerCalls++;
    throw new Error("Foreign inspection must not open a session writer");
  };
  try {
    mkdirSync(cwd);
    symlinkSync(cwd, alias, "dir");
    mkdirSync(bucket, { recursive: true });
    writeFileSync(path, content);
    const session = inspectSessionFile(path);
    assert.equal(session.getSessionId(), id);
    assert.equal(session.getCwd(), cwd);
    assert.deepEqual(
      session.getEntries().map((entry) => entry.id),
      ["user", "assistant", "accounting"],
    );
    assert.equal(readForeignSessionHeader(path)?.id, id);
    const parsedHeader = session.getHeader();
    assert.equal(
      "title" in parsedHeader ? parsedHeader.title : undefined,
      "Live assignment",
    );
    assert.match(JSON.stringify(session.getEntries()), /blob:sha256:/);
    const messages = buildSessionContext(session.getEntries()).messages;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.match(JSON.stringify(messages), /Inspect this live assignment/);
    const interrupted = {
      type: "message",
      id: "interrupted",
      parentId: "accounting",
      timestamp,
      message: {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4.1",
        content: [{ type: "text", text: "Partial interrupted evidence" }],
        usage,
        stopReason: "aborted",
        timestamp: 2,
      },
    };
    const transcript = readPersistedTranscript(
      { piSessionId: id, piSessionFile: path },
      () => content + JSON.stringify(interrupted) + "\n",
      () => true,
    );
    assert.match(transcript.transcript, /Partial interrupted evidence/);
    const totals = collectSessionUsage(
      { sessionManager: session },
      () => [],
      () => undefined,
    );
    assert.deepEqual(totals.current, {
      input: 14,
      output: 6,
      cacheRead: 4,
      cacheWrite: 2,
      cost: 0.24,
    });
    assert.deepEqual(totals.breakdown.get("openai/gpt-4.1"), totals.current);
    assert.equal(totals.complete, true);
    assert.equal(findSessionFileById(alias, id), path);
    assert.equal(findSessionFileById(directory, id), undefined);
    assert.equal(findSessionFileById(cwd, id.slice(0, 8)), undefined);
    const mismatch = join(bucket, `mismatched_${id}.jsonl`);
    writeFileSync(
      mismatch,
      JSON.stringify({ ...header, id: randomUUID() }) + "\n",
    );
    assert.equal(findSessionFileById(cwd, id), path);
    const duplicate = join(bucket, `duplicate_${id}.jsonl`);
    writeFileSync(duplicate, content);
    assert.equal(findSessionFileById(cwd, id), undefined);
    const invalid = join(directory, "invalid.jsonl");
    writeFileSync(invalid, JSON.stringify({ ...header, id: "" }) + "\n");
    assert.throws(() => inspectSessionFile(invalid), /header/);
    for (const malformed of [
      "not JSON\n",
      "{}\n",
      "not JSON\n" + JSON.stringify(header) + "\n",
    ]) {
      writeFileSync(invalid, malformed);
      assert.throws(() => readForeignSessionHeader(invalid));
      assert.throws(() => inspectSessionFile(invalid));
    }
    assert.equal(readFileSync(path, "utf8"), content);
    assert.equal(writerCalls, 0);
  } finally {
    SessionManager.open = originalOpen;
    rmSync(bucket, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}
