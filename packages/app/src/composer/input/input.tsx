import { usePublishQuickPromptSurface } from "@/quick-prompts/capacity";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  View,
  Text,
  useWindowDimensions,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  TextInputSelectionChangeEventData,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  forwardRef,
} from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { ArrowUp, Mic, CornerDownLeft, Plus, Square } from "lucide-react-native";
import { useDictation } from "@/hooks/use-dictation";
import { DictationOverlay } from "@/components/dictation-controls";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { getDictationModelLabel } from "@/utils/dictation-selection";
import { useToast } from "@/contexts/toast-context";
import { resolveVoiceUnavailableMessage } from "@/utils/server-info-capabilities";
import {
  collectImageFilesFromClipboardData,
  filesToImageAttachments,
} from "@/utils/image-attachments-from-files";
import type { ComposerAttachment } from "@/attachments/types";
import type { ImageAttachment, MessagePayload, TextReplacement } from "@/composer/types";
import { focusWithRetries } from "@/utils/web-focus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import type { MenuPageDefinition } from "@/components/ui/menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useIosHardwareKeyboardSubmit } from "@/hooks/use-ios-hardware-keyboard-submit";
import { formatShortcut, type ShortcutKey } from "@/utils/format-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { isWeb } from "@/constants/platform";
import { useControlDensity, useIsCompactFormFactor } from "@/constants/layout";
import { TouchTarget, useTouchHitSlop } from "@/components/ui/touch-target";
import {
  COMPOSER_TOOLBAR_GEOMETRY,
  resolveComposerToolbarGlyphBox,
  resolveComposerToolbarGlyphStroke,
} from "@/composer/agent-controls/layout";
import { resolveContextWindowMeterRing } from "@/components/context-window-meter.utils";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { RenderProfile } from "@/utils/render-profiler";
import { useComposerHeight } from "./height";
import { useMessageInputKeyCommands } from "./key-commands";
import { resolveComposerInputMode, type ComposerInputMode } from "@/composer/input-mode";
import type { NativePastedFile } from "@/composer/native-pasted-image";
import {
  EditingTextInput,
  type EditingTextInputHandle as ComposerTextInputHandle,
  type EditingTextInputProps,
} from "@/components/ui/text-input";

const ComposerTextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.surface4,
}));
import {
  resolveAlternateSendTooltipLabel,
  resolveSendTooltipLabel,
  resolveSubmitAccessibilityLabel,
  resolveVoiceAccessibilityLabel,
  resolveVoiceTooltipText,
} from "./labels";
import {
  applyDictationTranscript,
  computeCanStartDictation,
  resolveAlternateSendActions,
  resolveComposerSurfacePresentation,
  runAlternateSendAction,
  runDefaultSendAction,
  runMessageInputKeyboardAction,
  type ComposerSendAction,
} from "./state";
import { SendAlternates } from "./send-alternates";
import type { ActiveTurnSendBehavior } from "@/composer/types";

const DEFAULT_SEND_KEYS: ShortcutKey[][] = [["Enter"]];
const ALTERNATE_SEND_KEYS: ShortcutKey[][] = [["mod", "Enter"]];
const COMPOSER_INPUT_DATASET = { composerInput: "" } as const;

export interface AttachmentMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  icon?: React.ReactElement | null;
}

export interface ComposerInputSnapshot {
  text: string;
  selection: { start: number; end: number };
}

export interface ComposerKeyPressEvent {
  key: string;
  preventDefault: () => void;
  input: ComposerInputSnapshot;
}

export interface MessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (payload: MessagePayload) => void;
  /** When true, the submit button is enabled even without text or images (e.g. external attachment selected). */
  hasExternalContent?: boolean;
  /** When true, the submit button stays visible and can submit even with no content. */
  allowEmptySubmit?: boolean;
  /** Optional accessibility label for the primary submit button. */
  submitButtonAccessibilityLabel?: string;
  /** Optional testID for the primary submit button. */
  submitButtonTestID?: string;
  submitIcon?: "arrow" | "return";
  isSubmitDisabled?: boolean;
  isSubmitLoading?: boolean;
  /** When true, keep the grown input height after submit (text is preserved, not cleared). */
  preserveHeightOnSubmit?: boolean;
  attachments: ComposerAttachment[];
  cwd: string;
  attachmentMenuItems: AttachmentMenuItem[];
  /** Pages the attachment menu can push into, such as quick prompts on the phone row. */
  attachmentMenuPages?: readonly MenuPageDefinition[];
  /** Rows after the attachment items, such as the quick-prompts sub trigger. */
  attachmentMenuFooter?: React.ReactNode;
  onAttachButtonRef?: (node: View | null) => void;
  onAddImages?: (images: ImageAttachment[]) => void;
  onPasteImages?: (files: readonly NativePastedFile[]) => void;
  client: DaemonClient | null;
  /** Dictation start gate from host runtime (socket connected + directory ready). */
  isReadyForDictation?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  autoFocusKey?: string;
  disabled?: boolean;
  /** Content to render on the left side of the composer toolbar (e.g., AgentControls) */
  leftContent?: React.ReactNode;
  /** Content to render on the right side before the voice button (e.g., context window meter) */
  beforeVoiceContent?: React.ReactNode;
  /** Auxiliary content to render on the right side after the voice button. */
  rightContent?: React.ReactNode;
  /** Primary action to render when the agent is active and the composer has no sendable content. */
  activeActionContent?: React.ReactNode;
  voiceServerId?: string;
  /** When true and there's sendable content, calls onQueue instead of onSubmit */
  isAgentRunning?: boolean;
  /** Controls what the default send action (Enter, send button, dictation) does when the agent is
   *  running. "interrupt" and "steer" send immediately, "queue" queues. Required so the default
   *  lives only in DEFAULT_CLIENT_SETTINGS. */
  defaultSendBehavior: "interrupt" | "steer" | "queue";
  /** Callback for queue button when agent is running */
  onQueue?: (payload: MessagePayload) => void;
  /** Optional handler used when submit button is in loading state. */
  onSubmitLoadingPress?: () => void;
  /** Intercept key press events before default handling. Return true to prevent default. */
  onKeyPress?: (event: ComposerKeyPressEvent) => boolean;
  /** Reports cursor selection updates from the underlying input. */
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  onFocusChange?: (focused: boolean) => void;
  onHeightChange?: (height: number) => void;
  /** Extra styles merged onto the input wrapper (e.g. elevated background). */
  inputWrapperStyle?: import("react-native").ViewStyle;
  /** Content rendered inside the bordered input surface, above the text input (e.g. attachment pills). */
  attachmentSlot?: React.ReactNode;
  /** What this composer is for. See `@/composer/input-mode` for what each mode implies. */
  inputMode?: ComposerInputMode;
  /** Renders `value` as static text on the same surface, for content there is nothing to type into. */
  readOnly?: boolean;
  /** Command issued when application state must replace native-owned text. */
  textReplacement: TextReplacement;
  /** Replaces the submit icon with this label, still inside the composer's own toolbar row. */
  submitLabel?: string;
}

export interface MessageInputRef {
  focus: () => void;
  blur: () => void;
  getText: () => string;
  getInputSnapshot: () => ComposerInputSnapshot;
  replaceText: (text: string, selection?: { start: number; end: number }) => void;
  runKeyboardAction: (action: MessageInputKeyboardActionKind) => boolean;
  /**
   * Web-only: return the underlying DOM element for focus assertions/retries.
   * May return null if not mounted or on native.
   */
  getNativeElement?: () => HTMLElement | null;
}

const MIN_INPUT_HEIGHT_MOBILE = 30;
const MIN_INPUT_HEIGHT_DESKTOP = 46;
const DEFAULT_MAX_INPUT_HEIGHT = 160;
const MAX_INPUT_VIEWPORT_RATIO = 0.5;
const MIN_INPUT_HEIGHT = isWeb ? MIN_INPUT_HEIGHT_DESKTOP : MIN_INPUT_HEIGHT_MOBILE;
type WebTextInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    // Web-only: present on DOM KeyboardEvent during IME composition (CJK input).
    isComposing?: boolean;
    keyCode?: number;
  }
>;

interface TextAreaHandle {
  scrollHeight?: number;
  clientHeight?: number;
  offsetHeight?: number;
  scrollTop?: number;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  style?: {
    height?: string;
    overflowY?: string;
  } & Record<string, unknown>;
}

function AttachButtonIcon({
  hovered,
  onAttachButtonRef,
  buttonIconSize,
}: {
  hovered: boolean;
  onAttachButtonRef: ((node: View | null) => void) | undefined;
  buttonIconSize: number;
}) {
  const colorMapping = hovered ? iconForegroundMapping : iconForegroundMutedMapping;
  return (
    <View ref={onAttachButtonRef} collapsable={false} style={styles.attachButtonAnchor}>
      <ThemedPlus
        size={toolbarGlyphBox(buttonIconSize, PLUS_INK_EXTENT)}
        {...toolbarGlyphStroke(buttonIconSize)}
        uniProps={colorMapping}
      />
    </View>
  );
}

function AttachmentMenuList({ items }: { items: AttachmentMenuItem[] }) {
  return (
    <>
      {items.map((item) => (
        <DropdownMenuItem
          key={item.id}
          testID={`message-input-attachment-menu-item-${item.id}`}
          disabled={item.disabled}
          onSelect={item.onSelect}
          leading={item.icon ?? null}
        >
          {item.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function AttachmentDropdown({
  visible,
  isConnected,
  disabled,
  attachButtonStyle,
  renderAttachButtonIcon,
  attachmentMenuItems,
  attachmentMenuPages,
  attachmentMenuFooter,
  addAttachmentLabel,
}: {
  visible: boolean;
  isConnected: boolean;
  disabled: boolean;
  attachButtonStyle: React.ComponentProps<typeof DropdownMenuTrigger>["style"];
  renderAttachButtonIcon: (input: { hovered?: boolean }) => React.ReactElement;
  attachmentMenuItems: AttachmentMenuItem[];
  attachmentMenuPages: readonly MenuPageDefinition[] | undefined;
  attachmentMenuFooter: React.ReactNode;
  addAttachmentLabel: string;
}) {
  const isButtonDisabled = !isConnected || disabled;
  const hitSlop = useTouchHitSlop(COMPOSER_TOOLBAR_GEOMETRY.controlSize);
  if (!visible) return null;
  return (
    <TouchTarget slotSize={COMPOSER_TOOLBAR_GEOMETRY.controlSize}>
      <DropdownMenu compactMode="sheet">
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger
              disabled={isButtonDisabled}
              accessibilityLabel={addAttachmentLabel}
              accessibilityRole="button"
              testID="message-input-attach-button"
              hitSlop={hitSlop}
              style={attachButtonStyle}
            >
              {renderAttachButtonIcon}
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{addAttachmentLabel}</Text>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="top"
          align="start"
          offset={8}
          minWidth={220}
          testID="message-input-attachment-menu"
          sheetTitle={addAttachmentLabel}
          pages={attachmentMenuPages}
        >
          <AttachmentMenuList items={attachmentMenuItems} />
          {attachmentMenuFooter}
        </DropdownMenuContent>
      </DropdownMenu>
    </TouchTarget>
  );
}

function VoiceButtonIcon({
  hovered,
  isDictating,
  buttonIconSize,
}: {
  hovered: boolean;
  isDictating: boolean;
  buttonIconSize: number;
}) {
  if (isDictating) {
    return (
      <Square
        size={buttonIconSize}
        {...toolbarGlyphStroke(buttonIconSize)}
        color="white"
        fill="white"
      />
    );
  }
  const colorMapping = hovered ? iconForegroundMapping : iconForegroundMutedMapping;
  return (
    <ThemedMic
      size={toolbarGlyphBox(buttonIconSize, MIC_INK_EXTENT)}
      {...toolbarGlyphStroke(buttonIconSize)}
      uniProps={colorMapping}
    />
  );
}

type ShortcutChord = NonNullable<React.ComponentProps<typeof Shortcut>["chord"]>;

function VoiceTooltipBody({
  voiceTooltipText,
  shortcut,
}: {
  voiceTooltipText: string;
  shortcut: ShortcutChord | null | undefined;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{voiceTooltipText}</Text>
      {shortcut ? <Shortcut chord={shortcut} /> : null}
    </View>
  );
}

function SendTooltipBody({
  label,
  sendKeys,
  alternateLabel,
}: {
  label: string;
  sendKeys: ShortcutChord | null | undefined;
  alternateLabel: string | null;
}) {
  return (
    <View style={styles.tooltipBody}>
      <View style={styles.tooltipRow}>
        <Text style={styles.tooltipText}>{label}</Text>
        {sendKeys ? <Shortcut chord={sendKeys} /> : null}
      </View>
      {alternateLabel ? (
        <View style={styles.tooltipRow}>
          <Text style={styles.tooltipTextMuted}>{alternateLabel}</Text>
          <Shortcut chord={ALTERNATE_SEND_KEYS} />
        </View>
      ) : null}
    </View>
  );
}

function SendButtonContent({
  isSubmitLoading,
  submitIcon,
  submitLabel,
  buttonIconSize,
}: {
  isSubmitLoading: boolean;
  submitIcon: "arrow" | "return";
  submitLabel: string | undefined;
  buttonIconSize: number;
}) {
  if (isSubmitLoading) {
    return <ThemedLoadingSpinner size="small" uniProps={iconSendForegroundMapping} />;
  }
  if (submitLabel) {
    return <Text style={styles.sendButtonLabel}>{submitLabel}</Text>;
  }
  if (submitIcon === "return") {
    return (
      <ThemedCornerDownLeft
        size={buttonIconSize}
        {...toolbarGlyphStroke(buttonIconSize)}
        uniProps={iconSendForegroundMapping}
      />
    );
  }
  return (
    <ThemedArrowUp
      size={buttonIconSize}
      {...toolbarGlyphStroke(buttonIconSize)}
      uniProps={iconSendForegroundMapping}
    />
  );
}

interface DesktopKeyPressContext {
  onKeyPressCallback: ((event: ComposerKeyPressEvent) => boolean) | undefined;
  input: ComposerKeyPressEvent["input"];
  submitOnEnter: boolean;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  disabled: boolean;
  handleAlternateSendAction: () => void;
  handleDefaultSendAction: () => void;
}

function handleDesktopKeyPressImpl(
  event: WebTextInputKeyPressEvent,
  ctx: DesktopKeyPressContext,
): void {
  if (isImeComposingKeyboardEvent(event.nativeEvent)) return;

  if (ctx.onKeyPressCallback) {
    const handled = ctx.onKeyPressCallback({
      key: event.nativeEvent.key,
      preventDefault: () => event.preventDefault(),
      input: ctx.input,
    });
    if (handled) return;
  }

  const { shiftKey, metaKey, ctrlKey } = event.nativeEvent;

  if (event.nativeEvent.key !== "Enter") return;
  if (!ctx.submitOnEnter) return;
  if (shiftKey) return;

  if ((metaKey || ctrlKey) && ctx.isAgentRunning && ctx.onQueue) {
    if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) return;
    event.preventDefault();
    ctx.handleAlternateSendAction();
    return;
  }

  if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) return;
  event.preventDefault();
  ctx.handleDefaultSendAction();
}

function getTextInputNativeElement(current: ComposerTextInputHandle | null): HTMLElement | null {
  if (!current) return null;
  const native = typeof current.getNativeRef === "function" ? current.getNativeRef() : current;
  return native instanceof HTMLElement ? native : null;
}

interface PasteImagesEffectArgs {
  getWebTextArea: () => TextAreaHandle | null;
  isConnected: boolean;
  disabled: boolean;
  isDictating: boolean;
  onAddImages: ((images: ImageAttachment[]) => void) | undefined;
}

function usePasteImagesEffect(args: PasteImagesEffectArgs): void {
  const { getWebTextArea, isConnected, disabled, isDictating, onAddImages } = args;

  useEffect(() => {
    if (!isWeb || !onAddImages) return;

    const textarea = getWebTextArea() as
      | (TextAreaHandle & {
          addEventListener?: (type: string, listener: (e: ClipboardEvent) => void) => void;
          removeEventListener?: (type: string, listener: (e: ClipboardEvent) => void) => void;
        })
      | null;
    if (
      !textarea ||
      typeof textarea.addEventListener !== "function" ||
      typeof textarea.removeEventListener !== "function"
    ) {
      return;
    }

    let disposed = false;
    const handlePaste = (event: ClipboardEvent) => {
      if (!isConnected || disabled || isDictating) return;

      const imageFiles = collectImageFilesFromClipboardData(event.clipboardData);
      if (imageFiles.length === 0) return;

      event.preventDefault();

      void filesToImageAttachments(imageFiles)
        .then((pastedAttachments) => {
          if (disposed || pastedAttachments.length === 0) return;
          onAddImages(pastedAttachments);
          return;
        })
        .catch((error) => {
          console.error("[MessageInput] Failed to process pasted images:", error);
        });
    };

    textarea.addEventListener("paste", handlePaste);
    return () => {
      disposed = true;
      textarea.removeEventListener?.("paste", handlePaste);
    };
  }, [disabled, getWebTextArea, isConnected, isDictating, onAddImages]);
}

function useAutoFocusOnWebEffect(
  textInputRef: React.MutableRefObject<ComposerTextInputHandle | null>,
  autoFocus: boolean,
  autoFocusKey: string | undefined,
): void {
  useEffect(() => {
    if (!isWeb || !autoFocus) return;
    return focusWithRetries({
      focus: () => textInputRef.current?.focus(),
      isFocused: () => {
        const element = getTextInputNativeElement(textInputRef.current);
        const active = typeof document !== "undefined" ? document.activeElement : null;
        return Boolean(element) && active === element;
      },
      deferInitialAttempt: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, autoFocusKey]);
}

function MessageInputAutoFocus({
  enabled,
  autoFocusKey,
  textInputRef,
}: {
  enabled: boolean;
  autoFocusKey: string | undefined;
  textInputRef: React.MutableRefObject<ComposerTextInputHandle | null>;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  useAutoFocusOnWebEffect(textInputRef, enabled && isActiveComposer, autoFocusKey);
  return null;
}

function MessageInputOverlay({
  showDictationOverlay,
  dictationVolume,
  dictationDuration,
  isDictating,
  isDictationProcessing,
  dictationStatus,
  dictationError,
  onCancelRecording,
  onAcceptRecording,
  onAcceptAndSendRecording,
  onRetryFailedRecording,
  onDiscardFailedRecording,
}: {
  showDictationOverlay: boolean;
  dictationVolume: number;
  dictationDuration: number;
  isDictating: boolean;
  isDictationProcessing: boolean;
  dictationStatus: React.ComponentProps<typeof DictationOverlay>["status"];
  dictationError: string | null;
  onCancelRecording: () => Promise<void>;
  onAcceptRecording: () => Promise<void>;
  onAcceptAndSendRecording: () => Promise<void>;
  onRetryFailedRecording: () => void;
  onDiscardFailedRecording: () => void;
}) {
  if (showDictationOverlay) {
    return (
      <DictationOverlay
        volume={dictationVolume}
        duration={dictationDuration}
        isRecording={isDictating}
        isProcessing={isDictationProcessing}
        status={dictationStatus}
        errorText={dictationStatus === "failed" ? (dictationError ?? undefined) : undefined}
        onCancel={onCancelRecording}
        onAccept={onAcceptRecording}
        onAcceptAndSend={onAcceptAndSendRecording}
        onRetry={dictationStatus === "failed" ? onRetryFailedRecording : undefined}
        onDiscard={dictationStatus === "failed" ? onDiscardFailedRecording : undefined}
      />
    );
  }
  return null;
}

function FocusHint({
  visible,
  focusInputKeys,
  label,
}: {
  visible: boolean;
  focusInputKeys: ShortcutChord | null | undefined;
  label: string;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  if (!isActiveComposer || !visible || !focusInputKeys || !label.trim()) return null;
  return (
    <Text style={styles.focusHintText} pointerEvents="none">
      {label}
    </Text>
  );
}

interface ComposerTextSurfaceProps {
  readOnly: boolean;
  value: string;
  textInputRef: React.Ref<ComposerTextInputHandle>;
  textInputStyle: EditingTextInputProps["style"];
  readOnlyTextStyle: React.ComponentProps<typeof Text>["style"];
  placeholder: string;
  accessibilityLabel: string;
  onChangeText: (text: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  editable: boolean;
  scrollEnabled: boolean;
  autoFocus: boolean;
  onKeyPress: ((event: WebTextInputKeyPressEvent) => void) | undefined;
  onSelectionChange: (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  onPasteImages: ((files: readonly NativePastedFile[]) => void) | undefined;
  onPasteError: (message: string) => void;
  focusHintVisible: boolean;
  focusInputKeys: ShortcutChord | null | undefined;
  focusHintLabel: string;
}

/**
 * The composer's content: an editable input, or static text when there is
 * nothing to type. Both sit in the same bordered surface, so read-only is a
 * state of this composer rather than a second one.
 */
function ComposerTextSurface(props: ComposerTextSurfaceProps): React.ReactElement {
  if (props.readOnly) {
    return (
      <View style={styles.textInputScrollWrapper}>
        <Text style={props.readOnlyTextStyle} testID="composer-readonly-content">
          {props.value}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.textInputScrollWrapper}>
      <ComposerTextInput
        ref={props.textInputRef}
        dataSet={COMPOSER_INPUT_DATASET}
        initialValue={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        accessibilityLabel={props.accessibilityLabel}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
        style={props.textInputStyle}
        multiline
        scrollEnabled={props.scrollEnabled}
        editable={props.editable}
        onKeyPress={props.onKeyPress}
        onSelectionChange={props.onSelectionChange}
        onPasteImages={props.onPasteImages}
        onPasteError={props.onPasteError}
        autoFocus={props.autoFocus}
      />
      <FocusHint
        visible={props.focusHintVisible}
        focusInputKeys={props.focusInputKeys}
        label={props.focusHintLabel}
      />
    </View>
  );
}

function VoiceButtonTooltip({
  visible,
  onVoicePress,
  isDictationStartEnabled,
  voiceButtonAccessibilityLabel,
  voiceButtonStyle,
  renderVoiceButtonIcon,
  voiceTooltipText,
  dictationToggleKeys,
}: {
  visible: boolean;
  onVoicePress: () => void;
  isDictationStartEnabled: boolean;
  voiceButtonAccessibilityLabel: string;
  voiceButtonStyle: React.ComponentProps<typeof TooltipTrigger>["style"];
  renderVoiceButtonIcon: (input: { hovered?: boolean }) => React.ReactElement;
  voiceTooltipText: string;
  dictationToggleKeys: ShortcutChord | null | undefined;
}) {
  const shortcut = dictationToggleKeys;
  const hitSlop = useTouchHitSlop(COMPOSER_TOOLBAR_GEOMETRY.controlSize);
  if (!visible) return null;
  return (
    <TouchTarget slotSize={COMPOSER_TOOLBAR_GEOMETRY.controlSize}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          onPress={onVoicePress}
          disabled={!isDictationStartEnabled}
          accessibilityRole="button"
          accessibilityLabel={voiceButtonAccessibilityLabel}
          hitSlop={hitSlop}
          style={voiceButtonStyle}
        >
          {renderVoiceButtonIcon}
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <VoiceTooltipBody voiceTooltipText={voiceTooltipText} shortcut={shortcut} />
        </TooltipContent>
      </Tooltip>
    </TouchTarget>
  );
}

function SendButtonTooltip({
  shouldShow,
  canPressLoadingButton,
  onSubmitLoadingPress,
  onDefaultSendAction,
  isSendButtonDisabled,
  submitAccessibilityLabel,
  sendButtonCombinedStyle,
  isSubmitLoading,
  submitIcon,
  submitLabel,
  submitButtonTestID,
  buttonIconSize,
  sendKeys,
  sendTooltipLabel,
  alternateSendTooltipLabel,
  onLongPress,
}: {
  shouldShow: boolean;
  canPressLoadingButton: boolean;
  onSubmitLoadingPress: (() => void) | undefined;
  onDefaultSendAction: () => void;
  isSendButtonDisabled: boolean;
  submitAccessibilityLabel: string;
  sendButtonCombinedStyle: React.ComponentProps<typeof TooltipTrigger>["style"];
  isSubmitLoading: boolean;
  submitIcon: "arrow" | "return";
  submitLabel: string | undefined;
  submitButtonTestID: string | undefined;
  buttonIconSize: number;
  sendKeys: ShortcutChord | null | undefined;
  sendTooltipLabel: string;
  alternateSendTooltipLabel: string | null;
  onLongPress?: (event: GestureResponderEvent) => void;
}) {
  const hitSlop = useTouchHitSlop(COMPOSER_TOOLBAR_GEOMETRY.primaryTouchSize);
  if (!shouldShow) return null;
  return (
    <TouchTarget slotSize={COMPOSER_TOOLBAR_GEOMETRY.controlSize}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          onPress={canPressLoadingButton ? onSubmitLoadingPress : onDefaultSendAction}
          onLongPress={canPressLoadingButton ? undefined : onLongPress}
          disabled={isSendButtonDisabled}
          accessibilityLabel={submitAccessibilityLabel}
          accessibilityRole="button"
          testID={submitButtonTestID}
          hitSlop={hitSlop}
          style={sendButtonCombinedStyle}
        >
          <SendButtonContent
            isSubmitLoading={isSubmitLoading}
            submitIcon={submitIcon}
            submitLabel={submitLabel}
            buttonIconSize={buttonIconSize}
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <SendTooltipBody
            label={sendTooltipLabel}
            sendKeys={sendKeys}
            alternateLabel={alternateSendTooltipLabel}
          />
        </TooltipContent>
      </Tooltip>
    </TouchTarget>
  );
}

type PrimaryActionKind = "send" | "active";

function hasSendableComposerContent(input: {
  hasText: boolean;
  attachments: readonly ComposerAttachment[];
  hasExternalContent: boolean;
}): boolean {
  return input.hasText || input.attachments.length > 0 || input.hasExternalContent;
}

/** The round send button is always there; it yields its slot only to the stop button. */
function resolvePrimaryActionKind(input: {
  hasSendableContent: boolean;
  allowEmptySubmit: boolean;
  isAgentRunning: boolean;
  isSubmitLoading: boolean;
}): PrimaryActionKind {
  if (input.hasSendableContent || input.allowEmptySubmit) return "send";
  if (input.isAgentRunning) return "active";
  return "send";
}

function PrimaryAction({
  kind,
  activeActionContent,
  alternateSendActions,
  onSendAction,
  ...sendButtonProps
}: {
  kind: PrimaryActionKind;
  activeActionContent: React.ReactNode;
  alternateSendActions: readonly ComposerSendAction[];
  onSendAction: (action: ComposerSendAction) => void;
} & Omit<React.ComponentProps<typeof SendButtonTooltip>, "onLongPress">) {
  if (kind === "active") return activeActionContent;
  return (
    <SendAlternates actions={alternateSendActions} onSelect={onSendAction}>
      {(onLongPress) => <SendButtonTooltip {...sendButtonProps} onLongPress={onLongPress} />}
    </SendAlternates>
  );
}
interface StartDictationContext {
  dictationUnavailableMessage: string | null | undefined;
  canStartDictation: () => boolean;
  toast: { error: (msg: string) => void };
  startDictation: () => Promise<void>;
}

async function startDictationIfAvailableImpl(ctx: StartDictationContext): Promise<void> {
  if (ctx.dictationUnavailableMessage) {
    ctx.toast.error(ctx.dictationUnavailableMessage);
    return;
  }
  if (!ctx.canStartDictation()) {
    return;
  }
  await ctx.startDictation();
}

interface VoicePressContext {
  isDictating: boolean;
  cancelDictation: () => Promise<void> | void;
  startDictationIfAvailable: () => Promise<void>;
}

async function handleVoicePressImpl(ctx: VoicePressContext): Promise<void> {
  if (ctx.isDictating) {
    await ctx.cancelDictation();
    return;
  }
  await ctx.startDictationIfAvailable();
}

interface SendMessageContext {
  value: string;
  attachments: ComposerAttachment[];
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  cwd: string;
  isAgentRunning: boolean;
  onSubmit: (payload: MessagePayload) => void;
  onMinimizeHeight: () => void;
  preserveHeightOnSubmit: boolean;
  activeTurnBehavior?: ActiveTurnSendBehavior;
}

function sendMessageImpl(ctx: SendMessageContext): void {
  const trimmed = ctx.value.trim();
  if (
    !trimmed &&
    ctx.attachments.length === 0 &&
    !ctx.hasExternalContent &&
    !ctx.allowEmptySubmit
  ) {
    return;
  }
  ctx.onSubmit({
    text: trimmed,
    attachments: ctx.attachments,
    cwd: ctx.cwd,
    forceSend: ctx.isAgentRunning || undefined,
    ...(ctx.activeTurnBehavior ? { activeTurnBehavior: ctx.activeTurnBehavior } : {}),
  });
  // When the host preserves and locks the composer (e.g. new-workspace creation),
  // the text stays put — collapsing the height would clip it. Keep it grown.
  if (!ctx.preserveHeightOnSubmit) {
    ctx.onMinimizeHeight();
  }
}

interface QueueMessageContext {
  value: string;
  attachments: ComposerAttachment[];
  cwd: string;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  replaceText: (text: string) => void;
  onMinimizeHeight: () => void;
}

function queueMessageImpl(ctx: QueueMessageContext): void {
  if (!ctx.onQueue) return;
  const trimmed = ctx.value.trim();
  if (!trimmed && ctx.attachments.length === 0) return;
  ctx.onQueue({ text: trimmed, attachments: ctx.attachments, cwd: ctx.cwd });
  ctx.replaceText("");
  ctx.onMinimizeHeight();
}

function computeShouldShowDictationOverlay(
  isDictating: boolean,
  isDictationProcessing: boolean,
  dictationStatus: string,
): boolean {
  return (
    isDictating ||
    isDictationProcessing ||
    dictationStatus === "starting" ||
    dictationStatus === "failed"
  );
}

function computeIsDictationStartEnabled(
  isReadyForDictation: boolean | undefined,
  isConnected: boolean,
  disabled: boolean,
): boolean {
  return (isReadyForDictation ?? isConnected) && !disabled;
}

function resolveMaxInputHeight(windowHeight: number): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return DEFAULT_MAX_INPUT_HEIGHT;
  return Math.max(DEFAULT_MAX_INPUT_HEIGHT, Math.floor(windowHeight * MAX_INPUT_VIEWPORT_RATIO));
}

function isTextAreaLike(v: unknown): v is TextAreaHandle {
  return typeof v === "object" && v !== null && "scrollHeight" in v;
}

function getWebTextAreaImpl(current: ComposerTextInputHandle | null): TextAreaHandle | null {
  if (!current) return null;
  const candidate = current as { getNativeRef?: () => unknown };
  if (typeof candidate.getNativeRef === "function") {
    const native = candidate.getNativeRef();
    if (isTextAreaLike(native)) return native;
  }
  if (isTextAreaLike(current)) return current;
  return null;
}

function getComposerInputSnapshot(
  current: ComposerTextInputHandle | null,
  fallbackText: string,
  fallbackSelection: ComposerInputSnapshot["selection"],
): ComposerInputSnapshot {
  const text = current?.getText() ?? fallbackText;
  const textArea = getWebTextAreaImpl(current);
  const start = textArea?.selectionStart ?? fallbackSelection.start;
  const end = textArea?.selectionEnd ?? fallbackSelection.end;
  return { text, selection: { start, end } };
}

interface SendButtonStateInput {
  disabled: boolean;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  hasSendableContent: boolean;
  allowEmptySubmit: boolean;
  onSubmitLoadingPress: (() => void) | undefined;
  defaultSendBehavior: "interrupt" | "steer" | "queue";
  isAgentRunning: boolean;
}

interface SendButtonStateOutput {
  canPressLoadingButton: boolean;
  isSendButtonDisabled: boolean;
  defaultActionQueues: boolean;
}

function computeSendButtonState(input: SendButtonStateInput): SendButtonStateOutput {
  const canPressLoadingButton =
    input.isSubmitLoading && typeof input.onSubmitLoadingPress === "function";
  const nothingToSend = !input.hasSendableContent && !input.allowEmptySubmit;
  const isSendButtonDisabled =
    input.disabled ||
    (!canPressLoadingButton && (input.isSubmitDisabled || input.isSubmitLoading || nothingToSend));
  const defaultActionQueues = input.defaultSendBehavior === "queue" && input.isAgentRunning;
  return { canPressLoadingButton, isSendButtonDisabled, defaultActionQueues };
}

interface ResolvedMessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (payload: MessagePayload) => void;
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  submitButtonAccessibilityLabel: string | undefined;
  submitButtonTestID: string | undefined;
  submitIcon: "arrow" | "return";
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  preserveHeightOnSubmit: boolean;
  attachments: ComposerAttachment[];
  cwd: string;
  attachmentMenuItems: AttachmentMenuItem[];
  attachmentMenuPages: readonly MenuPageDefinition[] | undefined;
  attachmentMenuFooter: React.ReactNode;
  onAttachButtonRef: ((node: View | null) => void) | undefined;
  onAddImages: ((images: ImageAttachment[]) => void) | undefined;
  onPasteImages: ((files: readonly NativePastedFile[]) => void) | undefined;
  client: DaemonClient | null;
  isReadyForDictation: boolean | undefined;
  placeholder: string | undefined;
  autoFocus: boolean;
  autoFocusKey: string | undefined;
  disabled: boolean;
  leftContent: React.ReactNode;
  beforeVoiceContent: React.ReactNode;
  rightContent: React.ReactNode;
  activeActionContent: React.ReactNode;
  voiceServerId: string | undefined;
  isAgentRunning: boolean;
  defaultSendBehavior: "interrupt" | "steer" | "queue";
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onSubmitLoadingPress: (() => void) | undefined;
  onKeyPressCallback: ((event: ComposerKeyPressEvent) => boolean) | undefined;
  onSelectionChangeCallback: ((selection: { start: number; end: number }) => void) | undefined;
  onFocusChange: ((focused: boolean) => void) | undefined;
  onHeightChange: ((height: number) => void) | undefined;
  inputWrapperStyle: import("react-native").ViewStyle | undefined;
  attachmentSlot: React.ReactNode;
  inputMode: ComposerInputMode;
  readOnly: boolean;
  textReplacement: TextReplacement;
  submitLabel: string | undefined;
}

function resolveMessageInputProps(props: MessageInputProps): ResolvedMessageInputProps {
  return {
    value: props.value,
    onChangeText: props.onChangeText,
    onSubmit: props.onSubmit,
    hasExternalContent: props.hasExternalContent ?? false,
    allowEmptySubmit: props.allowEmptySubmit ?? false,
    submitButtonAccessibilityLabel: props.submitButtonAccessibilityLabel,
    submitButtonTestID: props.submitButtonTestID,
    submitIcon: props.submitIcon ?? "arrow",
    isSubmitDisabled: props.isSubmitDisabled ?? false,
    isSubmitLoading: props.isSubmitLoading ?? false,
    preserveHeightOnSubmit: props.preserveHeightOnSubmit ?? false,
    attachments: props.attachments,
    cwd: props.cwd,
    attachmentMenuItems: props.attachmentMenuItems,
    attachmentMenuPages: props.attachmentMenuPages,
    attachmentMenuFooter: props.attachmentMenuFooter ?? null,
    onAttachButtonRef: props.onAttachButtonRef,
    onAddImages: props.onAddImages,
    onPasteImages: props.onPasteImages,
    client: props.client,
    isReadyForDictation: props.isReadyForDictation,
    placeholder: props.placeholder,
    autoFocus: props.autoFocus ?? false,
    autoFocusKey: props.autoFocusKey,
    disabled: props.disabled ?? false,
    leftContent: props.leftContent,
    beforeVoiceContent: props.beforeVoiceContent,
    rightContent: props.rightContent,
    activeActionContent: props.activeActionContent,
    voiceServerId: props.voiceServerId,
    isAgentRunning: props.isAgentRunning ?? false,
    defaultSendBehavior: props.defaultSendBehavior,
    onQueue: props.onQueue,
    onSubmitLoadingPress: props.onSubmitLoadingPress,
    onKeyPressCallback: props.onKeyPress,
    onSelectionChangeCallback: props.onSelectionChange,
    onFocusChange: props.onFocusChange,
    onHeightChange: props.onHeightChange,
    inputWrapperStyle: props.inputWrapperStyle,
    attachmentSlot: props.attachmentSlot,
    inputMode: props.inputMode ?? "chat",
    readOnly: props.readOnly ?? false,
    textReplacement: props.textReplacement,
    submitLabel: props.submitLabel,
  };
}

export const MessageInput = forwardRef<MessageInputRef, MessageInputProps>(
  function MessageInput(props, ref) {
    const {
      value,
      onChangeText,
      onSubmit,
      hasExternalContent,
      allowEmptySubmit,
      submitButtonAccessibilityLabel,
      submitButtonTestID,
      submitIcon,
      isSubmitDisabled,
      isSubmitLoading,
      preserveHeightOnSubmit,
      attachments,
      cwd,
      attachmentMenuItems,
      attachmentMenuPages,
      attachmentMenuFooter,
      onAttachButtonRef,
      onAddImages,
      onPasteImages,
      client,
      isReadyForDictation,
      placeholder,
      autoFocus,
      autoFocusKey,
      disabled,
      leftContent,
      beforeVoiceContent,
      rightContent,
      activeActionContent,
      voiceServerId,
      isAgentRunning,
      defaultSendBehavior,
      onQueue,
      onSubmitLoadingPress,
      onKeyPressCallback,
      onSelectionChangeCallback,
      onFocusChange,
      onHeightChange,
      inputWrapperStyle,
      attachmentSlot,
      inputMode,
      readOnly,
      textReplacement,
      submitLabel,
    } = resolveMessageInputProps(props);
    const mode = resolveComposerInputMode(inputMode);
    const { t } = useTranslation();
    const isCompact = useIsCompactFormFactor();
    const isTouchDensity = useControlDensity() === "touch";
    const { height: windowHeight } = useWindowDimensions();
    const maxInputHeight = resolveMaxInputHeight(windowHeight);
    const buttonIconSize = isWeb ? ICON_SIZE.md : ICON_SIZE.lg;
    const toast = useToast();
    const dictationToggleKeys = useShortcutKeys("dictation-toggle");
    const focusInputKeys = useShortcutKeys("focus-message-input");
    const [isInputFocused, setIsInputFocused] = useState(false);
    // Web text is DOM-owned between deferred draft publications. The action button only needs
    // this boundary, so publish empty/non-empty transitions without rerendering for every key.
    const initialHasLiveText = value.trim().length > 0;
    const [hasLiveText, setHasLiveText] = useState(initialHasLiveText);
    const hasLiveTextRef = useRef(initialHasLiveText);
    const rootRef = useRef<View | null>(null);
    const inputWrapperRef = useRef<View | null>(null);
    const textInputRef = useRef<ComposerTextInputHandle | null>(null);
    const isInputFocusedRef = useRef(false);
    const valueRef = useRef(value);
    const selectionRef = useRef({ start: value.length, end: value.length });
    const appliedTextReplacementKeyRef = useRef(textReplacement.key);
    const webTextareaRef = useRef<HTMLElement | null>(null);
    const getLiveText = useCallback(() => valueRef.current, []);
    const composerHeight = useComposerHeight({
      getText: getLiveText,
      textareaRef: webTextareaRef,
      minHeight: MIN_INPUT_HEIGHT,
      maxHeight: maxInputHeight,
    });
    const { style: composerHeightStyle, scrollEnabled: isComposerScrollEnabled } = composerHeight;
    const measuredComposerHeight = composerHeight.mode === "measured" ? composerHeight : undefined;
    const updateComposerHeightForText = measuredComposerHeight?.onTextChange;
    const resetComposerHeight = measuredComposerHeight?.reset;

    const handleComposerLayout = useCallback(
      (event: LayoutChangeEvent) => {
        const { height } = event.nativeEvent.layout;
        onHeightChange?.(height);
      },
      [onHeightChange],
    );

    const updateLiveTextPresence = useCallback((text: string) => {
      const nextHasLiveText = text.trim().length > 0;
      if (hasLiveTextRef.current === nextHasLiveText) return;
      hasLiveTextRef.current = nextHasLiveText;
      setHasLiveText(nextHasLiveText);
    }, []);

    const replaceText = useCallback(
      (nextText: string, selection?: { start: number; end: number }) => {
        updateComposerHeightForText?.(valueRef.current, nextText);
        valueRef.current = nextText;
        updateLiveTextPresence(nextText);
        selectionRef.current = selection ?? { start: nextText.length, end: nextText.length };
        if (nextText === "") {
          textInputRef.current?.reset();
        } else {
          textInputRef.current?.replaceText(nextText, selection);
        }
        onChangeText(nextText);
      },
      [onChangeText, updateComposerHeightForText, updateLiveTextPresence],
    );

    useImperativeHandle(ref, () => ({
      focus: () => {
        textInputRef.current?.focus();
      },
      blur: () => {
        textInputRef.current?.blur();
      },
      getText: () => textInputRef.current?.getText() ?? valueRef.current,
      getInputSnapshot: () =>
        getComposerInputSnapshot(textInputRef.current, valueRef.current, selectionRef.current),
      replaceText,
      runKeyboardAction: (action) =>
        runMessageInputKeyboardAction(action, {
          focusInput: () => textInputRef.current?.focus(),
          isDictationRecording: isDictationActive,
          markTranscriptForSend: () => {
            sendAfterTranscriptRef.current = true;
          },
          confirmDictation,
          cancelDictation,
          startDictation: startDictationIfAvailable,
        }),
      getNativeElement: () => (isWeb ? getTextInputNativeElement(textInputRef.current) : null),
    }));
    const sendAfterTranscriptRef = useRef(false);
    const serverInfo = useSessionStore(
      useCallback(
        (state) => {
          if (!voiceServerId) {
            return null;
          }
          return state.sessions[voiceServerId]?.serverInfo ?? null;
        },
        [voiceServerId],
      ),
    );

    useEffect(() => {
      if (appliedTextReplacementKeyRef.current === textReplacement.key) return;
      appliedTextReplacementKeyRef.current = textReplacement.key;
      updateComposerHeightForText?.(valueRef.current, textReplacement.text);
      valueRef.current = textReplacement.text;
      updateLiveTextPresence(textReplacement.text);
      if (textReplacement.text === "") {
        textInputRef.current?.reset();
      } else {
        textInputRef.current?.replaceText(textReplacement.text);
      }
    }, [textReplacement, updateComposerHeightForText, updateLiveTextPresence]);

    useEffect(() => {
      return () => {
        onFocusChange?.(false);
      };
    }, [onFocusChange]);

    const handleDictationTranscript = useCallback(
      (text: string, _meta: { requestId: string }) => {
        const autoSend = sendAfterTranscriptRef.current;
        sendAfterTranscriptRef.current = false;
        applyDictationTranscript(text, {
          value: valueRef.current,
          defaultSendBehavior,
          isAgentRunning,
          onQueue,
          onSubmit,
          replaceText,
          attachments,
          cwd,
          autoSend,
        });
      },
      [replaceText, onSubmit, onQueue, attachments, cwd, isAgentRunning, defaultSendBehavior],
    );

    const handleDictationError = useCallback(
      (error: Error) => {
        console.error("[MessageInput] Dictation error:", error);
        toast.error(error.message);
      },
      [toast],
    );

    const dictationUnavailableMessage = resolveVoiceUnavailableMessage({
      serverInfo,
      mode: "dictation",
    });

    const canStartDictation = useCallback(
      () =>
        computeCanStartDictation({
          client,
          isReadyForDictation,
          disabled,
          dictationUnavailableMessage,
        }),
      [client, disabled, dictationUnavailableMessage, isReadyForDictation],
    );

    const canConfirmDictation = useCallback(() => client?.isConnected ?? false, [client]);
    const isConnected = client?.isConnected ?? false;
    const isDictationStartEnabled = computeIsDictationStartEnabled(
      isReadyForDictation,
      isConnected,
      disabled,
    );

    const {
      isRecording: isDictating,
      isRecordingActive: isDictationActive,
      isProcessing: isDictationProcessing,
      partialTranscript: _dictationPartialTranscript,
      volume: dictationVolume,
      duration: dictationDuration,
      error: dictationError,
      status: dictationStatus,
      startDictation,
      cancelDictation,
      confirmDictation,
      retryFailedDictation,
      discardFailedDictation,
    } = useDictation({
      client,
      onTranscript: handleDictationTranscript,
      onError: handleDictationError,
      canStart: canStartDictation,
      canConfirm: canConfirmDictation,
      enableDuration: true,
    });

    const showDictationOverlay = computeShouldShowDictationOverlay(
      isDictating,
      isDictationProcessing,
      dictationStatus,
    );
    const showOverlay = showDictationOverlay;
    const surfacePresentation = resolveComposerSurfacePresentation(showOverlay);

    useEffect(() => {
      if (isDictating || isDictationProcessing) {
        return;
      }
      sendAfterTranscriptRef.current = false;
    }, [dictationStatus, isDictating, isDictationProcessing]);

    const startDictationIfAvailable = useCallback(
      () =>
        startDictationIfAvailableImpl({
          dictationUnavailableMessage,
          canStartDictation,
          toast,
          startDictation,
        }),
      [canStartDictation, dictationUnavailableMessage, startDictation, toast],
    );

    const handleVoicePress = useCallback(
      () =>
        handleVoicePressImpl({
          isDictating,
          cancelDictation,
          startDictationIfAvailable,
        }),
      [cancelDictation, isDictating, startDictationIfAvailable],
    );

    const handleCancelRecording = useCallback(async () => {
      await cancelDictation();
    }, [cancelDictation]);

    const handleAcceptRecording = useCallback(async () => {
      sendAfterTranscriptRef.current = false;
      await confirmDictation();
    }, [confirmDictation]);

    const handleAcceptAndSendRecording = useCallback(async () => {
      sendAfterTranscriptRef.current = true;
      await confirmDictation();
    }, [confirmDictation]);

    const handleRetryFailedRecording = useCallback(() => {
      void retryFailedDictation();
    }, [retryFailedDictation]);

    const handleDiscardFailedRecording = useCallback(() => {
      discardFailedDictation();
    }, [discardFailedDictation]);

    const minimizeInputHeight = useCallback(() => {
      resetComposerHeight?.();
    }, [resetComposerHeight]);

    const sendWithBehavior = useCallback(
      (activeTurnBehavior?: ActiveTurnSendBehavior) => {
        const liveValue = textInputRef.current?.getText() ?? valueRef.current;
        if (!preserveHeightOnSubmit) {
          updateLiveTextPresence("");
        }
        sendMessageImpl({
          value: liveValue,
          attachments,
          hasExternalContent,
          allowEmptySubmit,
          cwd,
          isAgentRunning,
          onSubmit,
          onMinimizeHeight: minimizeInputHeight,
          preserveHeightOnSubmit,
          activeTurnBehavior,
        });
      },
      [
        allowEmptySubmit,
        attachments,
        cwd,
        onSubmit,
        isAgentRunning,
        hasExternalContent,
        minimizeInputHeight,
        preserveHeightOnSubmit,
        updateLiveTextPresence,
      ],
    );
    const handleSendMessage = useCallback(() => sendWithBehavior(), [sendWithBehavior]);

    const handleQueueMessage = useCallback(
      () =>
        queueMessageImpl({
          value: textInputRef.current?.getText() ?? valueRef.current,
          attachments,
          cwd,
          onQueue,
          replaceText,
          onMinimizeHeight: minimizeInputHeight,
        }),
      [attachments, cwd, onQueue, replaceText, minimizeInputHeight],
    );

    const handleDefaultSendAction = useCallback(() => {
      runDefaultSendAction({
        defaultSendBehavior,
        isAgentRunning,
        onQueue,
        handleSendMessage,
        handleQueueMessage,
      });
    }, [defaultSendBehavior, isAgentRunning, onQueue, handleQueueMessage, handleSendMessage]);

    const handleSendAction = useCallback(
      (action: ComposerSendAction) => {
        if (action === "queue") {
          handleQueueMessage();
          return;
        }
        sendWithBehavior(action);
      },
      [handleQueueMessage, sendWithBehavior],
    );

    const handleAlternateSendAction = useCallback(() => {
      runAlternateSendAction({
        defaultSendBehavior,
        isAgentRunning,
        onQueue,
        handleSendMessage,
        handleQueueMessage,
      });
    }, [defaultSendBehavior, isAgentRunning, handleSendMessage, handleQueueMessage, onQueue]);

    const getWebTextArea = useCallback(
      (): TextAreaHandle | null => getWebTextAreaImpl(textInputRef.current),
      [],
    );

    useLayoutEffect(() => {
      if (isWeb) {
        webTextareaRef.current = getWebTextArea() as HTMLElement | null;
      }
    }, [getWebTextArea]);

    usePasteImagesEffect({
      getWebTextArea,
      isConnected,
      disabled,
      isDictating,
      onAddImages,
    });

    const handleSelectionChange = useCallback(
      (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const start = event.nativeEvent.selection?.start ?? 0;
        const end = event.nativeEvent.selection?.end ?? start;
        selectionRef.current = { start, end };
        onSelectionChangeCallback?.({ start, end });
      },
      [onSelectionChangeCallback],
    );

    const shouldHandleWebKeyPress = isWeb;
    const shouldSubmitOnEnter = isWeb && !isCompact;

    function handleDesktopKeyPress(event: WebTextInputKeyPressEvent) {
      if (!shouldHandleWebKeyPress) return;
      handleDesktopKeyPressImpl(event, {
        onKeyPressCallback,
        input: getComposerInputSnapshot(
          textInputRef.current,
          valueRef.current,
          selectionRef.current,
        ),
        submitOnEnter: shouldSubmitOnEnter,
        isAgentRunning,
        onQueue,
        isSubmitDisabled,
        isSubmitLoading,
        disabled,
        handleAlternateSendAction,
        handleDefaultSendAction,
      });
    }

    const hasSendableContent = hasSendableComposerContent({
      hasText: hasLiveText,
      attachments,
      hasExternalContent,
    });
    const primaryActionKind = resolvePrimaryActionKind({
      hasSendableContent,
      allowEmptySubmit,
      isAgentRunning,
      isSubmitLoading,
    });
    const { canPressLoadingButton, isSendButtonDisabled, defaultActionQueues } =
      computeSendButtonState({
        disabled,
        isSubmitDisabled,
        isSubmitLoading,
        hasSendableContent,
        allowEmptySubmit,
        onSubmitLoadingPress,
        defaultSendBehavior,
        isAgentRunning,
      });
    useIosHardwareKeyboardSubmit({
      isEnabled: isInputFocused && !isSendButtonDisabled,
      onSubmit: handleDefaultSendAction,
    });
    useMessageInputKeyCommands({
      isFocused: isInputFocused,
      isSubmitDisabled,
      isSubmitLoading,
      disabled,
      isAgentRunning,
      onQueue,
      sendDefault: handleDefaultSendAction,
      sendAlternate: handleAlternateSendAction,
    });
    const submitAccessibilityLabel = resolveSubmitAccessibilityLabel({
      submitButtonAccessibilityLabel,
      canPressLoadingButton,
      defaultActionQueues,
      defaultSendBehavior,
      isAgentRunning,
      t,
    });

    const voiceButtonAccessibilityLabel = resolveVoiceAccessibilityLabel({ isDictating, t });

    const voiceTooltipText = resolveVoiceTooltipText({
      dictationModelLabel: getDictationModelLabel(serverInfo),
      t,
    });

    const sendTooltipLabel = resolveSendTooltipLabel({
      submitButtonAccessibilityLabel,
      defaultActionQueues,
      t,
    });
    const canQueue = onQueue !== undefined;
    const alternateSendTooltipLabel = resolveAlternateSendTooltipLabel({
      defaultSendBehavior,
      isAgentRunning,
      canQueue,
      t,
    });
    const alternateSendActions = useMemo(
      () => resolveAlternateSendActions({ defaultSendBehavior, isAgentRunning, canQueue }),
      [canQueue, defaultSendBehavior, isAgentRunning],
    );

    const handleInputChange = useCallback(
      (nextValue: string) => {
        updateComposerHeightForText?.(valueRef.current, nextValue);
        valueRef.current = nextValue;
        updateLiveTextPresence(nextValue);
        onChangeText(nextValue);
      },
      [onChangeText, updateComposerHeightForText, updateLiveTextPresence],
    );

    const handleInputFocus = useCallback(() => {
      isInputFocusedRef.current = true;
      setIsInputFocused(true);
      onFocusChange?.(true);
    }, [onFocusChange]);

    const handleInputBlur = useCallback(() => {
      isInputFocusedRef.current = false;
      setIsInputFocused(false);
      onFocusChange?.(false);
    }, [onFocusChange]);

    const handlePasteError = useCallback(
      (message: string) => {
        console.error("[MessageInput] Native paste failed:", message);
        toast.error(t("composer.errors.pasteImageFailed"));
      },
      [t, toast],
    );

    const attachButtonStyle = useCallback(
      ({ hovered }: { hovered?: boolean }) => [
        styles.attachButton,
        Boolean(hovered) && styles.iconButtonHovered,
        (!isConnected || disabled) && styles.buttonDisabled,
      ],
      [isConnected, disabled],
    );

    const voiceButtonStyle = useCallback(
      ({ hovered }: { hovered?: boolean }) => [
        styles.voiceButton,
        Boolean(hovered) && !isDictating && styles.iconButtonHovered,
        !isDictationStartEnabled && styles.buttonDisabled,
        isDictating && styles.voiceButtonRecording,
      ],
      [isDictating, isDictationStartEnabled],
    );

    const inputWrapperCombinedStyle = useMemo(
      () => [
        styles.inputWrapper,
        readOnly && styles.inputWrapperReadOnly,
        inputWrapperStyle,
        { opacity: surfacePresentation.input.opacity },
      ],
      [inputWrapperStyle, readOnly, surfacePresentation.input.opacity],
    );
    // `withUnistyles` maps this component's `style` into a `.hash > *` child
    // rule, which ties on specificity with react-native-web's own
    // `.css-textinput-*` class and loses on source order — so a themed
    // `fontFamily` here is silently dropped while every other property lands.
    // An inline style outranks both classes. See docs/unistyles.md.
    const textInputStyle = useMemo(
      () => [styles.textInput, mode.isMonospace && styles.textInputMonospace, composerHeightStyle],
      [composerHeightStyle, mode.isMonospace],
    );
    // Static content has no textarea to mirror, so it grows with its own text
    // instead of the measured input height.
    const readOnlyTextStyle = useMemo(
      () => [styles.textInput, mode.isMonospace && styles.textInputMonospace, styles.readOnlyText],
      [mode.isMonospace],
    );
    const sendButtonCombinedStyle = useMemo(
      () => [
        styles.sendButton,
        isTouchDensity && styles.primaryButtonTouch,
        submitLabel ? styles.sendButtonLabeled : undefined,
        isSendButtonDisabled && styles.buttonDisabled,
      ],
      [isSendButtonDisabled, isTouchDensity, submitLabel],
    );
    const handleToolbarLayout = usePublishQuickPromptSurface({
      overlay: showOverlay,
      disabled,
      readOnly,
    });

    const rightButtonGroupStyle = useMemo(
      () => [styles.rightButtonGroup, isTouchDensity && styles.rightButtonGroupTouch],
      [isTouchDensity],
    );
    const overlayContainerStyle = useMemo(
      () => [styles.overlayContainer, { opacity: surfacePresentation.overlay.opacity }],
      [surfacePresentation.overlay.opacity],
    );

    const renderAttachButtonIcon = useCallback(
      ({ hovered }: { hovered?: boolean }) => (
        <AttachButtonIcon
          hovered={Boolean(hovered)}
          onAttachButtonRef={onAttachButtonRef}
          buttonIconSize={buttonIconSize}
        />
      ),
      [onAttachButtonRef, buttonIconSize],
    );

    const renderVoiceButtonIcon = useCallback(
      ({ hovered }: { hovered?: boolean }) => (
        <VoiceButtonIcon
          hovered={Boolean(hovered)}
          isDictating={isDictating}
          buttonIconSize={buttonIconSize}
        />
      ),
      [isDictating, buttonIconSize],
    );

    return (
      <View
        ref={rootRef}
        style={styles.container}
        testID="message-input-root"
        onLayout={handleComposerLayout}
      >
        <MessageInputAutoFocus
          enabled={autoFocus}
          autoFocusKey={autoFocusKey}
          textInputRef={textInputRef}
        />
        {/* Regular input */}
        <View
          ref={inputWrapperRef}
          style={inputWrapperCombinedStyle}
          pointerEvents={surfacePresentation.input.pointerEvents}
        >
          {attachmentSlot}
          {/* Text input */}
          <RenderProfile id="ComposerTextSurface">
            <ComposerTextSurface
              readOnly={readOnly}
              value={value}
              textInputRef={textInputRef}
              textInputStyle={textInputStyle}
              readOnlyTextStyle={readOnlyTextStyle}
              placeholder={placeholder ?? t("composer.placeholders.fallback")}
              accessibilityLabel={t(mode.accessibilityLabelKey)}
              onChangeText={handleInputChange}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
              editable={!isDictating && !disabled}
              scrollEnabled={isComposerScrollEnabled}
              autoFocus={false}
              onKeyPress={shouldHandleWebKeyPress ? handleDesktopKeyPress : undefined}
              onSelectionChange={handleSelectionChange}
              onPasteImages={onPasteImages}
              onPasteError={handlePasteError}
              focusHintVisible={isWeb && !isInputFocused && !value}
              focusInputKeys={focusInputKeys}
              focusHintLabel={t("composer.input.focusHint", {
                shortcut: focusInputKeys ? formatShortcut(focusInputKeys[0], getShortcutOs()) : "",
              })}
            />
          </RenderProfile>

          {/* Button row */}
          <View style={styles.buttonRow} onLayout={handleToolbarLayout}>
            {/* Toolbar left: attachment button + agent controls */}
            <View style={styles.leftButtonGroup}>
              <AttachmentDropdown
                visible={mode.showAttachments}
                isConnected={isConnected}
                disabled={disabled}
                attachButtonStyle={attachButtonStyle}
                renderAttachButtonIcon={renderAttachButtonIcon}
                attachmentMenuItems={attachmentMenuItems}
                attachmentMenuPages={attachmentMenuPages}
                attachmentMenuFooter={attachmentMenuFooter}
                addAttachmentLabel={t("composer.input.addAttachment")}
              />
              {leftContent}
            </View>

            {/* Right: dictation button, contextual button (send/cancel) */}
            <View style={rightButtonGroupStyle}>
              {beforeVoiceContent}
              <VoiceButtonTooltip
                visible={mode.showVoice}
                onVoicePress={handleVoicePress}
                isDictationStartEnabled={isDictationStartEnabled}
                voiceButtonAccessibilityLabel={voiceButtonAccessibilityLabel}
                voiceButtonStyle={voiceButtonStyle}
                renderVoiceButtonIcon={renderVoiceButtonIcon}
                voiceTooltipText={voiceTooltipText}
                dictationToggleKeys={dictationToggleKeys}
              />
              {rightContent}
              <PrimaryAction
                kind={primaryActionKind}
                activeActionContent={activeActionContent}
                shouldShow
                canPressLoadingButton={canPressLoadingButton}
                onSubmitLoadingPress={onSubmitLoadingPress}
                onDefaultSendAction={handleDefaultSendAction}
                isSendButtonDisabled={isSendButtonDisabled}
                submitAccessibilityLabel={submitAccessibilityLabel}
                sendButtonCombinedStyle={sendButtonCombinedStyle}
                isSubmitLoading={isSubmitLoading}
                submitIcon={submitIcon}
                submitLabel={submitLabel}
                submitButtonTestID={submitButtonTestID}
                buttonIconSize={buttonIconSize}
                sendKeys={DEFAULT_SEND_KEYS}
                sendTooltipLabel={sendTooltipLabel}
                alternateSendTooltipLabel={alternateSendTooltipLabel}
                alternateSendActions={alternateSendActions}
                onSendAction={handleSendAction}
              />
            </View>
          </View>
        </View>

        <View
          style={overlayContainerStyle}
          pointerEvents={surfacePresentation.overlay.pointerEvents}
        >
          <MessageInputOverlay
            showDictationOverlay={showDictationOverlay}
            dictationVolume={dictationVolume}
            dictationDuration={dictationDuration}
            isDictating={isDictating}
            isDictationProcessing={isDictationProcessing}
            dictationStatus={dictationStatus}
            dictationError={dictationError}
            onCancelRecording={handleCancelRecording}
            onAcceptRecording={handleAcceptRecording}
            onAcceptAndSendRecording={handleAcceptAndSendRecording}
            onRetryFailedRecording={handleRetryFailedRecording}
            onDiscardFailedRecording={handleDiscardFailedRecording}
          />
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flexShrink: 1,
    position: "relative",
  },
  inputWrapper: {
    flexShrink: 1,
    flexDirection: "column",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingTop: {
      xs: theme.spacing[2],
      md: theme.spacing[4],
    },
    // The button row bleeds 6px horizontally, so match its corner inset at the bottom.
    paddingBottom: {
      xs: theme.spacing[2],
      md: theme.spacing[3],
    },
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    ...(isWeb
      ? {
          transitionProperty: "border-color",
          transitionDuration: "200ms",
          transitionTimingFunction: "ease-in-out",
        }
      : {}),
  },
  // Dotted says "this surface is the same box, but there is nothing to type
  // into it" without swapping the border colour, which reads as an error state.
  inputWrapperReadOnly: {
    borderStyle: "dotted",
  },
  textInputScrollWrapper: {
    flexShrink: 1,
    position: "relative",
  },
  focusHintText: {
    position: "absolute",
    top: 0,
    right: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    opacity: 0.5,
  },
  textInput: {
    // Preserve the controls when an ancestor constrains an overlong draft.
    flexShrink: 1,
    width: "100%",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.normal,
    // No lineHeight on native. React Native applies it as a span over the text, and an
    // empty trailing line is laid out from the font's own metrics on some devices, so
    // the input jumps when the first character lands on a new line. The font's natural
    // line box is the same for every line. Web keeps the CSS value.
    ...(isWeb
      ? ({
          lineHeight: theme.fontSize.content * 1.4,
          outlineStyle: "none",
          outlineWidth: 0,
          outlineColor: "transparent",
        } as object)
      : {}),
  },
  textInputMonospace: {
    fontFamily: theme.fontFamily.mono,
  },
  readOnlyText: {
    minHeight: MIN_INPUT_HEIGHT,
    color: theme.colors.foregroundMuted,
  },
  // Every control shares one centerline: 28pt glyph buttons, the 32pt send circle, and the
  // clusters, whose touch hit slop lives inside their own frame.
  buttonRow: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: -6,
  },
  leftButtonGroup: {
    minWidth: 0,
    flexShrink: 1,
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0],
  },
  rightButtonGroup: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // Touch targets abut instead, so neighbouring buttons never share a strip of screen.
  rightButtonGroupTouch: {
    gap: 0,
  },
  attachButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  attachButtonAnchor: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButtonRecording: {
    backgroundColor: theme.colors.destructive,
  },
  // Codex's round arrow: the foreground as fill, the surface as ink.
  sendButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foreground,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: theme.spacing[1],
  },
  primaryButtonTouch: {
    width: COMPOSER_TOOLBAR_GEOMETRY.primaryTouchSize,
    height: COMPOSER_TOOLBAR_GEOMETRY.primaryTouchSize,
    marginLeft: 0,
  },
  sendButtonLabeled: {
    width: "auto",
    minWidth: 28,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
  },
  sendButtonLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.surface0,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipBody: {
    gap: theme.spacing[1],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  tooltipTextMuted: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  overlayContainer: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    right: 0,
    bottom: 0,
  },
})) as unknown as Record<string, object>;

const ThemedPlus = withUnistyles(Plus);
function toolbarGlyphStroke(size: number) {
  return resolveComposerToolbarGlyphStroke(resolveContextWindowMeterRing(size));
}
// Vertical spans on the 24 grid as they rasterise, measured on 2x and 3x screens: the path
// says 14 and 20, but round caps and curve apexes land about a third of a point short at each
// end, so the spans are a little under and each glyph comes out exactly as tall as the ring.
const PLUS_INK_EXTENT = 13.75;
const MIC_INK_EXTENT = 19.2;
function toolbarGlyphBox(size: number, inkExtent: number) {
  return resolveComposerToolbarGlyphBox(resolveContextWindowMeterRing(size), inkExtent);
}
const ThemedMic = withUnistyles(Mic);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedCornerDownLeft = withUnistyles(CornerDownLeft);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconSendForegroundMapping = (theme: Theme) => ({ color: theme.colors.surface0 });
