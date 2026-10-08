import { z } from "zod";

export const HostMemoryPressureSchema = z.enum(["normal", "warn", "critical"]);

export const HostDiskSchema = z.object({
  mount: z.string(),
  name: z.string(),
  totalBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
});

export const HostProcessSchema = z.object({
  pid: z.number().int(),
  name: z.string(),
  cpuPercent: z.number().nonnegative(),
  memoryBytes: z.number().nonnegative(),
  // Read from the process environment, so children an agent spawned (test runners, dev servers) count too.
  agentId: z.string().nullable(),
});

export const HostMetricsSnapshotSchema = z.object({
  sampledAt: z.string(),
  sampleIntervalMs: z.number().int().positive(),
  hostname: z.string(),
  platform: z.string(),
  osLabel: z.string(),
  arch: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().nonnegative(),
    // Null until the sampler has two readings to diff.
    percent: z.number().nonnegative().nullable(),
  }),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    pressure: HostMemoryPressureSchema.nullable(),
  }),
  disks: z.array(HostDiskSchema),
  // Oldest first, one entry per sample interval. Memory is percent of total.
  history: z.object({
    cpuPercent: z.array(z.number()),
    memoryPercent: z.array(z.number()),
  }),
  processes: z.array(HostProcessSchema),
});

export type HostMemoryPressure = z.infer<typeof HostMemoryPressureSchema>;
export type HostDisk = z.infer<typeof HostDiskSchema>;
export type HostProcess = z.infer<typeof HostProcessSchema>;
export type HostMetricsSnapshot = z.infer<typeof HostMetricsSnapshotSchema>;
