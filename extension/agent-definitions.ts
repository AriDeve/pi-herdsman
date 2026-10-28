import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  CURRENT_SESSION_VERSION,
  SessionManager,
  parseFrontmatter as parsePiFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { discoverContextFiles } from "@oh-my-pi/pi-coding-agent";
import { snapshotTextFiles } from "./core.ts";
import { herdsmanTempRoot } from "./storage.ts";

export const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const THINKING_LEVELS = new Set(VALID_THINKING_LEVELS);
const SYSTEM_PROMPT_MODES = new Set(["append", "replace"]);
type BodyMode = "replace" | "append";
const BODY_MODES = new Set<BodyMode>(["append", "replace"]);
const STRING_FIELDS = new Set([
  "name",
  "description",
  "model",
  "thinking",
  "systemPromptMode",
  "bodyMode",
]);
const BOOLEAN_CAPABILITY_FIELDS = new Set([
  "enabled",
  "fastMode",
  "noTools",
  "noBuiltinTools",
  "noSkills",
  "noExtensions",
  "inheritGlobalContext",
  "inheritProjectContext",
  "inheritSkills",
]);
const ARRAY_FIELDS = new Set([
  "tools",
  "excludeTools",
  "skills",
  "extensions",
  "agents",
]);
const SUPPORTED_FIELDS = new Set([
  "name",
  "description",
  "permission",
  ...STRING_FIELDS,
  ...BOOLEAN_CAPABILITY_FIELDS,
  ...ARRAY_FIELDS,
]);
const BODY_FILE_REFERENCE =
  sep === "\\"
    ? /^[ \t]*@((?:[\\/]|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\).+?)[ \t]*$/gmu
    : /^[ \t]*@((?:\/|~\/|\.\.?\/).+?)[ \t]*$/gmu;
const BUILTIN_AGENT_DIR = fileURLToPath(
  new URL("./agent-definitions", import.meta.url),
);

export const FLEXIBLE_LEAD_DEFINITION_NAME = "flexible-lead";
export const ORCHESTRATOR_LEAD_DEFINITION_NAME = "orchestrator-lead";
export const MANAGED_LEAD_DEFINITION_NAME = "managed-lead";
export const MANAGER_DEFINITION_NAME = "manager";
export const CHIEF_DEFINITION_NAME = "chief";
export const RESERVED_ROLE_DEFINITION_NAMES = [
  FLEXIBLE_LEAD_DEFINITION_NAME,
  ORCHESTRATOR_LEAD_DEFINITION_NAME,
  MANAGED_LEAD_DEFINITION_NAME,
  MANAGER_DEFINITION_NAME,
  CHIEF_DEFINITION_NAME,
] as const;
const RESERVED_ROLE_DEFINITION_NAME_SET = new Set<string>(
  RESERVED_ROLE_DEFINITION_NAMES,
);

export function isReservedRoleDefinition(name: string): boolean {
  return RESERVED_ROLE_DEFINITION_NAME_SET.has(name);
}

export function isRuntimeRoleDefinition(name: string): boolean {
  return (
    isReservedRoleDefinition(name) && name !== MANAGED_LEAD_DEFINITION_NAME
  );
}
const RUNTIME_LEAD_FIELDS = new Set([
  "name",
  "description",
  "bodyMode",
  "tools",
  "excludeTools",
]);
const SUPERVISOR_AGENT_FIELDS = new Set([
  MANAGER_DEFINITION_NAME,
  CHIEF_DEFINITION_NAME,
]);

export type FrontmatterValue =
  string | boolean | string[] | { [key: string]: unknown };
export type Frontmatter = {
  enabled?: boolean;
  model?: string;
  thinking?: string | false;
  fastMode?: boolean;
  bodyMode?: BodyMode;
  permission?: { [key: string]: unknown };
  noTools?: boolean;
  noBuiltinTools?: boolean;
  tools?: string[];
  excludeTools?: string[];
  noSkills?: boolean;
  skills?: string[];
  noExtensions?: boolean;
  extensions?: string[];
  agents?: string[];
  inheritGlobalContext?: boolean;
  [key: string]: FrontmatterValue | undefined;
};

export type AgentDefinition = {
  name: string;
  path: string;
  frontmatter: Frontmatter;
  body: string;
  extensionSource?: string;
  projectSource?: string;
  overrideSource?: string;
};

export const AGENT_COORDINATION_TOOLS = [
  "list_agents",
  "delegate_agent",
  "continue_agent",
  "steer_agent",
  "interrupt_agent",
  "reply_agent",
  "close_agent",
  "inspect_agent",
  "read_agent_transcript",
] as const;

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    // Dotfile managers deploy definitions as symlinks; reading follows them.
    return (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.endsWith(".md")
      ? [path]
      : [];
  });
}

function readAgentDefinitions(root: string): AgentDefinition[] {
  const definitions = markdownFiles(root)
    .filter((path) => !path.endsWith(".example.md"))
    .sort()
    .map((path) => {
      const content = readFileSync(path, "utf8").replace(/^\uFEFF/u, "");
      let parsed: ReturnType<typeof parsePiFrontmatter>;
      try {
        parsed = parsePiFrontmatter<Record<string, unknown>>(content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${path}: ${message}`, { cause: error });
      }
      if (!isPlainObject(parsed.frontmatter))
        throw new Error(`${path}: frontmatter must be a YAML mapping`);
      const frontmatter = parsed.frontmatter as Frontmatter;
      const definition: AgentDefinition = {
        name: typeof frontmatter.name === "string" ? frontmatter.name : "",
        path,
        frontmatter,
        body: resolveBodyFileReferences(parsed.body, path),
      };
      validateDefinition(definition, { allowBodyMode: true });
      return definition;
    });
  const pathsByName = new Map<string, string[]>();
  for (const definition of definitions)
    pathsByName.set(definition.name, [
      ...(pathsByName.get(definition.name) ?? []),
      definition.path,
    ]);
  for (const [name, paths] of pathsByName)
    if (paths.length > 1)
      throw new Error(
        `multiple definitions found for agent ${name}: ${paths.join(", ")}`,
      );
  return definitions;
}

function resolveBodyFileReferences(
  body: string,
  definitionPath: string,
): string {
  return body.replace(BODY_FILE_REFERENCE, (_match, input: string) => {
    const homeRelative = input.startsWith("~/") || input.startsWith(`~${sep}`);
    const expanded = homeRelative ? resolve(homedir(), input.slice(2)) : input;
    return `@${isAbsolute(expanded) ? expanded : resolve(dirname(definitionPath), expanded)}`;
  });
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function mergeFrontmatter(
  base: Frontmatter,
  override: Frontmatter,
): Frontmatter {
  return { ...base, ...override };
}

function validateDefinition(
  definition: AgentDefinition,
  options: { allowBodyMode?: boolean } = {},
): void {
  const { frontmatter, name, overrideSource, projectSource, extensionSource } =
    definition;
  const source =
    overrideSource ?? projectSource ?? extensionSource ?? definition.path;
  const invalid = (field: string, reason: string): never => {
    throw new Error(
      `${source}${name ? ` agent ${name}` : ""} field ${field}: ${reason}`,
    );
  };
  for (const field of Object.keys(frontmatter))
    if (!SUPPORTED_FIELDS.has(field))
      invalid(field, "is not a supported agent-definition field");
  if (
    frontmatter.permission !== undefined &&
    !isPlainObject(frontmatter.permission)
  )
    invalid("permission", "must be a mapping");
  if (typeof frontmatter.name !== "string" || !frontmatter.name)
    invalid("name", "must be a non-empty string");
  if (isReservedRoleDefinition(name) && frontmatter.fastMode !== undefined)
    invalid("fastMode", "is only supported on ordinary Agent definitions");
  for (const field of BOOLEAN_CAPABILITY_FIELDS)
    if (
      frontmatter[field] !== undefined &&
      typeof frontmatter[field] !== "boolean"
    )
      invalid(field, "must be a boolean");
  for (const field of ARRAY_FIELDS) {
    const value = frontmatter[field];
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        value.some(
          (entry) => typeof entry !== "string" || entry.trim().length === 0,
        ) ||
        (field === "agents" && new Set(value).size !== value.length))
    )
      invalid(
        field,
        field === "agents"
          ? "must be an array of unique non-empty strings"
          : "must be an array of non-empty strings",
      );
  }
  if (
    frontmatter.tools !== undefined &&
    normalizedToolNames(frontmatter.tools).some((tool) => /^[+-]/u.test(tool))
  )
    invalid("tools", "must be an allowlist without +name/-name modifiers");
  if (frontmatter.model !== undefined) {
    if (typeof frontmatter.model !== "string" || !frontmatter.model)
      invalid("model", "must be a non-empty string");
  }
  if (
    frontmatter.description !== undefined &&
    typeof frontmatter.description !== "string"
  )
    invalid("description", "must be a string");
  if (
    frontmatter.thinking !== undefined &&
    frontmatter.thinking !== false &&
    (typeof frontmatter.thinking !== "string" ||
      !THINKING_LEVELS.has(frontmatter.thinking))
  )
    invalid(
      "thinking",
      "must be one of off, minimal, low, medium, high, xhigh, max, or false",
    );
  if (
    frontmatter.systemPromptMode !== undefined &&
    (typeof frontmatter.systemPromptMode !== "string" ||
      !SYSTEM_PROMPT_MODES.has(frontmatter.systemPromptMode))
  )
    invalid("systemPromptMode", "must be append or replace");
  if (
    frontmatter.bodyMode !== undefined &&
    (typeof frontmatter.bodyMode !== "string" ||
      !BODY_MODES.has(frontmatter.bodyMode))
  )
    invalid("bodyMode", "must be append or replace");
  if (frontmatter.bodyMode !== undefined && !options.allowBodyMode)
    invalid("bodyMode", "only valid when overlaying an existing agent");
}

function mergeDefinitionBody(
  base: string,
  override: string,
  mode: BodyMode,
): string {
  if (!override) return base;
  if (mode === "append" && base) return `${base}\n\n${override}`;
  return override;
}

function overrideBodyMode(definition: AgentDefinition): BodyMode {
  return definition.frontmatter.bodyMode ?? "replace";
}

function normalizedToolNames(tools: readonly string[] | undefined): string[] {
  return (tools ?? [])
    .flatMap((tool) => tool.split(","))
    .map((tool) => tool.trim())
    .filter(Boolean);
}

export function matchesToolPattern(pattern: string, name: string): boolean {
  if (pattern === "mcp__") return name.startsWith("mcp__");
  if (!pattern.includes("*")) return pattern === name;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "u").test(name);
}

export function configuredToolPolicy(
  definition: AgentDefinition,
  requiredTools: readonly string[],
): { explicit: boolean; tools: string[]; excluded: string[] } {
  const configured = normalizedToolNames(definition.frontmatter.tools);
  const required = new Set(requiredTools);
  const excluded = normalizedToolNames(definition.frontmatter.excludeTools)
    .filter((pattern) => !required.has(pattern))
    .filter((pattern, index, all) => all.indexOf(pattern) === index);
  for (const pattern of excluded) {
    if (!pattern.includes("*")) continue;
    const matched = requiredTools.find((tool) =>
      matchesToolPattern(pattern, tool),
    );
    if (matched)
      throw new Error(
        `agent ${definition.name} excludeTools pattern ${JSON.stringify(pattern)} ` +
          `matches required tool ${JSON.stringify(matched)}; ` +
          `required tools cannot be excluded by patterns`,
      );
  }
  return {
    explicit: definition.frontmatter.tools !== undefined,
    tools: configured.filter((tool) => !required.has(tool)),
    excluded,
  };
}

function readOptionalAgentDefinitions(root: string): AgentDefinition[] {
  const stats = statSync(root, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory())
    throw new Error(`agent directory is not a directory: ${root}`);
  return readAgentDefinitions(root);
}

type DefinitionLayerSource = "projectSource" | "overrideSource";

function applyDefinitionLayer(
  definitions: Map<string, AgentDefinition>,
  layer: readonly AgentDefinition[],
  sourceField: DefinitionLayerSource,
): void {
  for (const definition of layer) {
    const base = definitions.get(definition.name);
    if (!base) {
      definition[sourceField] = definition.path;
      validateDefinition(definition);
      definitions.set(definition.name, definition);
      continue;
    }
    const mode = overrideBodyMode(definition);
    const { bodyMode: _bodyMode, ...overrideFrontmatter } =
      definition.frontmatter;
    const effective: AgentDefinition = {
      name: base.name,
      path: definition.path,
      frontmatter: mergeFrontmatter(base.frontmatter, overrideFrontmatter),
      body: mergeDefinitionBody(base.body, definition.body, mode),
      extensionSource: base.extensionSource,
      projectSource: base.projectSource,
      overrideSource: base.overrideSource,
      [sourceField]: definition.path,
    };
    validateDefinition(effective);
    definitions.set(effective.name, effective);
  }
}

export type DiscoverAgentDefinitionsOptions = { projectRoot?: string };

function validateEffectiveAgentReferences(
  definitions: readonly AgentDefinition[],
): void {
  const agents = definitions.filter(
    ({ name }) => !isReservedRoleDefinition(name),
  );
  const names = new Set(agents.map((definition) => definition.name));
  for (const definition of agents)
    for (const reference of definition.frontmatter.agents ?? [])
      if (!names.has(reference))
        throw new Error(
          `agent ${definition.name} references missing agent definition ${reference}`,
        );
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  for (const definition of definitions)
    if (SUPERVISOR_AGENT_FIELDS.has(definition.name))
      for (const reference of definition.frontmatter.agents ?? []) {
        if (isReservedRoleDefinition(reference))
          throw new Error(
            `agent ${definition.name} references reserved agent definition ${reference}`,
          );
        if (!byName.has(reference))
          throw new Error(
            `agent ${definition.name} references missing agent definition ${reference}`,
          );
      }
}

function validateManagedLeadLayer(definition: AgentDefinition): void {
  if (definition.name !== MANAGED_LEAD_DEFINITION_NAME) return;
  if (definition.frontmatter.systemPromptMode === "replace")
    throw new Error(
      `${definition.path} managed Lead field systemPromptMode: must be append`,
    );
  for (const field of ["enabled", "agents", "permission"] as const)
    if (definition.frontmatter[field] !== undefined)
      throw new Error(
        `${definition.path} managed Lead field ${field}: is not supported`,
      );
}

function validateRuntimeRoleLayer(definition: AgentDefinition): void {
  if (!isRuntimeRoleDefinition(definition.name)) return;
  const allowed = SUPERVISOR_AGENT_FIELDS.has(definition.name)
    ? new Set([...RUNTIME_LEAD_FIELDS, "agents"])
    : RUNTIME_LEAD_FIELDS;
  for (const field of Object.keys(definition.frontmatter))
    if (!allowed.has(field))
      throw new Error(
        `${definition.path} ${definition.name} field ${field}: is not supported`,
      );
}

function discoverEffectiveDefinitions(
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition[] {
  const bundled = readAgentDefinitions(BUILTIN_AGENT_DIR);
  const project = options.projectRoot
    ? readOptionalAgentDefinitions(
        join(options.projectRoot, CONFIG_DIR_NAME, "agents"),
      )
    : [];
  const user = readOptionalAgentDefinitions(join(getAgentDir(), "agents"));
  const definitions = new Map(
    bundled.map((definition) => [definition.name, definition]),
  );
  for (const definition of bundled) {
    if (!definition.extensionSource)
      definition.extensionSource = definition.path;
    validateDefinition(definition);
  }
  for (const definition of [...bundled, ...project, ...user]) {
    validateManagedLeadLayer(definition);
    validateRuntimeRoleLayer(definition);
  }
  const projectChief = project.find(
    ({ name }) => name === CHIEF_DEFINITION_NAME,
  );
  if (projectChief)
    throw new Error(
      `${projectChief.path} chief definition: project overrides are not supported; configure chief globally instead`,
    );
  applyDefinitionLayer(definitions, project, "projectSource");
  applyDefinitionLayer(definitions, user, "overrideSource");
  const effective = [...definitions.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  validateEffectiveAgentReferences(effective);
  return effective;
}

export function discoverAgentDefinitions(
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition[] {
  return discoverEffectiveDefinitions(options)
    .filter(({ name }) => !isReservedRoleDefinition(name))
    .map((definition) => withDefaultEnabled(definition));
}

function withDefaultEnabled(definition: AgentDefinition): AgentDefinition {
  return {
    ...definition,
    frontmatter: {
      ...definition.frontmatter,
      enabled: definition.frontmatter.enabled ?? true,
    },
  };
}

export async function contextAgentDefinitions(ctx: ExtensionContext) {
  const projectTrusted = ctx.isProjectTrusted();
  const effective = discoverEffectiveDefinitions(
    projectTrusted ? { projectRoot: ctx.cwd } : {},
  );
  return {
    projectTrusted,
    definitions: effective
      .filter(({ name }) => !isReservedRoleDefinition(name))
      .map(withDefaultEnabled),
    roleDefinitions: effective.filter(({ name }) =>
      isReservedRoleDefinition(name),
    ),
  };
}

export type RoleDefinitionName =
  | typeof FLEXIBLE_LEAD_DEFINITION_NAME
  | typeof ORCHESTRATOR_LEAD_DEFINITION_NAME
  | typeof MANAGED_LEAD_DEFINITION_NAME
  | typeof MANAGER_DEFINITION_NAME
  | typeof CHIEF_DEFINITION_NAME;

export function discoverRoleDefinition(
  name: RoleDefinitionName,
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition {
  const definition = discoverEffectiveDefinitions(options).find(
    (candidate) => candidate.name === name,
  );
  if (!definition) throw new Error(`role definition ${name} not found`);
  return definition;
}

export function discoverRoleDefinitions(
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition[] {
  const definitions = discoverEffectiveDefinitions(options);
  return [...RESERVED_ROLE_DEFINITION_NAMES].map((name) => {
    const definition = definitions.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`role definition ${name} not found`);
    return definition;
  });
}

export function discoverAgent(
  agentName: string,
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition {
  const definition = discoverAgentDefinitions(options).find(
    (candidate) => candidate.name === agentName,
  );
  if (!definition) throw new Error(`agent ${agentName} not found`);
  return definition;
}

export function agentDefinitionEnabled(definition: AgentDefinition): boolean {
  return definition.frontmatter.enabled !== false;
}

export function validateAgentDefinitionReferences(
  definition: AgentDefinition,
  definitions: readonly AgentDefinition[],
): void {
  const byName = new Map(
    definitions.map((candidate) => [candidate.name, candidate]),
  );
  for (const reference of definition.frontmatter.agents ?? []) {
    const referencedDefinition = byName.get(reference);
    if (!referencedDefinition)
      throw new Error(
        `agent ${definition.name} references missing agent definition ${reference}`,
      );
    if (!agentDefinitionEnabled(referencedDefinition))
      throw new Error(
        `agent ${definition.name} references disabled agent definition ${reference}; enable ${reference} before assigning ${definition.name}`,
      );
  }
}

export type AgentDefinitionScope = "delegating" | "leaf";

function withoutDelegationCapability(
  definition: AgentDefinition,
): AgentDefinition {
  const { agents: _agents, ...frontmatter } = definition.frontmatter;
  if (frontmatter.tools !== undefined)
    frontmatter.tools = normalizedToolNames(frontmatter.tools).filter(
      (tool) => tool !== "agent",
    );
  return {
    ...definition,
    frontmatter,
  };
}

export function projectAgentDefinition(
  agent: AgentDefinition,
  scope: AgentDefinitionScope,
): AgentDefinition {
  return scope === "leaf" ? withoutDelegationCapability(agent) : agent;
}

export function agentDefinitionMetadata(
  agent: AgentDefinition,
  scope: AgentDefinitionScope = "delegating",
) {
  const { frontmatter } = projectAgentDefinition(agent, scope);
  const description = frontmatter.description;
  const model = configuredModel(frontmatter);
  const thinking = configuredThinking(agent);
  return {
    name: agent.name,
    ...(agentDefinitionEnabled(agent) ? {} : { enabled: false }),
    ...(agent.extensionSource === undefined
      ? {}
      : { extensionSource: agent.extensionSource }),
    ...(agent.projectSource === undefined
      ? {}
      : { projectSource: agent.projectSource }),
    ...(agent.overrideSource === undefined
      ? {}
      : { overrideSource: agent.overrideSource }),
    ...(typeof description === "string" ? { description } : {}),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(frontmatter.fastMode === undefined
      ? {}
      : { fastMode: frontmatter.fastMode }),
    ...(frontmatter.noTools === undefined
      ? {}
      : { noTools: frontmatter.noTools }),
    ...(frontmatter.noBuiltinTools === undefined
      ? {}
      : { noBuiltinTools: frontmatter.noBuiltinTools }),
    ...(frontmatter.tools === undefined ? {} : { tools: frontmatter.tools }),
    ...(frontmatter.excludeTools === undefined
      ? {}
      : { excludeTools: frontmatter.excludeTools }),
    ...(frontmatter.noSkills === undefined
      ? {}
      : { noSkills: frontmatter.noSkills }),
    ...(frontmatter.inheritSkills === undefined
      ? {}
      : { inheritSkills: frontmatter.inheritSkills }),
    ...(frontmatter.skills === undefined ? {} : { skills: frontmatter.skills }),
    ...(frontmatter.noExtensions === undefined
      ? {}
      : { noExtensions: frontmatter.noExtensions }),
    ...(frontmatter.extensions === undefined
      ? {}
      : { extensions: frontmatter.extensions }),
    ...(frontmatter.agents === undefined ? {} : { agents: frontmatter.agents }),
  };
}

export type AgentOverrideField = "model" | "thinking" | "enabled" | "fastMode";

export function updateAgentOverride(
  definition: AgentDefinition,
  field: AgentOverrideField,
  value: string | boolean | undefined,
): { path: string; changed: boolean; content: string } {
  const path =
    definition.overrideSource ??
    join(getAgentDir(), "agents", `${encodeURIComponent(definition.name)}.md`);
  const exists = statSync(path, { throwIfNoEntry: false });
  if (value === undefined && !exists) {
    return { path, changed: false, content: "" };
  }
  if (value === undefined && definition.overrideSource === undefined)
    return { path, changed: false, content: readFileSync(path, "utf8") };

  let content: string;
  let mode = 0o600;
  if (exists) {
    if (!exists.isFile())
      throw new Error(`agent override is not a file: ${path}`);
    content = readFileSync(path, "utf8");
    mode = exists.mode & 0o777;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    content = `---\nname: ${JSON.stringify(definition.name)}\n---\n`;
  }

  const lines = [...content.matchAll(/.*(?:\r\n|\n|\r|$)/g)].filter(
    (match) => match[0].length > 0,
  );
  if (lines[0]?.[0].replace(/\r?\n|\r$/u, "").trim() !== "---")
    throw new Error(`invalid agent override frontmatter: ${path}`);
  const closing = lines.findIndex(
    (match, index) =>
      index > 0 && match[0].replace(/\r?\n|\r$/u, "").trim() === "---",
  );
  if (closing < 0)
    throw new Error(`invalid agent override frontmatter: ${path}`);
  const eol = content.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  const fieldLine = new RegExp(`^${field}:\\s*`);
  const existingIndex = lines.findIndex(
    (line, index) =>
      index > 0 &&
      index < closing &&
      fieldLine.test(line[0].replace(/\r?\n|\r$/u, "")),
  );
  const hadField = existingIndex !== -1;
  if (value === undefined && hadField) {
    const next = lines
      .slice(existingIndex + 1, closing)
      .find(([text]) => text.trim() && !text.trimStart().startsWith("#"));
    if (next && /^[ \t]/u.test(next[0]))
      throw new Error(`cannot safely remove multiline ${field} in ${path}`);
  }
  if (
    !hadField &&
    Object.hasOwn(parsePiFrontmatter(content).frontmatter, field)
  ) {
    throw new Error(`cannot safely edit ${field} in ${path}`);
  }
  const updated = lines
    .map((line, index) => {
      if (index === existingIndex) {
        if (value === undefined) return "";
        const ending = line[0].match(/\r\n|\n|\r$/u)?.[0] ?? "";
        return `${field}: ${value}${ending}`;
      }
      if (index === closing && !hadField && value !== undefined)
        return `${field}: ${value}${eol}${line[0]}`;
      return line[0];
    })
    .join("");
  const parsed = parsePiFrontmatter(updated).frontmatter;
  if (
    value === undefined ? Object.hasOwn(parsed, field) : parsed[field] !== value
  ) {
    throw new Error(`invalid ${field} override in ${path}`);
  }
  if (value === undefined && !hadField)
    return { path, changed: false, content: readFileSync(path, "utf8") };

  const temporary = join(
    dirname(path),
    `.${encodeURIComponent(definition.name)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, updated, {
      encoding: "utf8",
      mode,
      flag: "wx",
      flush: true,
    });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    return { path, changed: true, content: readFileSync(path, "utf8") };
  } finally {
    if (statSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary);
  }
}

export function configuredModel(frontmatter: Frontmatter): string | undefined {
  return typeof frontmatter.model === "string" && frontmatter.model
    ? frontmatter.model
    : undefined;
}

/**
 * Which model a delegated child may be launched with.
 *
 * Agent definitions opt out of extension discovery (`noExtensions: true`),
 * which is what keeps a child lean, while delegation hands that child the
 * spawning controller's model. When that model's provider is registered by an
 * extension, the two contradict each other and pi exits with
 * `Model "<id>" not found` about two seconds after launch.
 *
 * Pi reports which providers extensions registered, so the model's needs
 * outrank the definition's preference to stay lean.
 */
export type ChildModelDecision =
  /** Nothing to pass: the child uses its own default. */
  | { kind: "none" }
  /**
   * Pass `--model`. `extensionDiscovery` is true when the model's provider is
   * registered by an extension, in which case the child must not be launched
   * with `--no-extensions` or it cannot resolve the model it was given.
   */
  | { kind: "use"; model: string; extensionDiscovery: boolean };

export function resolveChildModel(input: {
  /** Model pinned by the agent definition's frontmatter, passed to Pi as given. */
  configured?: string;
  /** The spawning controller's model; Pi already resolved its provider. */
  inherited?: { provider: string; token: string };
  /** True when `providerId` is registered by an extension. */
  isForeignProvider: (providerId: string) => boolean;
}): ChildModelDecision {
  // A pinned model is passed through as written: the definition's own extension
  // policy governs it, so nothing here needs to interpret the value.
  if (input.configured !== undefined && input.configured.trim() !== "")
    return { kind: "use", model: input.configured, extensionDiscovery: false };
  if (input.inherited === undefined) return { kind: "none" };
  return {
    kind: "use",
    model: input.inherited.token,
    // Only an inherited model needs the exception: a child denied discovery
    // cannot resolve a model whose provider only an extension supplies.
    extensionDiscovery: input.isForeignProvider(input.inherited.provider),
  };
}

function configuredThinking(agent: AgentDefinition): string | undefined {
  const configured = agent.frontmatter.thinking;
  if (configured === false) return "off";
  if (typeof configured !== "string") return undefined;
  if (!THINKING_LEVELS.has(configured))
    throw new Error(
      `agent ${agent.name} has invalid thinking level: ${JSON.stringify(configured)}`,
    );
  return configured;
}

export function writePrivatePromptSnapshots(
  contents: readonly string[],
): string[] {
  const root = herdsmanTempRoot();
  const prompts = join(root, "prompts");
  mkdirSync(prompts, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(prompts, 0o700);
  const paths: string[] = [];
  try {
    for (const content of contents) {
      const path = join(prompts, randomUUID());
      writeFileSync(path, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      paths.push(path);
      chmodSync(path, 0o600);
    }
    return paths;
  } catch (error) {
    for (const path of paths) unlinkSync(path);
    throw error;
  }
}

export function expandAgentBodyFiles(
  body: string,
  skipCanonicalPaths: readonly string[],
  operation: string,
): string {
  const references = [...body.matchAll(BODY_FILE_REFERENCE)].map(
    (match) => match[1]!,
  );
  if (references.length === 0) return body;
  const snapshots = snapshotTextFiles(references, process.cwd(), operation, {
    skipCanonicalPaths,
  });
  const remaining = new Map(
    snapshots.map((snapshot) => [snapshot.input, snapshot.text]),
  );
  return body.replace(BODY_FILE_REFERENCE, (_match, input: string) => {
    const text = remaining.get(input);
    if (text === undefined) return "";
    remaining.delete(input);
    return text;
  });
}

export function agentDefinitionDelegationEnabled(
  definition: AgentDefinition,
): boolean {
  const {
    agents,
    tools: configured,
    excludeTools,
    noTools,
  } = definition.frontmatter;
  if ((agents?.length ?? 0) === 0) return false;

  const tools = normalizedToolNames(configured);
  if (normalizedToolNames(excludeTools).includes("agent")) return false;
  if (noTools === true && !tools.includes("agent")) return false;
  return configured === undefined || tools.length > 0;
}

export type AgentLaunchOptions = {
  bodyPromptPath?: string;
  sharedPromptPath?: string;
  cwd?: string;
  discoverContextFiles?: typeof discoverContextFiles;
  runtimeDirectories?: string[];
  temporaryPaths?: string[];
  managedAgent?: boolean;
  inheritedModel?: string;
  inheritedThinking?: string;
  requiredTools?: readonly string[];
  /**
   * Pre-computed model decision for this child. When omitted, the requested
   * model (configured, else inherited) is passed through unchanged.
   */
  modelDecision?: ChildModelDecision;
};

export async function agentLaunchArgs(
  agent: AgentDefinition,
  options: AgentLaunchOptions,
): Promise<string[]> {
  const {
    bodyPromptPath,
    sharedPromptPath,
    cwd,
    managedAgent,
    inheritedModel,
    inheritedThinking,
  } = {
    bodyPromptPath: options.bodyPromptPath,
    sharedPromptPath: options.sharedPromptPath,
    cwd: options.cwd ?? process.cwd(),
    managedAgent: options.managedAgent ?? false,
    inheritedModel: options.inheritedModel,
    inheritedThinking: options.inheritedThinking,
  };
  const bodyPromptPathForLaunch = agent.body ? bodyPromptPath : undefined;
  const { frontmatter } = agent;
  if (agent.body && bodyPromptPathForLaunch === undefined)
    throw new Error(
      `agent ${agent.name} has a body but no bodyPromptPath was provided`,
    );
  const args: string[] = [];
  const requestedModel = configuredModel(frontmatter) ?? inheritedModel;
  const decision =
    options.modelDecision ??
    (requestedModel === undefined
      ? { kind: "none" as const }
      : {
          kind: "use" as const,
          model: requestedModel,
          extensionDiscovery: false,
        });
  if (decision.kind === "use") args.push("--model", decision.model);

  const thinking = configuredThinking(agent) ?? inheritedThinking;
  if (thinking !== undefined) {
    args.push("--thinking", thinking);
  }
  if (managedAgent && typeof frontmatter.fastMode === "boolean")
    args.push("--herdsman-fast-mode", frontmatter.fastMode ? "on" : "off");

  const mode = frontmatter.systemPromptMode ?? "append";
  if (!SYSTEM_PROMPT_MODES.has(mode))
    throw new Error(
      `agent ${agent.name} has invalid systemPromptMode: ${JSON.stringify(mode)}`,
    );
  const appended: string[] = [];
  if (bodyPromptPathForLaunch !== undefined) {
    if (mode === "replace")
      args.push("--system-prompt", bodyPromptPathForLaunch);
    else appended.push(readFileSync(bodyPromptPathForLaunch, "utf8"));
  }
  const overlay: Record<string, unknown> = {};
  // OMP-only APIs require Bun; Node can still load pure definition/presentation code.
  const { readOmpLaunchSettings } = await import("./omp-settings.ts");
  const { discoverContextFiles, discoverSkills, loadSkillsFromDir } =
    await import("@earendil-works/pi-coding-agent");
  const launchSettings = await readOmpLaunchSettings(cwd);
  const inheritProjectContext =
    frontmatter.inheritProjectContext ?? agent.name === "delegate";
  const inheritGlobalContext =
    frontmatter.inheritGlobalContext ?? inheritProjectContext;
  if (!inheritProjectContext || !inheritGlobalContext) {
    const disabled = new Set(launchSettings.disabledExtensions);
    const discover = options.discoverContextFiles ?? discoverContextFiles;
    // Disabling a winning provider can reveal a shadowed context file. Repeat
    // native discovery until every denied scope is suppressed, not only AGENTS.md.
    for (;;) {
      let changed = false;
      for (const context of await discover(cwd, getAgentDir(), [...disabled])) {
        const scope = context.depth === undefined ? "user" : "project";
        if (scope === "user" ? inheritGlobalContext : inheritProjectContext)
          continue;
        const id = `context-file:${scope}:${basename(context.path)}`;
        if (!disabled.has(id)) {
          disabled.add(id);
          changed = true;
        }
      }
      if (!changed) break;
    }
    overlay.disabledExtensions = [...disabled];
  }
  if (sharedPromptPath) appended.push(readFileSync(sharedPromptPath, "utf8"));
  const requiredTools = [
    ...(managedAgent
      ? agentDefinitionDelegationEnabled(agent)
        ? [...AGENT_COORDINATION_TOOLS, "ask_owner"]
        : ["ask_owner"]
      : []),
    ...(options.requiredTools ?? []),
  ].filter((tool, index, all) => all.indexOf(tool) === index);
  const policy = configuredToolPolicy(agent, requiredTools);
  const noTools =
    frontmatter.noTools === true ||
    (policy.explicit && normalizedToolNames(frontmatter.tools).length === 0);
  const selected = [
    ...new Set([
      ...policy.tools.filter((tool) => !managedAgent || tool !== "agent"),
      ...requiredTools,
    ]),
  ];
  const launchPolicy: OmpLaunchPolicy = {
    tools: noTools || policy.explicit ? selected : null,
    excluded: policy.excluded,
    noBuiltinTools: frontmatter.noBuiltinTools === true,
    requiredTools,
    skillDirectories: [],
  };
  // Keep native builtins registered: --no-tools removes them from getAllTools(),
  // so the startup policy could not activate explicitly configured tools.
  const noSkills = frontmatter.noSkills ?? frontmatter.inheritSkills !== true;
  const explicitSkills = frontmatter.skills ?? [];
  if (explicitSkills.length === 0) {
    if (noSkills) args.push("--no-skills");
  } else {
    mkdirSync(herdsmanTempRoot(), { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(herdsmanTempRoot(), "skills-"));
    chmodSync(staging, 0o700);
    launchPolicy.skillDirectories.push(staging);
    options.runtimeDirectories?.push(staging);
    try {
      for (const [index, input] of explicitSkills.entries()) {
        const path = realpathSync(
          resolve(
            cwd,
            input.startsWith("~/") ? join(homedir(), input.slice(2)) : input,
          ),
        );
        const isDirectory = statSync(path).isDirectory();
        const directory = isDirectory ? path : dirname(path);
        const skillPath = isDirectory ? join(path, "SKILL.md") : path;
        const parsed = parsePiFrontmatter<{ name?: string }>(
          readFileSync(skillPath, "utf8"),
        );
        const target = join(
          staging,
          parsed.frontmatter.name ? String(index) : basename(directory),
        );
        if (isDirectory || basename(path) === "SKILL.md") {
          symlinkSync(directory, target, "dir");
        } else {
          mkdirSync(target, { mode: 0o700 });
          // Keep relative skill resources working while exposing just the
          // explicitly requested Markdown file as this directory's SKILL.md.
          for (const entry of readdirSync(directory)) {
            if (entry === "SKILL.md") continue;
            symlinkSync(join(directory, entry), join(target, entry));
          }
          symlinkSync(path, join(target, "SKILL.md"));
        }
      }
      const loaded = await loadSkillsFromDir({
        dir: staging,
        source: "custom:user",
      });
      if (
        loaded.warnings.length ||
        loaded.skills.length !== explicitSkills.length ||
        new Set(loaded.skills.map((skill) => skill.name)).size !==
          loaded.skills.length
      )
        throw new Error(
          `Cannot load explicit skills for agent ${agent.name}: ${loaded.warnings.map((warning) => warning.message).join("; ") || "missing or duplicate skills"}`,
        );
      const inherited = noSkills
        ? []
        : (await discoverSkills(cwd, getAgentDir(), launchSettings.skills))
            .skills;
      const names = [
        ...new Set([...inherited, ...loaded.skills].map((skill) => skill.name)),
      ];
      overlay.skills = {
        ...launchSettings.skills,
        enabled: true,
        enableCodexUser: false,
        enableClaudeUser: false,
        enableClaudeProject: false,
        enablePiUser: false,
        enablePiProject: false,
        enableAgentsUser: false,
        enableAgentsProject: false,
        customDirectories: [staging],
        includeSkills: names.map((name) =>
          name.replace(/[\\*?[\]{}!]/gu, "\\$&"),
        ),
      };
      if (!noSkills) {
        // Preserve inherited skill paths explicitly rather than discovering
        // siblings of an explicitly selected file in the child.
        for (const [index, skill] of inherited.entries()) {
          const target = join(staging, `inherited-${index}`);
          symlinkSync(dirname(skill.filePath), target, "dir");
        }
      }
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  args.push("--herdsman-launch-policy", JSON.stringify(launchPolicy));
  if (Object.keys(overlay).length) {
    const [config] = writePrivatePromptSnapshots([JSON.stringify(overlay)]);
    options.temporaryPaths?.push(config!);
    args.push("--config", config!);
  }

  // A model whose provider comes from an extension cannot resolve inside a
  // child denied extension discovery, so the model's needs outrank the
  // definition's preference to stay lean.
  const extensionDiscovery =
    decision.kind === "use" && decision.extensionDiscovery;
  if (frontmatter.noExtensions && !extensionDiscovery)
    args.push("--no-extensions");
  for (const extension of frontmatter.extensions ?? [])
    args.push("--extension", extension);
  if (managedAgent) appended.push(`<active_agent name="${agent.name}"/>`);
  if (appended.length) {
    const [prompt] = writePrivatePromptSnapshots([appended.join("\n\n")]);
    options.temporaryPaths?.push(prompt!);
    args.push("--append-system-prompt", prompt!);
  }
  return args;
}

/** Precreate the session identity required by a durable Manager assignment. */
export function createOmpSessionFile(cwd: string, id: string): string {
  const directory = SessionManager.getDefaultSessionDir(cwd);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `${new Date().toISOString().replace(/[:.]/gu, "-")}_${id}.jsonl`,
  );
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id,
      timestamp: new Date().toISOString(),
      cwd: resolve(cwd),
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return path;
}

export type OmpLaunchPolicy = {
  tools: string[] | null;
  excluded: string[];
  noBuiltinTools: boolean;
  requiredTools: string[];
  skillDirectories: string[];
};

type OmpPolicyTool = { name: string; sourceInfo: { source: string } };

export function ompLaunchTools(
  value: OmpLaunchPolicy,
  tools: readonly OmpPolicyTool[],
): string[] {
  const requested = [
    ...value.requiredTools,
    ...(value.tools ?? []).filter(
      (name) => !name.includes("*") && !name.startsWith("mcp__"),
    ),
  ];
  const missing = requested.filter(
    (name) => !tools.some((tool) => tool.name === name),
  );
  if (missing.length)
    throw new Error(`Missing configured Herdsman tools: ${missing.join(", ")}`);
  return tools
    .filter((tool) => {
      if (value.requiredTools.includes(tool.name)) return true;
      if (value.noBuiltinTools && tool.sourceInfo.source === "builtin")
        return false;
      if (
        value.excluded.some((pattern) => matchesToolPattern(pattern, tool.name))
      )
        return false;
      return (
        value.tools === null ||
        value.tools.some((pattern) => matchesToolPattern(pattern, tool.name))
      );
    })
    .map((tool) => tool.name);
}

/** Install before role listeners so their baseline captures the restricted tools. */
export function registerOmpLaunchPolicy(pi: ExtensionAPI): void {
  pi.registerFlag("herdsman-launch-policy", {
    type: "string",
    description: "Herdsman child capability policy",
  });
  pi.registerFlag("herdsman-fast-mode", {
    type: "string",
    description: "Herdsman Agent launch fast policy (on/off)",
  });
  let cachedPolicy: OmpLaunchPolicy | null | undefined;
  const policy = (): OmpLaunchPolicy | undefined => {
    if (cachedPolicy !== undefined) return cachedPolicy ?? undefined;
    const value = pi.getFlag("herdsman-launch-policy");
    if (value === undefined) {
      cachedPolicy = null;
      return undefined;
    }
    if (typeof value !== "string")
      throw new Error("Invalid Herdsman launch policy");
    const parsed: unknown = JSON.parse(value);
    if (!isPlainObject(parsed))
      throw new Error("Invalid Herdsman launch policy");
    const stringArray = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === "string");
    if (
      (parsed.tools !== null && !stringArray(parsed.tools)) ||
      !stringArray(parsed.excluded) ||
      !stringArray(parsed.requiredTools) ||
      !stringArray(parsed.skillDirectories) ||
      typeof parsed.noBuiltinTools !== "boolean"
    )
      throw new Error("Invalid Herdsman launch policy");
    if (
      parsed.skillDirectories.some(
        (directory) =>
          dirname(resolve(directory)) !== resolve(herdsmanTempRoot()) ||
          !/^skills-[A-Za-z0-9]+$/u.test(basename(directory)),
      )
    )
      throw new Error("Invalid Herdsman skill directory");
    cachedPolicy = {
      tools: parsed.tools,
      excluded: parsed.excluded,
      noBuiltinTools: parsed.noBuiltinTools,
      requiredTools: parsed.requiredTools,
      skillDirectories: parsed.skillDirectories,
    };
    return cachedPolicy;
  };
  const applyPolicy = async (value: OmpLaunchPolicy) => {
    const selected = ompLaunchTools(value, pi.getAllTools());
    const active = new Set([...pi.getActiveTools(), ...value.requiredTools]);
    await pi.setActiveTools(
      value.tools === null
        ? selected.filter((name) => active.has(name))
        : selected,
    );
  };
  pi.on("session_start", async () => {
    const value = policy();
    if (value) await applyPolicy(value);
  });
  pi.on("before_agent_start", async (event) => {
    const value = policy();
    if (!value) return;
    // Native deferred MCP discovery can activate tools after session_start.
    await applyPolicy(value);
    const allowed = ompLaunchTools(value, pi.getAllTools());
    const active = pi.getActiveTools().filter((name) => allowed.includes(name));
    const routing = active.includes("bash")
      ? "Use permitted read/search tools for inspection; bounded bash is available only for work authorized by the assignment."
      : "The bash tool is unavailable; use permitted read/search tools for inspection.";
    // Native OMP carries prompt blocks; the legacy Pi type still declares a string.
    const nativeEvent = event as unknown as { systemPrompt: string[] };
    const systemPrompt = nativeEvent.systemPrompt;
    return {
      systemPrompt: [
        ...systemPrompt,
        `Effective Agent tool policy permits: ${JSON.stringify(allowed)}.\nActive top-level tools: ${JSON.stringify(active)}.\n${routing}\nTool-routing guidance applies only to permitted capabilities. Indirect MCP/device routes remain subject to the same Agent tool policy; a wrapper does not authorize its target.`,
      ],
    };
  });
  pi.on("tool_call", (event) => {
    const value = policy();
    if (!value) return;
    if (!ompLaunchTools(value, pi.getAllTools()).includes(event.toolName))
      return {
        block: true,
        reason: `Tool ${event.toolName} is denied by the Agent definition`,
      };
  });
  pi.on("session_shutdown", () => {
    for (const directory of policy()?.skillDirectories ?? [])
      rmSync(directory, { recursive: true, force: true });
  });
}
