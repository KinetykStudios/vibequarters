// The page's one way to write: the per-start token the server puts in the page (control on only), sent in the
// X-HQ-Token header of every POST to its own origin. No token (control off): the page can answer nothing.
const meta = document.querySelector('meta[name="hq-token"]');
const TOKEN = meta && /^[0-9a-f]{64}$/.test(meta.content) ? meta.content : null;
export const canAnswer = () => TOKEN !== null;
// Whether the bridge can act here on an answer or a message to a chat (it cannot off Windows), and the line that says it
// cannot; the page's other buttons work anywhere
const OFF = document.querySelector('meta[name="hq-answers"]') !== null;
export const canReply = () => canAnswer() && !OFF;
export const answersNote = () => (canAnswer() && OFF ? "Answering prompts and chats from this page works on Windows only. Here Claude Code asks in its own prompt." : "");
// a 2xx answer's parsed body ({} when it is not a JSON object), so it is always truthy; false for any other answer or
// none. Never throws
export async function post(path, body, { keepalive = false } = {}) {
  if (!TOKEN) return false;
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-HQ-Token": TOKEN }, body: JSON.stringify(body), cache: "no-store", keepalive });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return j !== null && typeof j === "object" ? j : {};
  } catch {
    return false;
  }
}
