/** The slice of the WebRTC API live mode uses, shared by browsers and react-native-webrtc. */
export interface LiveMediaTrack {
  enabled: boolean;
  stop(): void;
}

export interface LiveMediaStream {
  getTracks(): LiveMediaTrack[];
  getAudioTracks(): LiveMediaTrack[];
}

export interface LiveDataChannel {
  readonly readyState: string;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface LiveStatsReport {
  forEach(callback: (stat: Record<string, unknown>) => void): void;
}

export interface LivePeerConnection {
  readonly connectionState: string;
  readonly iceGatheringState: string;
  readonly localDescription: { sdp: string; type: string } | null;
  addTrack(track: LiveMediaTrack, stream: LiveMediaStream): unknown;
  createDataChannel(label: string): LiveDataChannel;
  createOffer(options?: Record<string, unknown>): Promise<{ sdp?: string; type: string }>;
  setLocalDescription(description: { sdp?: string; type: string }): Promise<void>;
  setRemoteDescription(description: { sdp: string; type: "answer" }): Promise<void>;
  getStats(): Promise<LiveStatsReport>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  close(): void;
}

export interface LiveWebrtcRuntime {
  createPeerConnection(): LivePeerConnection;
  getMicrophone(): Promise<LiveMediaStream>;
  /** Plays the remote stream where the platform doesn't do it by itself (browsers). */
  attachRemoteAudio(event: unknown): () => void;
  /** CallKit owns the iOS audio session; WebRTC must be told when it is handed over. */
  onCallAudioSession(): () => void;
  preferSpeakerOutput(enabled: boolean): void;
}
