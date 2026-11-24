// public/voice-wave.js: the voice mode's wave. At rest it barely breathes; the owner's voice swells it in from the right,
// where their words sit, and the assistant's from the left, where its words sit.
import test from "node:test";
import assert from "node:assert/strict";
const { waveY } = await import("../public/voice-wave.js");

const peak = (amp, side, from, to) => {
  let m = 0;
  for (let u = from; u <= to; u += 0.005) for (let ph = 0; ph < 6.3; ph += 0.7) m = Math.max(m, Math.abs(waveY(u, amp, ph, side)));
  return m;
};

test("voice wave: at rest the line barely moves", () => {
  assert.ok(peak(0, "you", 0, 1) <= 2 && peak(0, "ai", 0, 1) <= 2);
});

test("voice wave: the owner's voice swells the right side, the assistant's the left", () => {
  const youRight = peak(1, "you", 0.6, 1), youLeft = peak(1, "you", 0, 0.4);
  const aiLeft = peak(1, "ai", 0, 0.4), aiRight = peak(1, "ai", 0.6, 1);
  assert.ok(youRight > 3 * youLeft, `the owner's: right ${youRight} vs left ${youLeft}`);
  assert.ok(aiLeft > 3 * aiRight, `its: left ${aiLeft} vs right ${aiRight}`);
  assert.ok(youRight > 20 && youRight <= 40, `a loud voice fills the stage, never past it (${youRight})`);
});

test("voice wave: the ends stay pinned to the middle", () => {
  for (const side of ["you", "ai"]) assert.ok(Math.abs(waveY(0, 1, 1, side)) < 0.5 && Math.abs(waveY(1, 1, 1, side)) < 0.5);
});
