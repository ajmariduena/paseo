import net from "node:net";
import { expect, test } from "vitest";
import {
  isPublicPreviewAddress,
  resolvePublicPreviewAddresses,
  startPublicPreviewProxy,
} from "./public-proxy.js";

test("refuses private, mapped, metadata, and host interface addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "64:ff9b::a00:1",
    "2002:0a00:0001::",
  ]) {
    expect(isPublicPreviewAddress(address)).toBe(false);
  }
  expect(isPublicPreviewAddress("8.8.8.8")).toBe(true);
  expect(
    isPublicPreviewAddress("203.0.113.7", {
      en0: [{ address: "203.0.113.7", family: "IPv4" }],
    } as ReturnType<(typeof import("node:os"))["networkInterfaces"]>),
  ).toBe(false);
});

test("rejects mixed DNS answers and resolves once before connection", async () => {
  let calls = 0;
  const lookup = async () => {
    calls++;
    return calls === 1
      ? [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]
      : [{ address: "8.8.8.8", family: 4 }];
  };
  expect(
    await resolvePublicPreviewAddresses(
      "example.invalid",
      lookup as (typeof import("node:dns/promises"))["lookup"],
    ),
  ).toBeNull();
  expect(calls).toBe(1);
});

test("SOCKS proxy refuses loopback targets", async () => {
  const proxy = await startPublicPreviewProxy();
  try {
    const socket = net.connect(proxy.port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.length === 1) socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]));
    });
    socket.write(Buffer.from([5, 1, 0]));
    await new Promise<void>((resolve, reject) => {
      socket.on("close", resolve);
      socket.on("error", reject);
    });
    expect(chunks[0]).toEqual(Buffer.from([5, 0]));
    expect(chunks[1]?.[1]).toBe(2);
  } finally {
    await proxy.close();
  }
});
