import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { setImmediate as turn } from "node:timers/promises";
import { mock, test } from "node:test";

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
// The support module loads the extension; delivery must be mocked before that boundary.
const {
  fakePi,
  fakeContext,
  registerExtension,
  setLeadEnvironment,
  WORKSPACE,
  LEAD_SESSION_ID,
  isApiSnapshot,
  isAgentList,
  managedState,
  agentMailboxPath,
  writeAgentState,
  resetAgentMailbox,
  createStagedAssignmentFixture,
  realFs,
  nativeSessions,
  sessionAgentIdentity,
  readAgentState,
} = await import("./support.ts");
const { updateConfig } = await import("./config.ts");
const { supervisionRuntime, writeProjectAssignment, removeProjectAssignment } =
  await import("./supervision.ts");
const { ensureManagedAgentIdentity } =
  await import("./managed-agent-runtime.ts");
const { parseSessionEntries } = await import("@earendil-works/pi-coding-agent");

test("live exact-session filtering survives manual continuation outside worktrees and assignment release", async (t) => {
  setLeadEnvironment();
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hi-${randomUUID()}`
      : `/tmp/hi-${randomUUID()}.sock`;
  process.env.HERDR_SOCKET_PATH = endpoint;
  process.env.HERDR_PANE_ID = "notification-pane";
  process.env.HERDR_TAB_ID = "notification-tab";
  updateConfig("desktopNotifications", true);
  let agent = {
    agent: "omp",
    agent_status: "idle",
    state_change_seq: 1,
    pane_id: "notification-pane",
    tab_id: "notification-tab",
    workspace_id: WORKSPACE,
    agent_session: {
      source: "herdr:omp",
      agent: "omp",
      kind: "id",
      value: LEAD_SESSION_ID,
    },
    focused: true,
  };
  let get = Promise.withResolvers<void>();
  const f = fakePi({
    exec: (_command, args) => {
      let result: unknown = {};
      if (isApiSnapshot(args))
        result = {
          snapshot: { agents: [agent], panes: [{ ...agent, cwd: "/tmp" }] },
        };
      else if (isAgentList(args)) result = { agents: [agent] };
      else if (args[0] === "agent" && args[1] === "get") {
        get.resolve();
        result = { agent };
      } else if (args[0] === "worktree")
        throw new Error("Not a project worktree");
      return {
        stdout: JSON.stringify({ id: "fixture", result }),
        stderr: "",
        code: 0,
      };
    },
  });
  const ctx = fakeContext(f.entries);
  ctx.hasUI = true;
  ctx.mode = "rpc";
  let sessionName = "Before rename";
  ctx.sessionManager.getSessionName = () => sessionName;
  const subscribed = Promise.withResolvers<Socket>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString().trim());
      socket.write(
        `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
      );
      if (request.id === "herdsman:notifications") subscribed.resolve(socket);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(endpoint, listening.resolve);
  await listening.promise;
  const mailbox = agentMailboxPath(WORKSPACE, "continued-notification-worker");
  const runtime = supervisionRuntime();
  t.after(async () => {
    for (const handler of f.events.get("session_shutdown") ?? [])
      await handler({}, ctx);
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    removeProjectAssignment(runtime, "elsewhere", "managed");
    resetAgentMailbox(mailbox);
    updateConfig("desktopNotifications", undefined);
    setLeadEnvironment();
  });
  registerExtension(f.pi as never);
  for (const handler of f.events.get("session_start") ?? [])
    await handler({}, ctx);
  const socket = await subscribed.promise;
  await get.promise;
  await turn();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observe = async (state: string) => {
    agent = {
      ...agent,
      agent_status: state,
      state_change_seq: agent.state_change_seq + 1,
    };
    get = Promise.withResolvers<void>();
    socket.write(
      `${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: agent.pane_id, workspace_id: WORKSPACE, agent_status: state } })}\n`,
    );
    await get.promise;
    await turn();
  };
  const flush = async () => {
    t.mock.timers.tick(1000);
    await turn();
    await turn();
  };
  await observe("working");
  await observe("blocked");
  sessionName = `<b>${"😀".repeat(61)}</b>`;
  await flush();
  assert.equal(
    delivered.length,
    1,
    "verified standalone outside worktrees alerts even when selected",
  );
  assert.equal(delivered[0]?.body, `"${"😀".repeat(57)}..." needs input.`);
  assert.equal(
    ctx.sessionManager.getSessionName(),
    `<b>${"😀".repeat(61)}</b>`,
  );
  await observe("blocked");
  await flush();
  assert.equal(
    delivered.length,
    1,
    "renaming does not replay the pending event",
  );

  for (const [rawName, displayed] of [
    [
      '<span class="status"><strong>Deploy <em>ready</em></strong></span>',
      "Deploy ready",
    ],
    ['<B data-title="a > b">One <b>two</b></B>', "One two"],
    ["<div>first</div><p>second</p>", "first second"],
    ["first<br/>second<br>third", "first second third"],
    ["Plain session", "Plain session"],
    ['Say "yes" \\ now', 'Say "yes" \\ now'],
    ["Map<T> a < b && c > d", "Map<T> a < b && c > d"],
    [
      "<unknown>literal</unknown> and Map<b>",
      "<unknown>literal</unknown> and Map<b>",
    ],
    ["<b></b>", "Lead session"],
    ["<br/>", "Lead session"],
    [" \n ", "Lead session"],
    ["x".repeat(60), "x".repeat(60)],
    ["x".repeat(61), `${"x".repeat(57)}...`],
    ["😀".repeat(60), "😀".repeat(60)],
    ["😀".repeat(61), `${"😀".repeat(57)}...`],
    [
      `<b> ${"x".repeat(30)}\n${"y".repeat(30)} </b>`,
      `${"x".repeat(30)} ${"y".repeat(26)}...`,
    ],
  ] as const) {
    sessionName = rawName;
    await observe("working");
    await observe("blocked");
    const before = delivered.length;
    await flush();
    assert.equal(delivered.length, before + 1, `delivery for ${rawName}`);
    assert.equal(delivered.at(-1)?.body, `"${displayed}" needs input.`);
    assert.equal(ctx.sessionManager.getSessionName(), rawName);
  }
  const eligibleDeliveries = delivered.length;
  writeProjectAssignment(runtime, {
    version: 2,
    id: LEAD_SESSION_ID,
    repoKey: "elsewhere",
    branch: "managed",
    text: "Assigned work",
  });
  await observe("working");
  await observe("blocked");
  await flush();
  assert.equal(
    delivered.length,
    eligibleDeliveries,
    "exact assigned session remains muted outside its worktree",
  );
  removeProjectAssignment(runtime, "elsewhere", "managed");
  await observe("blocked");
  await flush();
  assert.equal(
    delivered.length,
    eligibleDeliveries,
    "assignment release does not replay muted input",
  );
  await observe("working");
  await observe("blocked");
  await flush();
  assert.equal(
    delivered.length,
    eligibleDeliveries + 1,
    "future standalone input alerts",
  );
  writeAgentState(mailbox, {
    ...managedState("continued-notification-worker"),
    piSessionId: LEAD_SESSION_ID,
    piSessionFile: ctx.sessionManager.getSessionFile(),
    paneId: agent.pane_id,
  });
  await observe("working");
  await observe("blocked");
  await flush();
  assert.equal(
    delivered.length,
    eligibleDeliveries + 1,
    "durable worker identity survives manual process continuation",
  );
  resetAgentMailbox(mailbox);
  agent = {
    ...agent,
    agent_session: { ...agent.agent_session, value: randomUUID() },
  };
  // A mismatched occupant short-circuits before agent get, so no get gate is expected.
  socket.write(
    `${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: agent.pane_id, workspace_id: WORKSPACE, agent_status: agent.agent_status } })}\n`,
  );
  await turn();
  await flush();
  assert.equal(
    delivered.length,
    eligibleDeliveries + 1,
    "a replaced pane occupant cannot inherit eligibility",
  );
});

test("persisted worker origin mutes manual input and completion after automatic result cleanup", async (t) => {
  delivered.length = 0;
  const completed = createStagedAssignmentFixture("agent", true);
  t.after(completed.shutdown);
  await t.waitFor(() => assert.equal(completed.initialStatusStarted, true));
  completed.releaseStart();
  completed.releasePreSubmitValidation();
  completed.releaseAcknowledgement();
  const delegated = await completed.pi.tools
    .find((tool) => tool.name === "delegate_agent")!
    .execute(
      "delegate",
      {
        definition: "agent",
        label: "agent",
        task: "complete before manual continuation",
      },
      undefined,
      undefined,
      completed.context,
    );
  assert.equal(delegated.details.ok, true, JSON.stringify(delegated.details));
  const sessionId = delegated.details.session_id;
  const sessionFile = delegated.details.session_path;
  const producer = fakePi();
  const original = fakeContext(producer.entries);
  original.sessionManager.getSessionId = () => sessionId;
  original.sessionManager.getSessionFile = () => sessionFile;
  // The simulated child uses the real managed-start identity producer before
  // releasing the owner's result scan and its automatic pane/mailbox cleanup.
  ensureManagedAgentIdentity(
    producer.pi as never,
    original as never,
    "agent",
    "agent",
  );
  const origin = producer.entries[0];
  assert.ok(origin && typeof origin === "object");
  realFs.appendFileSync(
    sessionFile,
    `${JSON.stringify({
      ...origin,
      id: randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
    })}\n`,
  );
  const finished = readAgentState(completed.mailbox)!;
  writeAgentState(completed.mailbox, {
    ...finished,
    activeRequestId: undefined,
    completedRequestId: delegated.details.request_id,
  });
  completed.releaseInitialStatus();
  await t.waitFor(() =>
    assert.equal(realFs.existsSync(completed.mailbox), false),
  );
  assert.ok(
    completed.pi.sent.some(
      (message) =>
        message &&
        typeof message === "object" &&
        "customType" in message &&
        message.customType === "pi-herdsman-agent-result",
    ),
  );
  assert.ok(
    completed.pi.calls.some(
      (args) => args[0] === "pane" && args[1] === "close",
    ),
  );
  completed.shutdown();
  const entries = parseSessionEntries(
    realFs.readFileSync(sessionFile, "utf8"),
  ).filter((entry) => entry.type !== "session");
  assert.deepEqual(sessionAgentIdentity(entries, sessionId), {
    sessionId,
    definition: "agent",
    label: "agent",
  });

  setLeadEnvironment();
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hc-${randomUUID()}`
      : `/tmp/hc-${randomUUID()}.sock`;
  process.env.HERDR_SOCKET_PATH = endpoint;
  process.env.HERDR_PANE_ID = "continued-worker-pane";
  process.env.HERDR_TAB_ID = "continued-worker-tab";
  updateConfig("desktopNotifications", true);
  let agent = {
    agent: "omp",
    agent_status: "idle",
    state_change_seq: 1,
    pane_id: "continued-worker-pane",
    tab_id: "continued-worker-tab",
    workspace_id: WORKSPACE,
    agent_session: {
      source: "herdr:omp",
      agent: "omp",
      kind: "path",
      value: sessionFile,
    },
  };
  let get = Promise.withResolvers<void>();
  const resumed = fakePi({
    entries,
    exec: (_command, args) => {
      let result: unknown = {};
      if (isApiSnapshot(args))
        result = {
          snapshot: { agents: [agent], panes: [{ ...agent, cwd: "/tmp" }] },
        };
      else if (isAgentList(args)) result = { agents: [agent] };
      else if (args[0] === "agent" && args[1] === "get") {
        get.resolve();
        result = { agent };
      } else if (args[0] === "worktree")
        throw new Error("Not a project worktree");
      return {
        stdout: JSON.stringify({ id: "fixture", result }),
        stderr: "",
        code: 0,
      };
    },
  });
  // A fresh interactive native context loads the saved full entry list, not
  // managed environment flags or a surviving mailbox. The selected branch is empty.
  const ctx = fakeContext(entries, []);
  ctx.sessionManager.getSessionId = () => sessionId;
  ctx.sessionManager.getSessionFile = () => sessionFile;
  ctx.hasUI = true;
  ctx.mode = "rpc";
  let idle = true;
  ctx.isIdle = () => idle;
  const subscribed = Promise.withResolvers<Socket>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString().trim());
      socket.write(
        `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
      );
      if (request.id === "herdsman:notifications") subscribed.resolve(socket);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(endpoint, listening.resolve);
  await listening.promise;
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of resumed.events.get(name) ?? [])
      await handler(event, ctx);
  };
  t.after(async () => {
    await emit("session_shutdown");
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    updateConfig("desktopNotifications", undefined);
    nativeSessions.delete(sessionId);
    realFs.rmSync(sessionFile, { force: true });
    setLeadEnvironment();
  });
  registerExtension(resumed.pi as never);
  await emit("session_start");
  const socket = await subscribed.promise;
  await get.promise;
  await turn();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observe = async (state: string) => {
    agent = {
      ...agent,
      agent_status: state,
      state_change_seq: agent.state_change_seq + 1,
    };
    get = Promise.withResolvers<void>();
    socket.write(
      `${JSON.stringify({
        event: "pane.agent_status_changed",
        data: {
          pane_id: agent.pane_id,
          workspace_id: WORKSPACE,
          agent_status: state,
        },
      })}\n`,
    );
    await get.promise;
    await turn();
  };
  const flush = async () => {
    t.mock.timers.tick(1000);
    await turn();
    await turn();
  };
  idle = false;
  await emit("agent_start");
  await observe("working");
  idle = true;
  await emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  await observe("idle");
  await flush();
  assert.deepEqual(delivered, [], "post-cleanup worker completion stays muted");
  idle = false;
  await emit("agent_start");
  await observe("working");
  await observe("blocked");
  await flush();
  assert.deepEqual(
    delivered,
    [],
    "post-cleanup worker needs-input stays muted",
  );
});
