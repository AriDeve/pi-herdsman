import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerOmpRuntime } from "./omp-runtime.ts";
import { controlMarker } from "./mailbox.ts";
import { Type } from "typebox";

type Event = Record<string, unknown>;
const ACCEPTED = "11111111-1111-4111-8111-111111111111";
const REJECTED = "22222222-2222-4222-8222-222222222222";
type Handler = (event: Event, ctx: ExtensionContext) => unknown;
function fixture() {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const tools: ToolDefinition[] = [];
  let idle = true;
  // This fixture supplies only the host methods exercised at the boundary.
  const ctx = {
    isIdle: () => idle,
    hasPendingMessages: () => false,
    sessionManager: {
      getBranch: () => [
        {
          id: "durable-response",
          type: "message",
          message: { role: "assistant", timestamp: 42 },
        },
      ],
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    sendUserMessage(content: unknown, options: unknown) {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  registerOmpRuntime(pi);
  const on = pi.on as unknown as (name: string, handler: Handler) => void;
  const emit = async (name: string, event: Event = {}) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? [])
      results.push(await handler({ type: name, ...event }, ctx));
    return results;
  };
  return {
    pi,
    on,
    emit,
    sent,
    tools,
    ctx,
    setIdle(value: boolean) {
      idle = value;
    },
  };
}

test("mailbox acceptance transforms once and starts idle native sessions", async () => {
  const f = fixture();
  f.on("input", (event) =>
    event.text === controlMarker(ACCEPTED)
      ? { action: "transform", text: "Accepted assignment" }
      : { action: "handled" },
  );
  await f.emit("session_start");
  f.pi.sendUserMessage(controlMarker(ACCEPTED), { deliverAs: "steer" });
  assert.deepEqual(f.sent, [
    { content: "Accepted assignment", options: undefined },
  ]);
  f.pi.sendUserMessage(controlMarker(REJECTED), { deliverAs: "steer" });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(await f.emit("input", { text: controlMarker(REJECTED) }), [
    { handled: true },
  ]);
  f.setIdle(false);
  f.pi.sendUserMessage(controlMarker(ACCEPTED), { deliverAs: "steer" });
  assert.deepEqual(f.sent[1], {
    content: "Accepted assignment",
    options: { deliverAs: "steer" },
  });
});

test("retries cannot settle assignments and terminal evidence uses persisted identity", async () => {
  const f = fixture();
  const settled: Event[] = [];
  const turns: Event[] = [];
  f.on("agent_settled", (event) => {
    settled.push(event);
  });
  f.on("turn_end", (event) => {
    turns.push(event);
  });
  const message = { role: "assistant", timestamp: 42, stopReason: "stop" };
  await f.emit("agent_end", { messages: [message], willContinue: true });
  assert.deepEqual(settled, []);
  await f.emit("turn_end", { message });
  assert.equal(turns[0]?.messageEntryId, "durable-response");
  assert.equal(turns[0]?.outcome, "completed");
  await f.emit("agent_end", {
    messages: [{ ...message, stopReason: "aborted" }],
  });
  assert.equal(settled[0]?.aborted, true);
  assert.equal(settled[0]?.outcome, "aborted");
});

test("automatic compaction reason cannot leak into a later manual compaction", async () => {
  const f = fixture();
  const reasons: unknown[] = [];
  f.on("session_before_compact", (event) => {
    reasons.push(event.reason);
  });
  await f.emit("auto_compaction_start", { reason: "overflow" });
  await f.emit("session_before_compact");
  await f.emit("auto_compaction_end", { result: {} });
  await f.emit("session_before_compact");
  assert.deepEqual(reasons, ["overflow", "manual"]);
});

test("sequential orchestration calls cannot overlap and rejection releases the next call", async () => {
  const f = fixture();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const parameters = Type.Object({});
  f.pi.registerTool({
    name: "first",
    label: "first",
    description: "first",
    parameters,
    executionMode: "sequential",
    async execute() {
      order.push("first-start");
      await gate;
      order.push("first-end");
      throw new Error("transition failed");
    },
  });
  f.pi.registerTool({
    name: "second",
    label: "second",
    description: "second",
    parameters,
    executionMode: "sequential",
    async execute() {
      order.push("second");
      return { content: [{ type: "text", text: "recovered" }], details: {} };
    },
  });
  const first = f.tools[0]!.execute("one", {}, undefined, undefined, f.ctx);
  const second = f.tools[1]!.execute("two", {}, undefined, undefined, f.ctx);
  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  release();
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "fulfilled"],
  );
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});
