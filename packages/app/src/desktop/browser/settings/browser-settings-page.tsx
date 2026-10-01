import { BrowserCookieImportSection } from "./browser-cookie-import-section";
import { BrowserDataSection } from "./browser-data-section";
import { BrowserLinksSection } from "./browser-links-section";

export function BrowserSettingsPage() {
  return (
    <>
      <BrowserLinksSection />
      <BrowserCookieImportSection />
      <BrowserDataSection />
    </>
  );
}
