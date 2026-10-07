import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function previewBrowserHostDiagnostic(
  executable: string,
  options: {
    stderr?: string;
    exitCode?: number | null;
    sandboxEnabled?: boolean;
    platform?: NodeJS.Platform;
  } = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    const report = await execFileAsync("ldd", [executable], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    }).then(
      (result) => result.stdout,
      () => "",
    );
    const missing = [...report.matchAll(/^\s*(\S+) => not found$/gm)].map((match) => match[1]);
    if (missing.length)
      return `Preview browser is missing Linux libraries: ${missing.join(", ")}. Install them in the browser-enabled container image before running paseo browser setup. See docs/docker.md#html-preview-browser.`;
  }
  const sandboxSignature =
    /No usable sandbox|Failed to (?:move to|create|enter).*namespace|user namespace.*(?:disabled|not permitted|permission denied)/i.test(
      options.stderr ?? "",
    );
  if (
    options.sandboxEnabled !== false &&
    (sandboxSignature || (platform === "linux" && options.exitCode === 133))
  ) {
    return "Chrome could not start its Linux sandbox. In Docker, use a seccomp profile that permits user namespaces and check the host AppArmor policy. See docs/docker.md#html-preview-browser. PASEO_PREVIEW_BROWSER_SANDBOX=0 disables Chrome's sandbox and is unsafe for untrusted HTML.";
  }
  return null;
}
