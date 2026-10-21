import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
// This check must exercise the native host's legacy-module loading boundary.
const definitions = (await loadLegacyPiModule(
  join(repository, "extension/agent-definitions.ts"),
)) as typeof DefinitionModule;
const directory = await mkdtemp(join(tmpdir(), "herdsman-native-tools-"));
const temporaryPaths: string[] = [];
const runtimeDirectories: string[] = [];
const provider = join(directory, "provider.ts");
const sentinel = "NATIVE_READ_CONTENT_OK";
const inputFile = join(directory, "input.txt");

try {
  await writeFile(inputFile, sentinel);
  await writeFile(
    provider,
    `
import assert from "node:assert/strict";
import { contentText } from "@earendil-works/pi-ai";
export default function(pi) {
  const expected = JSON.parse(process.env.OMP_CHECK_TOOLS);
  const tool = process.env.OMP_CHECK_TOOL;
  const model = {id:"check",name:"check",api:"herdsman-tools-check-api",provider:"herdsman-tools-check",baseUrl:"https://invalid.local",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:4096};
  pi.registerProvider(model.provider, {api:model.api,baseUrl:model.baseUrl,apiKey:"local-check-only",models:[model],streamSimple:(_model,context)=>{
    assert.deepEqual(pi.getActiveTools().sort(), [...expected].sort(), "configured tools must be executable, without unrelated defaults");
    const result = context.messages.findLast(message => message.role === "toolResult" && message.toolName === tool);
    if (result) {
      assert.notEqual(result.isError, true, contentText(result.content, ""));
      assert.ok(contentText(result.content, "").includes(process.env.OMP_CHECK_OUTPUT));
    }
    const content = !tool || result
      ? [{type:"text",text:"OMP_TOOL_EXECUTION_OK"}]
      : [{type:"toolCall",id:"native-tool-check",name:tool,arguments:tool === "bash" ? {command:"pwd",timeout:5} : {path:process.env.OMP_CHECK_INPUT}}];
    const message = {role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:content[0].type === "toolCall" ? "toolUse" : "stop",timestamp:Date.now()};
    return {result:async()=>message,async *[Symbol.asyncIterator](){
      yield {type:"start",partial:message};
      const block=content[0];
      if(block.type === "toolCall") yield {type:"toolcall_end",contentIndex:0,toolCall:block,partial:message};
      else {
        yield {type:"text_start",contentIndex:0,partial:message};
        yield {type:"text_delta",contentIndex:0,delta:block.text,partial:message};
        yield {type:"text_end",contentIndex:0,content:block.text,partial:message};
      }
      yield {type:"done",reason:message.stopReason,message};
    }};
  }});
}
`,
  );
  for (const name of ["generalist", "scout", "empty"] as const) {
    const path = join(
      repository,
      "extension/agent-definitions",
      `${name === "empty" ? "generalist" : name}.md`,
    );
    const parsed = parseFrontmatter<Frontmatter>(await readFile(path, "utf8"));
    const definition: AgentDefinition = {
      name,
      path,
      frontmatter:
        name === "empty"
          ? { ...parsed.frontmatter, noTools: true, tools: [] }
          : parsed.frontmatter,
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
    const tool =
      name === "generalist" ? "bash" : name === "scout" ? "read" : "";
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
          PI_CODING_AGENT_DIR: join(directory, "agent"),
          OMP_CHECK_TOOLS: JSON.stringify(definition.frontmatter.tools),
          OMP_CHECK_TOOL: tool,
          OMP_CHECK_OUTPUT: tool === "bash" ? directory : sentinel,
          OMP_CHECK_INPUT: inputFile,
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
    if (tool)
      assert.ok(
        messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === tool &&
            !message.isError,
        ),
        `${name}: missing successful ${tool} result`,
      );
    console.log(`Native OMP ${name}: ${tool || "no tools"} policy passed`);
  }
} finally {
  for (const path of [...temporaryPaths, ...runtimeDirectories, directory])
    await rm(path, { recursive: true, force: true });
}
