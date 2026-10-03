import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { AudioLines } from "lucide-react-native";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { iconButtonChromeGlyphSize } from "@/components/ui/icon-button-chrome";
import type { Theme } from "@/styles/theme";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";
import { useGlobalVoice } from "@/voice-chat/use-global-voice";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedAudioLines = withUnistyles(AudioLines);
const NO_KEYS: never[] = [];

export function GlobalVoiceHeaderButton() {
  const { t } = useTranslation();
  const call = useGlobalVoice();
  const handlePress = useCallback(() => {
    if (call.isActive || call.isStarting) {
      useGlobalVoiceStore.getState().setMinimized(false);
      return;
    }
    call.start();
  }, [call]);

  return (
    <HeaderToggleButton
      onPress={handlePress}
      tooltipLabel={t("globalVoice.actions.start")}
      tooltipKeys={NO_KEYS}
      tooltipSide="bottom"
      testID="header-global-voice"
      accessibilityRole="button"
      accessibilityLabel={t("globalVoice.actions.start")}
    >
      <ThemedAudioLines uniProps={mutedColorMapping} size={iconButtonChromeGlyphSize("large")} />
    </HeaderToggleButton>
  );
}
