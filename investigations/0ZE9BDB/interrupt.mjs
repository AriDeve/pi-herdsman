// Current-source operation-dispatch check; historical pre-repair observations are in ../0ZE9BDB.md.
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
  const runtime = registerOmpRuntime(pi);
  const execution = createManagedAgentExecutionState();
  const replacement = "Owner interrupt: synthetic replacement";
  execution.pendingInterruptReplacement = replacement;
  const unexpected = () => {
    throw new Error("Unexpected result-publication branch");
  };
  let settlements = 0;
  settlement = registerManagedAgentSettlementHandlers(pi, execution, {
    onOperationEnd: runtime.onOperationEnd,
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

  for (const queued of [false, true]) {
    for (const willContinue of [false, true]) {
      execution.pendingInterruptReplacement = replacement;
      pending = queued;
      const before = settlements;
      const deliveries = delivered.length;
      await end(willContinue, "aborted");
      assert.equal(execution.pendingInterruptReplacement, undefined);
      assert.equal(delivered.length, deliveries + 1);
      assert.equal(delivered.at(-1), replacement);
      assert.equal(settlements, before);
      await end(willContinue, "stop");
      assert.equal(delivered.length, deliveries + 1);
      assert.equal(settlements, before + (!queued && !willContinue ? 1 : 0));
    }
  }
  console.log(
    "VERIFIED: operation-end replacement dispatch is independent of queue/continuation predicates; terminal guards remain intact.",
  );
  console.log(
    "Native queue supersession and historical event causation are not established by this adapter check.",
  );
} finally {
  settlement?.cleanup();
  rmSync(root, { recursive: true, force: true });
}
