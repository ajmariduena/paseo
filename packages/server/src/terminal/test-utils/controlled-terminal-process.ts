import type { TerminalProcess } from "../terminal.js";

type Exit = Parameters<Parameters<TerminalProcess["onExit"]>[0]>[0];

/** A controllable PTY: delivering a signal does not imply process exit. */
export class ControlledTerminalProcess implements TerminalProcess {
  readonly pid = 123;
  readonly signals: Array<string | undefined> = [];
  readonly writes: Array<string | Buffer> = [];
  private readonly exitListeners = new Set<(event: Exit) => void>();
  private readonly dataListeners = new Set<(data: string) => void>();

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(signal?: string): void {
    this.signals.push(signal);
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  onExit(listener: (event: Exit) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  exit(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0 });
    this.exitListeners.clear();
    this.dataListeners.clear();
  }

  output(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}
