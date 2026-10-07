import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { withOutput, type CommandOptions, type OutputSchema } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

interface BrowserStatus {
  state: string;
  version: string;
  platform: string | null;
  executable?: string;
  message?: string;
}

const schema: OutputSchema<BrowserStatus> = {
  idField: "platform",
  columns: [
    { header: "STATE", field: "state" },
    { header: "VERSION", field: "version" },
    { header: "PLATFORM", field: "platform" },
  ],
  renderHuman(result) {
    const status = result.type === "single" ? result.data : result.data[0];
    return status
      ? [
          `Preview browser: ${status.state}`,
          `Version: ${status.version}`,
          `Platform: ${status.platform ?? "unsupported"}`,
          ...(status.executable ? [`Executable: ${status.executable}`] : []),
          ...(status.message ? [status.message] : []),
        ].join("\n")
      : "Preview browser unavailable";
  },
};

async function runBrowserCommand(operation: "status" | "setup", options: CommandOptions) {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const status =
      operation === "setup"
        ? await client.setupPreviewBrowser()
        : await client.getPreviewBrowserStatus();
    return { type: "single" as const, data: status, schema };
  } finally {
    await client.close();
  }
}

export function createBrowserCommand(): Command {
  const browser = new Command("browser").description("Manage the HTML preview browser");
  addJsonAndDaemonHostOptions(
    browser.command("status").description("Show the daemon's preview browser status"),
  ).action(
    withOutput((options: CommandOptions, _command: Command) =>
      runBrowserCommand("status", options),
    ),
  );
  addJsonAndDaemonHostOptions(
    browser.command("setup").description("Install the daemon's pinned preview browser"),
  ).action(
    withOutput((options: CommandOptions, _command: Command) => runBrowserCommand("setup", options)),
  );
  return browser;
}
