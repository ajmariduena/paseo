import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function previewBrowserHostDiagnostic(
  executable: string,
  stderr = "",
): Promise<string | null> {
  if (process.platform !== "linux") return null;
  const report = await execFileAsync("ldd", [executable], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  }).then(
    (result) => result.stdout,
    () => "",
  );
  const missing = [...report.matchAll(/^\s*(\S+) => not found$/gm)].map((match) => match[1]);
  if (missing.length)
    return `Preview browser is missing Linux libraries: ${missing.join(", ")}. Install them in the host or browser-enabled container image.`;
  const restricted = await readFile(
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    "utf8",
  ).then(
    (value) => value.trim() === "1",
    () => false,
  );
  const profile = await access("/etc/apparmor.d/paseo-chrome-headless-shell").then(
    () => true,
    () => false,
  );
  if (stderr.includes("No usable sandbox") || (restricted && !profile)) {
    return "This Linux host blocks Chrome's user-namespace sandbox. Configure an AppArmor userns profile for the pinned shell (or the container's user-namespace/seccomp policy), then retry. PASEO_PREVIEW_BROWSER_SANDBOX=0 is an explicit unsafe operator opt-out.";
  }
  return null;
}
