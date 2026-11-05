import assert from "node:assert/strict";
import { test } from "node:test";
import { removalIntents, sameRemovalTarget, REMOVAL_INTENT_ENTRY } from "./worktree-removal-intent.ts";

const request = { version: 1, phase: "request", requestId: "request-a", sessionId: "manager-session", repoKey: "/repo/.git", branch: "feature", assignmentId: "lead-session", piSessionFile: "/sessions/lead.jsonl", checkoutPath: "/checkouts/feature", createdAt: 1 } as const;
const entry = (data: unknown) => ({ type: "custom", customType: REMOVAL_INTENT_ENTRY, data });

test("removal intent replay isolates sessions and consumes exact IDs, not replacements", () => {
  const replacement = { ...request, requestId: "request-b", assignmentId: "replacement" };
  const entries = [entry(request), entry(replacement), entry({ version: 1, phase: "resolution", sessionId: request.sessionId, requestId: request.requestId, outcome: "cancelled" })];
  assert.deepEqual(removalIntents(entries, request.sessionId), [replacement]);
  assert.deepEqual(removalIntents(entries, "other-session"), []);
  assert.deepEqual(removalIntents([...entries, entry({ version: 1, phase: "resolution", sessionId: request.sessionId, requestId: replacement.requestId, outcome: "approved" })], request.sessionId), []);
  assert.deepEqual(removalIntents([entry(request)], request.sessionId), [request]);
});

test("removal intent parser rejects unknown versions, fields and malformed target identities", () => {
  for (const invalid of [{ ...request, version: 2 }, { ...request, leaseId: "old-authority" }, { ...request, checkoutPath: "relative" }, { ...request, piSessionFile: "" }, { ...request, createdAt: NaN }]) {
    assert.deepEqual(removalIntents([entry(invalid)], request.sessionId), []);
  }
});

test("removal intent resolutions require a string enum, without coercing arrays", () => {
  for (const outcome of [["approved"], ["cancelled"], ["dismissed"], ["left"], null, {}, 1, "unknown"]) {
    const resolution = { version: 1, phase: "resolution", sessionId: request.sessionId, requestId: request.requestId, outcome };
    assert.deepEqual(removalIntents([entry(request), entry(resolution)], request.sessionId), [request]);
  }
});

test("removal intent rejects embedded NUL in each filesystem identity", () => {
  for (const field of ["repoKey", "piSessionFile", "checkoutPath"] as const) {
    assert.deepEqual(removalIntents([entry({ ...request, [field]: `${request[field]}\0invalid` })], request.sessionId), [], field);
  }
  assert.deepEqual(removalIntents([{ type: "custom", customType: "unrelated", data: { outcome: ["approved"], checkoutPath: "/checkout\0invalid" } }, entry(request)], request.sessionId), [request]);
});

test("malformed and foreign-version removal entries cannot affect valid current intent", () => {
  const malformed = [entry(null), entry({ ...request, version: 2 }), entry({ ...request, sessionId: "foreign", checkoutPath: "\0invalid" }), entry({ version: 2, phase: "resolution", requestId: request.requestId, sessionId: request.sessionId, outcome: "approved" })];
  assert.deepEqual(removalIntents([entry(request), ...malformed], request.sessionId), [request]);
});

test("duplicate identity binds assignment, checkout and persisted session provenance", () => {
  assert.equal(sameRemovalTarget(request, { ...request, requestId: "different" }), true);
  for (const change of [{ assignmentId: "new" }, { checkoutPath: "/new" }, { piSessionFile: "/other.jsonl" }, { repoKey: "/other/.git" }, { branch: "other" }]) assert.equal(sameRemovalTarget(request, { ...request, ...change }), false);
});
