import { getDesktopHost } from "@/desktop/host";

export interface LinkDestinationDecision {
  choice: "in-app" | "external";
  remember: boolean;
}

export async function askLinkDestination(labels: {
  title: string;
  message: string;
  inAppLabel: string;
  externalLabel: string;
  rememberLabel: string;
}): Promise<LinkDestinationDecision | null> {
  const askWithCheckbox = getDesktopHost()?.dialog?.askWithCheckbox;
  if (typeof askWithCheckbox !== "function") {
    return null;
  }
  const result = await askWithCheckbox(labels.message, {
    title: labels.title,
    okLabel: labels.inAppLabel,
    cancelLabel: labels.externalLabel,
    checkboxLabel: labels.rememberLabel,
  });
  return { choice: result.confirmed ? "in-app" : "external", remember: result.dontAskAgain };
}
