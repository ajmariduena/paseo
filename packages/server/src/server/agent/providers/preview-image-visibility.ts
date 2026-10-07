export function isHtmlPreviewToolName(name: string): boolean {
  return /(?:^|[._])html_preview$/.test(name);
}

export function visibleToolResultImages<T>(name: string, images: T[]): T[] {
  return isHtmlPreviewToolName(name) ? [] : images;
}
