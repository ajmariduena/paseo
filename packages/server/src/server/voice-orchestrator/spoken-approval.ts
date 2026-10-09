const APPROVAL_PATTERNS = [
  /\b(yes|yeah|yep|yup|sure|ok|okay|approve[ds]?|allow(ed)?|go ahead|do it|confirm(ed)?)\b/,
  /(^|[^\p{L}])(s[ií]|dale|claro|hazlo|adelante|aprob[aá]r?(lo)?|apru[eé]ba(lo)?|apruebo|perm[ií]te(lo)?|acepta(lo)?|confirmo|de acuerdo|vale)([^\p{L}]|$)/u,
];

const REFUSAL_PATTERN =
  /(^|[^\p{L}])(no|nope|deny|don't|do not|cancel|stop|niega|rechaza|cancela|para|espera|wait)([^\p{L}]|$)/u;

/** True when a fresh transcript is a plain spoken yes, not a refusal or a hedge. */
export function isSpokenApproval(transcript: string): boolean {
  const text = transcript.toLowerCase().trim();
  if (!text) return false;
  if (REFUSAL_PATTERN.test(text)) return false;
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(text));
}

/** Whether any yes-word appears, even next to a no ("sí, espera"). */
export function mentionsApproval(transcript: string): boolean {
  const text = transcript.toLowerCase().trim();
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(text));
}

// What a bare yes may contain besides the yes itself.
// \b is ASCII-only in JavaScript, so "sí" needs letter-aware boundaries.
const BARE_APPROVAL_FILLER =
  /(?<!\p{L})(s[ií]|dale|claro|hazlo|adelante|aprob[aá]r?(lo)?|apru[eé]ba(lo)?|apruebo|perm[ií]te(lo)?|acepta(lo)?|confirmo|confirmado|de acuerdo|vale|va|listo|eso|ok|okay|okey|ya|pues|por favor|porfa|nom[aá]s|yes|yeah|yep|sure|please|go ahead|do it|confirm(ed)?|approve[ds]?|allow)(?!\p{L})/giu;

/**
 * A yes and nothing else. "Sí, dale" runs the action that was asked about; "sí, la de la mini"
 * carries a correction and goes back to the model.
 */
export function isBareApproval(transcript: string): boolean {
  if (!isSpokenApproval(transcript)) return false;
  const rest = transcript
    .toLowerCase()
    .replace(BARE_APPROVAL_FILLER, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return rest.length === 0;
}

/** True when a fresh transcript says no, cancel or wait. */
export function isSpokenRefusal(transcript: string): boolean {
  return REFUSAL_PATTERN.test(transcript.toLowerCase().trim());
}
