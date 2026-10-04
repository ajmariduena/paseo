/**
 * The whole text of messages this app put in a daemon queue, by message id. The queue snapshot
 * only carries a cut preview, so an edit needs the original to avoid truncating the message.
 */
const queuedTexts = new Map<string, string>();

export function rememberQueuedText(messageId: string, text: string): void {
  queuedTexts.set(messageId, text);
}

export function readQueuedText(messageId: string): string | null {
  return queuedTexts.get(messageId) ?? null;
}

export function forgetQueuedText(messageId: string): void {
  queuedTexts.delete(messageId);
}
