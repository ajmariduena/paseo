export interface CallSessionHandlers {
  onEndedBySystem: () => void;
  onMuteChanged: (muted: boolean) => void;
}
