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

/** True when a fresh transcript says no, cancel or wait. */
export function isSpokenRefusal(transcript: string): boolean {
  return REFUSAL_PATTERN.test(transcript.toLowerCase().trim());
}
