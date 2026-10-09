import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceFleetHostState, VoiceToolResult } from "@getpaseo/protocol/voice-fleet/types";
import { RemoteFleet, CourierTimeoutError, type CourierRequest } from "./remote-fleet.js";

const NOW = Date.parse("2026-10-09T14:00:00.000Z");
const logger = pino({ level: "silent" });
const fleets: RemoteFleet[] = [];
afterEach(() => {
  for (const fleet of fleets.splice(0)) fleet.reset();
  vi.useRealTimers();
});

function request(operationId = "operation-1"): CourierRequest {
  return {
    operationId,
    serverId: "mini",
    tool: "create_note",
    args: { title: "Probar Bluetooth" },
    language: "es",
  };
}

function setup() {
  let now = NOW;
  const forwarded: CourierRequest[] = [];
  const hosts: VoiceFleetHostState[] = [
    {
      serverId: "mini",
      label: "Mini",
      online: true,
      supportsTools: true,
      lastSeenAt: new Date(NOW).toISOString(),
      digest: {
        generatedAt: new Date(NOW).toISOString(),
        agents: [],
        workspaces: [],
        projects: [],
        sessions: [],
      },
    },
  ];
  const fleet = new RemoteFleet({ logger, now: () => now });
  fleets.push(fleet);
  fleet.update({ hosts, appState: "active", channel: (message) => forwarded.push(message) });
  return {
    fleet,
    hosts,
    forwarded,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("RemoteFleet courier", () => {
  it("forwards the unchanged operation and settles its exact result", async () => {
    const { fleet, forwarded } = setup();
    const operation = request();
    const pending = fleet.run(operation, "Mini");
    expect(forwarded).toEqual([operation]);
    const result: VoiceToolResult = { ok: true, text: "Nota guardada.", detail: "note-1" };
    fleet.settle({ operationId: operation.operationId, result, error: null });
    expect(await pending).toEqual(result);
  });

  it("keeps simultaneous requests independent when replies arrive out of order", async () => {
    const { fleet } = setup();
    const first = fleet.run(request("first"), "Mini");
    const second = fleet.run(request("second"), "Mini");
    fleet.settle({
      operationId: "second",
      result: { ok: false, text: "No se creó." },
      error: null,
    });
    fleet.settle({
      operationId: "unknown",
      result: { ok: true, text: "Respuesta ajena." },
      error: null,
    });
    fleet.settle({
      operationId: "first",
      result: { ok: true, text: "Primera guardada." },
      error: null,
    });
    expect(await first).toEqual({ ok: true, text: "Primera guardada." });
    expect(await second).toEqual({ ok: false, text: "No se creó." });
  });

  it("propagates a remote delivery error without treating it as success", async () => {
    const { fleet } = setup();
    const pending = fleet.run(request(), "Mini");
    const rejected = expect(pending).rejects.toThrow("The destination disconnected");
    fleet.settle({
      operationId: "operation-1",
      result: null,
      error: "The destination disconnected",
    });
    await rejected;
  });

  it("ignores a duplicate result after the operation has already settled", async () => {
    const { fleet } = setup();
    const pending = fleet.run(request(), "Mini");
    fleet.settle({
      operationId: "operation-1",
      result: { ok: true, text: "Guardado." },
      error: null,
    });
    fleet.settle({ operationId: "operation-1", result: null, error: "Late error" });
    expect(await pending).toEqual({ ok: true, text: "Guardado." });
  });

  it("rejects every pending request on reset and discards the previous fleet", async () => {
    const { fleet, forwarded } = setup();
    const first = expect(fleet.run(request("first"), "Mini")).rejects.toThrow("the call ended");
    const second = expect(fleet.run(request("second"), "Mini")).rejects.toThrow("the call ended");
    fleet.reset();
    await Promise.all([first, second]);
    expect(fleet.isLive).toBe(false);
    expect(fleet.fleetHosts()).toEqual([]);
    fleet.settle({ operationId: "first", result: { ok: true, text: "Late success" }, error: null });
    await expect(fleet.run(request("after-reset"), "Mini")).rejects.toBeInstanceOf(
      CourierTimeoutError,
    );
    expect(forwarded.map((entry) => entry.operationId)).toEqual(["first", "second"]);
  });

  it("stops forwarding as soon as the phone's view becomes stale", async () => {
    const { fleet, forwarded, setNow } = setup();
    expect(fleet.fleetHosts()[0]?.online).toBe(true);
    setNow(NOW + 20_000);
    expect(fleet.isLive).toBe(false);
    expect(fleet.fleetHosts()[0]?.online).toBe(false);
    await expect(fleet.run(request(), "Mini")).rejects.toBeInstanceOf(CourierTimeoutError);
    expect(forwarded).toEqual([]);
  });

  it("rejects a synchronous courier failure and remains usable for the next request", async () => {
    const { fleet, hosts, forwarded } = setup();
    fleet.update({
      hosts,
      appState: "active",
      channel: () => {
        throw new Error("Socket closed");
      },
    });
    await expect(fleet.run(request("failed"), "Mini")).rejects.toThrow("Socket closed");
    fleet.update({ hosts, appState: "active", channel: (message) => forwarded.push(message) });
    const next = fleet.run(request("next"), "Mini");
    fleet.settle({ operationId: "next", result: { ok: true, text: "Guardado." }, error: null });
    expect(await next).toEqual({ ok: true, text: "Guardado." });
    expect(forwarded.map((entry) => entry.operationId)).toEqual(["next"]);
  });

  it("times out an unanswered operation without reporting that its effect failed or succeeded", async () => {
    const { fleet, forwarded } = setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = fleet.run(request(), "Mini");
    const timedOut = expect(pending).rejects.toEqual(new CourierTimeoutError("Mini"));
    await vi.advanceTimersByTimeAsync(16_000);
    await timedOut;
    expect(forwarded).toEqual([request()]);
    fleet.settle({
      operationId: "operation-1",
      result: { ok: true, text: "Late result" },
      error: null,
    });
  });
});
