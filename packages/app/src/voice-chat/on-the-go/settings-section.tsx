import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { getCarSignals } from "./car-signals";
import type { MotionAuthorization } from "./car-signals-types";
import type { OnTheGoPreference } from "./on-the-go-detector";
import { useOnTheGoSettingsStore } from "./on-the-go-store";

/** Device-local On the go settings; the screen only exists on phones. */
export function OnTheGoSettingsSection() {
  const { t } = useTranslation();
  const preference = useOnTheGoSettingsStore((state) => state.preference);
  const useMotion = useOnTheGoSettingsStore((state) => state.useMotion);
  const rememberedCars = useOnTheGoSettingsStore((state) => state.rememberedCars);
  const signals = useMemo(() => getCarSignals(), []);
  const [motionAuthorization, setMotionAuthorization] = useState<MotionAuthorization>(
    () => signals?.getMotionAuthorization() ?? "unavailable",
  );
  const options = useMemo(
    () => [
      { value: "auto" as const, label: t("settings.onTheGo.auto") },
      { value: "always" as const, label: t("settings.onTheGo.always") },
      { value: "never" as const, label: t("settings.onTheGo.never") },
    ],
    [t],
  );
  const setPreference = useCallback((value: OnTheGoPreference) => {
    useOnTheGoSettingsStore.getState().setPreference(value);
  }, []);
  // The system prompt for motion appears here, with the phone in hand, never mid-call.
  const toggleMotion = useCallback(
    (enabled: boolean) => {
      useOnTheGoSettingsStore.getState().setUseMotion(enabled);
      if (!enabled || !signals || motionAuthorization !== "notDetermined") return;
      void signals.requestMotionAuthorization().then(setMotionAuthorization, () => {});
    },
    [motionAuthorization, signals],
  );
  const motionBlocked = motionAuthorization === "denied" || motionAuthorization === "restricted";

  return (
    <SettingsSection title={t("settings.onTheGo.title")} info={t("settings.onTheGo.description")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.onTheGo.mode")}</Text>
            {preference === "auto" ? (
              <Text style={settingsStyles.rowHint}>{t("settings.onTheGo.autoHint")}</Text>
            ) : null}
          </View>
          <SegmentedControl
            options={options}
            value={preference}
            onValueChange={setPreference}
            size="sm"
            testID="on-the-go-preference"
          />
        </View>
        {preference === "auto" && motionAuthorization !== "unavailable" ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.onTheGo.useMotion")}</Text>
              <Text style={settingsStyles.rowHint}>
                {useMotion && motionBlocked
                  ? t("settings.onTheGo.motionDenied")
                  : t("settings.onTheGo.useMotionHint")}
              </Text>
            </View>
            <Switch value={useMotion} onValueChange={toggleMotion} />
          </View>
        ) : null}
        {preference === "auto" ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.onTheGo.rememberedCars")}</Text>
              {rememberedCars.length === 0 ? (
                <Text style={settingsStyles.rowHint}>{t("settings.onTheGo.noCars")}</Text>
              ) : null}
            </View>
          </View>
        ) : null}
        {preference === "auto"
          ? rememberedCars.map((car) => (
              <RememberedCarRow key={car.uid} uid={car.uid} name={car.name} />
            ))
          : null}
      </View>
    </SettingsSection>
  );
}

function RememberedCarRow({ uid, name }: { uid: string; name: string }) {
  const { t } = useTranslation();
  const forget = useCallback(() => useOnTheGoSettingsStore.getState().forgetCar(uid), [uid]);
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{name}</Text>
      </View>
      <Button variant="ghost" size="sm" onPress={forget}>
        {t("settings.onTheGo.forget")}
      </Button>
    </View>
  );
}
