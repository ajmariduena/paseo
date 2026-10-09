import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  openCustomEndpointForm,
  openKeyForm,
  type CustomEndpointError,
  type VoiceCommandsApi,
} from "./form";

interface DialogProps {
  api: VoiceCommandsApi;
  size: FieldControlSize;
  /** Called after the host accepted the change. */
  onSaved: () => void;
  onClose: () => void;
}

export function KeyDialog({
  provider,
  providerLabel,
  hasKey,
  api,
  size,
  onSaved,
  onClose,
}: DialogProps & { provider: string; providerLabel: string; hasKey: boolean }) {
  const { t } = useTranslation();
  const [form] = useState(openKeyForm);
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const busy = state.submitting !== null;
  const header = useMemo(
    () => ({ title: t("settings.voiceCommands.keyDialog.title", { provider: providerLabel }) }),
    [t, providerLabel],
  );
  const save = useCallback(
    async (apiKey: string | null) => {
      await api.setKey({ provider, apiKey });
    },
    [api, provider],
  );
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  const submit = useCallback(async () => {
    if (await form.save(save)) onSaved();
  }, [form, save, onSaved]);
  const pressSave = useCallback(() => {
    void submit();
  }, [submit]);
  const remove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("settings.voiceCommands.keyDialog.removeTitle", { provider: providerLabel }),
      message: t("settings.voiceCommands.keyDialog.removeMessage", { provider: providerLabel }),
      confirmLabel: t("settings.voiceCommands.keyDialog.remove"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (confirmed && (await form.remove(save))) onSaved();
  }, [form, save, onSaved, t, providerLabel]);
  const pressRemove = useCallback(() => {
    void remove();
  }, [remove]);
  const fieldLabel = t("settings.voiceCommands.keyDialog.field");
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={480}
      testID="voice-commands-key-dialog"
    >
      <View style={styles.body}>
        <Field label={fieldLabel}>
          <FormTextInput
            size={size}
            initialValue=""
            onChangeText={form.set}
            onSubmitEditing={pressSave}
            editable={!busy}
            secureTextEntry
            placeholder={
              hasKey
                ? t("settings.voiceCommands.keyDialog.replacePlaceholder")
                : t("settings.voiceCommands.keyDialog.placeholder")
            }
            accessibilityLabel={fieldLabel}
            autoCapitalize="none"
            autoCorrect={false}
            testID="voice-commands-key-input"
          />
        </Field>
        {state.error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {state.error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {hasKey ? (
            <Button
              variant="outline"
              onPress={pressRemove}
              loading={state.submitting === "remove"}
              disabled={busy}
              testID="voice-commands-key-remove"
            >
              {t("settings.voiceCommands.keyDialog.remove")}
            </Button>
          ) : (
            <View />
          )}
          <View style={styles.trailingActions}>
            <Button variant="secondary" onPress={close} disabled={busy}>
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="default"
              onPress={pressSave}
              loading={state.submitting === "save"}
              disabled={!state.canSave}
              testID="voice-commands-key-save"
            >
              {t("settings.voiceCommands.save")}
            </Button>
          </View>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function customErrorMessage(error: CustomEndpointError, invalidUrl: string): string {
  return error.code === "invalidUrl" ? invalidUrl : error.message;
}

export function CustomEndpointDialog({
  baseUrl,
  model,
  hasKey,
  api,
  size,
  onSaved,
  onClose,
}: DialogProps & { baseUrl: string; model: string; hasKey: boolean }) {
  const { t } = useTranslation();
  const [form] = useState(() => openCustomEndpointForm({ baseUrl, model }));
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const modelInput = useRef<EditingTextInputHandle>(null);
  const keyInput = useRef<EditingTextInputHandle>(null);
  const header = useMemo(() => ({ title: t("settings.voiceCommands.customDialog.title") }), [t]);
  const close = useCallback(() => {
    if (!state.submitting) onClose();
  }, [state.submitting, onClose]);
  const submit = useCallback(async () => {
    if (await form.submit(api)) onSaved();
  }, [form, api, onSaved]);
  const pressSave = useCallback(() => {
    void submit();
  }, [submit]);
  const setBaseUrl = useCallback((next: string) => form.set({ baseUrl: next }), [form]);
  const setModel = useCallback((next: string) => form.set({ model: next }), [form]);
  const setApiKey = useCallback((next: string) => form.set({ apiKey: next }), [form]);
  const focusModel = useCallback(() => modelInput.current?.focus(), []);
  const focusKey = useCallback(() => keyInput.current?.focus(), []);
  const baseUrlLabel = t("settings.voiceCommands.customDialog.baseUrl");
  const modelLabel = t("settings.voiceCommands.customDialog.model");
  const keyLabel = t("settings.voiceCommands.customDialog.apiKey");
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={480}
      testID="voice-commands-custom-dialog"
    >
      <View style={styles.body}>
        <Field label={baseUrlLabel}>
          <FormTextInput
            size={size}
            initialValue={baseUrl}
            onChangeText={setBaseUrl}
            onSubmitEditing={focusModel}
            submitBehavior="submit"
            editable={!state.submitting}
            placeholder="https://api.example.com/v1"
            accessibilityLabel={baseUrlLabel}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="voice-commands-custom-base-url"
          />
        </Field>
        <Field label={modelLabel}>
          <FormTextInput
            ref={modelInput}
            size={size}
            initialValue={model}
            onChangeText={setModel}
            onSubmitEditing={focusKey}
            submitBehavior="submit"
            editable={!state.submitting}
            accessibilityLabel={modelLabel}
            autoCapitalize="none"
            autoCorrect={false}
            testID="voice-commands-custom-model"
          />
        </Field>
        <Field label={keyLabel}>
          <FormTextInput
            ref={keyInput}
            size={size}
            initialValue=""
            onChangeText={setApiKey}
            onSubmitEditing={pressSave}
            editable={!state.submitting}
            secureTextEntry
            placeholder={
              hasKey
                ? t("settings.voiceCommands.customDialog.keepKey")
                : t("settings.voiceCommands.optional")
            }
            accessibilityLabel={keyLabel}
            autoCapitalize="none"
            autoCorrect={false}
            testID="voice-commands-custom-key"
          />
        </Field>
        {state.error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {customErrorMessage(state.error, t("settings.voiceCommands.customDialog.invalidUrl"))}
          </Text>
        ) : null}
        <View style={styles.trailingActions}>
          <Button variant="secondary" onPress={close} disabled={state.submitting}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={pressSave}
            loading={state.submitting}
            disabled={!state.canSubmit}
            testID="voice-commands-custom-save"
          >
            {t("settings.voiceCommands.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  trailingActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
