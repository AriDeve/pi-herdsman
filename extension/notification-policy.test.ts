import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import {
  createNotificationPolicy,
  type NotificationObservation,
} from "./notification-policy.ts";

function fixture(send?: () => Promise<void>) {
  let current: NotificationObservation = {
    session: "session-a",
    name: "Deployment review",
    authority: "lead:a",
    role: "Lead",
    enabled: true,
    state: "idle",
    sequence: 1,
    completion: 1,
    completionAllowed: false,
  };
  let callback: (() => void) | undefined;
  const delivered: unknown[] = [];
  const errors: unknown[] = [];
  const policy = createNotificationPolicy({
    current: async () => current,
    send: async (message) => {
      await send?.();
      delivered.push(message);
    },
    report: (error) => {
      errors.push(error);
    },
    schedule: (fn, delay) => {
      assert.equal(delay, 1000);
      callback = fn;
      return () => {
        callback = undefined;
      };
    },
  });
  return {
    policy,
    delivered,
    errors,
    observe(change: Partial<NotificationObservation> = {}, baseline = false) {
      current = { ...current, ...change };
      policy.observe(current, baseline);
    },
    change(change: Partial<NotificationObservation>) {
      current = { ...current, ...change };
    },
    async flush() {
      const run = callback;
      callback = undefined;
      run?.();
      await turn();
    },
  };
}

test("only fresh verified completion delivers once after coalescing", async () => {
  const f = fixture();
  f.observe({}, true);
  await f.flush();
  assert.deepEqual(f.delivered, []);
  f.observe({ state: "working", sequence: 2 });
  f.observe({
    state: "idle",
    sequence: 3,
    completion: 3,
    completionAllowed: true,
  });
  f.observe();
  assert.deepEqual(f.delivered, []);
  await f.flush();
  assert.deepEqual(f.delivered, [
    { title: "Herdsman · Lead", body: '"Deployment review" completed.' },
  ]);
  f.observe();
  await f.flush();
  assert.equal(f.delivered.length, 1);
});

test("new blocked input coalesces and resolved input cancels", async () => {
  const f = fixture();
  f.observe({}, true);
  f.observe({ state: "blocked", sequence: 2 });
  f.observe({ sequence: 3 });
  await f.flush();
  assert.deepEqual(f.delivered, [
    { title: "Herdsman · Lead", body: '"Deployment review" needs input.' },
  ]);
  f.observe({ state: "working", sequence: 4 });
  f.observe({ state: "blocked", sequence: 5 });
  f.observe({ state: "working", sequence: 6 });
  await f.flush();
  assert.equal(f.delivered.length, 1);
});

for (const state of ["idle", "blocked"] as const)
  test(`rename before ${state === "idle" ? "completion" : "input"} delivery uses the current name without replay`, async () => {
    const f = fixture();
    f.observe({}, true);
    f.observe({ state: "working", sequence: 2 });
    f.observe(
      state === "idle"
        ? { state, sequence: 3, completion: 3, completionAllowed: true }
        : { state, sequence: 3 },
    );
    f.observe({ name: "Renamed session" });
    await f.flush();
    assert.deepEqual(f.delivered, [
      {
        title: "Herdsman · Lead",
        body: `"Renamed session" ${state === "idle" ? "completed" : "needs input"}.`,
      },
    ]);
    f.observe({ name: "Renamed again" });
    await f.flush();
    assert.equal(f.delivered.length, 1);
  });

for (const state of ["idle", "blocked"] as const)
  test(`unnamed ${state} sessions remain eligible and use a quoted role-based fallback`, async () => {
    const f = fixture();
    f.observe({ name: undefined, role: "Manager" }, true);
    f.observe({ state: "working", sequence: 2 });
    f.observe(
      state === "idle"
        ? { state, sequence: 3, completion: 3, completionAllowed: true }
        : { state, sequence: 3 },
    );
    await f.flush();
    assert.deepEqual(f.delivered, [
      {
        title: "Herdsman · Manager",
        body: `"Manager session" ${state === "idle" ? "completed" : "needs input"}.`,
      },
    ]);
  });

for (const [name, change] of [
  ["resumed work", { state: "working" }],
  ["disabled", { enabled: false }],
  ["unknown or managed ownership", { authority: undefined }],
  ["ownership generation", { authority: "manager:b" }],
  ["session replacement", { session: "session-b" }],
  ["scheduled continuation", { completionAllowed: false }],
] as const)
  test(`pending completion revalidates ${name}`, async () => {
    const f = fixture();
    f.observe({}, true);
    f.observe({
      state: "idle",
      sequence: 2,
      completion: 2,
      completionAllowed: true,
    });
    f.change(change);
    await f.flush();
    assert.deepEqual(f.delivered, []);
  });

test("muted history, restored state and takeover are never replayed", async () => {
  const f = fixture();
  f.observe({ authority: undefined }, true);
  f.observe({ sequence: 2, completion: 2, completionAllowed: true });
  f.observe({ authority: "lead:a" });
  await f.flush();
  assert.deepEqual(f.delivered, []);
  f.observe({ state: "working", sequence: 3 });
  f.observe({ state: "idle", sequence: 4, completion: 4 });
  await f.flush();
  assert.equal(f.delivered.length, 1);
  f.observe({ state: "blocked", sequence: 5 }, true);
  await f.flush();
  assert.equal(f.delivered.length, 1);
});

test("startup idle without completion and continuation never alert", async () => {
  const f = fixture();
  f.observe({}, true);
  f.observe({ sequence: 2, completion: undefined });
  f.observe({ state: "working", sequence: 3 });
  f.observe({
    state: "idle",
    sequence: 4,
    completion: 4,
    completionAllowed: false,
  });
  f.observe({ completionAllowed: true });
  await f.flush();
  assert.deepEqual(f.delivered, []);
});

test("shutdown cancels pending delivery", async () => {
  const f = fixture();
  f.observe({}, true);
  f.observe({ state: "blocked", sequence: 2 });
  f.policy.dispose();
  await f.flush();
  assert.deepEqual(f.delivered, []);
});

test("one native completion cannot replay after a separate blocked episode", async () => {
  const f = fixture();
  f.observe({}, true);
  f.observe({
    state: "idle",
    sequence: 2,
    completion: 2,
    completionAllowed: true,
  });
  await f.flush();
  f.observe({ state: "blocked", sequence: 3 });
  await f.flush();
  f.observe({ state: "idle", sequence: 4 });
  await f.flush();
  assert.deepEqual(f.delivered, [
    { title: "Herdsman · Lead", body: '"Deployment review" completed.' },
    { title: "Herdsman · Lead", body: '"Deployment review" needs input.' },
  ]);
});

test("delivery failures do not suspend future events and diagnostics are bounded", async () => {
  let attempts = 0;
  const f = fixture(async () => {
    attempts++;
    throw new Error("Enable the desktop notification service");
  });
  f.observe({}, true);
  f.observe({ state: "blocked", sequence: 2 });
  await f.flush();
  f.observe({ state: "working", sequence: 3 });
  f.observe({ state: "blocked", sequence: 4 });
  await f.flush();
  assert.equal(attempts, 2);
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /Enable the desktop notification service/);
  assert.deepEqual(f.delivered, []);
});
