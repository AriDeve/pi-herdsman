// Real OMP + Herdr + Herdsman lifecycle with a scripted loopback model:
// report + addendum -> result delivery -> automatic cleanup -> recovery through
// read_agent_responses -> session continuation -> assignment isolation.
// Only model decisions are simulated. Run after `npm run build`.
// --manager-handoff instead checks managed Lead launch policy through late
// registration, repeated reconciliation, and two real stop/resume cycles.
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

const managerHandoff = process.argv.includes("--manager-handoff");
// --project-continuation: a Manager project Lead delegates a worker whose
// evidence is project-scoped, lets normal cleanup remove its mailbox, then
// continues the exact worker session.
const projectContinuation = process.argv.includes("--project-continuation");
const completion = projectContinuation
  ? "PROJECT_CONTINUATION_DONE"
  : managerHandoff
    ? "POLICY_SMOKE_DONE"
    : "RECOVERY_SMOKE_DONE";
const leadTools = [
  "list_agents",
  "delegate_agent",
  "continue_agent",
  "steer_agent",
  "interrupt_agent",
  "reply_agent",
  "close_agent",
  "inspect_agent",
  "read_agent_transcript",
  "read_agent_responses",
  "message_supervisor",
  "list_peers",
  "message_peer",
];
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
let projectWorkspaceId = "";
const mailboxStates = (): string[] => [
  ...new Bun.Glob("**/mailboxes-v5/*/state.json").scanSync({
    cwd: root,
    absolute: true,
  }),
];
const policyGenerations = new Map<string, { step: number; pending?: string }>();
function* managerProgram(): Generator<Call | { wait: RegExp }, void, string> {
  const delegated = yield {
    name: "delegate_project",
    args: {
      branch: "smoke-policy",
      task: "Verify current managed Lead policy.",
    },
  };
  const result: unknown = JSON.parse(delegated);
  assert.ok(result && typeof result === "object" && "session" in result);
  const session = result.session;
  assert.equal(typeof session, "string", delegated);
  for (let generation = 1; generation <= 3; generation++) {
    yield { wait: new RegExp(`POLICY_OK_${generation}\\b`) };
    yield { name: "stop_lead", args: { session } };
    if (generation < 3) {
      yield { name: "resume_project", args: { branch: "smoke-policy" } };
      yield {
        name: "message_staff",
        args: { session, message: "Verify the managed policy again." },
      };
    }
  }
}

function policyTurn(
  messages: Wire[],
  tools: Array<{ function: { name: string; description?: string } }>,
) {
  const probe = tools.find((tool) => tool.function.name === "policy_allowed");
  assert.ok(probe, "late wildcard tool must reach the real provider");
  assert.deepEqual(
    tools.map((tool) => tool.function.name).sort(),
    [...leadTools, "policy_allowed"].sort(),
    "managed provider surface excludes builtins, exclusions, and supervisory tools",
  );
  const pid = probe.function.description!;
  let state = policyGenerations.get(pid);
  if (!state) {
    state = { step: 0 };
    policyGenerations.set(pid, state);
    log(
      `managed generation ${policyGenerations.size}: ${pid}; provider policy surface verified`,
    );
  }
  if (state.pending) {
    const result = messages.find(
      (message) => message.tool_call_id === state.pending,
    );
    assert.ok(
      result,
      "scripted call must execute before the next provider request",
    );
    if (state.step === 2 || state.step === 4)
      assert.ok(
        text(result.content).includes("POLICY_SURFACE_OK"),
        text(result.content),
      );
    state.pending = undefined;
  }
  const sequence: Call[] = [
    { name: "list_agents", args: {} },
    { name: "policy_allowed", args: {} },
    { name: "list_agents", args: {} },
    { name: "policy_allowed", args: {} },
    {
      name: "message_supervisor",
      args: { message: `POLICY_OK_${policyGenerations.size}` },
    },
  ];
  const call = sequence[state.step++];
  return call ? { call, policyState: state } : { content: "POLICY_LEAD_DONE" };
}
const waitForCleanup = async () => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    lastProgress = Date.now();
    const panes = (
      await herdr(
        "pane",
        "list",
        "--workspace",
        projectContinuation ? projectWorkspaceId : workspaceId,
      )
    ).result?.panes as unknown[] | undefined;
    assert.ok(Array.isArray(panes), "pane list omitted panes");
    // Project mode (project workspace only): the Lead pane remains; the worker pane and its
    // mailbox state are removed by normal delivered-result cleanup.
    if (
      panes.length === 1 &&
      (!projectContinuation || mailboxStates().length === 0)
    )
      break;
    assert.ok(
      Date.now() < deadline,
      `child pane was not cleaned up: panes=${panes.length} mailboxes=${mailboxStates().length}`,
    );
    await Bun.sleep(250);
  }
  childRequestsAtCleanup ??= requests.child;
};

function* managerContinuationProgram(): Generator<
  Call | { wait: RegExp },
  void,
  string
> {
  const delegated = yield {
    name: "delegate_project",
    args: {
      branch: "smoke-continuation",
      task: "Delegate one reviewer and continue it after cleanup.",
      files: [join(paths.work, "input.txt")],
    },
  };
  projectWorkspaceId = JSON.parse(delegated).workspace_id;
  assert.ok(projectWorkspaceId, delegated);
  yield { wait: /PROJECT_LEAD_DONE/ };
}

function* leadContinuationProgram(): Generator<
  Call | { wait: RegExp } | { cleanup: true },
  void,
  string
> {
  const delegated = yield {
    name: "delegate_agent",
    args: {
      definition: "generalist",
      label: "reviewer",
      task: "Produce the review",
    },
  };
  const sessionId = delegated.match(/Session: (\S+)/)?.[1];
  assert.ok(sessionId, delegated);
  yield { wait: /Result ref: result:reviewer#1/ };
  yield { cleanup: true };
  yield {
    name: "continue_agent",
    args: { session: sessionId, task: "Second assignment" },
  };
  yield { wait: /Result ref: result:reviewer#2/ };
  yield { cleanup: true };
  yield { name: "message_supervisor", args: { message: "PROJECT_LEAD_DONE" } };
}

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
  yield {
    name: "read_agent_responses",
    args: { session: sessionId, result: ref1 },
  };
  yield { name: "read_agent_responses", args: {} };
}

async function ownerTurn(messages: Wire[], lead = false) {
  const calls = new Map(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.tool_calls ?? []).map(
            (call) => [call.id, call.function.name] as const,
          )
        : [],
    ),
  );
  const scriptedTools = projectContinuation
    ? [
        "delegate_project",
        "delegate_agent",
        "continue_agent",
        "message_supervisor",
      ]
    : managerHandoff
      ? ["delegate_project", "stop_lead", "resume_project", "message_staff"]
      : ["delegate_agent", "continue_agent", "read_agent_responses"];
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
  const program = projectContinuation
    ? lead
      ? leadContinuationProgram()
      : managerContinuationProgram()
    : managerHandoff
      ? managerProgram()
      : ownerProgram();
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
  return { content: completion };
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
        tools?: Array<{
          function: {
            name: string;
            description?: string;
            strict?: boolean;
            parameters?: {
              properties?: Record<string, unknown>;
              required?: string[];
            };
          };
        }>;
      };
      const responseTool = payload.tools?.find(
        (tool) => tool.function.name === "read_agent_responses",
      );
      if (!managerHandoff && responseTool) {
        const recoveryControls = ["offset", "response", "result", "session"];
        assert.ok(
          recoveryControls.every((name) =>
            Object.hasOwn(
              responseTool.function.parameters?.properties ?? {},
              name,
            ),
          ),
          "provider schema exposes every response-recovery control",
        );
        assert.deepEqual(
          (responseTool.function.parameters?.required ?? []).filter((name) =>
            recoveryControls.includes(name),
          ),
          [],
          "provider schema keeps response-recovery controls optional",
        );
        assert.notEqual(
          responseTool.function.strict,
          true,
          "provider schema must not enable strict rewriting for response recovery",
        );
      }
      const policyLead =
        managerHandoff &&
        (payload.tools ?? []).some(
          (tool) => tool.function.name === "delegate_agent",
        );
      const hasTool = (name: string) =>
        (payload.tools ?? []).some((tool) => tool.function.name === name);
      const child = policyLead || hasTool("ask_owner");
      const projectLead =
        projectContinuation && hasTool("delegate_agent") && !child;
      if (managerHandoff && !child) {
        assert.ok(
          payload.tools?.some(
            (tool) => tool.function.name === "delegate_project",
          ),
        );
        assert.ok(
          !payload.tools?.some((tool) =>
            ["delegate_agent", "policy_allowed", "read"].includes(
              tool.function.name,
            ),
          ),
          "Manager projection must not acquire Lead or ordinary policy tools",
        );
      }
      if (requests[child ? "child" : "owner"] === 0)
        log(
          `${child ? "child" : "owner"} provider tools: ${(payload.tools ?? []).map((tool) => tool.function.name).join(", ")}`,
        );
      requests[child ? "child" : "owner"]++;
      assert.ok(
        requests.owner <= 40 && requests.child <= (managerHandoff ? 18 : 3),
        `unexpected provider loop: ${JSON.stringify(requests)}`,
      );
      const turn = policyLead
        ? policyTurn(payload.messages, payload.tools ?? [])
        : child
          ? childTurn(payload.messages)
          : await ownerTurn(payload.messages, projectLead);
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "recovery", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const call = "call" in turn ? turn.call : undefined;
      const callId = `call-${randomUUID().slice(0, 8)}`;
      if ("policyState" in turn && turn.policyState)
        turn.policyState.pending = callId;
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
                      id: callId,
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
let managerSessionFile: string | undefined;
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
  if (managerHandoff || projectContinuation) {
    for (const args of [
      ["init", "-b", "main"],
      [
        "-c",
        "user.name=Smoke",
        "-c",
        "user.email=smoke@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "Smoke root",
      ],
    ]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: paths.work, env });
      assert.equal(result.exitCode, 0, String(result.stderr));
    }
    const seed = Bun.spawnSync(
      [
        "bun",
        "-e",
        `
      import { SessionManager } from "@oh-my-pi/pi-coding-agent";
      const session = SessionManager.create(${JSON.stringify(paths.work)}, ${JSON.stringify(join(paths.agent, "sessions"))});
      session.appendCustomEntry("pi-herdsman-role", { role: "manager", leadTools: [] });
      await session.ensureOnDisk();
      await session.close();
      console.log(session.getSessionFile());
    `,
      ],
      { cwd: repository, env },
    );
    assert.equal(seed.exitCode, 0, String(seed.stderr));
    managerSessionFile = String(seed.stdout).trim();
    assert.ok(existsSync(managerSessionFile));
  }
  if (managerHandoff) {
    const probe = join(root, "policy-probe.ts");
    await writeFile(
      probe,
      `
import assert from "node:assert/strict";
export default function(pi) {
  pi.on("session_start", async (_event, ctx) => {
    // Register after Herdsman's startup role projection, as deferred tools do.
    await Bun.sleep(25);
    for (const name of ["policy_allowed", "policy_denied"]) pi.registerTool({
      name, label: name, description: "process-" + process.pid,
      parameters: {type:"object",properties:{}},
      async execute() {
        assert.equal(name, "policy_allowed");
        assert.deepEqual(pi.getActiveTools().sort(), ${JSON.stringify([...leadTools, "policy_allowed"].sort())});
        const baseline = ctx.sessionManager.getBranch().findLast(entry =>
          entry.type === "custom" && entry.customType === "pi-herdsman-lead-execution");
        assert.deepEqual(baseline?.data.leadTools, [], "historical ordinary baseline remains empty");
        return {content:[{type:"text",text:"POLICY_SURFACE_OK"}],details:{}};
      }
    });
  });
}
`,
    );
    await mkdir(join(paths.agent, "agents"), { recursive: true });
    await writeFile(
      join(paths.agent, "agents/managed-lead.md"),
      `---\nname: managed-lead\nmodel: loopback/scripted\ntools: [read, "policy_*"]\nexcludeTools: [policy_denied]\nnoBuiltinTools: true\nextensions: [${JSON.stringify(probe)}]\n---\n`,
    );
  }
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
    ...(managerSessionFile
      ? [
          "--resume",
          managerSessionFile,
          `'${projectContinuation ? "Run the project continuation check." : "Verify the managed Lead policy."}'`,
        ]
      : ["'Delegate the review and recover its responses.'"]),
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
          r.type === "message" && text(r.message?.content).includes(completion),
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
  if (projectContinuation) {
    const tools = (name: string) =>
      ownerRecords.filter(
        (r) =>
          r.type === "message" &&
          r.message?.role === "toolResult" &&
          r.message.toolName === name,
      );
    for (const name of [
      "delegate_agent",
      "continue_agent",
      "message_supervisor",
    ])
      assert.ok(tools(name).length, `Lead ran ${name}`);
    for (const r of ["delegate_agent", "continue_agent"].flatMap(tools))
      assert.ok(!r.message.isError, JSON.stringify(r.message.content));
    assert.equal(requests.child, 3, "worker made exactly three model requests");
    assert.equal(
      mailboxStates().length,
      0,
      "worker mailbox removed after the second result",
    );
    const saved = sessionFiles().flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    const delivered = saved.filter(
      (r) =>
        r.customType === "pi-herdsman-agent-result" ||
        r.message?.customType === "pi-herdsman-agent-result",
    );
    const workerResults = delivered
      .map((record) => record.details ?? record.message?.details ?? record.data)
      .filter((details) => details?.agentLabel === "reviewer");
    assert.equal(workerResults.length, 2, "both worker results were delivered");
    assert.ok(
      workerResults.every((details) => details.projectAssignmentId),
      "every delivered worker result carries projectAssignmentId",
    );
    assert.ok(
      saved.some(
        (r) =>
          r.customType === "pi-herdsman-agent-required-evidence" &&
          r.data?.agentLabel === "reviewer" &&
          r.data.projectAssignmentId &&
          r.data.inheritedEvidence?.length > 0,
      ),
      "worker accepted a non-empty inherited evidence snapshot",
    );
    log(`project continuation passed: ${JSON.stringify(requests)}`);
  } else if (managerHandoff) {
    assert.equal(
      policyGenerations.size,
      3,
      "initial launch and two resumed processes",
    );
    assert.ok(
      [...policyGenerations.values()].every((state) => state.step >= 5),
    );
    const results = ownerRecords.filter(
      (record) =>
        record.type === "message" &&
        record.message?.role === "toolResult" &&
        [
          "delegate_project",
          "stop_lead",
          "resume_project",
          "message_staff",
        ].includes(record.message.toolName),
    );
    assert.deepEqual(
      results.map((record) => record.message.toolName),
      [
        "delegate_project",
        "stop_lead",
        "resume_project",
        "message_staff",
        "stop_lead",
        "resume_project",
        "message_staff",
        "stop_lead",
      ],
    );
    assert.ok(
      results.every((record) => !record.message.isError),
      "all real lifecycle operations succeed",
    );
    const identities = results
      .map((record) => record.message.details?.session)
      .filter(Boolean);
    assert.equal(
      new Set(identities).size,
      1,
      "resume preserves the assigned session",
    );
    log(
      `managed policy assertions passed: three processes, historical [], six list_agents reconciliations, two resumes; requests=${JSON.stringify(requests)}`,
    );
  } else {
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
    assert.equal(
      delivered.length,
      2,
      "two assignment results must be delivered",
    );
    const [first, second] = delivered.map(
      (r) => r.details ?? r.message?.details,
    );
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
    const afterContinuation = rest.slice(-6);
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
    assert.equal(
      afterContinuation[4]!.details.ok,
      false,
      "supplying both recovery selectors is rejected",
    );
    assert.equal(
      afterContinuation[5]!.details.ok,
      false,
      "omitting both recovery selectors is rejected",
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
  }
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
