import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata,
} from "@getpaseo/protocol/binary-frames/index";
import type { FrameSource } from "./frame-source";

export interface FrameLayer {
  source: FrameSource;
  metadata: BrowserScreencastFrameMetadata;
  sequence: number;
}

export interface FramePresentation {
  layers: readonly [FrameLayer | null, FrameLayer | null];
  /** The layer the user sees; null until a frame has decoded. */
  visible: 0 | 1 | null;
}

const EMPTY: FramePresentation = { layers: [null, null], visible: null };

/**
 * Double-buffers decoded frames: a new frame loads into the hidden layer and becomes visible only
 * after it has decoded, so the pane never flashes an empty image. At most one frame waits behind
 * the one loading; a newer arrival replaces it. Every frame is acknowledged exactly once, after it
 * is shown or dropped, which is what returns credit to the daemon.
 */
export class FramePresenter {
  private presentation: FramePresentation = EMPTY;
  private loading: 0 | 1 | null = null;
  private queued: BrowserScreencastFrame | null = null;
  private disposed = false;

  constructor(
    private readonly options: {
      createSource: (frame: BrowserScreencastFrame) => FrameSource;
      onChange: (presentation: FramePresentation) => void;
      ack: (sequence: number) => void;
    },
  ) {}

  get current(): FramePresentation {
    return this.presentation;
  }

  /** The metadata of the frame the user is looking at, not the newest one received. */
  get visibleMetadata(): BrowserScreencastFrameMetadata | null {
    const { visible } = this.presentation;
    return visible === null ? null : (this.presentation.layers[visible]?.metadata ?? null);
  }

  push(frame: BrowserScreencastFrame): void {
    if (this.disposed) {
      this.options.ack(frame.sequence);
      return;
    }
    if (this.loading !== null) {
      if (this.queued) this.options.ack(this.queued.sequence);
      this.queued = frame;
      return;
    }
    this.load(frame);
  }

  loaded(layer: 0 | 1, sequence: number): void {
    if (this.loading !== layer || this.presentation.layers[layer]?.sequence !== sequence) return;
    this.loading = null;
    this.presentation = { layers: this.presentation.layers, visible: layer };
    this.options.onChange(this.presentation);
    this.options.ack(sequence);
    this.loadQueued();
  }

  failed(layer: 0 | 1, sequence: number): void {
    if (this.loading !== layer || this.presentation.layers[layer]?.sequence !== sequence) return;
    this.loading = null;
    const layers = [...this.presentation.layers] as [FrameLayer | null, FrameLayer | null];
    layers[layer]?.source.release();
    layers[layer] = null;
    this.presentation = { layers, visible: this.presentation.visible };
    this.options.onChange(this.presentation);
    this.options.ack(sequence);
    this.loadQueued();
  }

  /** Clears every image, e.g. when the stream ends or the app goes to the background. */
  clear(): void {
    if (this.queued) this.options.ack(this.queued.sequence);
    this.queued = null;
    const loadingLayer = this.loading !== null ? this.presentation.layers[this.loading] : null;
    if (loadingLayer) this.options.ack(loadingLayer.sequence);
    this.loading = null;
    for (const layer of this.presentation.layers) layer?.source.release();
    this.presentation = EMPTY;
    this.options.onChange(this.presentation);
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  private loadQueued(): void {
    const next = this.queued;
    this.queued = null;
    if (next) this.load(next);
  }

  private load(frame: BrowserScreencastFrame): void {
    const hidden: 0 | 1 = this.presentation.visible === 0 ? 1 : 0;
    const layers = [...this.presentation.layers] as [FrameLayer | null, FrameLayer | null];
    layers[hidden]?.source.release();
    layers[hidden] = {
      source: this.options.createSource(frame),
      metadata: frame.metadata,
      sequence: frame.sequence,
    };
    this.loading = hidden;
    this.presentation = { layers, visible: this.presentation.visible };
    this.options.onChange(this.presentation);
  }
}
