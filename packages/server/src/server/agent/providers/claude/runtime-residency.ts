import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type BackgroundTasksChangedMessage = Extract<
  SDKMessage,
  { type: "system"; subtype: "background_tasks_changed" }
>;

// Claude Code reports live background work two ways: every Stop hook input carries the whole
// inventory (background tasks and session crons), and `background_tasks_changed` replaces the task
// set whenever it changes. Neither is sent when the CLI process starts, and CLIs that predate them
// never send them, so an empty set means nothing until a Stop hook in the current process has
// reported both fields. Session-scoped permission grants also live only in the process.
export class ClaudeRuntimeResidency {
  private inventoryReported = false;
  private liveTaskIds = new Set<string>();
  private sessionCronCount = 0;
  private holdsSessionPermissions = false;

  observeStopHook(input: unknown): void {
    const record = typeof input === "object" && input !== null ? input : {};
    const tasks = (record as { background_tasks?: unknown }).background_tasks;
    const crons = (record as { session_crons?: unknown }).session_crons;
    if (!Array.isArray(tasks) || !Array.isArray(crons)) {
      this.inventoryReported = false;
      return;
    }
    this.inventoryReported = true;
    this.liveTaskIds = new Set(
      tasks.flatMap((task) => {
        const id = (task as { id?: unknown } | null)?.id;
        return typeof id === "string" ? [id] : [];
      }),
    );
    this.sessionCronCount = crons.length;
  }

  observeMessage(message: SDKMessage): void {
    if (message.type !== "system" || message.subtype !== "background_tasks_changed") return;
    const { tasks } = message as BackgroundTasksChangedMessage;
    this.liveTaskIds = new Set(tasks.map((task) => task.task_id));
  }

  observePermissionUpdates(updates: readonly { destination?: unknown }[] | undefined): void {
    if (updates?.some((update) => update.destination === "session")) {
      this.holdsSessionPermissions = true;
    }
  }

  reset(): void {
    this.inventoryReported = false;
    this.liveTaskIds = new Set();
    this.sessionCronCount = 0;
    this.holdsSessionPermissions = false;
  }

  canRelease(): boolean {
    return (
      this.inventoryReported &&
      this.liveTaskIds.size === 0 &&
      this.sessionCronCount === 0 &&
      !this.holdsSessionPermissions
    );
  }
}
