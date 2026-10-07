import { validFollowUpParams } from "./visualize-bridge";

export async function performVisualizationFollowUp(input: {
  prompt: string;
  title?: string;
  confirm: (prompt: string, title?: string) => Promise<boolean>;
  send: (prompt: string) => Promise<unknown>;
}): Promise<boolean> {
  if (!validFollowUpParams(input)) throw new Error("Invalid follow-up");
  if (!(await input.confirm(input.prompt, input.title))) return false;
  await input.send(input.prompt);
  return true;
}
