import { createConnection, type Socket } from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentEndEvent } from "@oh-my-pi/pi-coding-agent";
import { sendDesktopNotification } from "./desktop-notifications.ts";
import {
  createNotificationPolicy,
  type NotificationObservation,
  type NotificationPolicy,
} from "./notification-policy.ts";

type Host = {
  enabled(): boolean;
  current(
    ctx: ExtensionContext,
  ): Promise<Omit<NotificationObservation, "completionAllowed"> | undefined>;
};

/** Observe Herdr's existing semantic reporting; never write pane state or desktop settings. */
export function registerDesktopNotifications(
  pi: ExtensionAPI,
  host: Host,
): void {
  let context: ExtensionContext | undefined;
  let latestContext: ExtensionContext | undefined;
  let refreshCurrent: (() => void) | undefined;
  let socket: Socket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let sessionGeneration = 0;
  let stopped = true;
  let terminalCompletion = false;
  let activeWork = false;
  let workGeneration = 0;
  let policy: NotificationPolicy | undefined;
  let setupReported = false;

  const stop = () => {
    stopped = true;
    sessionGeneration++;
    clearTimeout(reconnect);
    reconnect = undefined;
    socket?.destroy();
    socket = undefined;
    policy?.dispose();
    policy = undefined;
    context = undefined;
    terminalCompletion = false;
    activeWork = false;
    refreshCurrent = undefined;
  };
  const start = (ctx: ExtensionContext) => {
    stop();
    if (!ctx.hasUI) return;
    try {
      if (!host.enabled()) return;
    } catch (error) {
      if (!setupReported) {
        setupReported = true;
        ctx.ui.notify(
          `Desktop notifications: ${String(error).slice(0, 600)}`,
          "warning",
        );
      }
      return;
    }
    const endpoint = process.env.HERDR_SOCKET_PATH;
    const pane = process.env.HERDR_PANE_ID;
    if (!endpoint || !pane) return;
    context = ctx;
    stopped = false;
    const sessionId = ctx.sessionManager.getSessionId();
    activeWork = !ctx.isIdle();
    if (activeWork) workGeneration++;
    const generation = sessionGeneration;
    let inputEpisode = 0;
    const current = async () => {
      const work = workGeneration;
      const input = inputEpisode;
      const observation = await host.current(ctx);
      if (
        stopped ||
        generation !== sessionGeneration ||
        work !== workGeneration ||
        observation?.session !== sessionId
      )
        return undefined;
      if (ctx.hasPendingMessages()) {
        terminalCompletion = false;
        policy?.cancelPending();
      }
      const completionAllowed =
        terminalCompletion && ctx.isIdle() && !ctx.hasPendingMessages();
      return (
        observation && {
          ...observation,
          inputEpisode: input,
          completion: completionAllowed ? workGeneration : undefined,
          completionAllowed,
        }
      );
    };
    const activePolicy = createNotificationPolicy({
      current,
      send: sendDesktopNotification,
      report: (error) =>
        ctx.ui.notify(
          `Desktop notifications: ${String(error)
            .replace(/^Error: /, "")
            .slice(0, 600)}`,
          "warning",
        ),
    });
    policy = activePolicy;
    let refreshing = false;
    let dirty = false;
    let baseline = true;
    // Snapshot reads may finish after a new native terminal event. Only native
    // completions already present at the reconciliation boundary are historical.
    let baselineCompletion: number | undefined;
    let subscribedOnce = false;
    let connectionGeneration = 0;
    const refresh = async () => {
      dirty = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (dirty && !stopped && generation === sessionGeneration) {
          dirty = false;
          const connection = connectionGeneration;
          const input = inputEpisode;
          const isBaseline = baseline;
          const historicalCompletion = baselineCompletion;
          baseline = false;
          try {
            const observation = await current();
            if (connection !== connectionGeneration || input !== inputEpisode)
              continue;
            if (
              isBaseline &&
              observation?.completion !== undefined &&
              observation.completion !== historicalCompletion
            ) {
              activePolicy.observe(
                {
                  ...observation,
                  completion: historicalCompletion,
                  completionAllowed: false,
                },
                true,
              );
              activePolicy.observe(observation);
            } else activePolicy.observe(observation, isBaseline);
          } catch (error) {
            activePolicy.observe(undefined);
            activePolicy.report(error);
          }
        }
      } finally {
        refreshing = false;
      }
    };
    refreshCurrent = () => {
      void refresh();
    };
    const connect = () => {
      if (stopped || generation !== sessionGeneration) return;
      let buffer = "";
      let subscribed = false;
      const connection = createConnection(endpoint);
      socket = connection;
      connection.unref();
      connection.setEncoding("utf8");
      connection.setTimeout(3000, () =>
        connection.destroy(
          new Error(
            "Herdr notification subscription timed out after 3 seconds",
          ),
        ),
      );
      connection.once("connect", () =>
        connection.write(
          `${JSON.stringify({
            id: "herdsman:notifications",
            method: "events.subscribe",
            params: {
              subscriptions: [
                { type: "pane.agent_status_changed", pane_id: pane },
                { type: "pane.agent_detected" },
                { type: "pane.closed" },
                { type: "pane.exited" },
              ],
            },
          })}\n`,
        ),
      );
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          connection.destroy(
            new Error("Herdr notification event buffer exceeded 1 MiB"),
          );
          return;
        }
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (!subscribed) {
              if (
                message.id !== "herdsman:notifications" ||
                message.result?.type !== "subscription_started"
              )
                throw new Error(
                  "Herdr notification subscription unavailable; use Herdr with events.subscribe support",
                );
              subscribed = true;
              connection.setTimeout(0);
              if (subscribedOnce) {
                connectionGeneration++;
                baseline = true;
                baselineCompletion = terminalCompletion
                  ? workGeneration
                  : undefined;
              }
              subscribedOnce = true;
              void refresh();
            } else if (message.error) {
              throw new Error(
                `Herdr notification subscription lost: ${message.error.code ?? "unknown"}`,
              );
            } else if (message.data?.pane_id === pane) {
              const status = message.data.agent_status;
              if (
                message.event === "pane.agent_status_changed" &&
                ["idle", "working", "done", "unknown"].includes(status)
              ) {
                // Resolution invalidates the input episode before any asynchronous
                // inventory read can coalesce it with a later blocked episode.
                inputEpisode++;
                activePolicy.inputResolved();
              }
              void refresh();
            }
          } catch (error) {
            connection.destroy(
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
        }
      });
      connection.on("error", (error) =>
        activePolicy.report(
          new Error(
            `Cannot observe Herdr notifications at ${endpoint}: ${error.message}`,
          ),
        ),
      );
      connection.once("close", () => {
        connectionGeneration++;
        baseline = true;
        baselineCompletion = terminalCompletion ? workGeneration : undefined;
        activePolicy.observe(undefined);
        if (socket === connection) socket = undefined;
        if (stopped || generation !== sessionGeneration) return;
        activePolicy.report(
          new Error(
            "Herdr notification subscription disconnected; reconnecting without replay. Check the Herdr server if this persists.",
          ),
        );
        reconnect = setTimeout(connect, 1000);
        reconnect.unref();
      });
    };
    connect();
  };

  pi.on("session_start", (_event, ctx) => {
    latestContext = ctx;
    start(ctx);
  });
  pi.on("session_switch", (_event, ctx) => {
    latestContext = ctx;
    start(ctx);
  });
  const unsubscribe = pi.events.on("pi-herdsman:desktop-notifications", () => {
    if (latestContext) start(latestContext);
  });
  pi.on("session_shutdown", () => {
    stop();
    latestContext = undefined;
    unsubscribe?.();
  });
  pi.on("agent_start", (_event, ctx) => {
    terminalCompletion = false;
    policy?.cancelPending();
    // Opting in takes effect for future work, without replaying the previous idle state.
    if (!context) start(ctx);
    activeWork = true;
    workGeneration++;
    refreshCurrent?.();
  });
  pi.on("agent_end", (event, ctx) => {
    if (
      !context ||
      ctx.sessionManager.getSessionId() !==
        context.sessionManager.getSessionId() ||
      !activeWork
    )
      return;
    // Herdsman's public Pi type omits native OMP continuation flags.
    const native = event as unknown as AgentEndEvent;
    const message = native.messages?.findLast(
      (candidate) => candidate.role === "assistant",
    );
    terminalCompletion =
      !native.willContinue &&
      !native.awaitingAsyncWork &&
      !ctx.hasPendingMessages() &&
      message?.role === "assistant" &&
      !["error", "aborted", "toolUse"].includes(message.stopReason);
    if (!terminalCompletion) policy?.cancelPending();
    activeWork = false;
    refreshCurrent?.();
  });
}
