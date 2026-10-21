import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import type * as DefinitionModule from "../extension/agent-definitions.ts";
import type {
  AgentDefinition,
  Frontmatter,
} from "../extension/agent-definitions.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
// Exercise the native host's legacy-module loading and provider request boundaries.
const definitions = (await loadLegacyPiModule(
  join(repository, "extension/agent-definitions.ts"),
)) as typeof DefinitionModule;
const directory = await mkdtemp(join(tmpdir(), "herdsman-native-tools-"));
const temporaryPaths: string[] = [];
const runtimeDirectories: string[] = [];
const provider = join(directory, "provider.ts");
const agentDirectory = join(directory, "agent");
const mcpServer = join(directory, "mcp-server.mjs");
const mcpCalls = join(directory, "mcp-calls.jsonl");
const sentinel = "NATIVE_READ_CONTENT_OK";
const mcpSentinel = "NATIVE_MCP_CONTENT_OK";
const inputFile = join(directory, "input.txt");
type Step = {
  tool: string;
  arguments: Record<string, unknown>;
  error?: boolean;
  output?: string;
};
type WireRequest = {
  tools?: Array<{ type: string; function: { name: string } }>;
  messages: Array<{
    role: string;
    tool_call_id?: string;
    content: string | Array<{ text?: string }> | null;
  }>;
};
let current:
  | {
      direct: string[];
      permitted: string[];
      steps: Step[];
      next: number;
    }
  | undefined;
const providerFailures: unknown[] = [];
// Use OMP's actual OpenAI-compatible serializer and stream parser, not a custom
// streamSimple implementation that could conceal provider/host surface drift.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    try {
      assert.ok(current);
      const payload: WireRequest = await request.json();
      assert.ok(Array.isArray(payload.messages));
      assert.deepEqual(
        (payload.tools ?? []).map((tool) => tool.function.name).sort(),
        [...current.direct].sort(),
        "provider-visible schemas must match the restricted top-level surface",
      );
      const text = (content: WireRequest["messages"][number]["content"]) =>
        typeof content === "string"
          ? content
          : (content ?? []).map((block) => block.text ?? "").join("\n");
      const prompt = payload.messages
        .filter((message) => ["system", "developer"].includes(message.role))
        .map((message) => text(message.content))
        .join("\n");
      const summary = prompt.match(
        /Effective Agent tool policy permits: (\[[^\n]*\])\./,
      );
      assert.ok(
        summary,
        "provider must receive the effective capability summary",
      );
      assert.deepEqual(
        JSON.parse(summary[1]!).sort(),
        [...current.permitted].sort(),
      );
      if (current.next > 0) {
        const previous = current.steps[current.next - 1]!;
        const previousId = `native-tool-check-${current.next - 1}`;
        const result = payload.messages.findLast(
          (message) =>
            message.role === "tool" && message.tool_call_id === previousId,
        );
        assert.ok(
          result,
          "executed tool result must cross the provider boundary",
        );
        if (previous.output)
          assert.ok(
            text(result.content).includes(previous.output),
            text(result.content),
          );
      }
      const step = current.steps[current.next];
      const delta = step
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `native-tool-check-${current.next++}`,
                type: "function",
                function: {
                  name: step.tool,
                  arguments: JSON.stringify(step.arguments),
                },
              },
            ],
          }
        : { role: "assistant", content: "OMP_TOOL_EXECUTION_OK" };
      const chunk = (delta: unknown, finish_reason: string | null) => ({
        id: "native-provider-check",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "check",
        choices: [{ index: 0, delta, finish_reason }],
      });
      return new Response(
        `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, step ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } catch (error) {
      providerFailures.push(error);
      return Response.json(
        { error: { message: String(error) } },
        { status: 500 },
      );
    }
  },
});

try {
  await mkdir(agentDirectory);
  await writeFile(inputFile, sentinel);
  await writeFile(mcpCalls, "");
  // Real stdio MCP transport; the call log proves denied targets never execute.
  await writeFile(
    mcpServer,
    `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"check",version:"1"}};
  else if (request.method === "tools/list") result = {tools:["allowed","denied"].map(name => ({name,description:"Native policy check " + name,inputSchema:{type:"object",properties:{}}}))};
  else if (request.method === "tools/call") {
    appendFileSync(process.argv[2], JSON.stringify(request.params) + "\\n");
    result = {content:[{type:"text",text:${JSON.stringify(mcpSentinel)}}]};
  } else if (request.method === "ping") result = {};
  else {
    console.log(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32601,message:"Method not found"}}));
    continue;
  }
  console.log(JSON.stringify({jsonrpc:"2.0",id:request.id,result}));
}
`,
  );
  await writeFile(
    join(agentDirectory, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        check: { command: "node", args: [mcpServer, mcpCalls] },
      },
    }),
  );
  await writeFile(
    provider,
    `
import assert from "node:assert/strict";
// No custom stream: OMP must serialize requests and parse the local SSE response.
export default function(pi) {
  const expected = JSON.parse(process.env.OMP_CHECK_DIRECT_TOOLS);
  const model = {id:"check",name:"check",api:"openai-completions",provider:"herdsman-tools-check",baseUrl:process.env.OMP_CHECK_BASE_URL,reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:4096};
  pi.registerProvider(model.provider, {api:model.api,baseUrl:model.baseUrl,apiKey:"local-check-only",models:[model]});
  pi.on("before_agent_start", () => {
    assert.deepEqual(pi.getActiveTools().sort(), [...expected].sort(), "native top-level execution surface");
  });
}
`,
  );
  for (const name of ["generalist", "scout", "empty", "mcp"] as const) {
    const path = join(
      repository,
      "extension/agent-definitions",
      `${name === "scout" ? name : "generalist"}.md`,
    );
    const parsed = parseFrontmatter<Frontmatter>(await readFile(path, "utf8"));
    const frontmatter: Frontmatter =
      name === "empty"
        ? { ...parsed.frontmatter, noTools: true, tools: [] }
        : name === "mcp"
          ? {
              ...parsed.frontmatter,
              tools: ["read", "write", "mcp__check_allowed"],
              excludeTools: ["mcp__check_denied"],
            }
          : parsed.frontmatter;
    const definition: AgentDefinition = {
      name,
      path,
      frontmatter,
      body: parsed.body,
    };
    const bodyPromptPath = join(directory, `${name}.prompt`);
    await writeFile(bodyPromptPath, definition.body);
    const args = await definitions.agentLaunchArgs(definition, {
      cwd: directory,
      bodyPromptPath,
      temporaryPaths,
      runtimeDirectories,
    });
    const deniedBash: Step = {
      tool: "bash",
      arguments: { command: "pwd", timeout: 5 },
      error: true,
    };
    const steps: Step[] =
      name === "generalist"
        ? [{ ...deniedBash, error: false, output: directory }]
        : name === "scout"
          ? [
              deniedBash,
              {
                tool: "read",
                arguments: { path: inputFile },
                output: sentinel,
              },
            ]
          : name === "empty"
            ? [deniedBash]
            : [
                {
                  tool: "read",
                  arguments: { path: "xd://mcp__check_allowed" },
                  output: "Native policy check allowed",
                },
                {
                  tool: "write",
                  arguments: { path: "xd://mcp__check_allowed", content: "{}" },
                  output: mcpSentinel,
                },
                {
                  tool: "write",
                  arguments: { path: "xd://mcp__check_denied", content: "{}" },
                  error: true,
                },
              ];
    current = {
      direct: name === "mcp" ? ["read", "write"] : frontmatter.tools!,
      permitted: frontmatter.tools!,
      steps,
      next: 0,
    };
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("PI_HERDSMAN_") &&
          !key.startsWith("HERDR_") &&
          key !== "PI_PROFILE" &&
          key !== "PI_SUBAGENT_PARENT_SESSION",
      ),
    );
    // Approval applies only to this isolated check; production launch policy is unchanged.
    const child = Bun.spawn(
      [
        "omp",
        "--mode",
        "json",
        "--no-session",
        "--no-title",
        "--auto-approve",
        "--cwd",
        directory,
        "-e",
        join(repository, "dist/index.js"),
        "-e",
        provider,
        "--model",
        "herdsman-tools-check/check",
        ...args,
        "-p",
        "Run the configured native-tool check.",
      ],
      {
        cwd: directory,
        env: {
          ...env,
          PI_CODING_AGENT_DIR: agentDirectory,
          OMP_CHECK_DIRECT_TOOLS: JSON.stringify(
            name === "mcp" ? ["read", "write"] : frontmatter.tools,
          ),
          OMP_CHECK_BASE_URL: new URL("v1", server.url).href,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill(), 20_000);
    let stdout: string;
    let stderr: string;
    let exit: number;
    try {
      [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(providerFailures, [], `${name}: native provider failures`);
    assert.equal(
      current.next,
      steps.length,
      `${name}: incomplete tool sequence`,
    );
    assert.equal(exit, 0, `${name}: ${stderr}\n${stdout}`);
    assert.doesNotMatch(
      stdout + stderr,
      /Missing configured Herdsman tools/,
      name,
    );
    const records = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const messages = records
      .filter((record) => record.type === "message_end")
      .map((record) => record.message);
    assert.ok(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (block: { type: string; text?: string }) =>
              block.type === "text" && block.text === "OMP_TOOL_EXECUTION_OK",
          ),
      ),
      `${name}: ${stdout}\n${stderr}`,
    );
    for (const [index, step] of steps.entries())
      assert.ok(
        messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === `native-tool-check-${index}` &&
            message.toolName === step.tool &&
            (message.isError === true) === (step.error === true),
        ),
        `${name}: missing ${step.error ? "rejected" : "successful"} ${step.tool} result at step ${index}`,
      );
    console.log(
      `Native OMP ${name}: provider surface and execution policy passed`,
    );
  }
  assert.deepEqual(
    (await readFile(mcpCalls, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).name),
    ["allowed"],
    "only the permitted indirect MCP target may reach the server",
  );
} finally {
  server.stop(true);
  for (const path of [...temporaryPaths, ...runtimeDirectories, directory])
    await rm(path, { recursive: true, force: true });
}
