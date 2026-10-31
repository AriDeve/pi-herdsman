// Isolated actual-adapter replay, not a native-host cancellation experiment.
// Run: bun investigations/0ZE9BDB/interrupt.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "herdsman-0ZE9BDB-interrupt-"));
process.env.PI_CODING_AGENT_DIR = root;
let settlement;
try {
  // The mailbox module captures its data root at import: isolate this loading boundary first.
  const { registerOmpRuntime } = await import("../../extension/omp-runtime.ts");
  const {
    createManagedAgentExecutionState,
    registerManagedAgentSettlementHandlers,
  } = await import("../../extension/managed-agent-runtime.ts");
  const nativeEvents = new Map();
  const delivered = [];
  const pi = {
    on(name, handler) {
      nativeEvents.set(name, [...(nativeEvents.get(name) ?? []), handler]);
    },
    sendUserMessage(text) {
      delivered.push(text);
    },
    registerTool() {},
  };
  registerOmpRuntime(pi);
  const execution = createManagedAgentExecutionState();
  const replacement = "Owner interrupt: synthetic replacement";
  execution.pendingInterruptReplacement = replacement;
  const unexpected = () => {
    throw new Error("Unexpected result-publication branch");
  };
  settlement = registerManagedAgentSettlementHandlers(pi, execution, {
    delegationEnabled: false,
    tryClaimAssignmentLock: unexpected,
    sameIdentity: () => false,
    hasUndeliveredDirectChildWork: () => false,
    reportMetadata: unexpected,
    appendStateError: unexpected,
    appendResultError: unexpected,
    resultWriteMaxAttempts: 1,
    settleControllerResults: async () => {
      unexpected();
    },
  });
  let pending = true;
  const context = { hasPendingMessages: () => pending };
  async function end(willContinue, stopReason) {
    for (const handler of nativeEvents.get("agent_end") ?? []) {
      await handler(
        {
          type: "agent_end",
          willContinue,
          messages: [{ role: "assistant", stopReason, content: [] }],
        },
        context,
      );
    }
  }

  await end(false, "aborted");
  assert.equal(execution.pendingInterruptReplacement, replacement);
  assert.deepEqual(delivered, []);
  pending = false;
  await end(false, "aborted");
  assert.equal(execution.pendingInterruptReplacement, undefined);
  assert.deepEqual(delivered, [replacement]);
  console.log(
    "REPRODUCED: pending messages withhold replacement; same aborted event with an empty queue delivers it.",
  );

  execution.pendingInterruptReplacement = replacement;
  await end(true, "aborted");
  assert.equal(execution.pendingInterruptReplacement, replacement);
  assert.equal(delivered.length, 1);
  await end(false, "aborted");
  assert.equal(execution.pendingInterruptReplacement, undefined);
  assert.deepEqual(delivered, [replacement, replacement]);
  console.log(
    "REPRODUCED: willContinue alone withholds replacement; clearing it releases replacement.",
  );

  execution.pendingInterruptReplacement = replacement;
  pending = true;
  await end(false, "aborted");
  assert.equal(execution.pendingInterruptReplacement, replacement);
  pending = false;
  await end(false, "stop");
  assert.equal(execution.pendingInterruptReplacement, undefined);
  assert.deepEqual(delivered, [replacement, replacement, replacement]);
  console.log(
    "REPRODUCED: abort-with-pending followed by natural-stop-with-empty-queue delays replacement until the stop.",
  );
  console.log(
    "Historical event predicate values are not recorded; this proves a sufficient mechanism, not exact incident attribution.",
  );
} finally {
  settlement?.cleanup();
  rmSync(root, { recursive: true, force: true });
}
