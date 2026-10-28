// Real OMP + Herdr + Herdsman lifecycle with a scripted loopback model:
// report + addendum -> result delivery -> automatic cleanup -> recovery through
// read_agent_responses -> session continuation -> assignment isolation.
// Only model decisions are simulated. Run after `npm run build`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const bundle = join(repository, "dist/index.js");
assert.ok(existsSync(bundle), "run `npm run build` before this check");

const root = await mkdtemp(join(await realpath("/tmp"), "phs-recovery-"));
const paths = {
  agent: join(root, "agent"),
  xdgConfig: join(root, "xdg-config"),
  xdgState: join(root, "xdg-state"),
  herdrConfig: join(root, "herdr.toml"),
  work: join(root, "work"),
};
const sessionName = `phs-rec-${randomUUID().slice(0, 8)}`;
const REPORT = `REPORT-START ${"é😀 report line\n".repeat(900)} REPORT-END`;
const ADDENDUM = "ADDENDUM: the report above is complete.";
const SECOND = "SECOND-ASSIGNMENT-ANSWER";
const THINKING = "PRIVATE_THINKING_SENTINEL";

type Call = { name: string; args: Record<string, unknown> };
type Wire = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string } }>;
  tool_call_id?: string;
};
const log = (message: string) => console.log(`[recovery-smoke] ${message}`);
const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? "").join("\n")
      : "";

const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("PI_HERDSMAN_") &&
        !key.startsWith("HERDR_") &&
        key !== "PI_PROFILE" &&
        key !== "PI_CONFIG_FILES" &&
        key !== "PI_SUBAGENT_PARENT_SESSION" &&
        key !== "OMP_PROFILE",
    ),
  ),
  HOME: join(root, "home"),
  XDG_CACHE_HOME: join(root, "xdg-cache"),
  PI_CODING_AGENT_DIR: paths.agent,
  XDG_CONFIG_HOME: paths.xdgConfig,
  XDG_STATE_HOME: paths.xdgState,
  HERDR_CONFIG_PATH: paths.herdrConfig,
  HERDR_SESSION: sessionName,
} as Record<string, string>;
const herdr = async (...args: string[]) => {
  const child = Bun.spawn(["herdr", "--session", sessionName, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `herdr ${args.join(" ")}: ${err}${out}`);
  if (args[0] === "pane" && args[1] === "read") return out;
  return out.trim() ? JSON.parse(out) : {};
};

// ---- scripted model -------------------------------------------------------
const requests = { owner: 0, child: 0 };
let providerFailure: unknown;
let lastProgress = Date.now();
let lastSignature = "";
let childRequestsAtCleanup: number | undefined;
let childRequestsAfterRecovery: number | undefined;
let rootPane = "";
let workspaceId = "";
const waitForCleanup = async () => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const panes = (await herdr("pane", "list", "--workspace", workspaceId))
      .result?.panes as unknown[] | undefined;
    assert.ok(Array.isArray(panes), "pane list omitted panes");
    if (panes.length === 1) break;
    assert.ok(Date.now() < deadline, "child pane was not cleaned up");
    await Bun.sleep(250);
  }
  childRequestsAtCleanup ??= requests.child;
};

function* ownerProgram(): Generator<
  Call | { wait: RegExp } | { cleanup: true },
  void,
  string
> {
  yield {
    name: "delegate_agent",
    args: {
      definition: "generalist",
      label: "reviewer",
      task: "Produce the review",
    },
  };
  yield { wait: /Result ref: result:reviewer#1/ };
  yield { cleanup: true };
  const ref1 = "result:reviewer#1";
  const listing = yield {
    name: "read_agent_responses",
    args: { result: ref1 },
  };
  const ids = [...listing.matchAll(/- id=(\S+) #\d+/g)].map((m) => m[1]!);
  const sessionId = listing.match(/Session: (\S+)/)![1]!;
  for (const id of ids) {
    let offset = 0;
    for (;;) {
      const chunk = yield {
        name: "read_agent_responses",
        args: { result: ref1, response: id, offset },
      };
      const next = chunk.match(/Incomplete: .*offset=(\d+)/);
      if (!next) break;
      offset = Number(next[1]);
    }
  }
  childRequestsAfterRecovery ??= requests.child;
  yield {
    name: "continue_agent",
    args: { session: sessionId, task: "Second assignment" },
  };
  yield { wait: /Result ref: result:reviewer#2/ };
  yield { cleanup: true };
  yield { name: "read_agent_responses", args: { result: ref1 } };
  yield { name: "read_agent_responses", args: { result: "result:reviewer#2" } };
  yield { name: "read_agent_responses", args: { session: sessionId } };
  yield {
    name: "read_agent_responses",
    args: { result: ref1, response: "not-in-scope" },
  };
}

async function ownerTurn(messages: Wire[]) {
  const calls = new Map(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.tool_calls ?? []).map(
            (call) => [call.id, call.function.name] as const,
          )
        : [],
    ),
  );
  const scriptedTools = [
    "delegate_agent",
    "continue_agent",
    "read_agent_responses",
  ];
  const results = messages.flatMap((message) => {
    const name =
      message.role === "tool" && message.tool_call_id
        ? calls.get(message.tool_call_id)
        : undefined;
    return name && scriptedTools.includes(name)
      ? [{ name, text: text(message.content) }]
      : [];
  });
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => text(m.content))
    .join("\n");
  const signature = `${results.length}:${userText.includes("result:reviewer#1")}:${userText.includes("result:reviewer#2")}`;
  if (signature !== lastSignature) {
    lastSignature = signature;
    lastProgress = Date.now();
    log(
      `owner progress ${signature}; last tool result: ${JSON.stringify(results.at(-1)?.text.slice(0, 400))}`,
    );
  }
  const program = ownerProgram();
  let used = 0;
  let step = program.next();
  while (!step.done) {
    const value = step.value;
    if ("wait" in value) {
      if (!value.wait.test(userText))
        return { content: "Waiting for the Agent result." };
      step = program.next("");
    } else if ("cleanup" in value) {
      await waitForCleanup();
      step = program.next("");
    } else if (used < results.length) {
      const result = results[used++]!;
      assert.equal(
        result.name,
        value.name,
        "native tool result must match the scripted call",
      );
      step = program.next(result.text);
    } else return { call: value };
  }
  return { content: "RECOVERY_SMOKE_DONE" };
}

function childTurn(messages: Wire[]) {
  const last = messages.at(-1)!;
  const task = messages.findLast((m) => m.role === "user");
  if (last.role === "tool")
    return {
      content: text(task?.content).includes("Second assignment")
        ? SECOND
        : ADDENDUM,
    };
  if (text(task?.content).includes("Second assignment"))
    return { content: SECOND };
  return {
    reasoning: THINKING,
    content: REPORT,
    call: { name: "read", args: { path: join(paths.work, "input.txt") } },
  };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    try {
      const payload = (await request.json()) as {
        messages: Wire[];
        tools?: Array<{ function: { name: string } }>;
      };
      const child = (payload.tools ?? []).some(
        (tool) => tool.function.name === "ask_owner",
      );
      if (requests[child ? "child" : "owner"] === 0)
        log(
          `${child ? "child" : "owner"} provider tools: ${(payload.tools ?? []).map((tool) => tool.function.name).join(", ")}`,
        );
      requests[child ? "child" : "owner"]++;
      assert.ok(
        requests.owner <= 30 && requests.child <= 3,
        `unexpected provider loop: ${JSON.stringify(requests)}`,
      );
      const turn = child
        ? childTurn(payload.messages)
        : await ownerTurn(payload.messages);
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "recovery", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const call = "call" in turn ? turn.call : undefined;
      const body = [
        ...("reasoning" in turn && turn.reasoning
          ? [
              chunk(
                { role: "assistant", reasoning_content: turn.reasoning },
                null,
              ),
            ]
          : []),
        ...("content" in turn && turn.content
          ? [chunk({ role: "assistant", content: turn.content }, null)]
          : []),
        ...(call
          ? [
              chunk(
                {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${randomUUID().slice(0, 8)}`,
                      type: "function",
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.args),
                      },
                    },
                  ],
                },
                null,
              ),
            ]
          : []),
        chunk({}, call ? "tool_calls" : "stop"),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    } catch (error) {
      providerFailure = error;
      console.error("provider failure", error);
      return Response.json(
        { error: { message: String(error) } },
        { status: 500 },
      );
    }
  },
});

// ---- environment ----------------------------------------------------------
let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
let serverVerified = false;
let serverStderr: Promise<string> | undefined;
try {
  await mkdir(join(paths.agent, "extensions"), { recursive: true });
  await mkdir(paths.work, { recursive: true });
  await writeFile(
    join(paths.agent, "config.yml"),
    JSON.stringify({
      startup: { setupWizard: false, checkUpdate: false },
      marketplace: { autoUpdate: "off" },
    }),
  );
  await writeFile(join(paths.work, "input.txt"), "input for the review\n");
  await writeFile(
    join(paths.agent, "models.yml"),
    [
      "providers:",
      "  loopback:",
      `    baseUrl: ${new URL("v1", server.url).href}`,
      "    apiKey: local-check-only",
      "    api: openai-completions",
      "    models:",
      "      - id: scripted",
      "        name: scripted",
      "        reasoning: true",
      "        contextWindow: 200000",
      "        maxTokens: 8192",
      "",
    ].join("\n"),
  );
  // Install the Herdr OMP integration under a throwaway HOME, then place it in the
  // isolated agent directory (the installer refuses the shared Pi/OMP override).
  const home = join(root, "home");
  await mkdir(join(home, ".omp/agent/extensions"), { recursive: true });
  const { PI_CODING_AGENT_DIR: _ignored, ...installEnv } = env;
  const installed = Bun.spawnSync(
    ["herdr", "--session", sessionName, "integration", "install", "omp"],
    {
      env: { ...installEnv, HOME: home },
    },
  );
  assert.equal(installed.exitCode, 0, String(installed.stderr));
  const integration = join(
    home,
    ".omp/agent/extensions/herdr-omp-agent-state.ts",
  );
  assert.ok(existsSync(integration), "Herdr OMP integration was not installed");
  await copyFile(
    integration,
    join(paths.agent, "extensions", "herdr-omp-agent-state.ts"),
  );
  serverProcess = Bun.spawn(["herdr", "--session", sessionName, "server"], {
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  serverStderr = new Response(serverProcess.stderr).text();
  for (let attempt = 0; ; attempt++) {
    if (serverProcess.exitCode !== null)
      throw new Error(
        `owned Herdr server exited before readiness: ${await serverStderr}`,
      );
    const status = Bun.spawnSync(
      ["herdr", "--session", sessionName, "status", "--json"],
      { env },
    );
    if (status.exitCode === 0) {
      const actual = JSON.parse(String(status.stdout)).server;
      if (actual?.running) {
        assert.equal(actual.session, sessionName);
        assert.equal(
          actual.socket,
          join(paths.xdgConfig, "herdr", "sessions", sessionName, "herdr.sock"),
        );
        assert.equal(actual.compatible, true);
        serverVerified = true;
        log(
          `owned server ready: ${sessionName} pid=${serverProcess.pid} socket=${actual.socket}`,
        );
        break;
      }
    }
    assert.ok(attempt < 100, "owned Herdr server did not start");
    await Bun.sleep(150);
  }
  const created = await herdr(
    "workspace",
    "create",
    "--cwd",
    paths.work,
    "--label",
    "recovery-smoke",
    "--no-focus",
  );
  workspaceId =
    created.workspace?.workspace_id ?? created.result?.workspace?.workspace_id;
  rootPane = created.root_pane?.pane_id ?? created.result?.root_pane?.pane_id;
  assert.ok(workspaceId && rootPane, JSON.stringify(created));
  const command = [
    "omp",
    "--model",
    "loopback/scripted",
    "--no-title",
    "--no-skills",
    "--no-rules",
    "--no-context-files",
    "--auto-approve",
    "-e",
    bundle,
    "'Delegate the review and recover its responses.'",
  ].join(" ");
  await herdr(
    "pane",
    "run",
    rootPane,
    `env PI_CODING_AGENT_DIR=${paths.agent} ${command}`,
  );
  log("owner OMP started in an isolated Herdr pane");

  // ---- wait for the scripted program, then verify the owner's session ------
  const deadline = Date.now() + 150_000;
  const sessionFiles = (): string[] => {
    const base = join(paths.agent, "sessions");
    if (!existsSync(base)) return [];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory()
          ? walk(path)
          : name.endsWith(".jsonl")
            ? [path]
            : [];
      });
    return walk(base);
  };
  let ownerRecords: any[] = [];
  for (;;) {
    ownerRecords = sessionFiles().flatMap((file) => {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      const records = lines.map((line) => JSON.parse(line));
      return records.some(
        (r) =>
          r.type === "message" &&
          text(r.message?.content).includes("RECOVERY_SMOKE_DONE"),
      )
        ? records
        : [];
    });
    if (ownerRecords.length) break;
    if (providerFailure) throw providerFailure;
    assert.ok(
      Date.now() - lastProgress <
        (requests.owner + requests.child === 0 ? 12_000 : 30_000),
      `owner stalled: ${JSON.stringify(requests)} progress=${lastSignature}`,
    );
    assert.ok(
      Date.now() < deadline,
      `owner did not finish: ${JSON.stringify(requests)}`,
    );
    await Bun.sleep(500);
  }
  const reads = ownerRecords
    .filter(
      (r) =>
        r.type === "message" &&
        r.message?.role === "toolResult" &&
        r.message?.toolName === "read_agent_responses",
    )
    .map((r) => ({
      details: r.message.details,
      text: text(r.message.content),
      error: r.message.isError,
    }));
  const delivered = ownerRecords.filter(
    (r) =>
      r.customType === "pi-herdsman-agent-result" ||
      r.message?.customType === "pi-herdsman-agent-result",
  );
  assert.equal(delivered.length, 2, "two assignment results must be delivered");
  const [first, second] = delivered.map((r) => r.details ?? r.message?.details);
  assert.equal(first.status, "completed");
  assert.ok(
    first.responseEntryId,
    "result must persist selected-response provenance",
  );
  assert.match(
    text(delivered[0].content ?? delivered[0].message?.content),
    /read_agent_responses/,
  );
  assert.ok(
    text(delivered[0].content ?? delivered[0].message?.content).includes(
      ADDENDUM,
    ),
    "the delivered result selects the addendum",
  );
  assert.equal(first.resultIndex, 1);
  assert.equal(second.resultIndex, 2);

  const [listing1, ...rest] = reads;
  assert.equal(listing1!.details.scope, "assignment");
  assert.equal(listing1!.details.selected_response, first.responseEntryId);
  assert.deepEqual(
    listing1!.details.responses.map((item: any) => item.selected === true),
    [false, true],
    "report and addendum recoverable, addendum selected",
  );
  const chunks = rest.filter((r) => typeof r.details?.text === "string");
  const joined = (id: string) =>
    chunks
      .filter(
        (r) =>
          r.details.response === id &&
          r.details.result_ref === "result:reviewer#1",
      )
      .map((r) => r.details.text)
      .join("");
  const [reportId, addendumId] = listing1!.details.responses.map(
    (i: any) => i.id,
  );
  assert.ok(
    Buffer.byteLength(REPORT) > 16 * 1024,
    "the report exceeds the transcript tail",
  );
  assert.ok(
    chunks.filter((r) => r.details.response === reportId).length > 1,
    "the report spans multiple chunks",
  );
  assert.equal(
    joined(reportId),
    REPORT.trim(),
    "full report recovered in chunks",
  );
  assert.equal(joined(addendumId), ADDENDUM);
  assert.ok(
    chunks.every((r) => Buffer.byteLength(r.details.text) <= 12 * 1024),
    "chunks bounded",
  );
  const afterContinuation = rest.slice(-4);
  assert.equal(
    afterContinuation[0]!.details.total_responses,
    2,
    "later assignment not mixed in",
  );
  assert.equal(
    afterContinuation[1]!.details.selected_response,
    second.responseEntryId,
  );
  assert.equal(afterContinuation[1]!.details.total_responses, 1);
  assert.equal(afterContinuation[2]!.details.scope, "session");
  assert.equal(afterContinuation[2]!.details.total_responses, 3);
  assert.equal(
    afterContinuation[3]!.details.ok,
    false,
    "out-of-scope response is rejected",
  );
  const persistedThinking = sessionFiles().some((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        const record = JSON.parse(line);
        return (
          record.type === "message" &&
          record.message?.role === "assistant" &&
          Array.isArray(record.message.content) &&
          record.message.content.some(
            (block: unknown) =>
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              block.type === "thinking" &&
              "thinking" in block &&
              typeof block.thinking === "string" &&
              block.thinking.includes(THINKING),
          )
        );
      }),
  );
  assert.ok(
    persistedThinking,
    "the saved session contains the thinking sentinel",
  );
  assert.doesNotMatch(
    JSON.stringify(reads),
    new RegExp(THINKING),
    "thinking is never exposed",
  );
  assert.equal(
    childRequestsAtCleanup,
    2,
    "child made exactly the report and addendum requests before cleanup",
  );
  assert.equal(
    childRequestsAfterRecovery,
    2,
    "recovery made no model request before continuation",
  );
  assert.equal(requests.child, 3, "recovery made no child model request");
  log(`scenario assertions passed (requests: ${JSON.stringify(requests)})`);
} catch (error) {
  if (serverVerified && rootPane) {
    try {
      log(
        `owner pane on failure: ${JSON.stringify(await herdr("pane", "read", rootPane, "--source", "recent-unwrapped", "--lines", "80"))}`,
      );
    } catch (diagnosticError) {
      log(`owner pane diagnostic failed: ${String(diagnosticError)}`);
    }
  }
  throw error;
} finally {
  server.stop(true);
  if (serverProcess && serverVerified && serverProcess.exitCode === null) {
    const stopped = Bun.spawnSync(
      ["herdr", "--session", sessionName, "server", "stop"],
      { env },
    );
    assert.equal(
      stopped.exitCode,
      0,
      `owned server stop failed: ${String(stopped.stderr)}`,
    );
  }
  if (serverProcess && !serverVerified && serverProcess.exitCode === null) {
    log(`stopping unverified owned startup process pid=${serverProcess.pid}`);
    serverProcess.kill();
  }
  if (serverProcess) {
    const exited = await Promise.race([
      serverProcess.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);
    assert.ok(
      exited,
      `owned server did not exit; retained ${root}, session=${sessionName}, pid=${serverProcess.pid}`,
    );
    log(
      `owned server exited: ${sessionName} pid=${serverProcess.pid}; stderr=${JSON.stringify(await serverStderr)}`,
    );
  }
  await rm(root, { recursive: true, force: true });
  log(`removed owned temporary root ${root}`);
}
