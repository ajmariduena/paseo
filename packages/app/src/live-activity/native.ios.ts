import { requireOptionalNativeModule } from "expo-modules-core";
import type { LiveActivityNative } from "./native-types";

// Optional because an OTA JS update can land on a binary built before the module existed.
export const liveActivityNative =
  requireOptionalNativeModule<LiveActivityNative>("PaseoLiveActivity");
