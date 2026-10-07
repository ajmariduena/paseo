import * as Linking from "expo-linking";
import { getDesktopHost } from "@/desktop/host";
import { isWeb } from "@/constants/platform";

import { isHttpUrl } from "./http-url";

export async function openExternalUrl(url: string, requireWindow = false): Promise<void> {
  if (!isHttpUrl(url)) return;
  if (isWeb) {
    const opener = getDesktopHost()?.opener?.openUrl;
    if (typeof opener === "function") {
      await opener(url);
      return;
    }

    if (requireWindow) {
      const opened = window.open("about:blank", "_blank");
      if (!opened) throw new Error("Could not open link");
      try {
        opened.opener = null;
        opened.location.replace(url);
      } catch (error) {
        opened.close();
        throw error;
      }
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  await Linking.openURL(url);
}
