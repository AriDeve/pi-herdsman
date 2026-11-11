import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { setImmediate as turn } from "node:timers/promises";
import { mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NotificationObservation } from "./notification-policy.ts";

const delivered: Array<{ title: string; body: string }> = [];
mock.module("./desktop-notifications.ts", {
  namedExports: {
    sendDesktopNotification: async (message: {
      title: string;
      body: string;
    }) => {
      delivered.push(message);
    },
  },
});
// Install the delivery boundary mock before support imports the composed extension.
const { fakePi, fakeContext, setLeadEnvironment } =
  await import("./support.ts");
const { registerDesktopNotifications } =
  await import("./notification-runtime.ts");

test("native completion composes with Herdr semantics without completion_seq; continuation and switch never replay", async (t) => {
  setLeadEnvironment();
  delivered.length = 0;
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hn-${randomUUID()}`
      : `/tmp/hn-${randomUUID()}.sock`;
  process.env.HERDR_SOCKET_PATH = endpoint;
  process.env.HERDR_PANE_ID = "notification-pane";
  const server = createServer();
  const sockets = new Set<Socket>();
  let subscribed = Promise.withResolvers<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString().trim());
      socket.write(
        `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
      );
      subscribed.resolve(socket);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(endpoint, listening.resolve);
  await listening.promise;
  const f = fakePi();
  let queued = false;
  const ctx = { ...fakeContext(), hasPendingMessages: () => queued };
  ctx.hasUI = true;
  let enabled = false;
  let current: Omit<NotificationObservation, "completionAllowed"> = {
    session: "session-a",
    role: "Lead",
    authority: "lead:session-a",
    enabled: true,
    state: "idle",
    sequence: 1,
  };
  ctx.sessionManager.getSessionId = () => current.session;
  let read = Promise.withResolvers<void>();
  registerDesktopNotifications(f.pi as unknown as ExtensionAPI, {
    enabled: () => enabled,
    current: async () => {
      read.resolve();
      return { ...current, enabled };
    },
  });
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of f.events.get(name) ?? []) await handler(event, ctx);
  };
  t.after(async () => {
    await emit("session_shutdown");
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    setLeadEnvironment();
  });
  await emit("session_start");
  await turn();
  assert.equal(
    sockets.size,
    0,
    "default-off does not create a semantic observer",
  );
  enabled = true;
  f.pi.events.emit("pi-herdsman:desktop-notifications", undefined);
  await subscribed.promise;
  await read.promise;
  await turn();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observe = async (change: Partial<typeof current>) => {
    current = { ...current, ...change };
    read = Promise.withResolvers<void>();
    for (const socket of sockets)
      if (!socket.destroyed)
        socket.write(
          `${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "notification-pane", workspace_id: "workspace", agent_status: current.state } })}\n`,
        );
    await read.promise;
    await turn();
  };
  const flush = async () => {
    t.mock.timers.tick(1000);
    await turn();
    await turn();
  };
  const successful = { messages: [{ role: "assistant", stopReason: "stop" }] };
  await flush();
  assert.deepEqual(delivered, []);
  await emit("agent_start");
  await turn();
  await observe({ state: "working", sequence: 2 });
  await emit("agent_end", successful);
  await observe({ state: "idle", sequence: 3 });
  await flush();
  assert.deepEqual(delivered, [
    { title: "Herdsman · Lead", body: "Session session-a completed." },
  ]);
  await emit("agent_end", successful);
  await observe({ sequence: 4 });
  await flush();
  assert.equal(delivered.length, 1, "a repeated end is not new work");
  for (const continuation of [
    { willContinue: true },
    { awaitingAsyncWork: true },
  ]) {
    await emit("agent_start");
    await observe({ state: "working", sequence: current.sequence + 1 });
    await emit("agent_end", { ...successful, ...continuation });
    await observe({ state: "idle", sequence: current.sequence + 1 });
    await flush();
    assert.equal(
      delivered.length,
      1,
      "scheduled continuation or async work is not completion",
    );
  }
  await observe({ state: "blocked", sequence: 9 });
  await flush();
  assert.equal(delivered.at(-1)?.body, "Session session-a needs input.");
  await observe({ state: "working", sequence: 10 });
  await observe({ state: "blocked", sequence: 11 });
  enabled = false;
  await flush();
  assert.equal(delivered.length, 2, "disablement cancels pending input");
  enabled = true;
  subscribed = Promise.withResolvers<Socket>();
  read = Promise.withResolvers<void>();
  current = { ...current, session: "session-b", authority: "lead:session-b" };
  await emit("session_switch");
  await subscribed.promise;
  await read.promise;
  await flush();
  assert.equal(delivered.length, 2, "restored blocked input is a baseline");
  await emit("agent_start");
  await observe({ state: "working", sequence: 12 });
  await emit("agent_end", successful);
  await observe({ state: "idle", sequence: 13 });
  queued = true;
  await flush();
  assert.equal(delivered.length, 2, "send-time queued work cancels completion");
  queued = false;
  await observe({ state: "working", sequence: 14 });
  await observe({ state: "blocked", sequence: 15 });
  await flush();
  assert.equal(
    delivered.length,
    3,
    "session replacement leaves exactly one future delivery observer",
  );
  assert.equal(delivered.at(-1)?.body, "Session session-b needs input.");
});

test("direct opt-in preserves a fast completion while the initial observation is in flight", async (t) => {
  setLeadEnvironment();
  delivered.length = 0;
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hf-${randomUUID()}`
      : `/tmp/hf-${randomUUID()}.sock`;
  process.env.HERDR_SOCKET_PATH = endpoint;
  process.env.HERDR_PANE_ID = "fast-manager-pane";
  const accepted = Promise.withResolvers<Socket>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => accepted.resolve(socket));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(endpoint, listening.resolve);
  await listening.promise;
  const f = fakePi();
  let enabled = false;
  let idle = true;
  const ctx = { ...fakeContext(), hasUI: true, isIdle: () => idle };
  const initialRead = Promise.withResolvers<void>();
  const releaseInitialRead = Promise.withResolvers<void>();
  const followingRead = Promise.withResolvers<void>();
  let reads = 0;
  let current: Omit<NotificationObservation, "completionAllowed"> = {
    session: ctx.sessionManager.getSessionId(),
    role: "Manager",
    authority: "manager:current",
    enabled: true,
    state: "idle",
    sequence: 3,
    semanticCompletion: 3,
  };
  registerDesktopNotifications(f.pi as unknown as ExtensionAPI, {
    enabled: () => enabled,
    current: async () => {
      if (++reads === 1) {
        initialRead.resolve();
        await releaseInitialRead.promise;
      } else followingRead.resolve();
      return { ...current };
    },
  });
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of f.events.get(name) ?? []) await handler(event, ctx);
  };
  t.after(async () => {
    releaseInitialRead.resolve();
    await emit("session_shutdown");
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    setLeadEnvironment();
  });
  await emit("session_start");
  // A config-file write is first noticed at agent_start, not through the settings bus.
  enabled = true;
  idle = false;
  await emit("agent_start");
  await initialRead.promise;
  const socket = await accepted.promise;
  current = { ...current, state: "idle", sequence: 5, semanticCompletion: 5 };
  idle = true;
  await emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  releaseInitialRead.resolve();
  await followingRead.promise;
  await turn();
  socket.write(
    `${JSON.stringify({ id: "herdsman:notifications", result: { type: "subscription_started" } })}\n`,
  );
  await turn();
  await turn();
  t.mock.timers.tick(1000);
  await turn();
  await turn();
  assert.deepEqual(delivered, [
    {
      title: "Herdsman · Manager",
      body: `Session ${current.session} completed.`,
    },
  ]);
});
