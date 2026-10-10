import { isHttpUrl } from "@/utils/http-url";

export async function confirmNativeExternalLink(
  url: string,
  confirm: (input: { title: string; message: string; confirmLabel: string }) => Promise<boolean>,
  open: (url: string) => Promise<void>,
): Promise<void> {
  if (!isHttpUrl(url)) throw new Error("Invalid link");
  if (!(await confirm({ title: "Open link?", message: url, confirmLabel: "Open" }))) {
    throw new Error("Link opening cancelled");
  }
  await open(url);
}
