import type { AgentPromptInput } from "../agent-sdk-types.js";

const INSTRUCTIONS_OPEN = "<paseo_instructions>";
const INSTRUCTIONS_CLOSE = "</paseo_instructions>";
const REQUEST_OPEN = "<user_request>";
const REQUEST_CLOSE = "</user_request>";

const WRAPPED_PROMPT_PATTERN =
  /^\s*<paseo_instructions>\s*([\s\S]*?)\s*<\/paseo_instructions>\s*<user_request>\n?([\s\S]*?)\n?<\/user_request>\s*$/;

export interface UnwrappedACPPrompt {
  text: string;
  instructions: string | null;
}

/**
 * ACP has no system prompt channel, so instructions travel inside a user prompt. Native slash
 * commands are left alone because they only expand at the very start of the prompt.
 */
export function isACPSlashCommand(promptText: string): boolean {
  return promptText.trimStart().startsWith("/");
}

export function wrapACPPromptWithInstructions(
  prompt: AgentPromptInput,
  instructions: string,
): AgentPromptInput {
  const head = `${INSTRUCTIONS_OPEN}\n${instructions}\n${INSTRUCTIONS_CLOSE}\n\n${REQUEST_OPEN}\n`;
  const tail = `\n${REQUEST_CLOSE}`;
  if (typeof prompt === "string") {
    return `${head}${prompt}${tail}`;
  }
  return [{ type: "text", text: head }, ...prompt, { type: "text", text: tail }];
}

export function unwrapACPPromptText(text: string): UnwrappedACPPrompt {
  const match = WRAPPED_PROMPT_PATTERN.exec(text);
  if (!match) {
    return { text, instructions: null };
  }
  return { text: match[2] ?? "", instructions: match[1] ?? "" };
}
