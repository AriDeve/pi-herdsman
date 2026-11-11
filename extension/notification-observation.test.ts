import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { setImmediate as turn } from "node:timers/promises";
import { mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NotificationObservation } from "./notification-policy.ts";

class Subscription extends EventEmitter {
  readonly endpoint: string;
  constructor(endpoint: string) {
    super();
    this.endpoint = endpoint;
  }
  destroyed = false;
  unref() {
    return this;
  }
  setEncoding() {
    return this;
  }
  setTimeout() {
    return this;
  }
  write() {
    return true;
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
}
const subscriptions: Subscription[] = [];
const delivered: Array<{ title: string; body: string }> = [];
mock.module("node:net", {
  namedExports: {
    ...net,
    createConnection: (endpoint: string) => {
      const socket = new Subscription(endpoint);
      subscriptions.push(socket);
      return socket;
    },
  },
});
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
// Transport and delivery mocks must precede support's composed-extension import.
const { fakePi, fakeContext, setLeadEnvironment } =
  await import("./support.ts");
const { registerDesktopNotifications } =
  await import("./notification-runtime.ts");

async function fixture(
  state: NotificationObservation["state"] = "working",
  endpoint = "notification-test-socket",
  enabledAtStart = true,
) {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = endpoint;
  process.env.HERDR_PANE_ID = "input-pane";
  const f = fakePi();
  let idle = true;
  const ctx = { ...fakeContext(), hasUI: true, isIdle: () => idle };
  let current: Omit<NotificationObservation, "completionAllowed"> = {
    session: ctx.sessionManager.getSessionId(),
    role: "Manager",
    authority: "manager:current",
    enabled: true,
    state,
    sequence: 1,
  };
  let held: { started: () => void; wait: Promise<void> } | undefined;
  let enabled = enabledAtStart;
  const subscriptionIndex = subscriptions.length;
  registerDesktopNotifications(f.pi as unknown as ExtensionAPI, {
    enabled: () => enabled,
    current: async () => {
      const read = held;
      if (read) {
        read.started();
        await read.wait;
      }
      return { ...current };
    },
  });
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of f.events.get(name) ?? []) await handler(event, ctx);
  };
  let socket: Subscription | undefined;
  const attach = async () => {
    const candidate = subscriptions[subscriptionIndex];
    if (!candidate || candidate === socket) return;
    socket = candidate;
    socket.emit("connect");
    socket.emit(
      "data",
      `${JSON.stringify({ id: "herdsman:notifications", result: { type: "subscription_started" } })}\n`,
    );
    await turn();
  };
  await emit("session_start");
  await attach();
  return {
    get socket() {
      assert.ok(socket);
      return socket;
    },
    status(
      state: NotificationObservation["state"],
      details: Partial<typeof current> = {},
    ) {
      current = {
        ...current,
        state,
        sequence: current.sequence + 1,
        ...details,
      };
      socket?.emit(
        "data",
        `${JSON.stringify({
          event: "pane.agent_status_changed",
          data: {
            pane_id: "input-pane",
            workspace_id: "workspace",
            agent_status: state,
          },
        })}\n`,
      );
    },
    delayRead() {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      held = { started: started.resolve, wait: release.promise };
      return {
        started: started.promise,
        release: () => {
          held = undefined;
          release.resolve();
        },
      };
    },
    enable() {
      enabled = true;
    },
    begin: async () => {
      idle = false;
      await emit("agent_start");
      await attach();
    },
    end: async () => {
      idle = true;
      await emit("agent_end", {
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
    },
    stop: () => emit("session_shutdown"),
  };
}

test("public Herdr subscription envelopes deliver new needs-input", async (t) => {
  delivered.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  t.after(f.stop);
  f.status("blocked");
  await turn();
  t.mock.timers.tick(1000);
  await turn();
  assert.deepEqual(delivered, [
    {
      title: "Herdsman · Manager",
      body: "Session aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa needs input.",
    },
  ]);
});

test("resolved input cancels its timer even when reblocking overtakes a delayed refresh", async (t) => {
  delivered.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  t.after(f.stop);
  f.status("blocked");
  await turn();
  t.mock.timers.tick(600);
  const read = f.delayRead();
  f.status("working");
  await read.started;
  f.status("blocked");
  read.release();
  await turn();
  t.mock.timers.tick(400);
  await turn();
  assert.deepEqual(
    delivered,
    [],
    "the resolved episode cannot deliver for the new episode",
  );
  t.mock.timers.tick(599);
  await turn();
  assert.deepEqual(delivered, []);
  t.mock.timers.tick(1);
  await turn();
  assert.equal(delivered.length, 1, "the new episode gets its own full second");
});

test("pending input does not survive shutdown and runtime re-registration", async (t) => {
  delivered.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = await fixture();
  t.after(original.stop);
  original.status("blocked");
  await turn();
  t.mock.timers.tick(500);
  await original.stop();
  const replacement = await fixture("blocked");
  t.after(replacement.stop);
  t.mock.timers.tick(1000);
  await turn();
  assert.deepEqual(
    delivered,
    [],
    "neither the old pending input nor restored blocked state replays",
  );
  replacement.status("working");
  await turn();
  replacement.status("blocked");
  await turn();
  original.status("blocked");
  t.mock.timers.tick(999);
  await turn();
  assert.deepEqual(delivered, []);
  t.mock.timers.tick(1);
  await turn();
  assert.equal(delivered.length, 1);
});

test("Windows uses the qualified native pipe endpoint unchanged", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const endpoint = String.raw`\\.\pipe\herdr-notification-test`;
  const f = await fixture("working", endpoint);
  t.after(f.stop);
  assert.equal(f.socket.endpoint, endpoint);
});

for (const completionSeq of [false, true])
  for (const coalesced of [false, true])
    for (const cold of [false, true])
      test(`delayed semantic work preserves completion (${completionSeq ? "with" : "without"} completion_seq, ${coalesced ? "coalesced" : "observed"} working, ${cold ? "direct-config opt-in" : "enabled startup"})`, async (t) => {
        delivered.length = 0;
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const f = await fixture("idle", undefined, !cold);
        t.after(f.stop);
        if (cold) {
          await f.begin();
          await f.end();
        }
        f.status("idle", {
          sequence: 100,
          semanticCompletion: completionSeq ? 7 : undefined,
        });
        await turn();
        f.enable();
        await f.begin();
        await turn();
        await f.end();
        await turn();
        assert.deepEqual(delivered, []);
        const read = coalesced ? f.delayRead() : undefined;
        f.status("working", { sequence: 101 });
        if (read) await read.started;
        else await turn();
        f.status("idle", {
          sequence: 102,
          semanticCompletion: completionSeq ? 8 : undefined,
        });
        read?.release();
        await turn();
        t.mock.timers.tick(1000);
        await turn();
        assert.deepEqual(delivered, [
          {
            title: "Herdsman · Manager",
            body: "Session aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa completed.",
          },
        ]);
      });
