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
import {
  registerOmpLaunchPolicy,
  type OmpLaunchPolicy,
} from "./agent-definitions.ts";
import {
  createManagedAgentExecutionState,
  registerManagedAgentSettlementHandlers,
} from "./managed-agent-runtime.ts";

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
  const runtime = registerOmpRuntime(pi);
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
    runtime,
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

test("interrupt dispatch does not wait for whole-run settlement or publish its cancelled result", async () => {
  for (const pending of [false, true]) {
    for (const willContinue of [false, true]) {
      const f = fixture();
      f.ctx.hasPendingMessages = () => pending;
      const execution = createManagedAgentExecutionState();
      execution.pendingInterruptReplacement = "Owner interrupt: replacement";
      let settlements = 0;
      const unexpected = () => {
        throw new Error("Unexpected result publication");
      };
      const lifecycle = registerManagedAgentSettlementHandlers(
        f.pi,
        execution,
        {
          onOperationEnd: f.runtime.onOperationEnd,
          delegationEnabled: false,
          tryClaimAssignmentLock: unexpected,
          sameIdentity: () => false,
          hasUndeliveredDirectChildWork: () => false,
          reportMetadata: unexpected,
          appendStateError: unexpected,
          appendResultError: unexpected,
          resultWriteMaxAttempts: 1,
          settleControllerResults: async () => {
            settlements++;
          },
        },
      );
      try {
        await f.emit("agent_end", {
          messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
          willContinue,
        });
        assert.equal(f.sent[0]?.content, "Owner interrupt: replacement");
        assert.equal(execution.pendingInterruptReplacement, undefined);
        assert.equal(
          settlements,
          0,
          "cancelled operation cannot settle the assignment",
        );
        await f.emit("agent_end", {
          messages: [{ role: "assistant", stopReason: "stop", content: [] }],
        });
        assert.equal(f.sent.length, 1, "replacement is dispatched once");
        assert.equal(settlements, pending ? 0 : 1);
      } finally {
        lifecycle.cleanup();
      }
    }
  }
});

test("settlement failure preserves later handlers and native error reporting", async () => {
  const f = fixture();
  const failures = [
    new Error("first settlement failure"),
    new Error("second settlement failure"),
  ];
  f.on("agent_before_settle", () => {
    throw failures[0];
  });
  f.on("agent_settled", async () => {
    throw failures[1];
  });
  f.on("agent_settled", () =>
    f.pi.sendUserMessage("later settlement completed"),
  );
  let reported: unknown;
  try {
    await f.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [] }],
    });
  } catch (error) {
    reported = error;
  }
  assert.equal(f.sent[0]?.content, "later settlement completed");
  assert.ok(reported instanceof AggregateError);
  assert.deepEqual(reported.errors, failures);
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

test("native Agent policy rejects denied targets even after tool activation changes", async () => {
  const handlers = new Map<string, (event: Event) => unknown>();
  const policy: OmpLaunchPolicy = {
    tools: ["read", "write", "mcp__check_allowed"],
    excluded: ["mcp__check_denied"],
    noBuiltinTools: false,
    requiredTools: ["ask_owner"],
    skillDirectories: [],
  };
  let active = ["bash", "read", "write", "mcp__check_denied"];
  const all = [...active, "ask_owner", "mcp__check_allowed"].map((name) => ({
    name,
    sourceInfo: { source: name.startsWith("mcp__") ? "mcp" : "builtin" },
  }));
  const pi = {
    registerFlag() {},
    getFlag: () => JSON.stringify(policy),
    getAllTools: () => all,
    getActiveTools: () => active,
    async setActiveTools(names: string[]) {
      active = names;
    },
    on(name: string, handler: (event: Event) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  registerOmpLaunchPolicy(pi);
  await handlers.get("session_start")!({});
  assert.deepEqual(active, [
    "read",
    "write",
    "ask_owner",
    "mcp__check_allowed",
  ]);
  // Another extension may change activation; the execution policy still applies.
  await pi.setActiveTools(all.map((tool) => tool.name));
  for (const toolName of ["bash", "mcp__check_denied"]) {
    const result = handlers.get("tool_call")!({ toolName });
    assert.ok(result && typeof result === "object" && "block" in result);
    assert.equal(result.block, true);
  }
  for (const toolName of ["read", "write", "ask_owner", "mcp__check_allowed"])
    assert.equal(handlers.get("tool_call")!({ toolName }), undefined);
  await handlers.get("before_agent_start")!({ systemPrompt: ["Base policy"] });
  assert.deepEqual(active, [
    "read",
    "write",
    "ask_owner",
    "mcp__check_allowed",
  ]);
});
