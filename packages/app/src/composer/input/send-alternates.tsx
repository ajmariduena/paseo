import { useCallback, type ReactElement, type ReactNode } from "react";
import { Platform, StatusBar, type GestureResponderEvent } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  useContextMenu,
} from "@/components/ui/context-menu";
import { isNative } from "@/constants/platform";
import { resolveSendActionLabel } from "./labels";
import type { ComposerSendAction } from "./state";

type LongPressHandler = (event: GestureResponderEvent) => void;

interface SendAlternatesProps {
  actions: readonly ComposerSendAction[];
  onSelect: (action: ComposerSendAction) => void;
  /** Renders the send button; the handler is set only when a long press opens the alternates. */
  children: (onLongPress: LongPressHandler | undefined) => ReactNode;
}

/**
 * Long-pressing send on a phone or tablet offers the send actions the setting does not default
 * to. Hardware keyboards and desktop get the same choice from Cmd/Ctrl+Enter instead.
 */
export function SendAlternates({ actions, onSelect, children }: SendAlternatesProps): ReactNode {
  if (!isNative || actions.length === 0) return children(undefined);
  return (
    <ContextMenu>
      <SendAlternatesMenu actions={actions} onSelect={onSelect}>
        {children}
      </SendAlternatesMenu>
    </ContextMenu>
  );
}

function SendAlternatesMenu({ actions, onSelect, children }: SendAlternatesProps): ReactElement {
  const { t } = useTranslation();
  const menu = useContextMenu();
  const handleLongPress = useCallback<LongPressHandler>(
    (event) => {
      const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
      menu.setAnchorRect({
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY + statusBarHeight,
        width: 0,
        height: 0,
      });
      menu.setOpen(true);
    },
    [menu],
  );

  return (
    <>
      {children(handleLongPress)}
      <ContextMenuContent sheetTitle={t("composer.sendModes.optionsTitle")} align="end">
        {actions.map((action) => (
          <SendAlternateItem key={action} action={action} onSelect={onSelect} />
        ))}
      </ContextMenuContent>
    </>
  );
}

function SendAlternateItem({
  action,
  onSelect,
}: {
  action: ComposerSendAction;
  onSelect: (action: ComposerSendAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(action), [action, onSelect]);
  return (
    <ContextMenuItem onSelect={handleSelect} testID={`composer-send-alternate-${action}`}>
      {resolveSendActionLabel(action, t)}
    </ContextMenuItem>
  );
}
