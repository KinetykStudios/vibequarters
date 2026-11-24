// The assistant's voice: ElevenLabs streaming text-to-speech, called only from HQ's server. The key comes from the
// ELEVENLABS_API_KEY environment variable, never from a file in the repo, and never reaches a result, an error or a
// log; ElevenLabs' own error text is never passed on either, since it can echo what was sent.
// Endpoint and model: https://elevenlabs.io/docs/api-reference/text-to-speech/stream (POST /v1/text-to-speech/<voice
// id>/stream, header xi-api-key) and https://elevenlabs.io/docs/overview/models ("Low-latency: Use eleven_v4_turbo",
// about 100 ms median).
const TTS_MODEL = "eleven_v4_turbo";
const MAX_TEXT = 600;

function ttsRequest({ text, voiceId, modelId, key }) {
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
    init: { method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ text, model_id: modelId }) },
  };
}

function readKey(env = process.env) {
  const k = typeof env.ELEVENLABS_API_KEY === "string" ? env.ELEVENLABS_API_KEY.trim() : "";
  return k || null;
}

// { ok: true, stream } with the reply's audio/mpeg body, or { ok: false, status, error } for the route to send.
async function ttsStream({ text, env = process.env, voiceId, modelId = TTS_MODEL, fetch = globalThis.fetch }) {
  const n = typeof text === "string" ? [...text].length : 0;
  if (n < 1 || n > MAX_TEXT) return { ok: false, status: 400, error: "text must be 1 to 600 characters" };
  const key = readKey(env);
  if (!key) return { ok: false, status: 503, error: "voice off: no ElevenLabs key" };
  if (!voiceId) return { ok: false, status: 503, error: "voice off: no voice id" };
  const failed = { ok: false, status: 502, error: "the voice service failed" };
  const { url, init } = ttsRequest({ text, voiceId, modelId, key });
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    return failed;
  }
  if (res.ok && res.body) return { ok: true, stream: res.body };
  if (res.body) res.body.cancel().catch(() => {}); // free the connection without reading what the service said
  return failed;
}

module.exports = { ttsRequest, readKey, ttsStream, TTS_MODEL };
