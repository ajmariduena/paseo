import { Fragment, useCallback, useMemo, type ReactElement } from "react";
import type {
  VoiceCommandsModel,
  VoiceCommandsOption,
} from "@getpaseo/protocol/voice-commands/rpc-schemas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import { sameModel, type VoiceCommandsOptionGroup } from "./catalog";

/** A choice outside the catalog, listed under the divider. */
export interface ModelPickerExtra {
  id: string;
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
}

interface ModelPickerProps {
  /** Names the control for assistive tech and titles the compact sheet. */
  label: string;
  display: string;
  groups: VoiceCommandsOptionGroup[];
  value: VoiceCommandsModel | null;
  extras: ModelPickerExtra[];
  disabled: boolean;
  /** The chosen value is being saved. */
  loading: boolean;
  size: FieldControlSize;
  onSelect: (model: VoiceCommandsModel) => void;
  testID: string;
}

export function ModelPicker({
  label,
  display,
  groups,
  value,
  extras,
  disabled,
  loading,
  size,
  onSelect,
  testID,
}: ModelPickerProps): ReactElement {
  const triggerDisplay = useMemo(() => ({ label: display }), [display]);
  const renderTrigger = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => (
      <SelectFieldTrigger
        display={triggerDisplay}
        placeholder={display}
        hovered={hovered}
        active={pressed || open}
        disabled={disabled}
        loading={loading}
        size={size}
      />
    ),
    [disabled, display, loading, size, triggerDisplay],
  );
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${display}`}
        testID={`${testID}-trigger`}
      >
        {renderTrigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        minWidth={280}
        maxWidth={360}
        maxHeight={440}
        scrollable
        sheetTitle={label}
        testID={`${testID}-menu`}
      >
        {groups.map((group) => (
          <Fragment key={group.provider}>
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {group.options.map((option) => (
              <CatalogItem
                key={option.model}
                option={option}
                selected={sameModel(option, value)}
                onSelect={onSelect}
                testID={`${testID}-option-${option.provider}-${option.model}`}
              />
            ))}
          </Fragment>
        ))}
        {groups.length > 0 && extras.length > 0 ? <DropdownMenuSeparator /> : null}
        {extras.map((extra) => (
          <DropdownMenuItem
            key={extra.id}
            description={extra.description}
            selected={extra.selected}
            onSelect={extra.onSelect}
            testID={`${testID}-${extra.id}`}
          >
            {extra.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CatalogItem({
  option,
  selected,
  onSelect,
  testID,
}: {
  option: VoiceCommandsOption;
  selected: boolean;
  onSelect: (model: VoiceCommandsModel) => void;
  testID: string;
}) {
  const select = useCallback(
    () => onSelect({ provider: option.provider, model: option.model }),
    [onSelect, option.model, option.provider],
  );
  return (
    <DropdownMenuItem
      description={option.description}
      selected={selected}
      onSelect={select}
      testID={testID}
    >
      {option.label}
    </DropdownMenuItem>
  );
}
