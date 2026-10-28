import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  agentDefinitionDelegationEnabled,
  agentDefinitionMetadata,
  agentDefinitionEnabled,
  AGENT_COORDINATION_TOOLS,
  discoverAgent,
  discoverAgentDefinitions,
  discoverRoleDefinition,
  discoverRoleDefinitions,
  FLEXIBLE_LEAD_DEFINITION_NAME,
  ORCHESTRATOR_LEAD_DEFINITION_NAME,
  isReservedRoleDefinition,
  MANAGED_LEAD_DEFINITION_NAME,
  MANAGER_DEFINITION_NAME,
  CHIEF_DEFINITION_NAME,
  expandAgentBodyFiles,
  mergeFrontmatter,
  projectAgentDefinition,
  resolveChildModel,
  updateAgentOverride,
  validateAgentDefinitionReferences,
  writePrivatePromptSnapshots,
  type Frontmatter,
} from "./agent-definitions.ts";

function withPiAgentDir<T>(agentDir: string, callback: () => T): T {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return callback();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

function discoverAgentDefinitionsWithContents(content: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-invalid-agent-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  writeFileSync(join(agents, "custom.md"), content);
  return withPiAgentDir(root, () => discoverAgentDefinitions());
}

function assertPosixMode(path: string, expected: number): void {
  const actual = statSync(path).mode & 0o777;
  if (process.platform !== "win32") assert.equal(actual, expected);
}

test("bundled definition bodies do not prescribe coordination APIs", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-bundled-contracts-"));
  const definitions = withPiAgentDir(root, () => [
    ...discoverRoleDefinitions(),
    ...discoverAgentDefinitions(),
  ]);
  const contractToolNames = [
    ...AGENT_COORDINATION_TOOLS,
    "ask_owner",
    "message_supervisor",
    "list_peers",
    "message_peer",
    "list_staff",
    "inspect_staff",
    "read_staff_transcript",
    "message_staff",
    "delegate_project",
    "resume_project",
    "stop_lead",
    "remove_worktree",
  ];
  const contractPattern = new RegExp(
    `\\b(?:${contractToolNames.join("|")})\\b|\\.files\\b|retain:\\s*(?:true|false)`,
  );
  for (const { name, body } of definitions)
    assert.doesNotMatch(body, contractPattern, name);
});

test("fastMode is an optional boolean ordinary-Agent override", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-fast-mode-"));
  withPiAgentDir(root, () => {
    let definition = discoverAgent("reviewer");
    assert.equal(definition.frontmatter.fastMode, undefined);
    for (const value of [true, false, undefined]) {
      updateAgentOverride(definition, "fastMode", value);
      definition = discoverAgent("reviewer");
      assert.equal(definition.frontmatter.fastMode, value);
      assert.equal(agentDefinitionMetadata(definition).fastMode, value);
    }
  });
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        '---\nname: custom\nfastMode: "true"\n---\n',
      ),
    /field fastMode: must be a boolean/,
  );
  for (const name of [
    FLEXIBLE_LEAD_DEFINITION_NAME,
    ORCHESTRATOR_LEAD_DEFINITION_NAME,
    MANAGED_LEAD_DEFINITION_NAME,
    MANAGER_DEFINITION_NAME,
    CHIEF_DEFINITION_NAME,
  ]) {
    const roles = mkdtempSync(join(tmpdir(), "pi-herdsman-fast-role-"));
    mkdirSync(join(roles, "agents"));
    writeFileSync(
      join(roles, "agents", `${name}.md`),
      `---\nname: ${name}\nfastMode: false\n---\n`,
    );
    withPiAgentDir(roles, () =>
      assert.throws(() => discoverRoleDefinition(name), /fastMode/),
    );
  }
});

test("parses scalar frontmatter fields and applies defaults", () => {
  const definition = discoverAgentDefinitionsWithContents(
    "---\nname: custom\ninheritSkills: false\n---\n\nPrompt\n",
  ).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter, {
    name: "custom",
    inheritSkills: false,
    enabled: true,
  });
  assert.equal(definition.body, "Prompt");
  assert.deepEqual(
    discoverAgentDefinitionsWithContents(
      "---\nname: custom\nenabled: false\n---\nPrompt",
    ).find(({ name }) => name === "custom")?.frontmatter,
    { name: "custom", enabled: false },
  );
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        "---\nname: custom\ninheritSkills: yes\n---",
      ),
    /custom\.md agent custom field inheritSkills: must be a boolean/,
  );
  for (const value of ["yes", '"false"', "1", "null", "[]", "{}"]) {
    assert.throws(
      () =>
        discoverAgentDefinitionsWithContents(
          `---\nname: custom\nenabled: ${value}\n---`,
        ),
      /must be a boolean/,
    );
  }
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        "---\nname: custom\nenabled: yes\n---\n",
      ),
    /custom\.md agent custom field enabled: must be a boolean/,
  );

  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-enabled-default-"));
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").frontmatter.enabled),
    true,
  );
});

test("accepts a UTF-8 BOM before native YAML frontmatter", () => {
  const definition = discoverAgentDefinitionsWithContents(
    "\uFEFF---\nname: custom\nskills:\n  - one\n  - two\n---\n",
  ).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter.skills, ["one", "two"]);
});

test("parses native YAML capability arrays and rejects unsupported fields", () => {
  const definition = discoverAgentDefinitionsWithContents(`---
name: custom
tools: ["read", " grep "]
excludeTools: []
skills:
  - "./skills/local.md"
extensions:
  - "./extensions/local.ts"
agents:
  - "scout"
  - "reviewer"
---
Prompt`).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter, {
    name: "custom",
    tools: ["read", " grep "],
    excludeTools: [],
    skills: ["./skills/local.md"],
    extensions: ["./extensions/local.ts"],
    agents: ["scout", "reviewer"],
    enabled: true,
  });
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        '---\nname: custom\nsubagents: ["scout"]\n---',
      ),
    /is not a supported agent-definition field/,
  );
});

test("explicit tools are closed allowlists without Pi modifiers", () => {
  for (const tools of [["+read"], ["-write"], ["read,+bash"], ["read,-write"]])
    assert.throws(
      () =>
        discoverAgentDefinitionsWithContents(
          `---\nname: custom\ntools: [${tools.map((tool) => JSON.stringify(tool)).join(", ")}]\n---`,
        ),
      /must be an allowlist without \+name\/-name modifiers/,
    );
});

test("loads multiline flow arrays and preserves compact arrays", () => {
  const definition = discoverAgentDefinitionsWithContents(`---
name: custom
skills:
  [
    "~/.agents/skills/ego-browser/SKILL.md",
    "~/Coding/AI/agent-skills/skills/backlog/SKILL.md",
    "~/Coding/AI/agent-skills/skills/gh-github/SKILL.md",
  ]
extensions:
  [
    "~/.pi/agent/npm/node_modules/@howaboua/pi-codex-conversion/dist/index.js",
    "~/.pi/agent/extensions/agents-md-imports.ts",
  ]
tools: ["read", "grep"]
---
Prompt`).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter.skills, [
    "~/.agents/skills/ego-browser/SKILL.md",
    "~/Coding/AI/agent-skills/skills/backlog/SKILL.md",
    "~/Coding/AI/agent-skills/skills/gh-github/SKILL.md",
  ]);
  assert.deepEqual(definition.frontmatter.extensions, [
    "~/.pi/agent/npm/node_modules/@howaboua/pi-codex-conversion/dist/index.js",
    "~/.pi/agent/extensions/agents-md-imports.ts",
  ]);
  assert.deepEqual(definition.frontmatter.tools, ["read", "grep"]);
});

test("reports malformed YAML with the source definition path", () => {
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents("---\nname: custom\nskills: [\n---"),
    /custom\.md:/,
  );
});

test("requires a YAML mapping as the frontmatter root", () => {
  assert.throws(
    () => discoverAgentDefinitionsWithContents("---\n- foo\n- bar\n---"),
    /custom\.md: frontmatter must be a YAML mapping/,
  );
});

test("preserves opaque permission mappings", () => {
  const definition = discoverAgentDefinitionsWithContents(
    `---
name: custom
permission:
  "*": deny
  read: allow
  bash:
    "*": deny
    "git status": allow
---
`,
  ).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter.permission, {
    "*": "deny",
    read: "allow",
    bash: { "*": "deny", "git status": "allow" },
  });
});

test("resolves whole-line body file references from their definition", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-body-files-"));
  const agents = join(root, "agents");
  const prompts = join(root, "prompts");
  mkdirSync(agents);
  const definitionPath = join(agents, "custom.md");
  const absolutePath = join(root, "absolute.md");
  mkdirSync(prompts);
  writeFileSync(join(prompts, "one.md"), "one");
  writeFileSync(
    definitionPath,
    `---\nname: custom\n---\nBefore\n@../prompts/one.md\n@./custom.md\n@~/prompts/home.md\n@${absolutePath}\nAfter\n@example`,
  );
  const definition = withPiAgentDir(root, () => discoverAgent("custom"));
  assert.equal(
    definition.body,
    `Before\n@${join(prompts, "one.md")}\n@${join(agents, "custom.md")}\n@${join(homedir(), "prompts", "home.md")}\n@${absolutePath}\nAfter\n@example`,
  );
});

test(
  "resolves native Windows body file reference forms",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-herdsman-windows-body-files-"));
    const agents = join(root, "agents");
    const prompts = join(root, "prompts");
    mkdirSync(agents);
    mkdirSync(prompts);
    const definitionPath = join(agents, "custom.md");
    writeFileSync(join(prompts, "one.md"), "one");
    writeFileSync(
      definitionPath,
      `---\nname: custom\n---\nBefore\n@..\\prompts\\one.md\n@.\\custom.md\n@~\\prompts\\home.md\n@C:\\work\\prompt.md\n@\\rooted\\prompt.md\n@\\\\server\\share\\prompt.md\nAfter\n@example`,
    );
    const definition = withPiAgentDir(root, () => discoverAgent("custom"));
    assert.equal(
      definition.body,
      `Before\n@${join(prompts, "one.md")}\n@${join(agents, "custom.md")}\n@${join(homedir(), "prompts", "home.md")}\n@C:\\work\\prompt.md\n@\\rooted\\prompt.md\n@\\\\server\\share\\prompt.md\nAfter\n@example`,
    );
  },
);

test("normalizes home-relative references in project and global definitions", () => {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-project-agents-"));
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-global-agents-"));
  const projectAgentDir = join(project, ".pi", "agents");
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgentDir, { recursive: true });
  mkdirSync(globalAgents);
  writeFileSync(
    join(projectAgentDir, "project.md"),
    "---\nname: project\n---\n@~/project.md",
  );
  writeFileSync(
    join(globalAgents, "global.md"),
    "---\nname: global\n---\n@~/global.md",
  );

  const definitions = withPiAgentDir(global, () =>
    discoverAgentDefinitions({ projectRoot: project }),
  );
  assert.equal(
    definitions.find(({ name }) => name === "project")?.body,
    `@${join(homedir(), "project.md")}`,
  );
  assert.equal(
    definitions.find(({ name }) => name === "global")?.body,
    `@${join(homedir(), "global.md")}`,
  );
});

test("leaves unsupported home and shell-looking references unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-body-reference-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  writeFileSync(
    join(agents, "custom.md"),
    "---\nname: custom\n---\n@~user/file\n@$HOME/file\n@${HOME}/file\ninline @~/file",
  );

  assert.equal(
    withPiAgentDir(root, () => discoverAgent("custom")).body,
    "@~user/file\n@$HOME/file\n@${HOME}/file\ninline @~/file",
  );
});

test("merges scalars, arrays, and false values", () => {
  assert.deepEqual(
    mergeFrontmatter(
      {
        name: "agent",
        model: "base/model",
        noTools: true,
        tools: ["read"],
        skills: ["base"],
      },
      {
        name: "agent",
        model: "override/model",
        noTools: false,
        tools: [],
        skills: ["override"],
      },
    ),
    {
      name: "agent",
      model: "override/model",
      noTools: false,
      tools: [],
      skills: ["override"],
    },
  );
});

test("rejects malformed capability fields", () => {
  for (const [field, value, message] of [
    ["tools", '"read"', /must be an array/],
    ["skills", '["ok", 1]', /must be an array/],
    ["extensions", '[""]', /must be an array/],
    [
      "systemPromptFiles",
      '["prompt.md"]',
      /is not a supported agent-definition field/,
    ],
    ["tools", '["   "]', /must be an array/],
    ["agents", '"scout"', /must be an array/],
    ["agents", '["scout", 1]', /must be an array/],
    ["agents", '["   "]', /must be an array/],
    [
      "agents",
      '["scout", "scout"]',
      /must be an array of unique non-empty strings/,
    ],
    ["noTools", '"true"', /must be a boolean/],
    ["noBuiltinTools", "yes", /must be a boolean/],
    ["noSkills", "1", /must be a boolean/],
    ["noExtensions", '"false"', /must be a boolean/],
    ["enabled", '"false"', /must be a boolean/],
    ["enabled", "yes", /must be a boolean/],
    ["enabled", "1", /must be a boolean/],
    ["enabled", "null", /must be a boolean/],
    ["permission", "allow", /must be a mapping/],
    ["inheritGlobalContext", '"false"', /must be a boolean/],
    ["inheritGlobalContext", "1", /must be a boolean/],
    ["inheritGlobalContext", "yes", /must be a boolean/],
  ] as const)
    assert.throws(
      () =>
        discoverAgentDefinitionsWithContents(
          `---\nname: custom\n${field}: ${value}\n---`,
        ),
      message,
    );
  for (const [field, value, message] of [
    ["model", "[]", /model.*must be a non-empty string/],
    ["model", "false", /model.*must be a non-empty string/],
    ["thinking", "1", /thinking.*must be one of/],
    [
      "systemPromptMode",
      "false",
      /systemPromptMode.*must be append or replace/,
    ],
    ["bodyMode", "merge", /bodyMode.*must be append or replace/],
    [
      "agents",
      "[\n  scout,\n  scout,\n]",
      /must be an array of unique non-empty strings/,
    ],
  ] as const)
    assert.throws(
      () =>
        discoverAgentDefinitionsWithContents(
          `---\nname: custom\n${field}: ${value}\n---\n`,
        ),
      message,
    );
});

test("discovers the five portable bundled definitions without a user agents directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-agents-"));
  assert.deepEqual(
    withPiAgentDir(root, () =>
      discoverAgentDefinitions().map((definition) => definition.name),
    ),
    ["generalist", "implementer", "researcher", "reviewer", "scout"],
  );
});

test("reserves the layered managed Lead definition outside the Agent roster", () => {
  const project = mkdtempSync(
    join(tmpdir(), "pi-herdsman-managed-lead-project-"),
  );
  const projectAgents = join(project, ".pi", "agents");
  const global = mkdtempSync(
    join(tmpdir(), "pi-herdsman-managed-lead-global-"),
  );
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgents, { recursive: true });
  mkdirSync(globalAgents);

  const bundled = withPiAgentDir(global, () =>
    discoverRoleDefinition(MANAGED_LEAD_DEFINITION_NAME),
  );
  assert.equal(bundled.name, "managed-lead");
  assert.deepEqual(bundled.frontmatter.tools, []);
  assert.equal(bundled.frontmatter.systemPromptMode, "append");
  assert.equal(bundled.frontmatter.inheritProjectContext, true);
  assert.equal(bundled.frontmatter.inheritGlobalContext, true);
  assert.equal(bundled.frontmatter.enabled, undefined);
  assert.match(bundled.body, /Delegate bounded project execution/);
  assert.equal(
    withPiAgentDir(global, () =>
      discoverAgentDefinitions().some(({ name }) => name === "managed-lead"),
    ),
    false,
  );
  assert.throws(
    () => withPiAgentDir(global, () => discoverAgent("managed-lead")),
    /agent managed-lead not found/,
  );

  const projectPath = join(projectAgents, "managed-lead.md");
  const globalPath = join(globalAgents, "managed-lead.md");
  writeFileSync(
    projectPath,
    '---\nname: managed-lead\ntools: ["read", "grep"]\nbodyMode: append\n---\nProject policy',
  );
  writeFileSync(
    globalPath,
    "---\nname: managed-lead\nthinking: high\nbodyMode: append\n---\nGlobal policy",
  );
  const effective = withPiAgentDir(global, () =>
    discoverRoleDefinition(MANAGED_LEAD_DEFINITION_NAME, {
      projectRoot: project,
    }),
  );
  assert.deepEqual(effective.frontmatter.tools, ["read", "grep"]);
  assert.equal(effective.frontmatter.thinking, "high");
  assert.equal(
    effective.body,
    `${bundled.body}\n\nProject policy\n\nGlobal policy`,
  );
  assert.equal(effective.projectSource, projectPath);
  assert.equal(effective.overrideSource, globalPath);

  writeFileSync(
    globalPath,
    "---\nname: managed-lead\nbodyMode: replace\n---\nCustom strategy",
  );
  const replaced = withPiAgentDir(global, () =>
    discoverRoleDefinition(MANAGED_LEAD_DEFINITION_NAME, {
      projectRoot: project,
    }),
  );
  assert.equal(replaced.body, "Custom strategy");
  assert.equal(replaced.frontmatter.systemPromptMode, "append");

  writeFileSync(projectPath, "---\nname: managed-lead\nenabled: false\n---");
  writeFileSync(globalPath, "---\nname: managed-lead\nthinking: high\n---");
  assert.throws(
    () =>
      withPiAgentDir(global, () =>
        discoverRoleDefinition(MANAGED_LEAD_DEFINITION_NAME, {
          projectRoot: project,
        }),
      ),
    new RegExp(projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  writeFileSync(
    join(globalAgents, "bad.md"),
    '---\nname: bad\nagents: ["managed-lead"]\n---',
  );
  assert.throws(
    () => withPiAgentDir(global, () => discoverAgentDefinitions()),
    /agent bad references missing agent definition managed-lead/,
  );
  unlinkSync(join(globalAgents, "bad.md"));

  for (const [field, value] of [
    ["enabled", "false"],
    ["agents", '["scout"]'],
    ["permission", '{ "*": "deny" }'],
  ] as const) {
    writeFileSync(
      globalPath,
      `---\nname: managed-lead\n${field}: ${value}\n---`,
    );
    assert.throws(
      () =>
        withPiAgentDir(global, () =>
          discoverRoleDefinition(MANAGED_LEAD_DEFINITION_NAME),
        ),
      new RegExp(`managed Lead field ${field}: is not supported`),
    );
  }
  writeFileSync(
    globalPath,
    "---\nname: managed-lead\nsystemPromptMode: replace\n---",
  );
  assert.throws(
    () =>
      withPiAgentDir(global, () =>
        discoverRoleDefinition(MANAGED_LEAD_DEFINITION_NAME),
      ),
    new RegExp(
      `${globalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} managed Lead field systemPromptMode: must be append`,
    ),
  );
});

test("reserves independent runtime role profiles with narrow fields", () => {
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-lead-profiles-"));
  const agents = join(global, "agents");
  mkdirSync(agents);
  const names = withPiAgentDir(global, () =>
    discoverRoleDefinitions().map(({ name }) => name),
  );
  assert.deepEqual(names, [
    FLEXIBLE_LEAD_DEFINITION_NAME,
    ORCHESTRATOR_LEAD_DEFINITION_NAME,
    MANAGED_LEAD_DEFINITION_NAME,
    MANAGER_DEFINITION_NAME,
    CHIEF_DEFINITION_NAME,
  ]);
  assert.equal(isReservedRoleDefinition("orchestrator-lead"), true);
  assert.equal(isReservedRoleDefinition("manager"), true);
  assert.equal(isReservedRoleDefinition("chief"), true);
  assert.equal(isReservedRoleDefinition("agent"), false);
  assert.equal(
    withPiAgentDir(global, () =>
      discoverAgentDefinitions().some(({ name }) =>
        names.includes(name as any),
      ),
    ),
    false,
  );
  const [flexible, orchestrator] = withPiAgentDir(global, () =>
    discoverRoleDefinitions(),
  );
  assert.equal(flexible!.frontmatter.tools, undefined);
  assert.deepEqual(orchestrator!.frontmatter.tools, []);
  writeFileSync(
    join(agents, "orchestrator-lead.md"),
    "---\nname: orchestrator-lead\nbodyMode: replace\n---\nCustom strategy",
  );
  const replaced = withPiAgentDir(global, () =>
    discoverRoleDefinition(ORCHESTRATOR_LEAD_DEFINITION_NAME),
  );
  assert.equal(replaced.body, "Custom strategy");
  assert.deepEqual(replaced.frontmatter.tools, orchestrator!.frontmatter.tools);
  assert.deepEqual(
    withPiAgentDir(
      global,
      () => discoverRoleDefinition("manager").frontmatter.tools,
    ),
    [],
  );
  assert.deepEqual(
    withPiAgentDir(
      global,
      () => discoverRoleDefinition("chief").frontmatter.tools,
    ),
    [],
  );
  const managed = withPiAgentDir(global, () =>
    discoverRoleDefinition(MANAGED_LEAD_DEFINITION_NAME),
  );
  for (const definition of [orchestrator!, managed]) {
    assert.match(definition.body, /non-overlapping execution scopes/);
    assert.match(definition.body, /independent assignments in parallel/);
    assert.match(
      definition.body,
      /dependent\s+assignments only after their prerequisites resolve/,
    );
  }
  for (const [field, value] of [
    ["model", '"provider/model"'],
    ["thinking", '"low"'],
    ["systemPromptMode", '"append"'],
    ["noTools", "false"],
    ["extensions", '["custom"]'],
    ["skills", '["custom"]'],
    ["inheritGlobalContext", "false"],
  ]) {
    writeFileSync(
      join(agents, "orchestrator-lead.md"),
      `---\nname: orchestrator-lead\n${field}: ${value}\n---\n`,
    );
    assert.throws(
      () => withPiAgentDir(global, () => discoverRoleDefinitions()),
      new RegExp(`orchestrator-lead field ${field}: is not supported`),
    );
  }
});

test("Manager and Chief overlays use reserved runtime-profile scope", () => {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-role-project-"));
  const projectAgents = join(project, ".pi", "agents");
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-role-global-"));
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgents, { recursive: true });
  mkdirSync(globalAgents);
  const managerProject = join(projectAgents, "manager.md");
  const managerGlobal = join(globalAgents, "manager.md");
  const chiefGlobal = join(globalAgents, "chief.md");
  writeFileSync(
    managerProject,
    "---\nname: manager\nbodyMode: append\n---\nProject manager guidance",
  );
  writeFileSync(
    managerGlobal,
    "---\nname: manager\nbodyMode: append\n---\nGlobal manager guidance",
  );
  writeFileSync(
    chiefGlobal,
    "---\nname: chief\nbodyMode: append\n---\nGlobal chief guidance",
  );
  const manager = withPiAgentDir(global, () =>
    discoverRoleDefinition("manager", { projectRoot: project }),
  );
  assert.deepEqual(manager.frontmatter.tools, []);
  assert.match(manager.body, /Project manager guidance/);
  assert.match(manager.body, /Global manager guidance/);
  const chief = withPiAgentDir(global, () => discoverRoleDefinition("chief"));
  assert.match(chief.body, /Global chief guidance/);
  writeFileSync(
    managerProject,
    "---\nname: manager\nbodyMode: replace\n---\nCustom Manager strategy",
  );
  unlinkSync(managerGlobal);
  writeFileSync(
    chiefGlobal,
    "---\nname: chief\nbodyMode: replace\n---\nCustom Chief strategy",
  );
  const replacedManager = withPiAgentDir(global, () =>
    discoverRoleDefinition("manager", { projectRoot: project }),
  );
  const replacedChief = withPiAgentDir(global, () =>
    discoverRoleDefinition("chief"),
  );
  assert.equal(replacedManager.body, "Custom Manager strategy");
  assert.equal(replacedChief.body, "Custom Chief strategy");
  assert.deepEqual(replacedManager.frontmatter.tools, []);
  assert.deepEqual(replacedChief.frontmatter.tools, []);
  writeFileSync(
    join(projectAgents, "chief.md"),
    "---\nname: chief\n---\nProject chief guidance",
  );
  assert.throws(
    () =>
      withPiAgentDir(global, () =>
        discoverRoleDefinition("chief", { projectRoot: project }),
      ),
    /chief definition: project overrides are not supported; configure chief globally instead/,
  );
  for (const name of ["manager", "chief"] as const)
    for (const field of ["model", "thinking", "systemPromptMode", "skills"]) {
      writeFileSync(
        join(globalAgents, `${name}.md`),
        `---\nname: ${name}\n${field}: ${field === "skills" || field === "agents" ? '["scout"]' : field === "systemPromptMode" ? '"append"' : '"low"'}\n---\n`,
      );
      assert.throws(
        () => withPiAgentDir(global, () => discoverRoleDefinition(name)),
        new RegExp(`${name} field ${field}: is not supported`),
      );
    }
});

test("Manager and Chief agent allowlists validate effective targets", () => {
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-supervisor-agents-"));
  const agents = join(global, "agents");
  mkdirSync(agents);
  writeFileSync(
    join(agents, "manager.md"),
    "---\nname: manager\nagents: [scout, disabled-helper]\n---\n",
  );
  writeFileSync(
    join(agents, "chief.md"),
    "---\nname: chief\nagents: [reviewer]\n---\n",
  );
  writeFileSync(
    join(agents, "disabled-helper.md"),
    "---\nname: disabled-helper\nenabled: false\n---\n",
  );

  withPiAgentDir(global, () => {
    assert.deepEqual(discoverRoleDefinition("manager").frontmatter.agents, [
      "scout",
      "disabled-helper",
    ]);
    assert.deepEqual(discoverRoleDefinition("chief").frontmatter.agents, [
      "reviewer",
    ]);

    writeFileSync(
      join(agents, "manager.md"),
      "---\nname: manager\nagents: [missing]\n---\n",
    );
    assert.throws(
      () => discoverRoleDefinition("manager"),
      /agent manager references missing agent definition missing/,
    );
    writeFileSync(
      join(agents, "manager.md"),
      "---\nname: manager\nagents: [chief]\n---\n",
    );
    assert.throws(
      () => discoverRoleDefinition("manager"),
      /agent manager references reserved agent definition chief/,
    );
    writeFileSync(
      join(agents, "orchestrator-lead.md"),
      "---\nname: orchestrator-lead\nagents: [scout]\n---\n",
    );
    assert.throws(
      () => discoverRoleDefinition("manager"),
      /orchestrator-lead field agents: is not supported/,
    );
  });
});

test("supervisor allowlists use effective overlays and layered Agent targets", () => {
  const project = mkdtempSync(
    join(tmpdir(), "pi-herdsman-supervisor-project-"),
  );
  const projectAgents = join(project, ".pi", "agents");
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-supervisor-global-"));
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgents, { recursive: true });
  mkdirSync(globalAgents);
  writeFileSync(
    join(projectAgents, "manager.md"),
    "---\nname: manager\nagents: [missing-project-target]\n---\n",
  );
  writeFileSync(
    join(globalAgents, "manager.md"),
    "---\nname: manager\nagents: [project-helper]\n---\n",
  );
  writeFileSync(
    join(globalAgents, "chief.md"),
    "---\nname: chief\nagents: [project-helper]\n---\n",
  );
  const projectHelperPath = join(projectAgents, "project-helper.md");
  writeFileSync(
    projectHelperPath,
    "---\nname: project-helper\n---\nProject helper",
  );

  withPiAgentDir(global, () => {
    const manager = discoverRoleDefinition("manager", { projectRoot: project });
    const chief = discoverRoleDefinition("chief", { projectRoot: project });
    assert.deepEqual(manager.frontmatter.agents, ["project-helper"]);
    assert.deepEqual(chief.frontmatter.agents, ["project-helper"]);
    const helper = discoverAgentDefinitions({ projectRoot: project }).find(
      ({ name }) => name === "project-helper",
    );
    assert.equal(helper?.projectSource, projectHelperPath);
  });
});

test("bundled definitions carry portable capabilities and role contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-bundled-prompts-"));
  const definitions = withPiAgentDir(root, () => discoverAgentDefinitions());
  const expectedTools = new Map([
    ["implementer", ["read", "bash", "edit", "write"]],
    ["researcher", ["read", "glob", "grep", "web_search"]],
    ["reviewer", ["read", "glob", "grep"]],
    ["scout", ["read", "glob", "grep"]],
    ["generalist", ["read", "bash", "edit", "write"]],
  ]);
  const expectedDescriptions = new Map([
    [
      "scout",
      "Read-only codebase reconnaissance for unfamiliar areas; use to find entry points, trace flows, dependencies, constraints, and risks before deciding or editing",
    ],
    [
      "researcher",
      "External research specialist for questions that require web, documentation, standards, vendor, or other authoritative evidence beyond the repository; use for current facts, API behavior, comparisons, and source-backed recommendations",
    ],
    [
      "implementer",
      "Focused implementation agent for a resolved change; use when the required behavior is already decided and the task is to edit, test, and report",
    ],
    [
      "reviewer",
      "Independent read-only internal team reviewer for plans, diffs, implementations, and codebase health; use for verification, missing cases, and regressions, not user or supervisor approval",
    ],
    [
      "generalist",
      "General-purpose execution agent for bounded tasks requiring broad capabilities",
    ],
  ]);
  const required = withPiAgentDir(
    root,
    () =>
      new Map(
        ["generalist", "implementer", "researcher", "reviewer", "scout"].map(
          (name) =>
            [name, discoverAgent(name).body.replaceAll(/\s+/g, " ")] as const,
        ),
      ),
  );
  assert.equal(required.size, 5);
  for (const definition of definitions) {
    assert.equal(definition.frontmatter.systemPromptMode, "append");
    assert.notEqual(definition.body.trim(), "");
    assert.equal(
      definition.frontmatter.description,
      expectedDescriptions.get(definition.name),
    );
    assert.equal(
      agentDefinitionMetadata(definition).description,
      expectedDescriptions.get(definition.name),
    );
    assert.deepEqual(
      definition.frontmatter.tools,
      expectedTools.get(definition.name),
    );
    assert.deepEqual(definition.frontmatter.skills, []);
    if (definition.name === "researcher")
      assert.equal(definition.frontmatter.extensions, undefined);
    else assert.deepEqual(definition.frontmatter.extensions, []);
    assert.doesNotMatch(
      readFileSync(definition.path, "utf8"),
      /(?:\/(?:Users|home)\/|[A-Za-z]:\\Users\\)[^/\\\s]+/,
    );
    if (definition.frontmatter.agents?.length)
      assert.doesNotMatch(
        readFileSync(definition.path, "utf8"),
        /tools:.*agent/,
      );
    assert.doesNotMatch(
      definition.body,
      /\b(exec|wait|mcp)\b|tools\.|Ponytail|Code Mode/i,
    );
  }
  assert.match(required.get("implementer")!, /scoped edits and validation/);
  assert.match(required.get("generalist")!, /smallest complete action/);
  assert.match(required.get("reviewer")!, /strictly read-only/);
  assert.match(required.get("reviewer")!, /conduct internal reviews/);
  assert.match(required.get("reviewer")!, /preserve its origin/);
  assert.match(required.get("scout")!, /read-only codebase reconnaissance/);
  assert.match(
    required.get("researcher")!,
    /prefer official and primary sources.*active capabilities/i,
  );
  assert.match(required.get("researcher")!, /Do not mutate files/);
  for (const name of ["generalist", "implementer", "reviewer"])
    assert.doesNotMatch(required.get(name)!, /delegate|orchestrat/i);
  assert.equal(
    definitions.filter((definition) => required.has(definition.name)).length,
    5,
  );
});

test("does not bundle the operator-local MCP runner", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-mcp-runner-agent-"));
  assert.deepEqual(
    withPiAgentDir(root, () =>
      discoverAgentDefinitions().map(({ name }) => name),
    ),
    ["generalist", "implementer", "researcher", "reviewer", "scout"],
  );
  assert.throws(
    () => withPiAgentDir(root, () => discoverAgent("mcp-runner")),
    /agent mcp-runner not found/,
  );
});

test("composes matching bundled bodies with bodyMode", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-body-mode-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  const base = withPiAgentDir(root, () => discoverAgent("scout").body);

  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\n---\nCustom scout instructions.",
  );
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").body),
    "Custom scout instructions.",
  );

  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\nbodyMode: replace\n---\nReplacement.",
  );
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").body),
    "Replacement.",
  );

  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\nbodyMode: append\n---\nAdditional instructions.",
  );
  const appended = withPiAgentDir(root, () => discoverAgent("scout"));
  assert.equal(appended.body, `${base}\n\nAdditional instructions.`);
  assert.equal(appended.frontmatter.bodyMode, undefined);

  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\nbodyMode: append\n---\n",
  );
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").body),
    base,
  );
  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\nbodyMode: replace\n---\n",
  );
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").body),
    base,
  );
  const promptRoot = mkdtempSync(
    join(tmpdir(), "pi-herdsman-body-mode-prompt-"),
  );
  const promptAgents = join(promptRoot, "agents");
  mkdirSync(promptAgents);
  writeFileSync(
    join(promptAgents, "scout.md"),
    "---\nname: scout\nbodyMode: append\nsystemPromptMode: append\n---\nExtra.",
  );
  const definition = withPiAgentDir(promptRoot, () => discoverAgent("scout"));
  assert.equal(definition.frontmatter.bodyMode, undefined);
  assert.equal(definition.frontmatter.systemPromptMode, "append");
  assert.match(definition.body, /\n\nExtra\.$/);
  const invalidRoot = mkdtempSync(
    join(tmpdir(), "pi-herdsman-body-mode-invalid-"),
  );
  const invalidAgents = join(invalidRoot, "agents");
  mkdirSync(invalidAgents);
  const overridePath = join(invalidAgents, "scout.md");
  writeFileSync(overridePath, "---\nname: scout\nbodyMode: merge\n---\nExtra.");
  assert.throws(
    () => withPiAgentDir(invalidRoot, () => discoverAgent("scout")),
    new RegExp(
      `${overridePath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")} agent scout field bodyMode: must be append or replace`,
    ),
  );
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        "---\nname: custom\nbodyMode: append\n---\nCustom",
      ),
    /custom\.md agent custom field bodyMode: only valid when overlaying an existing agent/,
  );
});

test("discovers project definitions and gives global overlays final precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-project-agents-"));
  const projectAgentDir = join(root, ".pi", "agents");
  mkdirSync(projectAgentDir, { recursive: true });
  writeFileSync(
    join(projectAgentDir, "project.md"),
    "---\nname: project-only\nmodel: project-model\n---\nProject policy",
  );
  const globalRoot = mkdtempSync(join(tmpdir(), "pi-herdsman-project-global-"));
  const globalAgents = join(globalRoot, "agents");
  mkdirSync(globalAgents);
  writeFileSync(
    join(globalAgents, "project.md"),
    "---\nname: project-only\nmodel: global-model\n---\nGlobal policy",
  );
  const definition = withPiAgentDir(globalRoot, () =>
    discoverAgent("project-only", { projectRoot: root }),
  );
  assert.equal(definition.frontmatter.model, "global-model");
  assert.equal(definition.projectSource, join(projectAgentDir, "project.md"));
  assert.equal(definition.overrideSource, join(globalAgents, "project.md"));
  assert.equal(definition.body, "Global policy");
});

test("follows symlinked definitions so dotfile-managed overlays apply", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-symlink-agents-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  const target = join(root, "scout-disabled.md");
  writeFileSync(target, "---\nname: scout\nenabled: false\n---\n");
  symlinkSync(target, join(agents, "scout.md"));
  withPiAgentDir(root, () => {
    const scout = discoverAgent("scout");
    assert.equal(agentDefinitionEnabled(scout), false);
    assert.equal(scout.overrideSource, join(agents, "scout.md"));
    symlinkSync(join(root, "missing.md"), join(agents, "broken.md"));
    assert.throws(() => discoverAgentDefinitions(), /ENOENT.*broken\.md/);
  });
});

test("project discovery tolerates a missing directory and rejects a file", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-project-root-"));
  withPiAgentDir(root, () => {
    assert.deepEqual(
      discoverAgentDefinitions({ projectRoot: root }).some(
        (d) => d.projectSource,
      ),
      false,
    );
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "agents"), "not a directory");
    assert.throws(
      () => discoverAgentDefinitions({ projectRoot: root }),
      /agent directory is not a directory/,
    );
  });
});

test("composes all definition layers with provenance and whole-array replacement", () => {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-layered-project-"));
  const projectAgentDir = join(project, ".pi", "agents");
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-layered-global-"));
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgentDir, { recursive: true });
  mkdirSync(globalAgents);
  const bundled = withPiAgentDir(global, () => discoverAgent("reviewer"));
  const projectPath = join(projectAgentDir, "reviewer.md");
  const globalPath = join(globalAgents, "reviewer.md");
  writeFileSync(
    projectPath,
    '---\nname: reviewer\nmodel: project/model\ntools: ["read", "grep"]\nbodyMode: append\n---\nProject policy',
  );
  writeFileSync(
    globalPath,
    '---\nname: reviewer\nmodel: global/model\nthinking: high\ntools: ["read"]\nbodyMode: append\n---\nGlobal policy',
  );
  const effective = withPiAgentDir(global, () =>
    discoverAgent("reviewer", { projectRoot: project }),
  );
  assert.equal(effective.frontmatter.model, "global/model");
  assert.equal(effective.frontmatter.thinking, "high");
  assert.deepEqual(effective.frontmatter.tools, ["read"]);
  assert.equal(
    effective.body,
    `${bundled.body}\n\nProject policy\n\nGlobal policy`,
  );
  assert.equal(effective.extensionSource, bundled.path);
  assert.equal(effective.projectSource, projectPath);
  assert.equal(effective.overrideSource, globalPath);
});

test("project body modes, duplicate names, body-file provenance, and child validation use the shared engine", () => {
  const project = mkdtempSync(
    join(tmpdir(), "pi-herdsman-project-validation-"),
  );
  const projectAgentDir = join(project, ".pi", "agents");
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-global-validation-"));
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgentDir, { recursive: true });
  mkdirSync(globalAgents);

  const standalone = join(projectAgentDir, "standalone.md");
  writeFileSync(
    standalone,
    "---\nname: standalone\nbodyMode: append\n---\nbody",
  );
  assert.throws(
    () => discoverAgentDefinitions({ projectRoot: project }),
    new RegExp(
      `${standalone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*bodyMode`,
    ),
  );
  unlinkSync(standalone);

  writeFileSync(
    join(projectAgentDir, "child.md"),
    "---\nname: child\n---\nchild",
  );
  writeFileSync(
    join(projectAgentDir, "parent.md"),
    '---\nname: parent\nagents: ["child"]\n---\nparent',
  );
  writeFileSync(
    join(projectAgentDir, "body.md"),
    "---\nname: scout\nbodyMode: append\n---\n@./policy.txt",
  );
  writeFileSync(join(projectAgentDir, "policy.txt"), "project policy");
  writeFileSync(
    join(globalAgents, "body.md"),
    "---\nname: scout\nbodyMode: append\n---\n@./policy.txt",
  );
  writeFileSync(join(globalAgents, "policy.txt"), "global policy");
  const definitions = withPiAgentDir(global, () =>
    discoverAgentDefinitions({ projectRoot: project }),
  );
  const body = definitions.find((definition) => definition.name === "scout")!;
  assert.match(
    body.body,
    new RegExp(
      join(projectAgentDir, "policy.txt").replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      ),
    ),
  );
  assert.match(
    body.body,
    new RegExp(
      join(globalAgents, "policy.txt").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
  validateAgentDefinitionReferences(
    definitions.find((definition) => definition.name === "parent")!,
    definitions,
  );
  assert.equal(
    definitions.find((definition) => definition.name === "parent")!
      .projectSource,
    join(projectAgentDir, "parent.md"),
  );

  const duplicate = join(projectAgentDir, "nested");
  mkdirSync(duplicate);
  writeFileSync(
    join(duplicate, "child.md"),
    "---\nname: child\n---\nduplicate",
  );
  assert.throws(
    () => discoverAgentDefinitions({ projectRoot: project }),
    /multiple definitions found for agent child/,
  );
});

test("overlays a bundled definition and extends the roster", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-agents-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  const overridePath = join(agents, "implementer.md");
  const override =
    "---\nname: implementer\ndescription: User implementation\nnoTools: true\n---\nUser prompt";
  writeFileSync(overridePath, override);
  writeFileSync(
    join(agents, "custom.md"),
    '---\nname: custom\nagents: ["researcher"]\n---\nCustom prompt',
  );

  withPiAgentDir(root, () => {
    const definitions = discoverAgentDefinitions();
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      [
        "custom",
        "generalist",
        "implementer",
        "researcher",
        "reviewer",
        "scout",
      ],
    );
    const implementer = discoverAgent("implementer");
    assert.equal(implementer.path, overridePath);
    assert.match(
      implementer.extensionSource!.split(sep).join("/"),
      /extension\/agent-definitions\/implementer\.md$/,
    );
    assert.equal(implementer.overrideSource, overridePath);
    assert.equal(implementer.frontmatter.description, "User implementation");
    assert.equal(implementer.frontmatter.model, undefined);
    assert.equal(implementer.frontmatter.noTools, true);
    assert.equal(implementer.frontmatter.noSkills, true);
    assert.equal(implementer.body, "User prompt");
  });
});

test("merges enabled overrides and validates disabled children without hiding the root roster", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-enabled-override-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  writeFileSync(
    join(agents, "reviewer.md"),
    "---\nname: reviewer\nenabled: false\n---\n",
  );
  writeFileSync(
    join(agents, "parent.md"),
    '---\nname: parent\nagents: ["reviewer"]\n---\nParent',
  );

  withPiAgentDir(root, () => {
    const definitions = discoverAgentDefinitions();
    const reviewer = definitions.find(({ name }) => name === "reviewer")!;
    const parent = definitions.find(({ name }) => name === "parent")!;
    assert.equal(reviewer.frontmatter.enabled, false);
    assert.equal(agentDefinitionEnabled(reviewer), false);
    assert.equal(agentDefinitionMetadata(reviewer).enabled, false);
    assert.throws(
      () => validateAgentDefinitionReferences(parent, definitions),
      /agent parent references disabled agent definition reviewer; enable reviewer/,
    );
    assert.equal(
      definitions.some(({ name }) => name === "reviewer"),
      true,
    );
  });
});

test("validates user duplicates and merged agent references", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-"));
  const agents = join(root, "agents");
  mkdirSync(join(agents, "nested"), { recursive: true });
  writeFileSync(
    join(agents, "parent.md"),
    '---\nname: parent\nagents: ["child"]\n---\nParent',
  );
  writeFileSync(
    join(agents, "child.md"),
    '---\nname: child\nagents: ["parent"]\n---\nChild',
  );
  writeFileSync(
    join(agents, "nested", "parent.md"),
    "---\nname: parent\n---\nDuplicate",
  );
  assert.throws(
    () => withPiAgentDir(root, () => discoverAgentDefinitions()),
    /multiple definitions found for agent parent/,
  );

  unlinkSync(join(agents, "nested", "parent.md"));
  assert.deepEqual(
    withPiAgentDir(root, () => discoverAgent("reviewer").frontmatter.agents),
    ["scout", "researcher"],
  );
  assert.deepEqual(
    withPiAgentDir(root, () => discoverAgentDefinitions())
      .filter(({ name }) => name === "parent" || name === "child")
      .map(({ name }) => name),
    ["child", "parent"],
  );

  writeFileSync(
    join(agents, "parent.md"),
    '---\nname: parent\nagents: ["missing"]\n---\nParent',
  );
  assert.throws(
    () => withPiAgentDir(root, () => discoverAgentDefinitions()),
    /agent parent references missing agent definition missing/,
  );
});

test("keeps a bundled parent valid when its child is overridden", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\ndescription: Overridden scout\n---\nScout",
  );
  assert.equal(
    withPiAgentDir(
      root,
      () => discoverAgent("reviewer").frontmatter.agents,
    )?.includes("scout"),
    true,
  );
});

test("writes ordered private prompt snapshots with private permissions", () => {
  const paths = writePrivatePromptSnapshots(["body", "append"]);
  try {
    assert.deepEqual(
      paths.map((path) => readFileSync(path, "utf8")),
      ["body", "append"],
    );
    for (const path of paths) assertPosixMode(path, 0o600);
  } finally {
    for (const path of paths) unlinkSync(path);
  }
});

test("bundled definitions leave execution settings to the controller", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-bundled-settings-"));
  withPiAgentDir(root, () => {
    for (const name of [
      "generalist",
      "implementer",
      "researcher",
      "reviewer",
      "scout",
    ]) {
      const definition = discoverAgent(name);
      assert.equal(definition.frontmatter.model, undefined);
      assert.equal(definition.frontmatter.thinking, undefined);
    }
  });
});

test("bundled generalist definition retains its declared tool policy", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-agent-policy-"));
  const generalist = withPiAgentDir(root, () => discoverAgent("generalist"));
  assert.equal(generalist.frontmatter.noExtensions, true);
  assert.deepEqual(generalist.frontmatter.tools, [
    "read",
    "bash",
    "edit",
    "write",
  ]);
});

test("preserves current definition metadata", () => {
  const agent = {
    name: "agent",
    path: "/agents/agent.md",
    frontmatter: {
      name: "agent",
      description: "An agent",
    },
    body: "",
  };
  assert.deepEqual(agentDefinitionMetadata(agent), {
    name: "agent",
    description: "An agent",
  });
  const configured = agentDefinitionMetadata({
    name: "reviewer",
    path: "/agents/reviewer.md",
    frontmatter: { model: "provider/model", thinking: "high" },
    body: "",
  });
  assert.deepEqual(configured, {
    name: "reviewer",
    model: "provider/model",
    thinking: "high",
  });
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "agent",
      path: "/agents/agent.md",
      frontmatter: { thinking: false },
      body: "",
    }),
    { name: "agent", thinking: "off" },
  );
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "agent",
      path: "/agents/agent.md",
      frontmatter: {},
      body: "",
    }),
    { name: "agent" },
  );
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "agent",
      path: "/agents/agent.md",
      frontmatter: { noExtensions: false, extensions: [] },
      body: "",
    }),
    { name: "agent", noExtensions: false, extensions: [] },
  );
  const capabilityAgent = {
    name: "reviewer",
    path: "/agents/reviewer.md",
    frontmatter: {
      name: "reviewer",
      description: "Read-only review",
      noTools: false,
      noBuiltinTools: true,
      tools: ["read", "grep"],
      excludeTools: ["write"],
      noSkills: false,
      inheritSkills: true,
      skills: ["./skills/review.md"],
      noExtensions: true,
      extensions: ["./extensions/local.ts", "/extensions/shared.ts"],
    },
    body: "",
  };
  assert.deepEqual(agentDefinitionMetadata(capabilityAgent), {
    name: "reviewer",
    description: "Read-only review",
    noTools: false,
    noBuiltinTools: true,
    tools: ["read", "grep"],
    excludeTools: ["write"],
    noSkills: false,
    inheritSkills: true,
    skills: ["./skills/review.md"],
    noExtensions: true,
    extensions: ["./extensions/local.ts", "/extensions/shared.ts"],
  });
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "implementer",
      path: "/agents/implementer.md",
      frontmatter: { agents: ["scout", "reviewer"] },
      body: "",
    }),
    { name: "implementer", agents: ["scout", "reviewer"] },
  );
});

test("expands body references with caller precedence and no recursion", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-body-expand-"));
  const nested = join(root, "nested.md");
  const included = join(root, "included.md");
  writeFileSync(nested, "@./ignored.md");
  writeFileSync(included, "included\n@./nested.md");
  assert.equal(
    expandAgentBodyFiles(
      `before\n@${included}\n@${included}\nafter`,
      [],
      "assign",
    ),
    "before\nincluded\n@./nested.md\n\nafter",
  );
  assert.equal(
    expandAgentBodyFiles(`@${included}`, [realpathSync(included)], "assign"),
    "",
  );
});

test("delegation preserves legacy tool-policy authorization", () => {
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        '---\nname: custom\nworkers: ["scout"]\n---',
      ),
    /is not a supported agent-definition field/,
  );
  for (const { frontmatter, enabled } of [
    { frontmatter: { agents: ["child"] }, enabled: true },
    { frontmatter: { agents: ["child"], tools: ["read"] }, enabled: true },
    {
      frontmatter: { agents: ["child"], excludeTools: ["agent"] },
      enabled: false,
    },
    { frontmatter: { agents: ["child"], noTools: true }, enabled: false },
    { frontmatter: { agents: ["child"], tools: [] }, enabled: false },
    {
      frontmatter: { agents: ["child"], noTools: true, tools: ["read"] },
      enabled: false,
    },
    {
      frontmatter: { agents: ["child"], tools: ["agent"] },
      enabled: true,
    },
    { frontmatter: { agents: [] }, enabled: false },
  ])
    assert.equal(
      agentDefinitionDelegationEnabled({
        name: "parent",
        path: "/parent.md",
        frontmatter,
        body: "",
      }),
      enabled,
    );
  assert.equal(
    agentDefinitionDelegationEnabled({
      name: "parent",
      path: "/parent.md",
      frontmatter: {
        agents: ["child"],
        tools: ["read"],
        excludeTools: ["delegate_agent"],
      },
      body: "",
    }),
    true,
  );
});

test("keeps ordinary tool metadata separate from managed role tools", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-tool-inference-"));
  const definitions = withPiAgentDir(root, () => discoverAgentDefinitions());
  const effective = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  assert.deepEqual(effective.get("implementer")?.frontmatter.tools, [
    "read",
    "bash",
    "edit",
    "write",
  ]);
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "parent",
      path: "/parent.md",
      frontmatter: { agents: ["child"], tools: ["read"] },
      body: "",
    }),
    { name: "parent", agents: ["child"], tools: ["read"] },
  );
});

test("projects parent-launched definitions as exact leaf capabilities", () => {
  const definition = {
    name: "parent",
    path: "/parent.md",
    frontmatter: {
      agents: ["scout"],
      tools: ["read", "bash"],
      excludeTools: ["write"],
      noExtensions: true,
      extensions: ["./review.ts"],
    },
    body: "",
  };
  const leaf = projectAgentDefinition(definition, "leaf");
  assert.equal(leaf.frontmatter.agents, undefined);
  assert.deepEqual(leaf.frontmatter.tools, ["read", "bash"]);
  assert.deepEqual(agentDefinitionMetadata(definition, "leaf"), {
    name: "parent",
    tools: ["read", "bash"],
    excludeTools: ["write"],
    noExtensions: true,
    extensions: ["./review.ts"],
  });
  const empty = projectAgentDefinition(
    {
      name: "empty",
      path: "/empty.md",
      frontmatter: { agents: ["scout"], tools: [] },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(empty.frontmatter.tools, []);
  assert.equal(empty.frontmatter.agents, undefined);
  const legacyToolLeaf = projectAgentDefinition(
    {
      name: "legacy",
      path: "/legacy.md",
      frontmatter: { agents: ["scout"], noTools: true, tools: ["agent"] },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(legacyToolLeaf.frontmatter.tools, []);
  assert.equal(legacyToolLeaf.frontmatter.noTools, true);
  const denied = projectAgentDefinition(
    {
      name: "denied",
      path: "/denied.md",
      frontmatter: {
        agents: ["scout"],
        tools: ["read"],
        excludeTools: ["delegate_agent"],
      },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(denied.frontmatter.tools, ["read"]);
  assert.deepEqual(denied.frontmatter.excludeTools, ["delegate_agent"]);
  const delegationOnlyLeaf = projectAgentDefinition(
    {
      name: "parent",
      path: "/parent.md",
      frontmatter: { agents: ["scout"], tools: [] },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(delegationOnlyLeaf.frontmatter.tools, []);
  assert.equal(delegationOnlyLeaf.frontmatter.agents, undefined);
  const omittedToolsLeaf = projectAgentDefinition(
    {
      name: "parent",
      path: "/parent.md",
      frontmatter: { agents: ["scout"] },
      body: "",
    },
    "leaf",
  );
  assert.equal(omittedToolsLeaf.frontmatter.agents, undefined);
  assert.equal(omittedToolsLeaf.frontmatter.tools, undefined);
});

test("merges effective frontmatter and preserves narrow override mutations", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-overrides-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  const path = join(agents, "reviewer.md");
  const original =
    "---\r\nname: reviewer\r\nmodel: old/model\r\nthinking: low\r\ndescription: keep\r\nbodyMode: append\r\n---\r\n\r\nKeep this body.\r\n";
  writeFileSync(path, original);
  const overrideDefinition = {
    name: "reviewer",
    path,
    overrideSource: path,
    extensionSource: "/bundled/reviewer.md",
    frontmatter: { name: "reviewer", model: "old/model", thinking: "low" },
    body: "Keep this body.",
  } as const;
  const set = withPiAgentDir(root, () =>
    updateAgentOverride(overrideDefinition, "model", "provider/model"),
  );
  assert.equal(set.changed, true);
  assert.equal(
    readFileSync(path, "utf8"),
    original.replace("model: old/model", "model: provider/model"),
  );
  const reset = withPiAgentDir(root, () =>
    updateAgentOverride(
      {
        ...overrideDefinition,
        frontmatter: {
          ...overrideDefinition.frontmatter,
          model: "provider/model",
        },
      },
      "model",
      undefined,
    ),
  );
  assert.equal(reset.changed, true);
  assert.equal(
    readFileSync(path, "utf8"),
    original.replace("model: old/model\r\n", ""),
  );
  const multilineOriginal = "---\nname: reviewer\nthinking: >-\n  high\n---\n";
  writeFileSync(path, multilineOriginal);
  assert.throws(
    () =>
      withPiAgentDir(root, () =>
        updateAgentOverride(overrideDefinition, "thinking", undefined),
      ),
    /cannot safely remove multiline thinking/u,
  );
  assert.equal(readFileSync(path, "utf8"), multilineOriginal);
  const formatted =
    "---\nname: reviewer\n\n# Execution settings\nmodel: provider/old-model\nthinking: low\nenabled: false\n\n# Capabilities\ntools:\n  - read\n---\n\nKeep this body.\n";
  for (const [field, oldValue, newValue] of [
    ["thinking", "low", "high"],
    ["enabled", "false", "true"],
  ] as const) {
    const fieldRoot = mkdtempSync(join(tmpdir(), `pi-herdsman-${field}-`));
    const fieldPath = join(fieldRoot, "reviewer.md");
    writeFileSync(fieldPath, formatted);
    withPiAgentDir(fieldRoot, () =>
      updateAgentOverride(
        { ...overrideDefinition, overrideSource: fieldPath },
        field,
        field === "enabled" ? newValue === "true" : newValue,
      ),
    );
    assert.equal(
      readFileSync(fieldPath, "utf8"),
      formatted.replace(`${field}: ${oldValue}`, `${field}: ${newValue}`),
    );
  }
  for (const [syntax, unsafe] of [
    ["quoted", '"model": old/model'],
    ["multiline", "model: |\n  old/model"],
  ] as const) {
    const unsafeRoot = mkdtempSync(join(tmpdir(), `pi-herdsman-${syntax}-`));
    const unsafePath = join(unsafeRoot, "reviewer.md");
    const unsafeOriginal = `---\nname: reviewer\n${unsafe}\nthinking: low\n---\n`;
    writeFileSync(unsafePath, unsafeOriginal);
    assert.throws(() =>
      withPiAgentDir(unsafeRoot, () =>
        updateAgentOverride(
          { ...overrideDefinition, overrideSource: unsafePath },
          "model",
          "provider/model",
        ),
      ),
    );
    assert.equal(readFileSync(unsafePath, "utf8"), unsafeOriginal);
  }
  const createRoot = mkdtempSync(
    join(tmpdir(), "pi-herdsman-override-create-"),
  );
  const createDefinition = {
    name: "custom/name",
    path: "/bundled/custom.md",
    extensionSource: "/bundled/custom.md",
    frontmatter: { name: "custom/name" },
    body: "",
  } as const;
  const result = withPiAgentDir(createRoot, () =>
    updateAgentOverride(createDefinition, "thinking", "off"),
  );
  assert.equal(result.changed, true);
  assert.match(result.path, /custom%2Fname\.md$/);
  assert.equal(
    readFileSync(result.path, "utf8"),
    '---\nname: "custom/name"\nthinking: off\n---\n',
  );
  const noop = withPiAgentDir(createRoot, () =>
    updateAgentOverride(
      { ...createDefinition, overrideSource: result.path },
      "model",
      undefined,
    ),
  );
  assert.equal(noop.changed, false);
  const enabledRoot = mkdtempSync(
    join(tmpdir(), "pi-herdsman-enabled-persist-"),
  );
  const enabledDefinition = {
    name: "reviewer",
    path: "/bundled/reviewer.md",
    extensionSource: "/bundled/reviewer.md",
    frontmatter: { name: "reviewer", enabled: true },
    body: "bundled body",
  } as const;
  const disabled = withPiAgentDir(enabledRoot, () =>
    updateAgentOverride(enabledDefinition, "enabled", false),
  );
  assert.equal(disabled.changed, true);
  assert.equal(
    readFileSync(disabled.path, "utf8"),
    '---\nname: "reviewer"\nenabled: false\n---\n',
  );
  const enabledReset = withPiAgentDir(enabledRoot, () =>
    updateAgentOverride(
      { ...enabledDefinition, overrideSource: disabled.path },
      "enabled",
      undefined,
    ),
  );
  assert.equal(enabledReset.changed, true);
  assert.doesNotMatch(readFileSync(disabled.path, "utf8"), /^enabled:/m);
});

const noForeignProviders = () => false;
const inheritedModel = (provider: string, token: string) => ({
  provider,
  token,
});

test("a child with no requested model passes no --model at all", () => {
  assert.deepEqual(
    resolveChildModel({ isForeignProvider: noForeignProviders }),
    {
      kind: "none",
    },
  );
});

test("a blank configured model is treated as no model", () => {
  assert.deepEqual(
    resolveChildModel({
      configured: "   ",
      isForeignProvider: noForeignProviders,
    }),
    { kind: "none" },
  );
});

test("a built-in or config provider keeps the child lean", () => {
  assert.deepEqual(
    resolveChildModel({
      inherited: inheritedModel("vendor-one", "vendor-one/chat-large"),
      isForeignProvider: noForeignProviders,
    }),
    {
      kind: "use",
      model: "vendor-one/chat-large",
      extensionDiscovery: false,
    },
  );
});

test("an extension-provided model carries the right to discover extensions", () => {
  assert.deepEqual(
    resolveChildModel({
      inherited: inheritedModel("acme", "acme/reasoning/mini"),
      isForeignProvider: (id) => id === "acme",
    }),
    {
      kind: "use",
      model: "acme/reasoning/mini",
      extensionDiscovery: true,
    },
  );
});

test("a configured model outranks the inherited one and keeps the definition's policy", () => {
  assert.deepEqual(
    resolveChildModel({
      configured: "vendor-two/chat-small",
      inherited: inheritedModel("acme", "acme/reasoning/mini"),
      isForeignProvider: (id) => id === "acme",
    }),
    {
      kind: "use",
      model: "vendor-two/chat-small",
      extensionDiscovery: false,
    },
  );
});

test("the inherited provider is Pi's resolved provider, not the token's first segment", () => {
  // Pi reports a provider that the token does not spell out; the decision must
  // follow Pi rather than re-derive the provider from the string.
  assert.deepEqual(
    resolveChildModel({
      inherited: inheritedModel("acme", "solo-chat"),
      isForeignProvider: (id) => id === "acme",
    }),
    { kind: "use", model: "solo-chat", extensionDiscovery: true },
  );
});
