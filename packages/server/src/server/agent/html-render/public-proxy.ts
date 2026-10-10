import { lookup as dnsLookup } from "node:dns/promises";
import net, { BlockList, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const nat64 = new BlockList();
nat64.addSubnet("64:ff9b::", 96, "ipv6");
const sixToFour = new BlockList();
sixToFour.addSubnet("2002::", 16, "ipv6");

function ipv6Groups(address: string): number[] {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  return [
    ...left,
    ...Array<string>(tail === undefined ? 0 : 8 - left.length - right.length).fill("0"),
    ...right,
  ].map((group) => Number.parseInt(group, 16));
}

function embeddedIpv4(address: string): string | null {
  let at = -1;
  if (nat64.check(address, "ipv6")) at = 6;
  else if (sixToFour.check(address, "ipv6")) at = 1;
  if (at < 0) return null;
  const groups = ipv6Groups(address);
  return [groups[at]! >> 8, groups[at]! & 255, groups[at + 1]! >> 8, groups[at + 1]! & 255].join(
    ".",
  );
}

export function isPublicPreviewAddress(address: string, own = networkInterfaces()): boolean {
  const family = net.isIP(address);
  if (!family) return false;
  const kind = family === 4 ? "ipv4" : "ipv6";
  if (blocked.check(address, kind)) return false;
  for (const entries of Object.values(own)) {
    for (const entry of entries ?? []) {
      if (entry.address === address) return false;
      const ownList = new BlockList();
      ownList.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
      if (ownList.check(address, kind)) return false;
    }
  }
  const embedded = family === 6 ? embeddedIpv4(address) : null;
  return embedded === null || isPublicPreviewAddress(embedded, own);
}

export async function resolvePublicPreviewAddresses(
  host: string,
  resolve: typeof dnsLookup = dnsLookup,
): Promise<{ address: string; family: number }[] | null> {
  const literal = net.isIP(host);
  const answers = literal
    ? [{ address: host, family: literal }]
    : await Promise.race([
        resolve(host, { all: true, verbatim: true }).catch(() => []),
        new Promise<[]>((resolveTimeout) => setTimeout(() => resolveTimeout([]), 3000)),
      ]);
  return answers.length && answers.every(({ address }) => isPublicPreviewAddress(address))
    ? answers
    : null;
}

function reject(socket: Socket, code: number): void {
  socket.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]), () => socket.destroy());
}

function readRequest(bytes: Buffer): { host: string; port: number; rest: Buffer } | "short" | null {
  if (bytes.length < 5) return "short";
  if (bytes[0] !== 5 || bytes[1] !== 1 || bytes[2] !== 0) return null;
  const type = bytes[3];
  let end = -1;
  if (type === 1) end = 10;
  else if (type === 3) end = 7 + bytes[4]!;
  else if (type === 4) end = 22;
  if (end < 0) return null;
  if (bytes.length < end) return "short";
  let host: string;
  if (type === 1) host = [...bytes.subarray(4, 8)].join(".");
  else if (type === 3) host = bytes.subarray(5, 5 + bytes[4]!).toString("latin1");
  else
    host = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(4 + i * 2).toString(16)).join(
      ":",
    );
  return { host, port: bytes.readUInt16BE(end - 2), rest: bytes.subarray(end) };
}

function connectSockets(client: Socket, upstream: Socket, early: Buffer): void {
  upstream.once("connect", () => {
    client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    if (early.length) upstream.write(early);
    let outgoing = 0;
    let incoming = 0;
    client.on("data", (data: Buffer) => {
      outgoing += data.length;
      if (outgoing > 32 * 1024 * 1024) client.destroy();
    });
    upstream.on("data", (data: Buffer) => {
      incoming += data.length;
      if (incoming > 32 * 1024 * 1024) upstream.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
  upstream.on("close", () => client.destroy());
  client.on("close", () => upstream.destroy());
}

async function connectTarget(
  client: Socket,
  request: Exclude<ReturnType<typeof readRequest>, "short" | null>,
  track: (socket: Socket) => Socket,
): Promise<void> {
  const addresses = await resolvePublicPreviewAddresses(request.host);
  if (client.destroyed) return;
  if (!addresses) {
    reject(client, 2);
    return;
  }
  const upstream = track(net.connect({ host: addresses[0]!.address, port: request.port }));
  connectSockets(client, upstream, request.rest);
}

export async function startPublicPreviewProxy(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.setTimeout(20_000, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server = net.createServer((client) => {
    if (sockets.size >= 64) {
      client.destroy();
      return;
    }
    track(client);
    let pending = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 64 * 1024) {
        client.destroy();
        return;
      }
      if (!greeted) {
        if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
        if (pending[0] !== 5 || !pending.subarray(2, 2 + pending[1]!).includes(0)) {
          client.end(Buffer.from([5, 255]));
          return;
        }
        pending = pending.subarray(2 + pending[1]!);
        greeted = true;
        client.write(Buffer.from([5, 0]));
      }
      const request = readRequest(pending);
      if (request === "short") return;
      client.off("data", onData);
      if (!request || request.port === 0) {
        reject(client, 7);
        return;
      }
      client.pause();
      void connectTarget(client, request, track).catch(() => reject(client, 2));
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolve();
    });
  });
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview proxy did not bind");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
