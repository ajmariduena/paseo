import { isShareExtensionUrl } from "@/incoming-share/model";

// The iOS share extension reopens the app through a URL that is not a route.
// The share listener reads it, so routing must ignore it: a cold start runs the
// normal startup restore, and a warm one stays on the current screen.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  if (!isShareExtensionUrl(path)) {
    return path;
  }
  return initial ? "/" : "";
}
