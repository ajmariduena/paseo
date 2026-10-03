import { useLinkingURL } from "expo-linking";
import { getShareExtensionKey, ShareIntentModule } from "expo-share-intent";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Platform } from "react-native";
import { useToast } from "@/contexts/toast-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { isShareExtensionUrl, parseIncomingShare } from "./model";
import { useIncomingShareStore } from "./store";

// Android reads the pending share Intent and ignores the URL. iOS reads the
// App Group entry the URL names, and reports an error for any other URL.
function requestShareIntent(url: string | null): void {
  if (Platform.OS === "android") {
    void ShareIntentModule?.getShareIntent("");
    return;
  }
  if (url && isShareExtensionUrl(url)) {
    void ShareIntentModule?.getShareIntent(url);
  }
}

export function IncomingShareListener() {
  const { t } = useTranslation();
  const toast = useToast();
  const url = useLinkingURL();

  const handleChange = useStableEvent((value: unknown) => {
    void ShareIntentModule?.clearShareIntent(getShareExtensionKey());
    try {
      const share = parseIncomingShare(value);
      if (share) {
        useIncomingShareStore.getState().receive(share);
      }
    } catch (error) {
      console.warn("[IncomingShare] Unreadable share payload", error);
      toast.error(t("incomingShare.errors.unreadable"));
    }
  });

  const handleError = useStableEvent((message: string) => {
    console.warn("[IncomingShare] Native share error", message);
    toast.error(t("incomingShare.errors.unreadable"));
  });

  useEffect(() => {
    if (!ShareIntentModule) {
      return;
    }
    const changeSubscription = ShareIntentModule.addListener("onChange", (event) => {
      handleChange(event.value);
    });
    const errorSubscription = ShareIntentModule.addListener("onError", (event) => {
      handleError(event.value);
    });
    return () => {
      changeSubscription.remove();
      errorSubscription.remove();
    };
  }, [handleChange, handleError]);

  useEffect(() => {
    requestShareIntent(url);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        requestShareIntent(url);
      }
    });
    return () => subscription.remove();
  }, [url]);

  return null;
}
