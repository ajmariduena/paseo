import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Cpu, Gauge, RotateCcw, Zap } from "lucide-react-native";
import type { AgentFeature, AgentFeatureToggle } from "@getpaseo/protocol/agent-types";
import { getAgentFeatureIcon } from "@/agent-controls/icons";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { getFeatureTooltip, resolveFeatureIconTint } from "@/composer/agent-controls/utils";
import type { EffortOption, EffortSelection } from "@/composer/agent-controls/effort-selection";

const SPEED_STANDARD = "standard";
const SPEED_FAST = "fast";

export interface AdvancedPageProps {
  modelLabel: string;
  onOpenModels: (() => void) | undefined;
  effort: EffortSelection;
  effortOptions: readonly EffortOption[];
  onSelectEffort: ((effortId: string) => void) | undefined;
  fastFeature: AgentFeatureToggle | null;
  features: readonly AgentFeature[];
  onSetFeature: ((featureId: string, value: unknown) => void) | undefined;
  onReset: () => void;
  canReset: boolean;
  disabled: boolean;
}

/**
 * Model, Intelligence and Speed as "Label  Value ›" rows. Model pushes into the model browser;
 * the others push a short list, which is the menu engine's idiom for Codex's inline pickers.
 */
export function AdvancedPage({
  modelLabel,
  onOpenModels,
  effort,
  effortOptions,
  onSelectEffort,
  fastFeature,
  features,
  onSetFeature,
  onReset,
  canReset,
  disabled,
}: AdvancedPageProps): ReactElement {
  const { t } = useTranslation();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const handleOpenChange = useCallback(
    (row: string) => (nextOpen: boolean) => setOpenRow(nextOpen ? row : null),
    [],
  );
  const effortValue = effort.hasEffort
    ? effort.selectedLabel
    : t("agentControls.intelligence.managed");

  return (
    <View style={styles.page} testID="agent-advanced-page">
      <View style={styles.group}>
        {onOpenModels ? (
          <AgentControlTrigger
            icon={Cpu}
            surface="sheet"
            label={t("agentControls.advanced.model")}
            value={modelLabel}
            showCaret
            disabled={disabled}
            onPress={onOpenModels}
            accessibilityLabel={t("modelSelector.selectedModel", { model: modelLabel })}
            testID="agent-effort-model"
          />
        ) : null}
        <EffortRow
          effort={effort}
          effortOptions={effortOptions}
          value={effortValue}
          onSelectEffort={onSelectEffort}
          open={openRow === "effort"}
          onOpenChange={handleOpenChange("effort")}
          disabled={disabled}
        />
      </View>
      {fastFeature || features.length > 0 ? (
        <View style={styles.group}>
          {fastFeature ? (
            <SpeedRow
              feature={fastFeature}
              onSetFeature={onSetFeature}
              open={openRow === "speed"}
              onOpenChange={handleOpenChange("speed")}
              disabled={disabled}
            />
          ) : null}
          {features.map((feature) => (
            <SheetFeatureItem
              key={`feature-${feature.id}`}
              feature={feature}
              disabled={disabled}
              openSelector={openRow}
              handleOpenChange={handleOpenChange}
              onSetFeature={onSetFeature}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.group}>
        <AgentControlTrigger
          icon={RotateCcw}
          surface="sheet"
          label={t("agentControls.advanced.reset")}
          value=""
          disabled={disabled || !canReset}
          onPress={onReset}
          accessibilityLabel={t("agentControls.advanced.reset")}
          testID="agent-effort-reset"
        />
      </View>
    </View>
  );
}

function EffortRow({
  effort,
  effortOptions,
  value,
  onSelectEffort,
  open,
  onOpenChange,
  disabled,
}: {
  effort: EffortSelection;
  effortOptions: readonly EffortOption[];
  value: string;
  onSelectEffort: ((effortId: string) => void) | undefined;
  open: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const options = useMemo<ComboboxOption[]>(
    () =>
      effortOptions.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
      })),
    [effortOptions],
  );
  const header = useMemo<SheetHeader>(
    () => ({ title: t("agentControls.intelligence.title") }),
    [t],
  );
  const handlePress = useCallback(() => onOpenChange(!open), [onOpenChange, open]);
  const handleSelect = useCallback(
    (optionId: string) => onSelectEffort?.(optionId),
    [onSelectEffort],
  );
  const pickable = effort.hasEffort && onSelectEffort !== undefined;
  return (
    <>
      <AgentControlTrigger
        ref={anchorRef}
        icon={Gauge}
        surface="sheet"
        label={t("agentControls.intelligence.title")}
        value={value}
        showCaret={pickable}
        open={open}
        disabled={disabled || !pickable}
        onPress={handlePress}
        accessibilityLabel={t("agentControls.intelligence.selectWithValue", { value })}
        testID="agent-effort-level"
      />
      {pickable ? (
        <Combobox
          options={options}
          value={effort.selectedId}
          onSelect={handleSelect}
          open={open}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          presentation="push"
          searchable={false}
          header={header}
        />
      ) : null}
    </>
  );
}

function SpeedRow({
  feature,
  onSetFeature,
  open,
  onOpenChange,
  disabled,
}: {
  feature: AgentFeatureToggle;
  onSetFeature: ((featureId: string, value: unknown) => void) | undefined;
  open: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const options = useMemo<ComboboxOption[]>(
    () => [
      { id: SPEED_STANDARD, label: t("agentControls.speed.standard") },
      { id: SPEED_FAST, label: feature.label, description: feature.description },
    ],
    [feature.description, feature.label, t],
  );
  const header = useMemo<SheetHeader>(() => ({ title: t("agentControls.speed.title") }), [t]);
  const handlePress = useCallback(() => onOpenChange(!open), [onOpenChange, open]);
  const handleSelect = useCallback(
    (optionId: string) => onSetFeature?.(feature.id, optionId === SPEED_FAST),
    [feature.id, onSetFeature],
  );
  const value = feature.value ? feature.label : t("agentControls.speed.standard");
  return (
    <>
      <AgentControlTrigger
        ref={anchorRef}
        icon={Zap}
        iconTint={feature.value ? "accent" : "muted"}
        surface="sheet"
        label={t("agentControls.speed.title")}
        value={value}
        showCaret
        open={open}
        disabled={disabled}
        onPress={handlePress}
        accessibilityLabel={getFeatureTooltip(feature)}
        testID="agent-effort-fast"
      />
      <Combobox
        options={options}
        value={feature.value ? SPEED_FAST : SPEED_STANDARD}
        onSelect={handleSelect}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        presentation="push"
        searchable={false}
        header={header}
      />
    </>
  );
}

export function SheetFeatureItem({
  feature,
  disabled,
  openSelector,
  handleOpenChange,
  onSetFeature,
}: {
  feature: AgentFeature;
  disabled: boolean;
  openSelector: string | null;
  handleOpenChange: (selector: string) => (nextOpen: boolean) => void;
  onSetFeature?: (featureId: string, value: unknown) => void;
}) {
  const { t } = useTranslation();
  const featureSelector = `feature-${feature.id}`;
  const featureAnchorRef = useRef<View>(null);

  const handleFeatureOpenChange = useMemo(
    () => handleOpenChange(featureSelector),
    [handleOpenChange, featureSelector],
  );
  const handleSelectPress = useCallback(
    () => handleFeatureOpenChange(openSelector !== featureSelector),
    [featureSelector, handleFeatureOpenChange, openSelector],
  );
  const sheetHeader = useMemo<SheetHeader>(() => ({ title: feature.label }), [feature.label]);

  const handleSelectOption = useCallback(
    (optionId: string) => {
      onSetFeature?.(feature.id, feature.type === "toggle" ? optionId === "true" : optionId);
    },
    [feature.id, feature.type, onSetFeature],
  );
  const comboboxOptions = useMemo<ComboboxOption[]>(() => {
    if (feature.type === "select") {
      return feature.options.map((option) => ({ id: option.id, label: option.label }));
    }
    return [
      { id: "true", label: t("agentControls.features.on") },
      { id: "false", label: t("agentControls.features.off") },
    ];
  }, [feature, t]);

  if (feature.type === "toggle") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    return (
      <>
        <AgentControlTrigger
          ref={featureAnchorRef}
          icon={FeatureIcon}
          iconTint={resolveFeatureIconTint(feature.id, feature.value)}
          surface="sheet"
          label={feature.label}
          value={feature.value ? t("agentControls.features.on") : t("agentControls.features.off")}
          open={openSelector === featureSelector}
          disabled={disabled}
          onPress={handleSelectPress}
          accessibilityLabel={getFeatureTooltip(feature)}
          testID={`agent-feature-${feature.id}`}
        />
        <Combobox
          options={comboboxOptions}
          value={String(feature.value)}
          onSelect={handleSelectOption}
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
          anchorRef={featureAnchorRef}
          presentation="push"
          searchable={false}
          header={sheetHeader}
        />
      </>
    );
  }

  if (feature.type === "select") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    const selectedOption = feature.options.find((o) => o.id === feature.value);
    return (
      <>
        <AgentControlTrigger
          ref={featureAnchorRef}
          icon={FeatureIcon}
          surface="sheet"
          label={feature.label}
          value={selectedOption?.label ?? feature.label}
          open={openSelector === featureSelector}
          disabled={disabled}
          onPress={handleSelectPress}
          accessibilityLabel={getFeatureTooltip(feature)}
          testID={`agent-feature-${feature.id}`}
        />
        <Combobox
          options={comboboxOptions}
          value={String(feature.value)}
          onSelect={handleSelectOption}
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
          anchorRef={featureAnchorRef}
          presentation="push"
          header={sheetHeader}
        />
      </>
    );
  }

  return null;
}

const styles = StyleSheet.create((theme) => ({
  page: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[4],
  },
  group: {
    gap: theme.spacing[1],
  },
}));
