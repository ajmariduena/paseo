/**
 * @vitest-environment jsdom
 */
import React, { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { Text, type View } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot, MenuTrigger, resolveMenuTriggerActivation } from "./menu-root";

beforeEach(() => vi.stubGlobal("React", React));

describe("MenuTrigger", () => {
  it("forwards its rendered trigger to callers", () => {
    const triggerRef = createRef<View>();

    render(
      <MenuRoot>
        <MenuTrigger ref={triggerRef} accessibilityLabel="Open menu">
          <Text>Open</Text>
        </MenuTrigger>
      </MenuRoot>,
    );

    expect(triggerRef.current).not.toBeNull();
  });

  // A tooltip wraps the trigger with `asChild` and composes its own `onPress` in; the tap must
  // still open the menu. The composer's + button broke this way once.
  it("opens on press and still runs an onPress the caller composed in", () => {
    const onPress = vi.fn();
    const onOpenChange = vi.fn();
    const { getByRole } = render(
      <MenuRoot onOpenChange={onOpenChange}>
        <MenuTrigger accessibilityRole="button" accessibilityLabel="Add" onPress={onPress}>
          <Text>Add</Text>
        </MenuTrigger>
      </MenuRoot>,
    );

    fireEvent.click(getByRole("button", { name: "Add" }));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(getByRole("button", { name: "Add" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the tap for the caller when the menu opens on a long press", () => {
    const onPress = vi.fn();
    const onOpenChange = vi.fn();
    const { getByRole } = render(
      <MenuRoot onOpenChange={onOpenChange}>
        <MenuTrigger
          accessibilityRole="button"
          accessibilityLabel="Send"
          activation="longPress"
          onPress={onPress}
        >
          <Text>Send</Text>
        </MenuTrigger>
      </MenuRoot>,
    );

    fireEvent.click(getByRole("button", { name: "Send" }));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(getByRole("button", { name: "Send" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("maps each activation to exactly one opening gesture", () => {
    expect(resolveMenuTriggerActivation("press")).toEqual({
      pressOpens: true,
      longPressOpens: false,
    });
    expect(resolveMenuTriggerActivation("longPress")).toEqual({
      pressOpens: false,
      longPressOpens: true,
    });
  });
});
