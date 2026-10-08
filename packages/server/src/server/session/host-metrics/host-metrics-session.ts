import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { HostMetricsSampler } from "../../host-metrics/sampler.js";

type HostMetricsRequest = Extract<SessionInboundMessage, { type: "host.metrics.get.request" }>;

export interface HostMetricsSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface HostMetricsSessionOptions {
  host: HostMetricsSessionHost;
  sampler: Pick<HostMetricsSampler, "getSnapshot">;
  logger: pino.Logger;
}

export function createHostMetricsSession(input: {
  sampler: HostMetricsSessionOptions["sampler"] | undefined;
  emit: HostMetricsSessionHost["emit"];
  logger: pino.Logger;
}): HostMetricsSession | null {
  if (!input.sampler) return null;
  return new HostMetricsSession({
    host: { emit: input.emit },
    sampler: input.sampler,
    logger: input.logger,
  });
}

export class HostMetricsSession {
  private readonly host: HostMetricsSessionHost;
  private readonly sampler: HostMetricsSessionOptions["sampler"];
  private readonly logger: pino.Logger;

  constructor(options: HostMetricsSessionOptions) {
    this.host = options.host;
    this.sampler = options.sampler;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type !== "host.metrics.get.request") return undefined;
    return this.handleGet(msg);
  }

  private async handleGet(request: HostMetricsRequest): Promise<void> {
    try {
      const metrics = await this.sampler.getSnapshot();
      this.host.emit({
        type: "host.metrics.get.response",
        payload: { requestId: request.requestId, metrics },
      });
    } catch (error) {
      this.logger.error({ err: error, requestType: request.type }, "Host metrics request failed");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          code: "host_metrics_failed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
