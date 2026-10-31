// Historical diagnostic replay for 0ZE9BDB, not a production authorization policy.
// Run from the repository root: bun investigations/0ZE9BDB/ownership.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
const root = mkdtempSync(join(tmpdir(), "herdsman-0ZE9BDB-ownership-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent-data");

try {
  // mailbox.ts captures the data root during initialization: isolate before import.
  const { resolveAssignmentSession, ownedAssignmentChildren } =
    await import("../../extension/agent-controller.ts");
  const owner = "11111111-1111-4111-8111-111111111111";
  const target = "22222222-2222-4222-8222-222222222222";
  const sessionPath = join(root, "target.jsonl");
  const entries = [
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: target,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "custom",
      id: "identity",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.001Z",
      customType: "pi-herdsman-agent-definition",
      data: { sessionId: target, definition: "reviewer", label: "review" },
    },
  ];
  writeFileSync(
    sessionPath,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const receipt = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "delegate_agent",
      details: {
        ok: true,
        owner_session_id: owner,
        session_id: target,
        session_path: sessionPath,
        agent: "review",
        definition: "reviewer",
      },
    },
  };
  const result = {
    type: "custom_message",
    customType: "pi-herdsman-agent-result",
    details: {
      ownerSessionId: owner,
      piSessionId: target,
      piSessionFile: sessionPath,
      runId: "33333333-3333-4333-8333-333333333333",
      requestId: "44444444-4444-4444-8444-444444444444",
      agentLabel: "review",
      agentDefinition: "reviewer",
      status: "failed",
    },
  };
  // This minimal context supplies only the seam consumed by the actual resolver.
  const context = (history: unknown[]) => ({
    cwd: root,
    sessionManager: { getSessionId: () => owner, getEntries: () => history },
  });
  const denial =
    /Assignment source is outside the caller's proven session ownership tree/;
  assert.equal(ownedAssignmentChildren([receipt] as never, owner).length, 0);
  assert.throws(
    () => resolveAssignmentSession(context([receipt]) as never, target),
    denial,
  );
  assert.equal(
    resolveAssignmentSession(context([receipt, result]) as never, target).id,
    target,
  );
  const foreignResult = {
    ...result,
    details: {
      ...result.details,
      ownerSessionId: "55555555-5555-4555-8555-555555555555",
    },
  };
  assert.throws(
    () =>
      resolveAssignmentSession(
        context([receipt, foreignResult]) as never,
        target,
      ),
    denial,
  );
  console.log(
    "REPRODUCED: receipt-only continuation denied; owned result resolves; foreign result denied.",
  );
  console.log(
    "The synthetic result is a differential probe input, not a proposal to fabricate an outcome on close.",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
