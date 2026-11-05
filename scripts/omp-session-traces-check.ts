// Real OMP + Herdsman + Herdr + native stats dashboard. Only model decisions
// are scripted. Run after bun run build. Evidence is retained outside checkout.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureDashboard } from "./omp-dashboard-capture.mjs";
import type { Subprocess } from "bun";

const repository = fileURLToPath(new URL("..", import.meta.url));
const bundle = join(repository, "dist/index.js");
assert.ok(existsSync(bundle), "run bun run build first");
const root = await mkdtemp("/tmp/phs-trace-");
const agent = join(root, "agent");
const home = join(root, "home");
const naturalFailure = process.argv.includes("--launch-failure-natural");
const launchFailure =
  naturalFailure || process.argv.includes("--launch-failure");
const nativeOmp = join(
  repository,
  "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
);
assert.ok(existsSync(nativeOmp), "installed native omp is required");
const work = join(root, "repo");
const sessionName = `trace-${randomUUID().slice(0, 8)}`;
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("PI_HERDSMAN_") &&
        !key.startsWith("HERDR_") &&
        ![
          "PI_PROFILE",
          "PI_CONFIG_FILES",
          "PI_SUBAGENT_PARENT_SESSION",
          "OMP_PROFILE",
          "PI_CODING_AGENT_SESSION_DIR",
        ].includes(key),
    ),
  ),
  PATH: `${join(root, "bin")}:${process.env.PATH}`,
  HOME: home,
  TMPDIR: root,
  XDG_CONFIG_HOME: join(root, "cfg"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  PI_CODING_AGENT_DIR: agent,
  HERDR_CONFIG_PATH: join(root, "herdr.toml"),
  HERDR_SESSION: sessionName,
} as Record<string, string>;
const log = (value: string) => console.log(`[native-traces] ${value}`);
log(`evidence=${root} session=${sessionName}`);
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => part?.text ?? "").join("\n")
      : "";
type Entry = {
  type: string;
  id?: string;
  timestamp?: string;
  customType?: string;
  data?: Record<string, unknown>;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    toolName?: string;
    isError?: boolean;
    details?: Record<string, unknown>;
  };
};
const records = (file: string): Entry[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const files = (directory = join(agent, "sessions")): string[] =>
  !existsSync(directory)
    ? []
    : readdirSync(directory).flatMap((name) => {
        const path = join(directory, name);
        return statSync(path).isDirectory()
          ? files(path)
          : name.endsWith(".jsonl")
            ? [path]
            : [];
      });
const run = (command: string[], cwd = repository) => {
  const child = Bun.spawnSync(command, { cwd, env });
  assert.equal(
    child.exitCode,
    0,
    `${command.join(" ")}: ${String(child.stderr)} ${String(child.stdout)}`,
  );
  return String(child.stdout).trim();
};
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
  if (!out.trim()) return undefined;
  return JSON.parse(out).result;
};
let providerFailure: unknown;
const waitFor = async (
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeout = 60000,
) => {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (providerFailure) throw providerFailure;
    assert.ok(Date.now() < deadline, `timed out: ${description}`);
    await Bun.sleep(150);
  }
};
type Call = { name: string; args: Record<string, unknown> };
type Wire = { role: string; content?: unknown; tool_call_id?: string };
const counts: Record<string, number> = {};
const stages: Record<string, number> = {};
let releaseLeaf = false;
let resumed = false;
const managerCalls: Call[] = [];
const turn = async (
  model: string,
  messages: Wire[],
): Promise<Call | string> => {
  const stage = stages[model] ?? 0;
  const body = messages.map((m) => text(m.content)).join("\n");
  if (model === "ordinary") return "ORDINARY_READY";
  if (model === "manager") {
    if (stage === 0) {
      stages[model] = 1;
      return {
        name: "delegate_project",
        args: {
          branch: "trace-project",
          task: "Run NATIVE_TRACE_LEAD; delegate trace-worker, await its result, then continue it.",
        },
      };
    }
    if (managerCalls.length) return managerCalls.shift()!;
    return "MANAGER_READY";
  }
  if (model === "lead") {
    if (stage === 0) {
      stages[model] = 1;
      return {
        name: "delegate_agent",
        args: {
          definition: "trace-worker",
          label: "worker",
          task: "NATIVE_TRACE_WORKER: delegate trace-leaf and await its result.",
        },
      };
    }
    if (stage === 1 && /Result ref: result:worker#\d+/.test(body)) {
      const delegated = messages
        .filter((m) => m.role === "tool")
        .map((m) => text(m.content))
        .find((s) => /Session:/.test(s));
      const session = delegated?.match(/Session: (\S+)/)?.[1];
      assert.ok(session, "worker delegation provides its exact saved session");
      // Result delivery precedes generation cleanup. Observe normal teardown
      // before continuing, as in omp-response-recovery-check.ts.
      const canonical = files().find((file) =>
        records(file).some(
          (entry) => entry.type === "session" && entry.id === session,
        ),
      );
      assert.ok(
        canonical,
        "worker continuation retains its canonical transcript",
      );
      await waitFor(
        "worker generation cleanup before continuation",
        async () => {
          const mailboxes = [
            ...new Bun.Glob("**/mailboxes-v5/*/state.json").scanSync({
              cwd: agent,
              absolute: true,
            }),
          ];
          const inventory = await herdr("agent", "list");
          return (
            mailboxes.length === 0 &&
            !inventory.agents.some(
              (item: { agent_session?: { kind: string; value: string } }) =>
                item.agent_session?.kind === "path" &&
                item.agent_session.value === canonical,
            )
          );
        },
      );
      await writeFile(
        join(root, "continuation-cleanup-evidence.json"),
        JSON.stringify(
          {
            session,
            canonical,
            observedAt: new Date().toISOString(),
            mailboxStates: 0,
            nativeGenerationAbsent: true,
          },
          null,
          2,
        ),
      );
      stages[model] = 2;
      return {
        name: "continue_agent",
        args: {
          session,
          task: "NATIVE_TRACE_CONTINUED: return continuation proof without new children.",
        },
      };
    }
    if (
      stage === 2 &&
      new Set(
        [...body.matchAll(/Result ref: result:worker#(\d+)/g)].map(
          (match) => match[1],
        ),
      ).size === 2
    ) {
      stages[model] = 3;
      return "LEAD_CONTINUATION_DONE";
    }
    if (resumed && stage >= 3) return "LEAD_RESTART_DONE";
    return { name: "list_agents", args: {} };
  }
  if (model === "worker") {
    if (body.includes("NATIVE_TRACE_CONTINUED")) return "WORKER_CONTINUED";
    if (stage === 0) {
      stages[model] = 1;
      return {
        name: "delegate_agent",
        args: {
          definition: "trace-leaf",
          label: "nested",
          task: "NATIVE_TRACE_LEAF: hold until the dashboard checkpoint completes.",
        },
      };
    }
    if (/Result ref: result:nested#\d+/.test(body)) return "WORKER_DONE";
    return { name: "list_agents", args: {} };
  }
  assert.equal(model, "leaf");
  return releaseLeaf ? "LEAF_DONE" : { name: "trace_checkpoint", args: {} };
};
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    try {
      const payload = (await request.json()) as {
        model: string;
        messages: Wire[];
      };
      const model = payload.model;
      counts[model] = (counts[model] ?? 0) + 1;
      assert.ok(
        counts[model] < 600,
        `provider runaway: ${JSON.stringify(counts)}`,
      );
      const result = await turn(model, payload.messages);
      if (typeof result !== "string") await Bun.sleep(250);
      const id = `trace-${randomUUID()}`;
      const delta =
        typeof result === "string"
          ? { role: "assistant", content: result }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: "function",
                  function: {
                    name: result.name,
                    arguments: JSON.stringify(result.args),
                  },
                },
              ],
            };
      const chunk = (value: unknown, finish: string | null, usage?: unknown) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: value, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      return new Response(
        chunk(delta, null) +
          chunk({}, typeof result === "string" ? "stop" : "tool_calls", {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
          }) +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } catch (error) {
      providerFailure = error;
      console.error(error);
      return Response.json(
        { error: { message: String(error) } },
        { status: 500 },
      );
    }
  },
});
let server: Subprocess<"ignore", "ignore", "pipe"> | undefined;
let verified = false;
let serverError: Promise<string> | undefined;
let dashboard: Subprocess<"ignore", "pipe", "ignore"> | undefined;
let pane = "";
let managerFile = "";
let dashboardUrl = "";
try {
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  const wrapper = join(root, "bin/omp");
  await writeFile(
    wrapper,
    `#!/bin/sh\n${launchFailure ? `case "$*" in *loopback/lead*) if [ ! -f '${root}/launch-failed' ]; then touch '${root}/launch-failed'; exit 73; fi;; esac\n` : ""}exec '${process.execPath}' '${nativeOmp}' "$@"\n`,
    { mode: 0o755 },
  );
  const version = run(["omp", "--version"]);
  assert.equal(version, "omp/18.12.3");
  await writeFile(join(root, "runtime-version.txt"), version);
  await writeFile(
    join(root, "run-provenance.json"),
    JSON.stringify(
      {
        argv: process.argv.slice(2),
        runtime: version,
        bun: Bun.version,
        herdr: run(["herdr", "--version"]),
        bundle,
        sha256: new Bun.CryptoHasher("sha256")
          .update(readFileSync(bundle))
          .digest("hex"),
      },
      null,
      2,
    ),
  );
  await mkdir(join(agent, "agents"), { recursive: true });
  await mkdir(join(home, ".omp/agent/extensions"), { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(join(home, ".zshrc"), "# isolated native trace acceptance\n");
  await writeFile(
    join(agent, "config.yml"),
    JSON.stringify({
      startup: { setupWizard: false, checkUpdate: false },
      marketplace: { autoUpdate: "off" },
    }),
  );
  await writeFile(
    join(agent, "models.yml"),
    `providers:\n  loopback:\n    baseUrl: ${new URL("v1", provider.url).href}\n    apiKey: local-check-only\n    api: openai-completions\n    models:\n${["manager", "ordinary", "lead", "worker", "leaf"].map((id) => `      - id: ${id}\n        name: ${id}\n        contextWindow: 200000\n        maxTokens: 8192`).join("\n")}\n`,
  );
  const probe = join(root, "checkpoint.ts");
  await writeFile(
    probe,
    `export default function(pi) { pi.registerTool({name:"trace_checkpoint", label:"trace checkpoint", description:"Wait for the native dashboard snapshot", parameters:{type:"object",properties:{}}, async execute(){ await Bun.sleep(250); return {content:[{type:"text",text:"ACTIVE_CHECKPOINT"}]}; }}); }`,
  );
  await writeFile(
    join(agent, "agents/managed-lead.md"),
    "---\nname: managed-lead\nmodel: loopback/lead\n---\n",
  );
  await writeFile(
    join(agent, "agents/trace-worker.md"),
    "---\nname: trace-worker\nmodel: loopback/worker\nagents: [trace-leaf]\n---\n",
  );
  await writeFile(
    join(agent, "agents/trace-leaf.md"),
    `---\nname: trace-leaf\nmodel: loopback/leaf\ntools: [trace_checkpoint]\nnoBuiltinTools: true\nextensions: [${JSON.stringify(probe)}]\n---\n`,
  );
  run(["git", "init", "-b", "main"], work);
  run(
    [
      "git",
      "-c",
      "user.name=Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Isolated trace fixture",
    ],
    work,
  );
  managerFile = run([
    "bun",
    "-e",
    `import {SessionManager} from '@oh-my-pi/pi-coding-agent'; const s=SessionManager.create(${JSON.stringify(work)}); s.appendCustomEntry('pi-herdsman-role',{role:'manager',leadTools:[]}); await s.ensureOnDisk(); await s.close(); console.log(s.getSessionFile());`,
  ]);
  const { PI_CODING_AGENT_DIR: ignored, ...installEnv } = env;
  const integration = Bun.spawnSync(
    ["herdr", "--session", sessionName, "integration", "install", "omp"],
    { env: installEnv },
  );
  assert.equal(integration.exitCode, 0, String(integration.stderr));
  await copyFile(
    join(home, ".omp/agent/extensions/herdr-omp-agent-state.ts"),
    join(agent, "extensions/herdr-omp-agent-state.ts"),
  );
  server = Bun.spawn(["herdr", "--session", sessionName, "server"], {
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  serverError = new Response(server.stderr).text();
  await waitFor("owned Herdr readiness", async () => {
    const result = Bun.spawnSync(
      ["herdr", "--session", sessionName, "status", "--json"],
      { env },
    );
    if (result.exitCode !== 0) return false;
    const actual = JSON.parse(String(result.stdout)).server;
    if (!actual?.running) return false;
    assert.equal(actual.session, sessionName);
    assert.equal(
      actual.socket,
      join(env.XDG_CONFIG_HOME!, "herdr/sessions", sessionName, "herdr.sock"),
    );
    assert.equal(actual.compatible, true);
    return (verified = true);
  });
  const created = await herdr(
    "workspace",
    "create",
    "--cwd",
    work,
    "--label",
    "native-traces",
    "--no-focus",
  );
  pane = created.root_pane.pane_id;
  await herdr(
    "pane",
    "run",
    pane,
    `env PI_CODING_AGENT_DIR=${agent} omp --model loopback/manager --no-title --no-skills --no-rules --auto-approve -e ${bundle} --resume ${managerFile} 'Start the native trace acceptance chain.'`,
  );
  let failedLaunchIdentity: { file: string; id: string } | undefined;
  if (launchFailure) {
    await waitFor(
      "injected native launch exit and exclusive header",
      () => existsSync(join(root, "launch-failed")) && files().length === 2,
    );
    const failedFile = files().find((file) => file !== managerFile)!;
    const header = records(failedFile).find((r) => r.type === "session");
    assert.ok(header?.id);
    const assignmentPath = [
      ...new Bun.Glob("**/assignments/**/*.json").scanSync({
        cwd: agent,
        absolute: true,
      }),
    ].find((file) => JSON.parse(readFileSync(file, "utf8")).id === header.id);
    assert.ok(assignmentPath);
    const failedAssignment = JSON.parse(readFileSync(assignmentPath, "utf8"));
    assert.equal(failedAssignment.piSessionFile, failedFile);
    failedLaunchIdentity = { file: failedFile, id: header.id };
    await writeFile(
      join(root, "launch-failure-evidence.json"),
      JSON.stringify(
        {
          recovery: naturalFailure
            ? "native natural tool timeout, then explicit same-session resume"
            : "native cancellation and exact Manager process restart; not autonomous settlement",
          header,
          failedAssignment,
          managerFile,
          failedFile,
        },
        null,
        2,
      ),
    );
    if (naturalFailure) {
      const observedAt = Date.now();
      await waitFor(
        "natural failed-launch tool result beyond supported 302s budget",
        () =>
          records(managerFile).some(
            (r) =>
              r.message?.toolName === "delegate_project" &&
              (r.message.isError === true || r.message.details?.ok === false),
          ),
        330000,
      );
      await writeFile(
        join(root, "natural-failure-settlement.json"),
        JSON.stringify(
          {
            observationMs: Date.now() - observedAt,
            toolResult: records(managerFile).findLast(
              (r) => r.message?.toolName === "delegate_project",
            ),
            failedAssignment: JSON.parse(readFileSync(assignmentPath, "utf8")),
            failedHeader: records(failedFile).find((r) => r.type === "session"),
          },
          null,
          2,
        ),
      );
      stages.manager = 2;
      managerCalls.push(
        { name: "resume_project", args: { branch: "trace-project" } },
        {
          name: "message_staff",
          args: {
            session: header.id,
            message:
              "NATIVE_TRACE_LEAD: run the preserved project assignment and delegate the worker.",
          },
        },
      );
      await herdr(
        "agent",
        "prompt",
        pane,
        "Recover the naturally failed managed launch using its exact canonical transcript.",
      );
    } else {
      stages.manager = 2;
      await herdr("pane", "send-keys", pane, "escape");
      await herdr("agent", "prompt", pane, "/exit");
      await waitFor(
        "failed launch Manager exits after native cancellation",
        async () =>
          !(await herdr("agent", "list")).agents.some(
            (item: { pane_id: string }) => item.pane_id === pane,
          ),
      );
      assert.ok(existsSync(failedFile));
      assert.equal(
        JSON.parse(readFileSync(assignmentPath, "utf8")).piSessionFile,
        failedFile,
      );
      managerCalls.push(
        { name: "resume_project", args: { branch: "trace-project" } },
        {
          name: "message_staff",
          args: {
            session: header.id,
            message:
              "NATIVE_TRACE_LEAD: run the preserved project assignment and delegate the worker.",
          },
        },
      );
      await herdr(
        "pane",
        "run",
        pane,
        `env PI_CODING_AGENT_DIR=${agent} omp --model loopback/manager --no-title --no-skills --no-rules --auto-approve -e ${bundle} --resume ${managerFile} 'Resume the preserved failed-launch assignment.'`,
      );
    }
  }
  await waitFor(
    "four native sessions active",
    () => files().length >= 4 && (counts.leaf ?? 0) >= 2,
  );
  await writeFile(
    join(root, "active-files.json"),
    JSON.stringify(files(), null, 2),
  );
  const active = files().map((file) => ({ file, records: records(file) }));
  const byModel = (model: string) =>
    active.find((s) =>
      s.records.some(
        (r) => r.message?.role === "assistant" && r.message?.model === model,
      ),
    );
  const lead = byModel("lead");
  const worker = byModel("worker");
  const leaf = byModel("leaf");
  assert.ok(
    lead && worker && leaf,
    "native messages establish each session identity",
  );
  assert.equal(
    records(managerFile).some((r) =>
      /LEAD_CONTINUATION_DONE/.test(text(r.message?.content)),
    ),
    false,
    "checkpoint precedes terminal project delivery",
  );
  const assignedSession = records(lead.file).find(
    (r) => r.type === "session",
  )?.id;
  assert.ok(assignedSession);
  for (const [session, name] of [
    [lead, "lead_trace-project"],
    [worker, "trace-worker_worker"],
    [leaf, "trace-leaf_nested"],
  ] as const) {
    const id = session.records.find((r) => r.type === "session")?.id;
    assert.ok(id);
    assert.equal(basename(session.file), `${name}_${id}.jsonl`);
  }
  if (failedLaunchIdentity) {
    assert.equal(
      assignedSession,
      failedLaunchIdentity.id,
      "launch failure and Manager restart preserve assigned native ID",
    );
    assert.equal(
      lead.file,
      failedLaunchIdentity.file,
      "launch failure and Manager restart preserve the one canonical transcript",
    );
  }
  const assignments = [
    ...new Bun.Glob("**/assignments/**/*.json").scanSync({
      cwd: agent,
      absolute: true,
    }),
  ];
  const assignmentFile = assignments.find(
    (file) => JSON.parse(readFileSync(file, "utf8")).id === assignedSession,
  );
  assert.ok(
    assignmentFile,
    "managed native header preserves the exact assigned ID",
  );
  const assignment = JSON.parse(readFileSync(assignmentFile, "utf8"));
  assert.equal(
    assignment.piSessionFile,
    lead.file,
    "assignment persists its one canonical native transcript",
  );
  await writeFile(
    join(root, "active-identities.json"),
    JSON.stringify(
      active.map((s) => ({
        file: s.file,
        header: s.records.find((r) => r.type === "session"),
        messages: s.records.filter((r) => r.message?.role === "assistant"),
      })),
      null,
      2,
    ),
  );
  const liveness = await herdr("agent", "list");
  await writeFile(
    join(root, "active-herdr-agents.json"),
    JSON.stringify(liveness, null, 2),
  );
  assert.ok(
    liveness.agents.filter(
      (item: { agent_status: string }) => item.agent_status === "working",
    ).length >= 3,
    "Lead, worker and nested Agent are active before delivery",
  );
  const dashboardCode = `import {startServer} from '@oh-my-pi/omp-stats'; const s=await startServer(0,'127.0.0.1'); console.log('DASHBOARD_URL=http://127.0.0.1:'+s.port);`;
  dashboard = Bun.spawn(["bun", "-e", dashboardCode], {
    cwd: repository,
    env,
    stdout: "pipe",
    stderr: Bun.file(join(root, "dashboard.stderr.log")),
  });
  const reader = dashboard.stdout.getReader();
  let output = "";
  while (!output.includes("DASHBOARD_URL=")) {
    const value = await reader.read();
    assert.ok(!value.done, "dashboard exited before ready");
    output += new TextDecoder().decode(value.value);
  }
  dashboardUrl = output.match(/DASHBOARD_URL=(\S+)/)![1]!;
  await writeFile(join(root, "dashboard-url.txt"), dashboardUrl);
  log(`dashboard=${dashboardUrl}`);
  const api = async (path: string, init?: RequestInit) => {
    const response = await fetch(dashboardUrl + path, init);
    assert.ok(
      response.ok,
      `${path}: ${response.status} ${await response.clone().text()}`,
    );
    return await response.json();
  };
  await api("/api/sync", { method: "POST" });
  await waitFor("native stats sync", async () => {
    const status = await api("/api/status");
    assert.equal(status.sync.error, null);
    return status.sync.phase === "idle" && status.sync.lastSyncedAt !== null;
  });
  const trace = await api(
    `/api/session/trace?file=${encodeURIComponent(managerFile)}`,
  );
  await writeFile(
    join(root, "active-trace.json"),
    JSON.stringify(trace, null, 2),
  );
  const stats = await api("/api/stats");
  await writeFile(
    join(root, "active-stats.json"),
    JSON.stringify(stats, null, 2),
  );
  log(
    `active tracks=${JSON.stringify(trace.tracks.map((t: { id: string; parentId: string | null; file: string }) => ({ id: t.id, parentId: t.parentId, file: t.file })))}, categories=${JSON.stringify(stats.byAgentType)}`,
  );
  assert.equal(
    trace.tracks.length,
    4,
    "native dashboard must link Manager -> managed Lead -> Agent -> nested Agent before terminal delivery",
  );
  for (const [child, parent] of [
    [lead.file, managerFile],
    [worker.file, lead.file],
    [leaf.file, worker.file],
  ]) {
    assert.equal(
      dirname(child),
      parent.slice(0, -6),
      `exact immediate creator for ${child}`,
    );
  }
  assert.equal(
    stats.byAgentType.find(
      (r: { agentType: string; totalRequests: number }) =>
        r.agentType === "subagent",
    )?.totalRequests > 0,
    true,
    "fresh child usage is natively subagent",
  );
  await captureDashboard(
    `${dashboardUrl}/#/traces?range=all&s=${encodeURIComponent(managerFile)}`,
    join(root, "active-ui"),
    4,
  );
  const activeGc = JSON.parse(run(["omp", "gc", "--apply", "--json"]));
  await writeFile(
    join(root, "active-native-gc.json"),
    JSON.stringify(activeGc, null, 2),
  );
  assert.ok(
    active.every((session) => existsSync(session.file)),
    "native default retention preserves active ancestry and descendants",
  );
  releaseLeaf = true;
  await waitFor("worker canonical continuation", () =>
    records(lead.file).some((r) =>
      text(r.message?.content).includes("LEAD_CONTINUATION_DONE"),
    ),
  );
  const originalPaths = files();
  assert.equal(
    originalPaths.length,
    4,
    "continuation creates no duplicate transcript",
  );
  log(
    `continuation preserved canonical files=${JSON.stringify(originalPaths)}`,
  );
  const managerTurn = async (
    calls: Call[],
    prompt: string,
    expectError = false,
  ) => {
    const before = records(managerFile).filter(
      (r) =>
        r.message?.role === "assistant" &&
        text(r.message.content) === "MANAGER_READY",
    ).length;
    managerCalls.push(...calls);
    await herdr("agent", "prompt", pane, prompt);
    await waitFor(
      prompt,
      () =>
        managerCalls.length === 0 &&
        records(managerFile).filter(
          (r) =>
            r.message?.role === "assistant" &&
            text(r.message.content) === "MANAGER_READY",
        ).length > before,
    );
    for (const call of calls) {
      const result = records(managerFile).findLast(
        (r) => r.message?.toolName === call.name,
      )?.message;
      assert.ok(result, `${call.name} publishes a native tool result`);
      assert.equal(
        result.isError === true || result.details?.ok === false,
        expectError,
        `${call.name} expected semantic error=${expectError}`,
      );
    }
  };
  await managerTurn(
    [{ name: "stop_lead", args: { session: assignedSession } }],
    "Stop the assigned Lead for canonical restart proof.",
  );
  resumed = true;
  await managerTurn(
    [
      { name: "resume_project", args: { branch: "trace-project" } },
      {
        name: "message_staff",
        args: {
          session: assignedSession,
          message: "Exercise the resumed canonical session.",
        },
      },
    ],
    "Resume the exact assigned Lead and ask it to confirm restart.",
  );
  await waitFor("same Lead transcript receives restart", () =>
    records(lead.file).some((r) =>
      text(r.message?.content).includes("LEAD_RESTART_DONE"),
    ),
  );
  assert.deepEqual(
    files().sort(),
    originalPaths.sort(),
    "restart reuses all canonical transcripts",
  );
  assert.equal(
    JSON.parse(readFileSync(assignmentFile, "utf8")).piSessionFile,
    lead.file,
  );
  await writeFile(
    join(root, "restart-evidence.json"),
    JSON.stringify(
      {
        assignedSession,
        assignment: JSON.parse(readFileSync(assignmentFile, "utf8")),
        files: files(),
        leadHeader: records(lead.file).find((r) => r.type === "session"),
      },
      null,
      2,
    ),
  );
  await api("/api/sync", { method: "POST" });
  await waitFor(
    "final native sync",
    async () => (await api("/api/status")).sync.phase === "idle",
  );
  let finalStats = await api("/api/stats");
  let expected: { file: string; requests: number }[] = [];
  await waitFor("eventual native exactly-once accounting", async () => {
    expected = files().map((file) => ({
      file,
      requests: records(file).filter(
        (r) =>
          r.message?.role === "assistant" &&
          ["manager", "lead", "worker", "leaf"].includes(
            r.message.model ?? "",
          ) &&
          r.message.content !== undefined,
      ).length,
    }));
    finalStats = await api("/api/stats");
    return (
      finalStats.byAgentType.reduce(
        (total: number, row: { totalRequests: number }) =>
          total + row.totalRequests,
        0,
      ) === expected.reduce((total, row) => total + row.requests, 0)
    );
  });
  await writeFile(
    join(root, "final-accounting.json"),
    JSON.stringify({ stats: finalStats, expected, counts }, null, 2),
  );
  const ingested = finalStats.byAgentType.reduce(
    (total: number, row: { totalRequests: number }) =>
      total + row.totalRequests,
    0,
  );
  assert.equal(
    ingested,
    expected.reduce((total, row) => total + row.requests, 0),
    "native totals count every persisted request exactly once",
  );
  assert.equal(
    finalStats.byAgentType.find(
      (row: { agentType: string }) => row.agentType === "main",
    ).totalRequests,
    expected.find((row) => row.file === managerFile)!.requests,
    "only standalone Manager work is main",
  );
  if (process.argv.includes("--lifecycle")) {
    const originalManagerFile = managerFile;
    const originalManagerPane = pane;
    const ordinaryWorkspace = await herdr(
      "worktree",
      "create",
      "--workspace",
      created.workspace.workspace_id,
      "--branch",
      "trace-ordinary",
      "--no-focus",
    );
    await writeFile(
      join(root, "ordinary-worktree-create.json"),
      JSON.stringify(ordinaryWorkspace, null, 2),
    );
    const ordinaryPane = ordinaryWorkspace.root_pane.pane_id;
    await herdr(
      "pane",
      "run",
      ordinaryPane,
      `env PI_CODING_AGENT_DIR=${agent} omp --model loopback/ordinary --no-title --no-skills --no-rules --auto-approve -e ${bundle} 'Prove ordinary Lead root semantics.'`,
    );
    let ordinaryFile: string | undefined;
    await waitFor("ordinary Lead root conversation", () => {
      ordinaryFile = files().find((file) =>
        records(file).some((r) => r.message?.model === "ordinary"),
      );
      return !!ordinaryFile;
    });
    assert.ok(ordinaryFile);
    assert.equal(
      dirname(dirname(ordinaryFile)),
      join(agent, "sessions"),
      "ordinary Lead is an independent native root",
    );
    await managerTurn(
      [{ name: "list_staff", args: {} }],
      "Observe the ordinary Lead without assigning or reparenting it.",
    );
    const ordinaryStaff = records(managerFile).findLast(
      (r) => r.message?.toolName === "list_staff",
    )?.message;
    await writeFile(
      join(root, "ordinary-supervision.json"),
      JSON.stringify(ordinaryStaff, null, 2),
    );
    assert.ok(
      JSON.stringify(ordinaryStaff).includes(
        records(ordinaryFile).find((r) => r.type === "session")!.id!,
      ),
      "verified supervision discovers the exact ordinary root",
    );
    assert.equal(
      (await api(`/api/session/trace?file=${encodeURIComponent(ordinaryFile)}`))
        .tracks.length,
      1,
      "supervision does not link the ordinary Lead",
    );
    const historyFile = run([
      "bun",
      "-e",
      `import {SessionManager} from '@oh-my-pi/pi-coding-agent'; const s=SessionManager.create(${JSON.stringify(work)}); s.appendCustomEntry('historical-flat-fixture',{purpose:'unchanged native history'}); await s.ensureOnDisk(); await s.close(); console.log(s.getSessionFile());`,
    ]);
    const historicalBytes = readFileSync(historyFile);
    const waitPane = async (target: string, pattern: RegExp) => {
      let value = "";
      await waitFor(`native UI ${pattern}`, async () => {
        value = await herdr("pane", "read", target, "--source", "visible");
        return pattern.test(value);
      });
      return value;
    };
    await herdr("agent", "prompt", originalManagerPane, "/manager leave");
    await waitFor(
      "original Manager relinquishes role",
      () =>
        records(originalManagerFile).findLast(
          (r) => r.customType === "pi-herdsman-role",
        )?.data?.role === "lead",
    );
    const beforeSwitch = files();
    await herdr("agent", "prompt", originalManagerPane, "/new");
    await herdr(
      "agent",
      "prompt",
      originalManagerPane,
      "Prove native session switching leaves old descendants in place.",
    );
    let replacementFile: string | undefined;
    await waitFor("session switch creates a new native root", () => {
      replacementFile = files().find(
        (file) =>
          !beforeSwitch.includes(file) &&
          records(file).some((r) => r.message?.model === "manager"),
      );
      return !!replacementFile;
    });
    assert.ok(replacementFile);
    await herdr("agent", "prompt", originalManagerPane, "/manager");
    await waitFor(
      "new root becomes replacement Manager",
      () =>
        records(replacementFile!).findLast(
          (r) => r.customType === "pi-herdsman-role",
        )?.data?.role === "manager",
    );
    await herdr("pane", "send-keys", originalManagerPane, "escape");
    managerFile = replacementFile;
    assert.equal(
      dirname(dirname(managerFile)),
      join(agent, "sessions"),
      "new standalone Manager stays a native root",
    );
    await managerTurn(
      [
        { name: "list_staff", args: {} },
        { name: "inspect_staff", args: { session: assignedSession } },
        {
          name: "message_staff",
          args: {
            session: assignedSession,
            message:
              "Confirm replacement Manager authority without reparenting.",
          },
        },
      ],
      "Exercise replacement Manager authority.",
    );
    assert.equal(
      JSON.parse(readFileSync(assignmentFile, "utf8")).piSessionFile,
      lead.file,
    );
    const workerSession = records(worker.file).find(
      (r) => r.type === "session",
    )!.id!;
    await managerTurn(
      [{ name: "read_agent_responses", args: { session: workerSession } }],
      "Prove historical nesting does not grant ownership of the Lead's Agent.",
      true,
    );
    const replacementTrace = await api(
      `/api/session/trace?file=${encodeURIComponent(managerFile)}`,
    );
    assert.equal(
      replacementTrace.tracks.length,
      1,
      "replacement Manager remains a separate root",
    );
    const historicalTrace = await api(
      `/api/session/trace?file=${encodeURIComponent(originalManagerFile)}`,
    );
    assert.equal(
      historicalTrace.tracks.length,
      4,
      "original ancestry survives Manager replacement and role changes",
    );
    await writeFile(
      join(root, "replacement-authority.json"),
      JSON.stringify(
        {
          originalManagerFile,
          replacementManagerFile: managerFile,
          assignment: JSON.parse(readFileSync(assignmentFile, "utf8")),
          historicalTrace,
          replacementTrace,
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(root, "session-switch-evidence.json"),
      JSON.stringify(
        {
          originalManagerFile,
          replacementManagerFile: managerFile,
          originalHistoricalHeader: records(originalManagerFile).find(
            (r) => r.type === "session",
          ),
          replacementHeader: records(managerFile).find(
            (r) => r.type === "session",
          ),
        },
        null,
        2,
      ),
    );
    const leadAgents = (await herdr("agent", "list")).agents.filter(
      (item: { agent_session?: { kind: string; value: string } }) =>
        item.agent_session?.kind === "path" &&
        item.agent_session.value === lead.file,
    );
    assert.equal(
      leadAgents.length,
      1,
      "exact assigned Lead remains live after Manager replacement",
    );
    const leadPane = leadAgents[0].pane_id;
    await herdr("agent", "prompt", leadPane, "/takeover");
    const takeoverPrompt = await waitPane(
      leadPane,
      /Take over this managed Lead/,
    );
    await writeFile(join(root, "takeover-prompt.txt"), takeoverPrompt);
    await herdr("pane", "send-keys", leadPane, "up");
    await herdr("pane", "send-keys", leadPane, "enter");
    await waitFor(
      "confirmed takeover releases only authority",
      () => !existsSync(assignmentFile),
    );
    assert.ok(originalPaths.every((file) => existsSync(file)));
    await managerTurn(
      [{ name: "stop_lead", args: { session: assignedSession } }],
      "Prove takeover removed managed execution authority.",
      true,
    );
    assert.equal(
      (
        await api(
          `/api/session/trace?file=${encodeURIComponent(originalManagerFile)}`,
        )
      ).tracks.length,
      4,
    );
    stages.lead = 0;
    stages.worker = 0;
    await managerTurn(
      [
        {
          name: "delegate_project",
          args: {
            branch: "trace-retire",
            task: "Create a second native Lead/Agent/nested Agent history for retirement proof.",
          },
        },
      ],
      "Create retained descendant history for worktree retirement.",
    );
    const retirementAssignmentFile = [
      ...new Bun.Glob("**/assignments/**/*.json").scanSync({
        cwd: agent,
        absolute: true,
      }),
    ].find(
      (file) =>
        JSON.parse(readFileSync(file, "utf8")).branch === "trace-retire",
    );
    assert.ok(retirementAssignmentFile);
    const retiring = JSON.parse(readFileSync(retirementAssignmentFile, "utf8"));
    assert.equal(
      dirname(retiring.piSessionFile),
      managerFile.slice(0, -6),
      "new descendants link to the exact replacement Manager session",
    );
    await waitFor(
      "retiring project completes its own canonical continuation",
      () =>
        records(retiring.piSessionFile).some(
          (r) =>
            r.message?.role === "assistant" &&
            text(r.message.content) === "LEAD_CONTINUATION_DONE",
        ),
    );
    const beforeRetirement = files();
    await herdr("agent", "prompt", pane, "/manager remove trace-retire");
    const removalPrompt = await waitPane(pane, /Type remove to confirm/i);
    await writeFile(join(root, "retirement-prompt.txt"), removalPrompt);
    await herdr("pane", "send-text", pane, "remove");
    await Bun.sleep(250);
    await herdr("pane", "send-keys", pane, "enter");
    await waitFor(
      "native guarded worktree removal retires exact assignment",
      () => !existsSync(retirementAssignmentFile),
    );
    assert.ok(
      beforeRetirement.every((file) => existsSync(file)),
      "Herdsman worktree retirement preserves all transcript history",
    );
    assert.deepEqual(
      readFileSync(historyFile),
      historicalBytes,
      "existing flat native history is byte-for-byte untouched",
    );
    const retainedGc = JSON.parse(run(["omp", "gc", "--apply", "--json"]));
    assert.ok(
      beforeRetirement.every((file) => existsSync(file)),
      "native default retained/newest policy preserves complete descendants after retirement",
    );
    const retiredTrace = await api(
      `/api/session/trace?file=${encodeURIComponent(managerFile)}`,
    );
    assert.equal(
      retiredTrace.tracks.length,
      4,
      "retired assignment ancestry remains visible beneath its creating Manager",
    );
    await writeFile(
      join(root, "lifecycle-evidence.json"),
      JSON.stringify(
        {
          ordinaryFile,
          historyFile,
          retiring,
          retainedGc,
          retiredTrace,
          beforeRetirement,
          afterRetirement: files(),
        },
        null,
        2,
      ),
    );
    await captureDashboard(
      `${dashboardUrl}/#/traces?range=all&s=${encodeURIComponent(managerFile)}`,
      join(root, "retired-ui"),
      4,
    );
  }
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        sessionName,
        managerFile,
        lead: lead.file,
        worker: worker.file,
        leaf: leaf.file,
        dashboardUrl,
        counts,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(join(root, "failure.txt"), String(error));
  if (verified && pane) {
    try {
      await writeFile(
        join(root, "manager-pane.txt"),
        await herdr(
          "pane",
          "read",
          pane,
          "--source",
          "recent-unwrapped",
          "--lines",
          "100",
        ),
      );
    } catch {}
  }
  throw error;
} finally {
  releaseLeaf = true;
  provider.stop(true);
  if (dashboard && dashboard.exitCode === null) {
    dashboard.kill();
    await dashboard.exited;
  }
  if (server && verified && server.exitCode === null) {
    const stopped = Bun.spawnSync(
      ["herdr", "--session", sessionName, "server", "stop"],
      { env },
    );
    assert.equal(
      stopped.exitCode,
      0,
      `owned cleanup failed; preserve ${root}: ${String(stopped.stderr)}`,
    );
  } else if (server && !verified && server.exitCode === null) server.kill();
  if (server) {
    const stopped = await Promise.race([
      server.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    assert.ok(
      stopped,
      `owned Herdr still live pid=${server.pid} session=${sessionName}`,
    );
  }
  await writeFile(
    join(root, "cleanup.json"),
    JSON.stringify(
      {
        sessionName,
        pid: server?.pid,
        exitCode: server?.exitCode,
        stderr: await serverError,
        retainedEvidence: root,
      },
      null,
      2,
    ),
  );
  log(`owned processes stopped; retained evidence=${root}`);
}
