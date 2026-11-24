const test = require("node:test");
const assert = require("node:assert/strict");
const { ttsRequest, readKey, ttsStream, TTS_MODEL } = require("../lib/tts");

const KEY = "sk_" + "test_never_shown_4d1c";
// an environment with ELEVENLABS_API_KEY set to content, or without it when content is null
function home(content) {
  return content == null ? {} : { ELEVENLABS_API_KEY: content };
}
// A fetch that records its calls and answers with `reply` (a function of the call, so it can throw).
function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return reply(url, init);
  };
  f.calls = calls;
  return f;
}
const noKeyIn = (r) => assert.ok(!JSON.stringify(r).includes(KEY), "the key leaked: " + JSON.stringify(r));

test("ttsRequest is the streaming endpoint with the key header and a JSON body", () => {
  assert.deepEqual(ttsRequest({ text: "Hello.", voiceId: "voice1", modelId: "model1", key: KEY }), {
    url: "https://api.elevenlabs.io/v1/text-to-speech/voice1/stream?output_format=mp3_44100_128",
    init: { method: "POST", headers: { "xi-api-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ text: "Hello.", model_id: "model1" }) },
  });
});

test("ttsRequest keeps a malformed voice id inside its path segment", () => {
  assert.match(ttsRequest({ text: "a", voiceId: "../voices", modelId: "m", key: KEY }).url, /text-to-speech\/\.\.%2Fvoices\/stream\?/);
});

test("readKey is the trimmed ELEVENLABS_API_KEY, or null when it is missing or empty", () => {
  assert.equal(readKey(home(" " + KEY + "\n")), KEY);
  assert.equal(readKey(home(null)), null);
  assert.equal(readKey(home(" \n")), null);
});

test("text must be 1 to 600 characters, before any key is read or call made", async () => {
  const f = fakeFetch(() => ({ ok: true, status: 200, body: {} }));
  for (const text of ["", "x".repeat(601), null, 42]) {
    assert.deepEqual(await ttsStream({ text, env: home(KEY), voiceId: "v", fetch: f }), { ok: false, status: 400, error: "text must be 1 to 600 characters" });
  }
  assert.equal((await ttsStream({ text: "x".repeat(600), env: home(KEY), voiceId: "v", fetch: f })).ok, true);
  assert.equal(f.calls.length, 1);
});

test("no key or no voice id turns the voice off with a reason, and nothing is called", async () => {
  const f = fakeFetch(() => ({ ok: true, status: 200, body: {} }));
  assert.deepEqual(await ttsStream({ text: "Hi.", env: home(null), voiceId: "v", fetch: f }), { ok: false, status: 503, error: "voice off: no ElevenLabs key" });
  const r = await ttsStream({ text: "Hi.", env: home(KEY), voiceId: "", fetch: f });
  assert.deepEqual(r, { ok: false, status: 503, error: "voice off: no voice id" });
  noKeyIn(r);
  assert.equal(f.calls.length, 0);
});

test("a good reply hands back its audio stream from the request ttsRequest builds", async () => {
  const body = new ReadableStream();
  const f = fakeFetch(() => ({ ok: true, status: 200, body }));
  const r = await ttsStream({ text: "Hi.", env: home(KEY + "\n"), voiceId: "v9", modelId: "m9", fetch: f });
  assert.equal(r.ok, true);
  assert.equal(r.stream, body);
  noKeyIn(r);
  const want = ttsRequest({ text: "Hi.", voiceId: "v9", modelId: "m9", key: KEY });
  assert.deepEqual(f.calls, [want]);
});

test("the model defaults to the low-latency one", async () => {
  const f = fakeFetch(() => ({ ok: true, status: 200, body: {} }));
  await ttsStream({ text: "Hi.", env: home(KEY), voiceId: "v", fetch: f });
  assert.equal(JSON.parse(f.calls[0].init.body).model_id, TTS_MODEL);
  assert.equal(TTS_MODEL, "eleven_v4_turbo");
});

test("a refused call or a failed fetch is a 502 that never repeats the service's words or the key", async () => {
  let canceled = 0;
  const said = { ok: false, status: 401, body: { cancel: async () => canceled++ }, text: async () => "invalid api key " + KEY };
  for (const reply of [() => said, () => { throw new Error("connect failed for key " + KEY); }, () => ({ ok: true, status: 200, body: null })]) {
    const r = await ttsStream({ text: "Hi.", env: home(KEY), voiceId: "v", fetch: fakeFetch(reply) });
    assert.deepEqual(r, { ok: false, status: 502, error: "the voice service failed" });
    noKeyIn(r);
  }
  assert.equal(canceled, 1); // the refused reply's body is let go, so its connection is freed
});
