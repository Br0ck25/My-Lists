import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

// Reset Account Data has to leave nothing behind.
//
// Channels kept the same kind of in-memory copy custom lists do, and
// loadLocalChannels returns it BEFORE consulting storage. clearLocalAccountData
// cleared only the custom-list pair, so a reset wiped storage and the very next
// read handed the channels straight back -- then the next save wrote them out
// again and synced them up.

const CHANNELS_KEY = "myListAddon:localChannels";
const LISTS_KEY = "myListAddon:localCustomLists";

const channel = (id, name) => ({ channelId: id, name, items: [{ id: "tt0903747", title: "Ep" }] });

function signedIn(storage) {
  return loadClient({ storage: {
    "myListAddon:creatorName": "james",
    "myListAddon:creatorKey": "MYL-AAAA-BBBB-CCCC",
    ...storage,
  } });
}

describe("Reset Account Data clears everything local", () => {
  it("does not leave created channels behind in memory", () => {
    const c = signedIn({
      [CHANNELS_KEY]: JSON.stringify({ ch1: channel("ch1", "90s Sitcoms"), ch2: channel("ch2", "Late Night") }),
    });
    // Prime the in-memory copy, the way any render does.
    assert.equal(Object.keys(c.call("loadLocalChannels")).length, 2, "precondition: channels are loaded");

    c.call("clearLocalAccountData");

    assert.deepEqual(c.call("loadLocalChannels"), {},
      "channels must be gone after a reset, not served back from memory");
    assert.ok(!c.localStorage.getItem(CHANNELS_KEY), "and not left in storage either");
  });

  it("still clears custom lists", () => {
    const c = signedIn({
      [LISTS_KEY]: JSON.stringify({ faves: { slug: "faves", name: "Faves", items: [{ id: "tt1" }] } }),
    });
    assert.ok(c.call("loadLocalCustomLists").faves, "precondition: the list is loaded");
    c.call("clearLocalAccountData");
    assert.ok(!c.call("loadLocalCustomLists").faves, "custom lists must still be cleared");
  });

  // The cache is what made this survivable, so pin that a save after the reset
  // cannot resurrect them either.
  it("leaves nothing for a later save to write back", () => {
    const c = signedIn({
      [CHANNELS_KEY]: JSON.stringify({ ch1: channel("ch1", "90s Sitcoms") }),
    });
    c.call("loadLocalChannels");
    c.call("clearLocalAccountData");
    c.call("saveLocalChannelsMap", c.call("loadLocalChannels"));
    const written = c.localStorage.getItem(CHANNELS_KEY);
    assert.ok(!written || written === "{}", "a save after reset must not restore the old channels, got: " + written);
  });
});
