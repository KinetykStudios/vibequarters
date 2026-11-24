const test = require("node:test");
const assert = require("node:assert/strict");
const { weekUsage } = require("../lib/usage");

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const NOW = Date.parse("2025-02-14T18:00:00.000Z"); // the week is the UTC days 2025-02-08 to 2025-02-14

test("the week's assistant spend by model beside the week's total", () => {
  const u = weekUsage({
    now: NOW,
    sessions: [
      { spend: { "2025-02-07": { "claude-sonnet-5-5": 5 }, "2025-02-08": { "claude-sonnet-5-5": 1.5 } } },
      { spend: { "2025-02-14": { "claude-sonnet-5-5": 2, "claude-opus-5-5": 0.25 } } },
    ],
    drafter: [{ at: Date.parse("2025-02-13T09:00:00.000Z"), costUsd: 0.75, model: "opus" }],
    last30: [
      { date: "2025-02-07", cost: 100, tools: 0 },
      { date: "2025-02-08", cost: 10, tools: 0 },
      { date: "2025-02-12", cost: 20, tools: 0 },
      { date: "2025-02-14", cost: 30, tools: 0 },
    ],
  });
  assert.deepEqual({ ...u, share: null }, { assistantUsd: 4.5, totalUsd: 60.75, byModel: { sonnet: 3.5, opus: 1 }, share: null });
  near(u.share, 4.5 / 60.75); // the drafter runs without a transcript, so its cost is added to the transcripts' total
});

test("an 8-day-old drafter row is left out, and its time may be an ISO string", () => {
  const drafter = [
    { at: "2025-02-06T18:00:00.000Z", costUsd: 9, model: "opus" },
    { at: "2025-02-08T00:00:00.000Z", costUsd: 1, model: "opus" },
  ];
  const u = weekUsage({ now: NOW, sessions: [], drafter, last30: [] });
  assert.deepEqual(u, { assistantUsd: 1, totalUsd: 1, byModel: { sonnet: 0, opus: 1 }, share: 1 });
});

test("a total of 0 gives a share of 0", () => {
  assert.deepEqual(weekUsage({ now: NOW, sessions: [], drafter: [], last30: [{ date: "2025-02-14", cost: 0, tools: 0 }] }), {
    assistantUsd: 0,
    totalUsd: 0,
    byModel: { sonnet: 0, opus: 0 },
    share: 0,
  });
});

test("missing inputs read as no spend", () => {
  assert.deepEqual(weekUsage({ now: NOW, sessions: [{}], drafter: undefined, last30: null }), { assistantUsd: 0, totalUsd: 0, byModel: { sonnet: 0, opus: 0 }, share: 0 });
});
