export type NotificationObservation = {
  session: string;
  /** Undefined means managed, unverified, or ambiguous. Changes establish a new baseline. */
  authority?: string;
  role: "Lead" | "Manager" | "Chief";
  enabled: boolean;
  state: "idle" | "working" | "blocked" | "unknown";
  sequence: number;
  completion?: number;
  semanticCompletion?: number;
  inputEpisode?: number;
  completionAllowed: boolean;
};

type Notification = { title: string; body: string };
type Host = {
  current(): Promise<NotificationObservation | undefined>;
  send(message: Notification): Promise<void>;
  report(error: unknown): void;
  schedule?(callback: () => void, delay: number): () => void;
};

export type NotificationPolicy = {
  observe(
    current: NotificationObservation | undefined,
    baseline?: boolean,
  ): void;
  cancelPending(): void;
  inputResolved(): void;
  report(error: unknown): void;
  dispose(): void;
};
/** Semantic transitions only: restored state and eligibility changes are baselines, never events. */
export function createNotificationPolicy(host: Host): NotificationPolicy {
  let previous: NotificationObservation | undefined;
  let consumedCompletion: NotificationObservation | undefined;
  let pendingCompletion: NotificationObservation | undefined;
  let cancel: (() => void) | undefined;
  let generation = 0;
  let disposed = false;
  let reported = false;
  const invalidate = () => {
    generation++;
    cancel?.();
    cancel = undefined;
    pendingCompletion = undefined;
  };
  const report = (error: unknown) => {
    if (reported || disposed) return;
    reported = true;
    host.report(error);
  };
  const schedule =
    host.schedule ??
    ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const sameAuthority = (
    a: NotificationObservation,
    b: NotificationObservation,
  ) =>
    a.session === b.session &&
    a.authority === b.authority &&
    a.role === b.role &&
    a.enabled === b.enabled;

  return {
    observe(current: NotificationObservation | undefined, baseline = false) {
      if (disposed) return;
      const before = previous;
      previous = current;
      if (!current || !before || baseline || !sameAuthority(before, current)) {
        invalidate();
        if (current?.completion !== undefined) consumedCompletion = current;
        return;
      }
      const needsInput =
        current.state === "blocked" &&
        (before.state !== "blocked" ||
          before.inputEpisode !== current.inputEpisode);
      if (
        current.state !== before.state ||
        current.completion !== before.completion ||
        (pendingCompletion &&
          (current.sequence !== pendingCompletion.sequence ||
            current.semanticCompletion !==
              pendingCompletion.semanticCompletion)) ||
        !current.enabled ||
        !current.authority ||
        (!current.completionAllowed && current.state !== "blocked")
      )
        invalidate();
      const completed =
        current.state === "idle" &&
        current.completionAllowed &&
        current.completion !== undefined &&
        (current.session !== consumedCompletion?.session ||
          current.completion !== consumedCompletion.completion) &&
        (current.session !== pendingCompletion?.session ||
          current.completion !== pendingCompletion.completion);
      if (
        current.completion !== undefined &&
        (!current.enabled || !current.authority || !current.completionAllowed)
      )
        consumedCompletion = current;
      if (!current.enabled || !current.authority || (!completed && !needsInput))
        return;
      invalidate();
      pendingCompletion = completed ? current : undefined;
      const ticket = generation;
      cancel = schedule(() => {
        cancel = undefined;
        void (async () => {
          try {
            const latest = await host.current();
            if (disposed || ticket !== generation) return;
            if (
              !latest ||
              !sameAuthority(current, latest) ||
              !latest.enabled ||
              !latest.authority ||
              (!needsInput && !latest.completionAllowed)
            ) {
              if (!needsInput) consumedCompletion = current;
              return;
            }
            if (
              needsInput
                ? latest.state !== "blocked" ||
                  latest.inputEpisode !== current.inputEpisode
                : latest.state !== "idle" ||
                  latest.completion !== current.completion ||
                  latest.sequence !== current.sequence ||
                  latest.semanticCompletion !== current.semanticCompletion
            )
              return;
            // A delayed semantic Working report may cancel a pending candidate.
            // Consume native completion only once revalidation admits delivery.
            if (!needsInput) consumedCompletion = current;
            await host.send({
              title: `Herdsman · ${latest.role}`,
              body: `Session ${latest.session} ${needsInput ? "needs input" : "completed"}.`,
            });
          } catch (error) {
            if (!needsInput) consumedCompletion = current;
            report(error);
          } finally {
            if (ticket === generation) pendingCompletion = undefined;
          }
        })();
      }, 1000);
    },
    report,
    dispose() {
      disposed = true;
      previous = undefined;
      invalidate();
    },
    cancelPending: invalidate,
    inputResolved() {
      if (previous?.state === "blocked") invalidate();
    },
  };
}
