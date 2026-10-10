import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushGitCommandTrace } from "./git-command-trace.js";
import { runGitCommand, runGitCommandToFile } from "./run-git-command.js";

describe("git command trace", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("writes one asynchronous settlement record for a real git process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-git-trace-"));
    tempDirectories.push(directory);
    const tracePath = path.join(directory, "git.jsonl");
    vi.stubEnv("PASEO_GIT_TRACE_FILE", tracePath);

    await runGitCommand(["--version"], { cwd: directory });
    await flushGitCommandTrace();

    const events = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "git_command",
      event: "settled",
      args: ["--version"],
      cwd: directory,
      queue: {
        submitted: { active: 0, pending: 0 },
        started: expect.objectContaining({
          active: expect.any(Number),
          pending: expect.any(Number),
        }),
      },
      queueWaitMs: expect.any(Number),
      spawnCallMs: expect.any(Number),
      pid: expect.any(Number),
      outcome: "closed",
      exitCode: 0,
      signal: null,
      durationMs: expect.any(Number),
    });
  });

  it("streams binary Git output to a file without returning an in-memory copy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-git-stream-"));
    tempDirectories.push(directory);
    const outputPath = path.join(directory, "blob");
    const content = Buffer.alloc(2 * 1024 * 1024, 0xab);
    await runGitCommand(["init", "--template="], { cwd: directory });
    const object = await runGitCommand(["hash-object", "-w", "--stdin"], {
      cwd: directory,
      input: content,
    });
    const result = await runGitCommandToFile(["cat-file", "blob", object.stdout.trim()], {
      cwd: directory,
      outputPath,
    });
    expect(result).toMatchObject({ stdout: undefined, exitCode: 0, truncated: false });
    expect(await readFile(outputPath)).toEqual(content);
  });

  it("stops file output at the byte ceiling and settles all pending writes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-git-stream-limit-"));
    tempDirectories.push(directory);
    const outputPath = path.join(directory, "blob");
    await runGitCommand(["init", "--template="], { cwd: directory });
    const content = Buffer.alloc(128 * 1024, 0xff);
    const object = await runGitCommand(["hash-object", "-w", "--stdin"], {
      cwd: directory,
      input: content,
    });
    const result = await runGitCommandToFile(["cat-file", "blob", object.stdout.trim()], {
      cwd: directory,
      outputPath,
      maxOutputBytes: 1234,
    });
    expect(result.truncated).toBe(true);
    expect(await readFile(outputPath)).toEqual(content.subarray(0, 1234));
  });

  it("removes its partial file when Git fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-git-stream-failure-"));
    tempDirectories.push(directory);
    const outputPath = path.join(directory, "blob");
    await expect(
      runGitCommandToFile(["not-a-git-command"], { cwd: directory, outputPath }),
    ).rejects.toThrow("Git command failed");
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites an existing output file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-git-stream-existing-"));
    tempDirectories.push(directory);
    const outputPath = path.join(directory, "blob");
    await writeFile(outputPath, "preserve");
    await expect(
      runGitCommandToFile(["--version"], { cwd: directory, outputPath }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(outputPath, "utf8")).toBe("preserve");
  });
});
