import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parseControlMarker } from "./mailbox.ts";

interface RuntimeEvent {
  type: string;
  text?: string;
  message?: AgentMessage;
  messages?: AgentMessage[];
  willContinue?: boolean;
  reason?: string;
  result?: unknown;
  errorMessage?: string;
  aborted?: boolean;
  [key: string]: unknown;
}
interface InputResult {
  action?: "continue" | "handled" | "transform";
  text?: string;
  images?: unknown[];
}
type Handler = (event: RuntimeEvent, ctx: ExtensionContext) => unknown;
type Register = (name: string, handler: Handler) => void;

function outcome(message: AgentMessage | undefined) {
  if (message?.role !== "assistant") return "error";
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "error") return "error";
  return message.stopReason === "toolUse" ? "continue" : "completed";
}

function turnEvidence(event: RuntimeEvent, ctx: ExtensionContext) {
  const message = event.message;
  const entry =
    message?.role === "assistant"
      ? ctx.sessionManager
          .getBranch()
          .findLast(
            (candidate) =>
              candidate.type === "message" &&
              candidate.message.role === "assistant" &&
              candidate.message.timestamp === message.timestamp,
          )
      : undefined;
  return { ...event, outcome: outcome(message), messageEntryId: entry?.id };
}

/** Translate the orchestration lifecycle at the OMP boundary, not in mailbox policy. */
export function registerOmpRuntime(pi: ExtensionAPI) {
  // The host dispatches structurally typed events; the upstream overload union
  // does not include native OMP lifecycle names.
  const on = pi.on.bind(pi) as unknown as Register;
  const inputHandlers: Array<
    (event: RuntimeEvent, ctx: ExtensionContext) => InputResult
  > = [];
  let context: ExtensionContext | undefined;
  let compactionReason = "manual";
  const compactionFailures: Handler[] = [];
  on("session_start", (_event, ctx) => {
    context = ctx;
  });
  on("auto_compaction_start", (event) => {
    compactionReason = event.reason ?? "threshold";
  });
  on("auto_compaction_end", async (event, ctx) => {
    try {
      if (!event.result && (event.errorMessage || event.aborted))
        for (const handler of compactionFailures)
          await handler({ ...event, reason: compactionReason }, ctx);
    } finally {
      compactionReason = "manual";
    }
  });
  const register: Register = (name, handler) => {
    if (name === "input") {
      const input = handler as unknown as (
        event: RuntimeEvent,
        ctx: ExtensionContext,
      ) => InputResult;
      inputHandlers.push(input);
      on(name, (event, ctx) => {
        const result = input(event, ctx);
        if (result?.action === "handled") return { handled: true };
        if (result?.action === "transform")
          return { text: result.text, images: result.images };
      });
    } else if (name === "turn_end") {
      on(name, (event, ctx) => handler(turnEvidence(event, ctx), ctx));
    } else if (name === "agent_settled" || name === "agent_before_settle") {
      on("agent_end", (event, ctx) => {
        if (event.willContinue || ctx.hasPendingMessages()) return;
        const message = event.messages?.findLast(
          (candidate) => candidate.role === "assistant",
        );
        const status = outcome(message);
        return handler(
          {
            ...event,
            type: name,
            outcome: status,
            aborted: status === "aborted",
          },
          ctx,
        );
      });
    } else if (name === "session_before_fork") {
      on("session_before_branch", handler);
    } else if (name === "session_before_compact") {
      on(name, (event, ctx) =>
        handler(
          {
            ...event,
            reason: compactionReason,
            willRetry: compactionReason === "overflow",
          },
          ctx,
        ),
      );
    } else if (name === "session_compact_failed") {
      compactionFailures.push(handler);
    } else {
      on(name, handler);
    }
  };
  pi.on = register as unknown as ExtensionAPI["on"];

  const sendUserMessage = pi.sendUserMessage.bind(pi);
  pi.sendUserMessage = (content, options) => {
    if (typeof content !== "string" || !parseControlMarker(content)) {
      sendUserMessage(content, options);
      return;
    }
    if (!context)
      throw new Error("Herdsman mailbox delivery precedes session startup");
    let text = content;
    for (const handler of inputHandlers) {
      const result = handler(
        { type: "input", text, source: "extension" },
        context,
      );
      if (result?.action === "handled") return;
      if (result?.action === "transform" && result.text !== undefined)
        text = result.text;
    }
    // OMP programmatic prompts bypass input hooks; the mailbox handler above is
    // the single acceptance gate. Explicit steer would strand idle requests.
    sendUserMessage(text, context.isIdle() ? undefined : options);
  };

  const registerTool = pi.registerTool.bind(pi);
  let toolQueue = Promise.resolve();
  pi.registerTool = (tool) =>
    registerTool({
      ...tool,
      defaultInactive: tool.defaultActive === false,
      loadMode: "essential",
      description: [tool.description, ...(tool.promptGuidelines ?? [])].join(
        "\n\n",
      ),
      execute: (id, params, signal, update, ctx) => {
        if (tool.executionMode !== "sequential")
          return tool.execute(id, params, signal, update, ctx);
        const run = toolQueue.then(() => {
          if (signal?.aborted)
            throw new DOMException("Tool call aborted", "AbortError");
          return tool.execute(id, params, signal, update, ctx);
        });
        toolQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    });
}
