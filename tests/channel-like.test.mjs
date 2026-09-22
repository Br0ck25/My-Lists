import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

// The Like button on a "See All" page.
//
// A list's See All has always had one; a channel opened from Explore Channels
// did not, even though the directory's own cards show a heart and the server
// has an /api/channel/like endpoint behind it. The details page is shared
// between the two (openChannelDetailsPage delegates to openListDetailsPage),
// and its like branch keyed entirely off a list URL -- so a "channel:" URL
// fell through the exclusion list and the button was simply hidden.

const preloaded = {
  sample: [{ id: "tt0903747", type: "series", name: "Ep", poster: "p.jpg" }],
  count: 1,
  maybeMore: false,
};

async function openDetails(client, listUrl, opts) {
  await client.call("openListDetailsPage", "Thing", "series", listUrl, preloaded, opts);
  return client.__byId.get("detailLikeBtn");
}

describe("See All Like button", () => {
  it("shows a channel heart wired to the channel code", async () => {
    const c = loadClient();
    const btn = await openDetails(c, "channel:id:directory:abc123", { channelLikeCode: "abc123" });
    assert.equal(btn.style.display, "", "the heart must be visible for a directory channel");
    assert.equal(btn.dataset.channelLikeCode, "abc123");
    assert.equal(typeof btn.onclick, "function", "it must have a channel-like handler");
  });

  // The delegated .searchLikeExternalBtn handler acts on dataset.url and
  // returns early without one. Leaving a stale URL here would send a channel
  // like down the list ledger's path as well as the channel one.
  it("leaves no list URL on the channel heart", async () => {
    const c = loadClient();
    const btn = await openDetails(c, "channel:id:directory:abc123", { channelLikeCode: "abc123" });
    assert.ok(!btn.dataset.url, "dataset.url must be cleared for a channel");
  });

  it("still hides the heart for a channel with no published code", async () => {
    const c = loadClient();
    const btn = await openDetails(c, "channel:id:mine", undefined);
    assert.equal(btn.style.display, "none", "one of your own channels has nothing published to like");
  });

  it("still shows the list heart, by URL, for an ordinary list", async () => {
    const c = loadClient();
    const btn = await openDetails(c, "https://mdblist.com/lists/someone/faves", undefined);
    assert.equal(btn.style.display, "");
    assert.equal(btn.dataset.url, "https://mdblist.com/lists/someone/faves");
    assert.ok(!btn.dataset.channelLikeCode, "a list must not carry a channel code");
  });
});
