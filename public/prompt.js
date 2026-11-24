// The link that opens one chat in VS Code with the typed text already in its box; VS Code waits for Enter.
// Built only for a lowercase UUID session id (the rule lib/describe.js keeps for its chat links); null for empty text.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PROMPT_MAX = 2000; // the box's maxlength
// Edge on Windows may silently drop an external link longer than this, so a longer one is never offered
export const PROMPT_LINK_MAX = 2048;
// Which chats get a Prompt box: the ones a link can be built for
export const canPrompt = (sessionId) => typeof sessionId === "string" && UUID.test(sessionId);
// The link at any length, or null. The text is encoded twice: VS Code percent-decodes the link's query once, and the
// Claude Code extension then reads it with URLSearchParams, which splits on & and turns + into a space as it decodes
// again; so the text arrives whole. A lone surrogate (pasted text) cannot go in a URL at all
function linkOf(sessionId, text) {
  if (!canPrompt(sessionId) || typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  try {
    return "vscode://anthropic.claude-code/open?session=" + sessionId + "&prompt=" + encodeURIComponent(encodeURIComponent(t));
  } catch {
    return null;
  }
}
export function promptLink(sessionId, text) {
  const link = linkOf(sessionId, text);
  return link && link.length <= PROMPT_LINK_MAX ? link : null;
}
// The text would make a link, but one too long to offer
export function promptTooLong(sessionId, text) {
  const link = linkOf(sessionId, text);
  return !!link && link.length > PROMPT_LINK_MAX;
}
