// Real OMP + Herdr + built Herdsman; only model decisions are scripted.
// Run with `bun scripts/omp-manager-removal-check.ts` after building dist/index.js.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const bundle = join(repository, "dist/index.js");
assert.ok(existsSync(bundle), "build dist/index.js first");
const root = await mkdtemp(join(await realpath("/tmp"), "phs-removal-"));
const agent = join(root, "agent");
const work = join(root, "repo");
const home = join(root, "home");
const config = join(root, "xdg-config");
const sessionName = `phs-remove-${randomUUID().slice(0, 8)}`;
const branch = "smoke-removal";
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
        ].includes(key),
    ),
  ),
  HOME: home,
  TMPDIR: root,
  XDG_CACHE_HOME: join(root, "xdg-cache"),
  XDG_CONFIG_HOME: config,
  XDG_STATE_HOME: join(root, "xdg-state"),
  PI_CODING_AGENT_DIR: agent,
  PI_CODING_AGENT_SESSION_DIR: join(agent, "sessions"),
  HERDR_CONFIG_PATH: join(root, "herdr.toml"),
  HERDR_SESSION: sessionName,
} as Record<string, string>;
const log = (message: string) => console.log(`[removal-smoke] ${message}`);
const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? "").join("\n")
      : "";
const run = (command: string, args: string[], cwd = work) => {
  const child = Bun.spawnSync([command, ...args], { cwd, env });
  assert.equal(
    child.exitCode,
    0,
    `${command} ${args.join(" ")}: ${String(child.stderr)} ${String(child.stdout)}`,
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
  // These pane-input operations use Herdr's no-result contract.
  if (
    args[0] === "pane" &&
    ["run", "send-text", "send-keys"].includes(args[1] ?? "")
  )
    return;
  const envelope = JSON.parse(out);
  assert.ok(
    envelope !== null &&
      typeof envelope === "object" &&
      Object.hasOwn(envelope, "id") &&
      Object.hasOwn(envelope, "result"),
    `herdr ${args.join(" ")} returned JSON without an id/result envelope: ${out}`,
  );
  return envelope.result;
};
const withinRoot = (path: string) => {
  const rel = relative(root, path);
  return (
    rel !== "" && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/")
  );
};
type Call = { name: string; args: Record<string, unknown> };
type Wire = { role: string; content?: unknown; tool_call_id?: string };
let steps: Call[] = [];
let next = 0;
let pendingId: string | undefined;
let providerFailure: unknown;
let progress = Date.now();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    try {
      const payload = (await request.json()) as {
        messages: Wire[];
        tools?: Array<{ function: { name: string } }>;
      };
      const manager = payload.tools?.some(
        (tool) => tool.function.name === "delegate_project",
      );
      let call: Call | undefined;
      if (manager) {
        if (pendingId) {
          assert.ok(
            payload.messages.some(
              (message) =>
                message.role === "tool" && message.tool_call_id === pendingId,
            ),
            `missing correlated tool result ${pendingId}`,
          );
          pendingId = undefined;
        }
        call = steps[next++];
      }
      progress = Date.now();
      const id = `removal-${randomUUID()}`;
      if (call) pendingId = id;
      const delta = call
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: manager ? "REMOVAL_TURN_DONE" : "Disposable Lead ready.",
          };
      const chunk = (value: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "removal", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
      return new Response(
        chunk(delta, null) +
          chunk({}, call ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } catch (error) {
      providerFailure = error;
      return Response.json(
        { error: { message: String(error) } },
        { status: 500 },
      );
    }
  },
});
let herdrProcess: ReturnType<typeof Bun.spawn> | undefined;
let stderr: Promise<string> | undefined;
let verified = false;
let pane = "";
let workspace = "";
let sessionFile = "";
const records = () =>
  existsSync(sessionFile)
    ? readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const messages = () =>
  records()
    .filter((record) => record.type === "message")
    .map((record) => record.message);
const outputs = (name: string) =>
  messages().filter(
    (message) => message.role === "toolResult" && message.toolName === name,
  );
const waitFor = async (
  description: string,
  predicate: () => boolean,
  timeout = 45000,
) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (providerFailure) throw providerFailure;
    assert.ok(
      Date.now() < deadline,
      `timed out waiting for ${description}; provider next=${next}, idle=${Date.now() - progress}ms`,
    );
    await Bun.sleep(100);
  }
};
const submit = async (value: string) => {
  await herdr("pane", "send-text", pane, value);
  await Bun.sleep(250);
  await herdr("pane", "send-keys", pane, "enter");
};
const paneText = async () =>
  (await herdr(
    "pane",
    "read",
    pane,
    "--source",
    "recent-unwrapped",
    "--lines",
    "100",
  )) as string;
const waitPane = async (pattern: RegExp) => {
  const deadline = Date.now() + 30000;
  for (;;) {
    const value = (await herdr(
      "pane",
      "read",
      pane,
      "--source",
      "visible",
    )) as string;
    if (pattern.test(value)) return value;
    assert.ok(Date.now() < deadline, `UI did not show ${pattern}: ${value}`);
    await Bun.sleep(150);
  }
};
const turn = async (calls: Call[], prompt: string) => {
  const before = messages().filter(
    (message) =>
      message.role === "assistant" &&
      text(message.content).includes("REMOVAL_TURN_DONE"),
  ).length;
  steps = calls;
  next = 0;
  pendingId = undefined;
  await herdr("agent", "prompt", pane, prompt);
  await waitFor(
    prompt,
    () =>
      messages().filter(
        (message) =>
          message.role === "assistant" &&
          text(message.content).includes("REMOVAL_TURN_DONE"),
      ).length > before,
  );
  assert.ok(next > calls.length, `${prompt}: incomplete provider sequence`);
};
const removal = { name: "remove_worktree", args: { branch } };
try {
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(join(home, ".omp/agent/extensions"), { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(join(home, ".zshrc"), "# isolated smoke\n");
  await writeFile(
    join(agent, "config.yml"),
    JSON.stringify({
      startup: { setupWizard: false, checkUpdate: false },
      marketplace: { autoUpdate: "off" },
    }),
  );
  await writeFile(
    join(agent, "models.yml"),
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
  run("git", ["init", "-b", "main"]);
  run("git", [
    "-c",
    "user.name=Smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "Disposable smoke root",
  ]);
  const { PI_CODING_AGENT_DIR: _ignored, ...installEnv } = env;
  const install = Bun.spawnSync(
    ["herdr", "--session", sessionName, "integration", "install", "omp"],
    { env: installEnv },
  );
  assert.equal(install.exitCode, 0, String(install.stderr));
  await copyFile(
    join(home, ".omp/agent/extensions/herdr-omp-agent-state.ts"),
    join(agent, "extensions/herdr-omp-agent-state.ts"),
  );
  const seed = Bun.spawnSync(
    [
      "bun",
      "-e",
      `import { SessionManager } from "@oh-my-pi/pi-coding-agent"; const s = SessionManager.create(${JSON.stringify(work)}, ${JSON.stringify(join(agent, "sessions"))}); s.appendCustomEntry("pi-herdsman-role", {role:"manager",leadTools:[]}); await s.ensureOnDisk(); await s.close(); console.log(s.getSessionFile());`,
    ],
    { cwd: repository, env },
  );
  assert.equal(seed.exitCode, 0, String(seed.stderr));
  sessionFile = String(seed.stdout).trim();
  assert.ok(existsSync(sessionFile) && withinRoot(sessionFile));
  herdrProcess = Bun.spawn(["herdr", "--session", sessionName, "server"], {
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  stderr = new Response(herdrProcess.stderr).text();
  for (let i = 0; ; i++) {
    if (herdrProcess.exitCode !== null)
      throw new Error(`owned server exited: ${await stderr}`);
    const status = Bun.spawnSync(
      ["herdr", "--session", sessionName, "status", "--json"],
      { env },
    );
    if (status.exitCode === 0) {
      const state = JSON.parse(String(status.stdout)).server;
      if (state?.running) {
        assert.equal(state.session, sessionName);
        assert.equal(
          state.socket,
          join(config, "herdr", "sessions", sessionName, "herdr.sock"),
        );
        assert.equal(state.compatible, true);
        verified = true;
        break;
      }
    }
    assert.ok(i < 100, "owned Herdr server did not start");
    await Bun.sleep(150);
  }
  log(`owned server ${sessionName} pid=${herdrProcess.pid} root=${root}`);
  const created = await herdr(
    "workspace",
    "create",
    "--cwd",
    work,
    "--label",
    "removal-smoke",
    "--no-focus",
  );
  assert.ok(
    created &&
      typeof created === "object" &&
      created.workspace &&
      created.root_pane,
    JSON.stringify(created),
  );
  workspace = created.workspace.workspace_id;
  pane = created.root_pane.pane_id;
  assert.ok(
    typeof workspace === "string" &&
      workspace &&
      typeof pane === "string" &&
      pane,
    JSON.stringify(created),
  );
  const command = `env PI_CODING_AGENT_DIR=${agent} omp --model loopback/scripted --no-title --no-skills --no-rules --no-context-files --auto-approve -e ${bundle} --resume ${sessionFile}`;
  steps = [
    {
      name: "delegate_project",
      args: { branch, task: "Remain idle in this disposable checkout." },
    },
  ];
  await herdr(
    "pane",
    "run",
    pane,
    `${command} 'Create the disposable project checkout.'`,
  );
  await waitFor("project delegation", () =>
    messages().some(
      (message) =>
        message.role === "assistant" &&
        text(message.content).includes("REMOVAL_TURN_DONE"),
    ),
  );
  assert.ok(
    next > steps.length,
    "project delegation provider sequence incomplete",
  );
  const delegated = outputs("delegate_project").at(-1);
  assert.ok(
    delegated && !delegated.isError && delegated.details?.ok,
    JSON.stringify(delegated),
  );
  const assignment = delegated.details.session;
  assert.equal(typeof assignment, "string");
  const assignmentFiles = [
    ...new Bun.Glob("**/assignments/**/*.json").scanSync({
      cwd: agent,
      absolute: true,
    }),
  ];
  const assignmentFile = assignmentFiles.find((file) => {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value.id === assignment && value.branch === branch;
  });
  assert.ok(
    assignmentFile && withinRoot(assignmentFile),
    "exact current assignment must exist before removal",
  );
  const topology = await herdr("worktree", "list", "--workspace", workspace);
  assert.ok(
    Array.isArray(topology?.worktrees),
    "Herdr worktree inventory must be authoritative",
  );
  const target = topology.worktrees.find(
    (item: { branch: string }) => item?.branch === branch,
  );
  assert.ok(
    target &&
      typeof target.path === "string" &&
      withinRoot(target.path) &&
      existsSync(target.path),
    JSON.stringify(target),
  );
  const checkout = target.path as string;
  assert.ok(
    withinRoot(await realpath(checkout)),
    "physical checkout must be inside the owned root",
  );
  assert.ok(
    target.open_workspace_id && target.open_workspace_id !== workspace,
    "target must have a distinct owned workspace",
  );
  assert.notEqual(await realpath(checkout), await realpath(work));
  const sessions = () => [
    ...new Bun.Glob("**/*.jsonl").scanSync({ cwd: agent, absolute: true }),
  ];
  await waitFor("Lead conversation", () =>
    sessions().some((file) => readFileSync(file, "utf8").includes(assignment)),
  );
  const leadFile = sessions().find(
    (file) =>
      readFileSync(file, "utf8").includes(assignment) && file !== sessionFile,
  );
  assert.ok(
    leadFile && withinRoot(leadFile),
    "assigned Lead conversation not found in isolated agent directory",
  );
  await turn(
    [removal, removal, { name: "list_staff", args: {} }],
    "Request removal twice, then continue coordination.",
  );
  const requests = outputs("remove_worktree").slice(-2);
  for (const result of requests)
    assert.deepEqual(
      {
        ok: result.details?.ok,
        confirmation_required: result.details?.confirmation_required,
        pending: result.details?.pending,
      },
      { ok: false, confirmation_required: true, pending: true },
      JSON.stringify(result),
    );
  const requestId = requests[0].details.request_id;
  assert.equal(typeof requestId, "string");
  assert.equal(requests[1].details.request_id, requestId);
  assert.ok(existsSync(checkout), "pending intent must not remove checkout");
  assert.ok(
    existsSync(assignmentFile),
    "pending intent must not retire the assignment",
  );
  assert.ok(
    outputs("list_staff").at(-1) && !outputs("list_staff").at(-1).isError,
    "coordination continued after pending request",
  );
  log(`pending duplicate and nonblocking coordination passed id=${requestId}`);
  await waitPane(/removal review pending.*\/manager remove/i);
  log("native pending status guides the user to /manager remove");
  const inventoryBeforeExit = await herdr("agent", "list");
  const agentsBeforeExit = inventoryBeforeExit?.agents;
  assert.ok(
    Array.isArray(agentsBeforeExit) &&
      agentsBeforeExit.some(
        (item: { pane_id: string }) => item.pane_id === pane,
      ),
    "Manager must be observed before exit",
  );
  await herdr("agent", "prompt", pane, "/exit");
  for (let attempt = 0; ; attempt++) {
    const inventory = await herdr("agent", "list");
    const agents = inventory?.agents;
    assert.ok(
      Array.isArray(agents),
      "Herdr agent inventory must be authoritative",
    );
    if (!agents.some((item: { pane_id: string }) => item.pane_id === pane))
      break;
    assert.ok(attempt < 200, "Manager did not exit before resume");
    await Bun.sleep(100);
  }
  await herdr("pane", "run", pane, command);
  for (let attempt = 0; ; attempt++) {
    const inventory = await herdr("agent", "list");
    const agents = inventory?.agents;
    assert.ok(
      Array.isArray(agents),
      "Herdr agent inventory must be authoritative",
    );
    if (
      agents.some(
        (item: { pane_id: string; agent_status: string }) =>
          item.pane_id === pane && ["idle", "done"].includes(item.agent_status),
      )
    )
      break;
    assert.ok(attempt < 300, "resumed Manager was not ready");
    await Bun.sleep(100);
  }
  await turn([removal], "Request the same removal after session reload.");
  assert.equal(
    outputs("remove_worktree").at(-1)?.details?.request_id,
    requestId,
    "same native session branch must restore pending identity",
  );
  log("same-session reload preserved pending request identity");
  await herdr("agent", "prompt", pane, `/manager remove ${branch}`);
  const removePrompt = await waitPane(/type remove to confirm/i);
  for (const required of [
    branch,
    checkout,
    "Removes this checkout and Herdr workspace.",
    "Running managed execution may be stopped.",
    "Preserves the Git branch and Pi conversation.",
    "Retires the assignment after verified removal.",
  ])
    assert.ok(
      removePrompt.includes(required),
      `confirmation must show ${required}: ${removePrompt}`,
    );
  log(`native removal confirmation: ${JSON.stringify(removePrompt)}`);
  await submit("cancel");
  await waitFor("durable human cancellation", () =>
    records().some(
      (record) =>
        record.type === "custom" &&
        record.data?.phase === "resolution" &&
        record.data?.requestId === requestId &&
        record.data?.outcome === "cancelled",
    ),
  );
  assert.ok(
    existsSync(checkout) && existsSync(assignmentFile),
    "cancelled review preserves checkout and assignment",
  );
  await turn([removal], "Request removal after cancelling the review.");
  const replacementId = outputs("remove_worktree").at(-1)?.details?.request_id;
  assert.equal(typeof replacementId, "string");
  assert.notEqual(
    replacementId,
    requestId,
    "cancelled intent must not be replayed",
  );
  log(
    `human cancellation consumed ${requestId}; subsequent request is ${replacementId}`,
  );
  await herdr("agent", "prompt", pane, "/manager remove");
  await waitPane(/pending worktree removal requests/i);
  await herdr("pane", "send-keys", pane, "enter");
  await waitPane(/dismiss request/i);
  await herdr("pane", "send-keys", pane, "down", "enter");
  await waitFor("durable dismissal", () =>
    records().some(
      (record) =>
        record.type === "custom" &&
        record.data?.phase === "resolution" &&
        record.data?.requestId === replacementId &&
        record.data?.outcome === "dismissed",
    ),
  );
  assert.ok(
    existsSync(checkout) && existsSync(assignmentFile),
    "dismissal preserves checkout and assignment",
  );
  await turn([removal], "Request removal after dismissal.");
  const leaveId = outputs("remove_worktree").at(-1)?.details?.request_id;
  assert.equal(typeof leaveId, "string");
  assert.notEqual(leaveId, replacementId, "dismissed intent must not replay");
  await herdr("agent", "prompt", pane, "/manager leave");
  await waitFor("durable leave resolution", () =>
    records().some(
      (record) =>
        record.type === "custom" &&
        record.data?.phase === "resolution" &&
        record.data?.requestId === leaveId &&
        record.data?.outcome === "left",
    ),
  );
  await waitFor("Manager role left", () =>
    records().some(
      (record) =>
        record.type === "custom" &&
        record.customType === "pi-herdsman-role" &&
        record.data?.role === "lead",
    ),
  );
  const managerEntries = records().filter(
    (record) =>
      record.type === "custom" &&
      record.customType === "pi-herdsman-role" &&
      record.data?.role === "manager",
  ).length;
  await herdr("agent", "prompt", pane, "/manager");
  await waitFor(
    "Manager role re-entered",
    () =>
      records().filter(
        (record) =>
          record.type === "custom" &&
          record.customType === "pi-herdsman-role" &&
          record.data?.role === "manager",
      ).length > managerEntries,
  );
  await turn([removal], "Request removal after Manager re-entry.");
  const reentryId = outputs("remove_worktree").at(-1)?.details?.request_id;
  assert.equal(typeof reentryId, "string");
  assert.notEqual(
    reentryId,
    leaveId,
    "intent consumed on leave must not replay",
  );
  log(
    `branchless dismissal and leave/re-entry consumed exact IDs ${replacementId} and ${leaveId}`,
  );
  const repoKey = await realpath(
    run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const userConfig = join(agent, "pi-herdsman", "config.json");
  const approved = () =>
    existsSync(userConfig) &&
    JSON.parse(
      readFileSync(userConfig, "utf8"),
    ).worktreeRemovalPreapprovedRepos?.includes(repoKey) === true;
  const verifyEnablePrompt = (prompt: string) => {
    for (const required of [
      repoKey,
      "Type enable to confirm.",
      "Manager requests may remove assigned clean checkouts without another prompt.",
      "/manager remove-preapproval off",
    ])
      assert.ok(
        prompt.includes(required),
        `enable confirmation must show ${required}: ${prompt}`,
      );
  };
  await herdr("agent", "prompt", pane, "/manager remove-preapproval on");
  const enablePrompt = await waitPane(/type enable to confirm/i);
  verifyEnablePrompt(enablePrompt);
  log(`native preauthorization confirmation: ${JSON.stringify(enablePrompt)}`);
  await submit("enable");
  await waitFor("repository preauthorization", approved);
  assert.deepEqual(
    JSON.parse(readFileSync(userConfig, "utf8"))
      .worktreeRemovalPreapprovedRepos,
    [repoKey],
  );
  await herdr("agent", "prompt", pane, "/manager remove-preapproval off");
  await waitFor("repository preauthorization revocation", () => !approved());
  await turn([removal], "Request removal after permission revocation.");
  assert.equal(
    outputs("remove_worktree").at(-1)?.details?.pending,
    true,
    "revocation immediately restores review",
  );
  assert.ok(existsSync(checkout));
  await herdr("agent", "prompt", pane, "/manager settings");
  await waitPane(/worktree removal preauthorization: off/i);
  await herdr("pane", "send-keys", pane, "enter");
  const settingsPrompt = await waitPane(/type enable to confirm/i);
  verifyEnablePrompt(settingsPrompt);
  await submit("enable");
  await waitFor("Settings preauthorization", approved);
  await herdr("agent", "prompt", pane, "/manager settings");
  await waitPane(/worktree removal preauthorization: on/i);
  await herdr("pane", "send-keys", pane, "enter");
  await waitFor("Settings revocation", () => !approved());
  log(
    "native Manager Settings enabled and revoked repository preauthorization",
  );
  await herdr("agent", "prompt", pane, "/manager remove-preapproval on");
  verifyEnablePrompt(await waitPane(/type enable to confirm/i));
  await submit("enable");
  await waitFor("repository preauthorization", approved);
  await turn([removal], "Remove the explicitly assigned disposable checkout.");
  const removed = outputs("remove_worktree").at(-1);
  assert.equal(removed?.details?.ok, true, JSON.stringify(removed));
  assert.equal(
    removed?.details?.checkout_removed,
    true,
    JSON.stringify(removed),
  );
  assert.equal(
    removed?.details?.assignment_retired,
    true,
    JSON.stringify(removed),
  );
  assert.equal(removed?.details?.forced, false, JSON.stringify(removed));
  assert.equal(existsSync(checkout), false, "checkout physically removed");
  assert.equal(
    existsSync(assignmentFile),
    false,
    "exact current assignment retired",
  );
  assert.ok(existsSync(leadFile), "Lead conversation survives removal");
  assert.equal(
    run("git", ["branch", "--list", branch]),
    branch,
    "Git branch survives removal",
  );
  const after = await herdr("worktree", "list", "--workspace", workspace);
  const remainingWorktrees = after?.worktrees;
  assert.ok(
    Array.isArray(remainingWorktrees),
    "Herdr worktree inventory must be authoritative",
  );
  assert.ok(
    !remainingWorktrees.some(
      (item: { branch: string }) => item.branch === branch,
    ),
  );
  const workspaces = await herdr("workspace", "list");
  const remaining = workspaces?.workspaces;
  assert.ok(
    Array.isArray(remaining),
    "Herdr workspace inventory must be authoritative",
  );
  assert.ok(
    !remaining.some(
      (item: { workspace_id: string }) =>
        item.workspace_id === target.open_workspace_id,
    ),
    "removed checkout workspace must be absent",
  );
  log(
    `successful non-forced Herdr removal: checkout=${checkout} branch=${branch} conversation=${leadFile}; result=${JSON.stringify(removed.details)}`,
  );
} catch (error) {
  if (verified && pane) {
    try {
      log(`pane on failure: ${JSON.stringify(await paneText())}`);
    } catch (diagnosticError) {
      log(`pane diagnostic failed: ${String(diagnosticError)}`);
    }
  }
  throw error;
} finally {
  server.stop(true);
  if (herdrProcess && verified && herdrProcess.exitCode === null) {
    const stopped = Bun.spawnSync(
      ["herdr", "--session", sessionName, "server", "stop"],
      { env },
    );
    assert.equal(
      stopped.exitCode,
      0,
      `owned server stop failed: ${String(stopped.stderr)}; retained ${root}`,
    );
  } else if (herdrProcess && !verified && herdrProcess.exitCode === null)
    herdrProcess.kill();
  if (herdrProcess) {
    const exited = await Promise.race([
      herdrProcess.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    assert.ok(
      exited,
      `owned server did not exit; retained ${root}, session=${sessionName}, pid=${herdrProcess.pid}`,
    );
    log(
      `owned server exited pid=${herdrProcess.pid}, stderr=${JSON.stringify(await stderr)}`,
    );
  }
  await rm(root, { recursive: true, force: true });
  log(`removed owned temporary root ${root}`);
}
