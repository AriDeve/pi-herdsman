import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import * as sdk from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "herdsman-omp-launch-"));
const temporaryPaths: string[] = [];
const contexts = [
  { path: join(root, "global", "AGENTS.md"), content: "global" },
  { path: join(root, "project", "AGENTS.md"), content: "project", depth: 0 },
];
const discoverContexts = async (
  _cwd: string,
  _agentDir: string,
  disabled: readonly string[],
) =>
  contexts.filter(
    (context) =>
      !disabled.includes(
        `context-file:${context.depth === undefined ? "user" : "project"}:${basename(context.path)}`,
      ),
  );
mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    ...sdk,
    CONFIG_DIR_NAME: ".omp",
    discoverContextFiles: discoverContexts,
    discoverSkills: async () => ({ skills: [], warnings: [] }),
    loadSkillsFromDir: async ({ dir }: { dir: string }) => ({
      skills: readdirSync(dir).map((entry) => {
        const filePath = join(dir, entry, "SKILL.md");
        const parsed = sdk.parseFrontmatter<{
          name: string;
          description: string;
        }>(readFileSync(filePath, "utf8"));
        return {
          name: parsed.frontmatter.name,
          filePath,
          description: parsed.frontmatter.description,
        };
      }),
      warnings: [],
    }),
  },
});
mock.module("./omp-settings.ts", {
  namedExports: {
    readOmpLaunchSettings: async () => ({ disabledExtensions: [], skills: {} }),
  },
});
// Load only after installing the synthetic native SDK boundary used by these tests.
const { agentLaunchArgs, ompLaunchTools } =
  await import("./agent-definitions.ts");
const options = { cwd: root, temporaryPaths };
const definition = {
  name: "leaf",
  path: join(root, "leaf.md"),
  frontmatter: {},
  body: "",
};
after(() => {
  for (const path of temporaryPaths)
    rmSync(path, { force: true, recursive: true });
  rmSync(root, { force: true, recursive: true });
});
function flagValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1);
  return args[index + 1]!;
}
function overlay(args: string[]): {
  disabledExtensions?: string[];
  skills?: { customDirectories: string[]; includeSkills: string[] };
} {
  return JSON.parse(readFileSync(flagValue(args, "--config"), "utf8"));
}

test("native child policy restricts tools, protects owner communication, and cannot activate excluded tools", async () => {
  const args = await agentLaunchArgs(
    {
      ...definition,
      frontmatter: {
        tools: ["read", "mcp__github__*"],
        excludeTools: ["write*", "ask_owner"],
      },
    },
    { ...options, managedAgent: true },
  );
  const policy = JSON.parse(flagValue(args, "--herdsman-launch-policy"));
  const tools = [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "write", sourceInfo: { source: "builtin" } },
    { name: "ask_owner", sourceInfo: { source: "extension" } },
    { name: "mcp__github__search", sourceInfo: { source: "mcp" } },
    { name: "mcp__other__search", sourceInfo: { source: "mcp" } },
  ];
  assert.deepEqual(ompLaunchTools(policy, tools), [
    "read",
    "ask_owner",
    "mcp__github__search",
  ]);
  assert.deepEqual(ompLaunchTools({ ...policy, noBuiltinTools: true }, tools), [
    "ask_owner",
    "mcp__github__search",
  ]);
  assert.deepEqual(ompLaunchTools({ ...policy, tools: [] }, tools), [
    "ask_owner",
  ]);
  assert.throws(
    () => ompLaunchTools({ ...policy, tools: ["missing"] }, tools),
    /Missing configured Herdsman tools/,
  );
  await assert.rejects(
    agentLaunchArgs(
      { ...definition, frontmatter: { excludeTools: ["ask_*"] } },
      { ...options, managedAgent: true },
    ),
    /required tools cannot be excluded/,
  );
});

test("context inheritance disables only the denied native scope", async () => {
  for (const [inheritGlobalContext, inheritProjectContext, expected] of [
    [false, true, ["project"]],
    [true, false, ["global"]],
    [false, false, []],
  ] as const) {
    const args = await agentLaunchArgs(
      {
        ...definition,
        frontmatter: { inheritGlobalContext, inheritProjectContext },
      },
      options,
    );
    const loaded = await discoverContexts(
      root,
      root,
      overlay(args).disabledExtensions ?? [],
    );
    assert.deepEqual(
      loaded.map((context) => context.content),
      expected,
    );
  }
});

test("OMP receives all body, shared and interoperability prompt content despite its last-wins append flag", async () => {
  const body = join(root, "body.md");
  const shared = join(root, "shared.md");
  writeFileSync(body, "body with quotes ' and Unicode café");
  writeFileSync(shared, "shared instructions");
  const args = await agentLaunchArgs(
    { ...definition, body: "body" },
    {
      ...options,
      managedAgent: true,
      bodyPromptPath: body,
      sharedPromptPath: shared,
    },
  );
  const appended = readFileSync(
    flagValue(args, "--append-system-prompt"),
    "utf8",
  );
  assert.match(appended, /body with quotes ' and Unicode café/);
  assert.match(appended, /shared instructions/);
  assert.match(appended, /<active_agent name="leaf"\/>/);
  assert.equal(
    args.filter((arg) => arg === "--append-system-prompt").length,
    1,
  );
  assert.equal(args.includes("--approve"), false);
  assert.equal(args.includes("--auto-approve"), false);
});

test("explicit skill files remain available with relative resources when inherited skills are disabled", async () => {
  const directory = join(root, "explicit-skill");
  mkdirSync(directory);
  const skill = join(directory, "custom.md");
  writeFileSync(
    skill,
    "---\nname: launch-check\ndescription: Explicit launch check\n---\nRead resource.txt",
  );
  writeFileSync(join(directory, "resource.txt"), "skill resource");
  const args = await agentLaunchArgs(
    { ...definition, frontmatter: { noSkills: true, skills: [skill] } },
    options,
  );
  const config = overlay(args);
  assert.ok(config.skills);
  assert.deepEqual(config.skills.includeSkills, ["launch-check"]);
  const staging = config.skills.customDirectories[0]!;
  temporaryPaths.push(staging);
  assert.equal(
    readFileSync(join(staging, "0", "SKILL.md"), "utf8"),
    readFileSync(skill, "utf8"),
  );
  assert.equal(
    readFileSync(join(staging, "0", "resource.txt"), "utf8"),
    "skill resource",
  );
  assert.equal(args.includes("--no-skills"), false);
});

test("failed explicit-skill preparation removes its private staging without removing source resources", async () => {
  const protectedResource = join(root, "unrelated-resource.txt");
  writeFileSync(protectedResource, "preserve");
  const runtimeDirectories: string[] = [];
  await assert.rejects(
    agentLaunchArgs(
      {
        ...definition,
        frontmatter: { skills: [join(root, "missing-skill.md")] },
      },
      { ...options, runtimeDirectories },
    ),
    /ENOENT/,
  );
  assert.equal(runtimeDirectories.length, 1);
  assert.equal(existsSync(runtimeDirectories[0]!), false);
  assert.equal(readFileSync(protectedResource, "utf8"), "preserve");
});
