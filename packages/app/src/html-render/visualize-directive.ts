export interface CodexVisualizeReference {
  path: string;
  title?: string;
  mode?: "wide";
  occurrenceId: string;
}

export type CodexVisualizePart =
  | { kind: "markdown"; text: string }
  | { kind: "visual"; reference: CodexVisualizeReference };

const UNICODE_REFERENCE = /^ {0,3}\uE200visualize\uE202(\{[^\r\n]*\})\uE201[ \t]*$/;
const ALIAS_REFERENCE = /^ {0,3}::visualize(\{[^\r\n]*\})[ \t]*$/;
const BASENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const STARTS_REFERENCE = /^ {0,3}(?:\uE200|::)/;

function validReferenceFields(fields: Record<string, unknown>): fields is {
  path: string;
  title?: string;
  mode?: "wide";
} {
  if (typeof fields.path !== "string" || fields.path.length > 4096) return false;
  const absolute = fields.path.startsWith("/") || /^[a-z]:[\\/]/i.test(fields.path);
  if (!absolute) return false;
  if (
    [...fields.path].some(
      (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '"' || char === "'",
    )
  )
    return false;
  const segments = fields.path.split(/[\\/]/);
  if (segments.some((part) => part === ".." || part === ".")) return false;
  if (!BASENAME.test(segments.at(-1) ?? "")) return false;
  if (fields.title !== undefined && (typeof fields.title !== "string" || fields.title.length > 200))
    return false;
  return fields.mode === undefined || fields.mode === "wide";
}

function parseReference(line: string, occurrenceId: string): CodexVisualizeReference | null {
  const encoded = UNICODE_REFERENCE.exec(line)?.[1] ?? ALIAS_REFERENCE.exec(line)?.[1];
  if (!encoded || encoded.length > 8192) return null;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (!validReferenceFields(fields)) return null;
  return {
    path: fields.path,
    ...(fields.title ? { title: fields.title } : {}),
    ...(fields.mode ? { mode: fields.mode } : {}),
    occurrenceId,
  };
}

export function splitCodexVisualizeDirectives(
  text: string,
  options: { complete: boolean },
): CodexVisualizePart[] {
  const parts: CodexVisualizePart[] = [];
  let cursor = 0;
  let markdownStart = 0;
  let fence: { char: string; length: number } | null = null;
  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const next = newline === -1 ? text.length : newline + 1;
    const line = text.slice(cursor, lineEnd).replace(/\r$/, "");
    if (newline === -1 && !options.complete) {
      if (!fence && STARTS_REFERENCE.test(line)) {
        if (markdownStart < cursor)
          parts.push({ kind: "markdown", text: text.slice(markdownStart, cursor) });
        return parts.length > 0 ? parts : [{ kind: "markdown", text: "" }];
      }
      break;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
    } else {
      const reference = parseReference(line, String(cursor));
      if (reference) {
        if (markdownStart < cursor) {
          parts.push({ kind: "markdown", text: text.slice(markdownStart, cursor) });
        }
        parts.push({ kind: "visual", reference });
        markdownStart = next;
      }
    }
    cursor = next;
  }
  if (markdownStart < text.length)
    parts.push({ kind: "markdown", text: text.slice(markdownStart) });
  return parts.length > 0 ? parts : [{ kind: "markdown", text: "" }];
}

export function hasWideCodexVisualization(text: string, complete: boolean): boolean {
  if (!text.includes("\uE200visualize") && !text.includes("::visualize")) return false;
  return splitCodexVisualizeDirectives(text, { complete }).some(
    (part) => part.kind === "visual" && part.reference.mode === "wide",
  );
}
