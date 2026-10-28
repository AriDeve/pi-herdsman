import assert from "node:assert/strict";
import test from "node:test";
import {
  assignmentResponses,
  RESPONSE_CHUNK_MAX_BYTES,
  RESPONSE_CHUNK_MAX_LINES,
  responseChunk,
  sessionResponses,
} from "./response-recovery.ts";

const assistant = (id: string, parentId: string, content: unknown) => ({
  type: "message",
  id,
  parentId,
  message: { role: "assistant", content },
});
const marker = (id: string, parentId: string) => ({
  type: "custom",
  id,
  parentId,
  customType: "pi-herdsman-agent-required-evidence",
});

test("chunks reassemble exactly without splitting characters or exceeding bounds", () => {
  const text = `${"a😀é\n".repeat(20_000)}tail`;
  let rebuilt = "";
  let offset = 0;
  for (;;) {
    const chunk = responseChunk(text, offset);
    assert.ok(Buffer.byteLength(chunk.text) <= RESPONSE_CHUNK_MAX_BYTES);
    assert.ok(chunk.text.split("\n").length <= RESPONSE_CHUNK_MAX_LINES);
    assert.doesNotMatch(chunk.text, /\uFFFD/u);
    rebuilt += chunk.text;
    if (chunk.nextOffset === undefined) break;
    offset = chunk.nextOffset;
  }
  assert.equal(rebuilt, text);
});

test("only visible assistant text is recoverable", () => {
  const entries = [
    { type: "message", id: "u", message: { role: "user", content: "USER" } },
    assistant("a", "u", [
      { type: "thinking", thinking: "PRIVATE" },
      { type: "toolCall", id: "c", name: "read", arguments: {} },
    ]),
    assistant("b", "a", [
      { type: "thinking", thinking: "PRIVATE" },
      { type: "text", text: "visible" },
    ]),
  ];
  assert.deepEqual(
    sessionResponses(entries).map((r) => [r.id, r.text]),
    [["b", "visible"]],
  );
});

test("recovery preserves visible response whitespace and omits whitespace-only messages", () => {
  const text = "\n    indented report é😀\r\n\n";
  const entries = [
    marker("m", "root"),
    assistant("blank", "m", " \n\t"),
    assistant("report", "blank", text),
  ];
  assert.deepEqual(
    sessionResponses(entries).map((r) => r.text),
    [text],
  );
  assert.deepEqual(
    assignmentResponses(entries, "m", "report").map((r) => r.text),
    [text],
  );
});

test("assignment scope follows parent links and refuses to cross another assignment", () => {
  const entries = [
    marker("m1", "root"),
    assistant("a1", "m1", "one"),
    assistant("a2", "a1", "two"),
    marker("m2", "a2"),
    assistant("a3", "m2", "three"),
  ];
  assert.deepEqual(
    assignmentResponses(entries, "m1", "a2").map((r) => r.id),
    ["a1", "a2"],
  );
  assert.deepEqual(
    assignmentResponses(entries, "m2", "a3").map((r) => r.id),
    ["a3"],
  );
  assert.deepEqual(assignmentResponses(entries, "m1", "a3"), []);
  assert.deepEqual(assignmentResponses(entries, "m2", "a2"), []);
  assert.deepEqual(assignmentResponses(entries, "m1", "missing"), []);
});
