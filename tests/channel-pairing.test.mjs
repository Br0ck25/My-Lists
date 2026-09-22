import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { loadClient, renderPage } = await import("./client-harness.mjs");

// The builder had no idea multi-part stories existed: it knew about hand-made
// pairs and nothing else, with no title detection at all. So "Shuffle Picks
// Now" dealt Pilot (1) and Pilot (2) sixteen positions apart and saved them
// that way, while the Worker glued them back at play time -- which is exactly
// why this read as a bug rather than a wrong channel.

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// The Worker's own copy, evaluated on its own.
function workerSplit() {
  const src = readFileSync(new URL("../05_catalog-core.js", import.meta.url), "utf8");
  const roman = src.match(/const CHANNEL_PART_ROMAN = \{[^}]*\};/)[0];
  const body = [
    roman,
    extractFunction(src, "channelPartBaseKey"),
    extractFunction(src, "channelPartTitleSplit"),
    "return channelPartTitleSplit;",
  ].join("\n");
  return eval(`(function () { ${body} })()`);
}

const TITLES = [
  "Pilot (1)", "Pilot (2)", "Exodus (1)", "Exodus (2)", "Exodus (3)",
  "The Best of Both Worlds, Part I", "The Best of Both Worlds, Part II",
  "Who Shot Mr. Burns? Part One", "Redux Pt. 2", "Redux Pt II",
  "Something — Part 3", "Trilogy Part IV", "Part of the Family",
  "White Rabbit", "Walkabout", "", "   ", "(1)", "Numbers (12)",
  "A Title (99)", "Finale part x", "Finale part xi", "Episode 1",
  "Two Cathedrals: Part 1", "Hello, part 2.", "The End (Part 2)",
];

describe("The builder reads multi-part titles exactly as the Worker does", () => {
  it("agrees on every title in the corpus", () => {
    const workerFn = workerSplit();
    const c = loadClient();
    for (const t of TITLES) {
      const mine = plainSplit(c.call("channelDraftPartTitleSplit", t));
      const theirs = plainSplit(workerFn(t));
      assert.deepEqual(mine, theirs, `disagreed on ${JSON.stringify(t)}`);
    }
  });

  it("actually detects the reported cases", () => {
    // A guard on the corpus itself: a parity test passes trivially if both
    // sides return null for everything, which is what a swallowed backslash
    // in the rendered bundle would look like.
    const c = loadClient();
    assert.deepEqual(plainSplit(c.call("channelDraftPartTitleSplit", "Pilot (1)")), { base: "pilot", part: 1 });
    assert.deepEqual(plainSplit(c.call("channelDraftPartTitleSplit", "Exodus (2)")), { base: "exodus", part: 2 });
    assert.deepEqual(plainSplit(c.call("channelDraftPartTitleSplit", "The Best of Both Worlds, Part II")),
      { base: "the best of both worlds", part: 2 });
    assert.equal(c.call("channelDraftPartTitleSplit", "White Rabbit"), null);
  });
});

const LOST = "tt0411008";
const ep = (e, name, show = LOST, season = 1) => ({
  imdbId: show, kind: "episode", season, episode: e,
  showName: "Lost", title: "Lost", epName: name,
});
const PICKS = () => [
  ep(1, "Pilot (1)"), ep(5, "White Rabbit"), ep(2, "Pilot (2)"), ep(23, "Exodus (1)"),
  ep(10, "Raised by Another"), ep(24, "Exodus (2)"), ep(3, "Tabula Rasa"), ep(8, "Confidence Man"),
];

function builder({ pairParts = true, picks = PICKS(), locked = [], pairedGroups = [] } = {}) {
  const c = loadClient();
  c.set("channelDraftItems", picks);
  c.set("channelDraftStoryLocked", locked);
  c.set("channelDraftPairedGroups", pairedGroups);
  c.document.getElementById("channelPairPartsCheck").checked = pairParts;
  return c;
}

// Copied into this realm: values that cross the vm boundary carry the
// sandbox's own Array/Object prototypes, which strict deep equality counts
// as a difference.
const names = (c) => [...c.get("channelDraftItems")].map((i) => String(i.epName));
const plainSplit = (v) => (v ? { base: String(v.base), part: Number(v.part) } : v);

function assertTogetherInOrder(list, a, b, label) {
  const ia = list.indexOf(a);
  const ib = list.indexOf(b);
  assert.notEqual(ia, -1, `${a} missing: ${list.join(" | ")}`);
  assert.equal(ib, ia + 1, `${label}: ${list.join(" | ")}`);
}

describe("Multi-part episodes stay together in the builder", () => {
  it("survives any shuffle", () => {
    // Run it enough times that a shuffle which merely happened to leave them
    // adjacent cannot carry the test.
    for (let n = 0; n < 60; n++) {
      const c = builder();
      c.call("shuffleChannelDraft");
      const list = names(c);
      assert.equal(list.length, 8, list.join(" | "));
      assertTogetherInOrder(list, "Pilot (1)", "Pilot (2)", "Pilot split by the shuffle");
      assertTogetherInOrder(list, "Exodus (1)", "Exodus (2)", "Exodus split by the shuffle");
    }
  });

  it("plays the story from part one even when part two is drawn first", () => {
    const c = builder({ picks: [ep(2, "Pilot (2)"), ep(5, "White Rabbit"), ep(1, "Pilot (1)")] });
    c.call("applyChannelDraftOrderRules");
    assert.deepEqual(names(c), ["Pilot (1)", "Pilot (2)", "White Rabbit"]);
  });

  it("cannot be pulled apart by hand while the toggle is on", () => {
    const c = builder();
    // What a drag or a typed position does: move one pick, then re-render.
    const items = c.get("channelDraftItems");
    const [part2] = items.splice(items.indexOf(items.find((i) => i.epName === "Pilot (2)")), 1);
    items.push(part2);
    c.set("channelDraftItems", items);
    c.call("renderChannelDraftList");
    assertTogetherInOrder(names(c), "Pilot (1)", "Pilot (2)", "a drag separated them");
  });

  it("lets them apart once the toggle is off", () => {
    const c = builder({ pairParts: false });
    const before = names(c);
    c.call("applyChannelDraftOrderRules");
    assert.deepEqual(names(c), before, "nothing should be glued with the toggle off");
  });

  it("keeps a hand-made pair together whether the toggle is on or not", () => {
    const c = builder({
      pairParts: false,
      pairedGroups: [[LOST + ":1:5", LOST + ":1:8"]],
    });
    c.call("shuffleChannelDraft");
    assertTogetherInOrder(names(c), "White Rabbit", "Confidence Man", "a hand-made pair was split");
  });

  it("stops holding a hand-made pair once it is unpaired", () => {
    const c = builder({ pairParts: false, pairedGroups: [[LOST + ":1:5", LOST + ":1:8"]] });
    c.set("channelDraftPairedGroups", []);
    const items = c.get("channelDraftItems");
    c.set("channelDraftItems", [items[1], items[0], ...items.slice(2)]);
    c.call("applyChannelDraftOrderRules");
    assert.equal(names(c)[0], "White Rabbit");
    assert.equal(names(c)[1], "Pilot (1)");
  });

  it("never adds or drops a pick", () => {
    const c = builder();
    c.call("shuffleChannelDraft");
    const list = names(c);
    assert.equal(list.length, 8);
    assert.equal(new Set(list).size, 8, list.join(" | "));
  });
});

describe("Story Lock holds a show in sequence", () => {
  const OTHER = "tt0386676";
  const mixed = () => [
    ep(4, "Lost E4"), { imdbId: OTHER, kind: "episode", season: 1, episode: 2, showName: "The Office", title: "The Office", epName: "Diversity Day" },
    ep(1, "Lost E1"), { imdbId: OTHER, kind: "episode", season: 1, episode: 1, showName: "The Office", title: "The Office", epName: "Pilot" },
    ep(3, "Lost E3"), ep(2, "Lost E2"),
  ];

  it("deals a locked show's episodes in broadcast order after a shuffle", () => {
    for (let n = 0; n < 40; n++) {
      const c = builder({ pairParts: false, picks: mixed(), locked: [LOST] });
      c.call("shuffleChannelDraft");
      const lostOrder = [...c.get("channelDraftItems")].filter((i) => i.imdbId === LOST).map((i) => Number(i.episode));
      assert.deepEqual(lostOrder, [1, 2, 3, 4], "a locked show must advance in order");
    }
  });

  it("leaves an unlocked show alone", () => {
    // Not an assertion that it IS scrambled -- a shuffle may deal it in order
    // by chance -- but that nothing is resequencing it over many runs.
    let sawOutOfOrder = false;
    for (let n = 0; n < 60 && !sawOutOfOrder; n++) {
      const c = builder({ pairParts: false, picks: mixed(), locked: [LOST] });
      c.call("shuffleChannelDraft");
      const other = [...c.get("channelDraftItems")].filter((i) => i.imdbId === OTHER).map((i) => Number(i.episode));
      if (other[0] !== 1) sawOutOfOrder = true;
    }
    assert.equal(sawOutOfOrder, true, "an unlocked show should not be held in sequence");
  });

  it("holds the lock through a hand reorder too", () => {
    const c = builder({ pairParts: false, picks: mixed(), locked: [LOST] });
    const items = c.get("channelDraftItems").slice().reverse();
    c.set("channelDraftItems", items);
    c.call("renderChannelDraftList");
    const lostOrder = [...c.get("channelDraftItems")].filter((i) => i.imdbId === LOST).map((i) => Number(i.episode));
    assert.deepEqual(lostOrder, [1, 2, 3, 4]);
  });

  it("does nothing when no show is locked", () => {
    const c = builder({ pairParts: false, picks: mixed(), locked: [] });
    const before = names(c);
    c.call("applyChannelDraftOrderRules");
    assert.deepEqual(names(c), before);
  });
});

describe("Reordering does not misdirect the selection", () => {
  it("keeps the selection pointing at the same picks", () => {
    // It is stored as indices, so reordering underneath it would leave Pair
    // and Unpair acting on whichever picks landed on those numbers.
    const c = builder({ picks: [ep(2, "Pilot (2)"), ep(5, "White Rabbit"), ep(1, "Pilot (1)")] });
    c.set("channelDraftSelection", [1]);
    c.call("applyChannelDraftOrderRules");
    const items = c.get("channelDraftItems");
    const selected = [...c.get("channelDraftSelection")].map((i) => String(items[i].epName));
    assert.deepEqual(selected, ["White Rabbit"]);
  });
});

describe("The shuffle button", () => {
  it("is titled Shuffle Picks Now", () => {
    const html = renderPage();
    assert.ok(!html.includes("Shuffle picks now"), "the lower-case label is still there");
    assert.equal((html.match(/>Shuffle Picks Now<\/button>/g) || []).length, 2, "both buttons should carry it");
  });
});
