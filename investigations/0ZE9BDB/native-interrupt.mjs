// Native host prerequisite probe, not a Herdsman repair or historical-causation proof.
// Run: bun investigations/0ZE9BDB/native-interrupt.mjs
// Add --expect-replacement-first to assert the missing ordering guarantee (red on OMP 18.14.1).
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = process.env.PROBE_STAGE ?? "agent_end";
const delivery = process.env.PROBE_DELIVERY ?? "steer";
assert.ok(
  ["agent_end", "toolUse", "aborted"].includes(stage),
  "Unknown probe stage",
);
assert.ok(
  ["steer", "followUp", "aside", "default"].includes(delivery),
  "Unknown delivery mode",
);
const root = await mkdtemp(join(tmpdir(), "herdsman-native-interrupt-"));
const observed = [];
let server;
let child;
let timer;
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const payload = await request.json();
      observed.push(payload.messages);
      const tool = observed.length === 1;
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "block",
                type: "function",
                function: { name: "block", arguments: "{}" },
              },
            ],
          }
        : { role: "assistant", content: "DONE" };
      const chunk = (value, finish) => ({
        id: "probe",
        object: "chat.completion.chunk",
        created: 1,
        model: "check",
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      });
      return new Response(
        `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, tool ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  for (const directory of ["agent", "home", "work"])
    await mkdir(join(root, directory));
  await writeFile(
    join(root, "probe.ts"),
    `export default function(pi) {
    const stage = ${JSON.stringify(stage)};
    const delivery = ${JSON.stringify(delivery)};
    const log = (kind, value) => console.error("CONTRACT " + JSON.stringify({ kind, value }));
    let context;
    let dispatched = false;
    pi.on("session_start", (_, ctx) => { context = ctx; });
    pi.on(stage === "agent_end" ? "agent_end" : "turn_end", (event, ctx) => {
      if (dispatched || (stage !== "agent_end" && event.message?.stopReason !== stage)) return;
      dispatched = true;
      pi.sendUserMessage("REPLACEMENT", delivery === "default" ? undefined : { deliverAs: delivery });
      log("replacement_sent", { stage, delivery, pending: ctx.hasPendingMessages() });
    });
    pi.registerProvider("interrupt-probe", {
      api: "openai-completions", baseUrl: process.env.PROBE_URL, apiKey: "local-only",
      models: [{ id: "check", name: "check", api: "openai-completions", provider: "interrupt-probe",
        reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000, maxTokens: 1024 }],
    });
    pi.registerTool({
      name: "block", label: "block", description: "Wait for synthetic cancellation",
      parameters: { type: "object", properties: {} },
      async execute(id, args, signal) {
        if (signal.aborted) throw new Error("Probe tool started with an aborted signal");
        let onAbort;
        const cancelled = new Promise(resolve => {
          onAbort = () => {
            log("tool_aborted", true);
            resolve({ content: [{ type: "text", text: "aborted" }] });
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          await pi.sendUserMessage("OLDER_OWNER_REPLY", { deliverAs: "steer" });
          if (!context.hasPendingMessages()) throw new Error("Older input was not pending before cancellation");
          log("queued_before_abort", true);
          context.abort();
          return await cancelled;
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
    });
  }`,
  );
  // Do not pass provider credentials, proxy settings, or ambient plugin configuration.
  const environment = { PATH: process.env.PATH };
  child = Bun.spawn(
    [
      "omp",
      "--mode",
      "json",
      "--no-session",
      "--no-title",
      "--auto-approve",
      "--cwd",
      join(root, "work"),
      "-e",
      join(root, "probe.ts"),
      "--model",
      "interrupt-probe/check",
      "--tools",
      "block",
      "-p",
      "INITIAL",
    ],
    {
      cwd: join(root, "work"),
      env: {
        ...environment,
        HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "agent"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        PROBE_URL: new URL("v1", server.url).href,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  timer = setTimeout(() => child.kill("SIGKILL"), 25000);
  const [, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(exit, 0, "Native child failed or timed out");
  const events = stderr
    .split("\n")
    .filter((line) => line.startsWith("CONTRACT "))
    .map((line) => JSON.parse(line.slice("CONTRACT ".length)));
  assert.ok(
    events.some((event) => event.kind === "tool_aborted"),
    "Native tool did not abort",
  );
  assert.ok(
    events.some((event) => event.kind === "queued_before_abort"),
    "Older input admission was not proven",
  );
  assert.ok(
    events.some((event) => event.kind === "replacement_sent"),
    "Replacement was not dispatched",
  );
  const order = observed
    .slice(1)
    .map((messages) =>
      messages
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          ["OLDER_OWNER_REPLY", "REPLACEMENT"].filter((marker) =>
            JSON.stringify(message.content).includes(marker),
          ),
        ),
    );
  assert.ok(order.length > 0, "No resumed provider request was observed");
  assert.ok(
    order.some((markers) => markers.includes("REPLACEMENT")),
    "Replacement never reached the provider",
  );
  const superseded =
    order[0].includes("REPLACEMENT") && !order[0].includes("OLDER_OWNER_REPLY");
  console.log(
    JSON.stringify(
      { stage, delivery, nativeExit: exit, events, order, superseded },
      null,
      2,
    ),
  );
  if (process.argv.includes("--expect-replacement-first")) {
    assert.ok(
      superseded,
      "Replacement must supersede older queued input before the first resumed model request",
    );
  }
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
  server?.stop(true);
  await rm(root, { recursive: true, force: true });
}
