import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";

const ThemedCopy = withUnistyles(Copy);
const ThemedCheck = withUnistyles(Check);

const COPIED_FEEDBACK_MS = 1500;

// Plain text only: a rendered Markdown preview must paste as its source, not as rich text.
export function FileCopyButton({ getText }: { getText: () => string }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(getText());
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, COPIED_FEEDBACK_MS);
  }, [getText]);

  const iconSize = paneContentToolbarIconSize(isCompact);
  return (
    <ToolbarButton
      label={t(copied ? "panels.file.editor.contentsCopied" : "panels.file.editor.copyContents")}
      compact={isCompact}
      testID="file-copy-contents"
      onPress={handleCopy}
    >
      {copied ? (
        <ThemedCheck size={iconSize} uniProps={extraMutedIconColorMapping} />
      ) : (
        <ThemedCopy size={iconSize} uniProps={extraMutedIconColorMapping} />
      )}
    </ToolbarButton>
  );
}
