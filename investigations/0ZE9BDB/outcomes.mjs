// Historical diagnostic replay, not a claim that a synthetic sequence caused the incident.
// Run: node --experimental-test-module-mocks investigations/0ZE9BDB/outcomes.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "herdsman-0ZE9BDB-outcomes-"));
const originalTmp = process.env.TMPDIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent-data");
process.env.TMPDIR = root;
let support;
try {
  // Exercise the module-loading boundary: capture the real translator before the
  // existing test support intentionally mocks it. Static imports would reorder this.
  const { registerOmpRuntime } = await import("../../extension/omp-runtime.ts");
  const { agentMailboxPath } = await import("../../extension/mailbox.ts");
  const assertContainedMailbox = (workspace, label) => {
    assert.ok(
      agentMailboxPath(workspace, label).startsWith(root + sep),
      "Diagnostic mailbox escaped the temporary root",
    );
  };
  // Check the cached mailbox root before support can scan or reset any mailbox.
  assertContainedMailbox("isolation-check", "probe");
  support = await import("../../extension/support.ts");
  const { createLeadHerdRunRuntime } =
    await import("../../extension/lead-runtime.ts");

  async function emit(pi, name, event, context) {
    for (const handler of pi.events.get(name) ?? [])
      await handler(event, context);
  }

  async function managed(savedBeforeTurn, perturbation = "none") {
    assertContainedMailbox(support.WORKSPACE, "outcomes-replay");
    const mailbox = support.setAgentEnvironment("outcomes-replay");
    const entries = [];
    const pi = support.fakePi({ entries });
    const context = support.fakeAgentContext(entries);
    registerOmpRuntime(pi.pi);
    support.registerExtension(pi.pi);
    await emit(pi, "session_start", undefined, context);
    await nextTurn();
    const state = support.readAgentState(mailbox);
    const request = {
      version: 5,
      runId: state.runId,
      requestId: support.REQUEST_ID,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "Produce a visible response.",
      createdAt: Date.now(),
    };
    support.writeRequest(mailbox, request);
    await emit(
      pi,
      "input",
      { text: support.controlMarker(request.requestId) },
      context,
    );
    await emit(pi, "agent_start", { type: "agent_start" }, context);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Saved visible answer" }],
      stopReason: "stop",
      timestamp: 1,
    };
    const entry = { type: "message", id: "synthetic-final", message };
    if (savedBeforeTurn) entries.push(entry);
    if (perturbation !== "missing-turn") {
      await emit(pi, "turn_end", { type: "turn_end", message }, context);
    }
    if (!savedBeforeTurn) entries.push(entry);
    if (perturbation === "reset-observation") {
      await emit(pi, "agent_start", { type: "agent_start" }, context);
    }
    const settledMessage =
      perturbation === "settlement-tool-tail"
        ? {
            ...message,
            stopReason: "toolUse",
            content: [{ type: "text", text: "Earlier tool-using turn" }],
          }
        : message;
    await emit(
      pi,
      "agent_end",
      { type: "agent_end", messages: [settledMessage] },
      context,
    );
    const result = support.readResult(mailbox, request.requestId);
    const completed = savedBeforeTurn && perturbation === "none";
    assert.equal(result?.status, completed ? "completed" : "failed");
    if (completed) {
      assert.equal(result.responseEntryId, entry.id);
      assert.equal(result.text, "Saved visible answer");
    } else {
      assert.equal(result.error?.code, "empty_result");
      assert.equal(result.error.message, "Agent produced no assistant text");
    }
    console.log(
      `managed savedBeforeTurn=${savedBeforeTurn} perturbation=${perturbation}: ${result.status}/${result.error?.code ?? "selected response"}`,
    );
    await emit(pi, "session_shutdown", {}, context);
  }

  async function lead(withPendingReport, lifecycle = "restore-only") {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const reportId = "22222222-2222-4222-8222-222222222222";
    const startedAt = 1;
    const entries = [
      {
        type: "custom",
        customType: "pi-herdsman-herd-run",
        data: { phase: "started", sessionId, startedAt, reportId },
      },
      {
        type: "message",
        id: "synthetic-abort",
        message: {
          role: "assistant",
          stopReason: "aborted",
          content: [
            {
              type: "text",
              text: "Partial final response retained in history",
            },
          ],
        },
      },
    ];
    if (withPendingReport) {
      entries.push({
        type: "custom",
        customType: "pi-herdsman-herd-run",
        data: {
          phase: "report_pending",
          sessionId,
          startedAt,
          reportId,
          target: "project",
          message: "Durable handoff preserved",
        },
      });
    }
    const sent = [];
    const context = {
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => entries,
      },
    };
    const runtime = createLeadHerdRunRuntime({
      activeRole: () => "lead",
      isVerifiedActiveLead: () => true,
      isManagedLead: () => true,
      pi: {
        appendEntry: (customType, data) =>
          entries.push({ type: "custom", customType, data }),
        sendMessage() {},
      },
      entryName: "pi-herdsman-herd-run",
      hasPendingStarts: () => false,
      listAgentStates: () => [],
      currentProjectAssignment: async () => ({ id: sessionId }),
      publishProjectMessage: async (
        _context,
        _assignment,
        text,
        _files,
        operation,
        id,
        kind,
      ) => {
        const message = { text, operation, reportId: id, kind };
        sent.push(message);
        return message;
      },
      publishChiefFailure: async () => false,
      requestStatusRefresh() {},
      queueLeadPresentation() {},
      appendDurableError(_pi, _context, _kind, error) {
        throw error;
      },
    });
    runtime.restoreSession(entries, sessionId);
    if (lifecycle !== "restore-only") {
      runtime.agentStarted();
      runtime.turnEnd({
        message: entries[1].message,
        messageEntryId: "synthetic-abort",
        outcome: "aborted",
      });
      runtime.beforeSettle({ outcome: "aborted" });
      if (lifecycle === "settle-before-dispose")
        await runtime.agentSettled(context, true);
      runtime.shutdown();
      runtime.restoreSession(entries, sessionId);
    }
    runtime.finishIfIdle(context);
    for (
      let turn = 0;
      turn < 30 && !entries.some((entry) => entry.data?.phase === "finished");
      turn++
    ) {
      await nextTurn();
    }
    assert.equal(sent.length, 1);
    const expected =
      lifecycle === "settle-before-dispose"
        ? "Lead execution was cancelled before a completed response."
        : withPendingReport
          ? "Durable handoff preserved"
          : "Lead execution outcome was not preserved across restoration; work remains unresolved.";
    assert.equal(sent[0].text, expected);
    assert.ok(entries.some((entry) => entry.data?.phase === "report_sent"));
    assert.ok(entries.some((entry) => entry.data?.phase === "finished"));
    console.log(
      `lead pending=${withPendingReport} lifecycle=${lifecycle}: ${sent[0].text}`,
    );
    runtime.shutdown();
  }

  await managed(false);
  await managed(true);
  await managed(true, "missing-turn");
  await managed(true, "reset-observation");
  await managed(true, "settlement-tool-tail");
  await lead(false);
  await lead(true);
  await lead(false, "dispose-before-settle");
  await lead(false, "settle-before-dispose");
  console.log(
    "REPRODUCED: distinct event sequences yield the same diagnostics; no unique historical cause inferred.",
  );
} finally {
  // The support fixture creates both roots beneath our temporary directory.
  if (support) {
    support.realFs.rmSync(support.testTmpRoot, {
      recursive: true,
      force: true,
    });
    support.realFs.rmSync(support.PI_AGENT_ROOT, {
      recursive: true,
      force: true,
    });
  }
  rmSync(root, { recursive: true, force: true });
  if (originalTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmp;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
}
