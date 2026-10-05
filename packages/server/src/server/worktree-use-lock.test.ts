import { describe, expect, it } from "vitest";
import {
  assertWorktreeNotCleaningUp,
  withWorktreeCleanupReservation,
  withWorktreeProjectLock,
} from "./worktree-use-lock.js";

async function checkAgentStartGuard(path: string): Promise<void> {
  await withWorktreeProjectLock("/tmp/worktree-project", async () => {
    expect(() => assertWorktreeNotCleaningUp(`${path}/subproject`)).toThrow(
      "Worktree is cleaning up",
    );
  });
}

describe("worktree project lock", () => {
  it("waits for a creation before allowing cleanup in the same project", async () => {
    let releaseCreation!: () => void;
    const creationHeld = new Promise<void>((done) => {
      releaseCreation = done;
    });
    let creationStarted!: () => void;
    const started = new Promise<void>((done) => {
      creationStarted = done;
    });
    const order: string[] = [];
    const creation = withWorktreeProjectLock("/tmp/worktree-project", async () => {
      order.push("creation started");
      creationStarted();
      await creationHeld;
      order.push("creation finished");
    });
    await started;
    const cleanup = withWorktreeProjectLock("/tmp/worktree-project", async () => {
      order.push("cleanup started");
    });
    await Promise.resolve();
    expect(order).toEqual(["creation started"]);
    releaseCreation();
    await Promise.all([creation, cleanup]);
    expect(order).toEqual(["creation started", "creation finished", "cleanup started"]);
  });

  it("blocks an agent start inside a reserved worktree while the project lock is free", async () => {
    const path = "/tmp/worktree-project/reserved";
    await withWorktreeCleanupReservation(path, async () => {
      await checkAgentStartGuard(path);
    });
    expect(() => assertWorktreeNotCleaningUp(`${path}/subproject`)).not.toThrow();
  });
});
