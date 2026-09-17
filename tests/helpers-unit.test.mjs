import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Helpers live as concatenation fragments (not exported). Load the source
// files they are defined in and eval just those functions in a sandbox.

function loadHelpers() {
  const src02 = readFileSync(new URL("../02_http-and-creator-utils.js", import.meta.url), "utf8");
  const names = [
    "normalizeCreatorDisplayName",
    "normalizeListVisibility",
    "isPublicListVisibility",
    "clientIpKey",
    "expandIpv6Hextets",
    "normalizeExternalListUrl",
    "utf8ByteLength",
    "formatAirClockTime",
    "airTimeZoneLabel",
    "formatAirTimeLabel",
  ];
  const chunks = [];
  for (const name of names) {
    const start = src02.indexOf(`function ${name}`);
    if (start < 0) throw new Error(`missing ${name}`);
    let i = src02.indexOf("{", start);
    let depth = 0;
    for (; i < src02.length; i++) {
      if (src02[i] === "{") depth++;
      else if (src02[i] === "}") {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    chunks.push(src02.slice(start, i));
  }
  const consts = [];
  for (const name of ["CREATOR_DISPLAY_NAME_MAX", "EXTERNAL_LIKE_HOSTS", "LIKEABLE_SENTINEL_PREFIXES", "LIKEABLE_SENTINEL_EXACT", "AIR_TIME_ZONE_LABELS"]) {
    const re = new RegExp(`const ${name}[\\s\\S]*?;`);
    const m = src02.match(re);
    if (m) consts.push(m[0]);
  }
  const fn = new Function(`${consts.join("\n")}\n${chunks.join("\n")}\nreturn { ${names.join(", ")} };`);
  return fn();
}

const H = loadHelpers();

describe("normalizeCreatorDisplayName", () => {
  it("falls back to the username, strips controls, and caps at 40", () => {
    assert.equal(H.normalizeCreatorDisplayName("", "alice").displayName, "alice");
    assert.equal(H.normalizeCreatorDisplayName("Alice", "alice").displayName, "Alice");
    assert.equal(H.normalizeCreatorDisplayName("A".repeat(41), "alice").ok, false);
    assert.equal(H.normalizeCreatorDisplayName("Alice\u0000Bob", "alice").displayName, "AliceBob");
  });
});

describe("list visibility", () => {
  it("writes fail closed and reads require public", () => {
    assert.equal(H.normalizeListVisibility("public"), "public");
    assert.equal(H.normalizeListVisibility(""), "private");
    assert.equal(H.normalizeListVisibility("PUBLIC"), "private");
    assert.equal(H.isPublicListVisibility("public"), true);
    assert.equal(H.isPublicListVisibility("private"), false);
    assert.equal(H.isPublicListVisibility(undefined), false);
  });
});

describe("clientIpKey", () => {
  const hdr = (v) => ({ headers: { get: (k) => (k === "CF-Connecting-IP" ? v : null) } });
  it("fails closed, unmaps v4, and folds IPv6 to /64", () => {
    assert.equal(H.clientIpKey(hdr("")), null);
    assert.equal(H.clientIpKey(hdr("203.0.113.10")), "203.0.113.10");
    assert.equal(H.clientIpKey(hdr("::ffff:203.0.113.10")), "203.0.113.10");
    assert.equal(H.clientIpKey(hdr("2001:db8:85a3:8d3:1319:8a2e:370:7348")), "2001:db8:85a3:8d3::/64");
  });
});

describe("URL allowlists", () => {
  it("like-external only accepts known provider hosts", () => {
    assert.equal(H.normalizeExternalListUrl("https://evil.example/x"), null);
    assert.equal(H.normalizeExternalListUrl("javascript:alert(1)"), null);
    assert.equal(H.normalizeExternalListUrl("https://trakt.tv/users/a/lists/b"), "https://trakt.tv/users/a/lists/b");
  });

  it("like-external also accepts this add-on's own shared (non-personal) chart sentinels", () => {
    assert.equal(H.normalizeExternalListUrl("tmdb:chart:popular"), "tmdb:chart:popular");
    assert.equal(H.normalizeExternalListUrl("tmdb:hidden-gems"), "tmdb:hidden-gems");
    assert.equal(H.normalizeExternalListUrl("trakt:chart:trending"), "trakt:chart:trending");
    assert.equal(H.normalizeExternalListUrl("simkl:chart:anime"), "simkl:chart:anime");
    // Case-insensitive, matching the real chart sentinels' own casing.
    assert.equal(H.normalizeExternalListUrl("TMDB:CHART:popular"), "tmdb:chart:popular");
  });

  it("like-external still rejects session/account-relative sentinels (no single shared list to like)", () => {
    assert.equal(H.normalizeExternalListUrl("mdblist:watchlist"), null);
    assert.equal(H.normalizeExternalListUrl("trakt:history"), null);
    assert.equal(H.normalizeExternalListUrl("simkl:user:alice"), null);
    // Not a real chart id at all, just an unmatched sentinel-shaped string.
    assert.equal(H.normalizeExternalListUrl("tmdb:notachart"), null);
  });
});

// Every *_BYTES_MAX ceiling in 00_constants.js is a byte budget -- KV value
// size, and D1's 2,000,000-byte maximum string size. All four guards measured
// with String.prototype.length, which counts UTF-16 code units. This is the
// one-line difference.
describe("utf8ByteLength", () => {
  it("agrees with .length on ASCII, which is why the bug was invisible", () => {
    assert.equal(H.utf8ByteLength("hello"), 5);
    assert.equal(H.utf8ByteLength("hello"), "hello".length);
  });

  it("counts 3 bytes for a CJK character that .length counts as 1", () => {
    assert.equal("\u65e5\u672c\u8a9e".length, 3);
    assert.equal(H.utf8ByteLength("\u65e5\u672c\u8a9e"), 9);
  });

  it("counts 4 bytes for an astral character that .length counts as 2", () => {
    assert.equal("\u{1f600}".length, 2);
    assert.equal(H.utf8ByteLength("\u{1f600}"), 4);
  });

  it("treats null and undefined as empty rather than as their spelling", () => {
    assert.equal(H.utf8ByteLength(null), 0);
    assert.equal(H.utf8ByteLength(undefined), 0);
    assert.equal(H.utf8ByteLength(""), 0);
  });
});

describe("air time labels", () => {
  it("writes a slot the way a listing does", () => {
    assert.equal(H.formatAirClockTime("21:00"), "9 PM", "the minutes go on the hour");
    assert.equal(H.formatAirClockTime("21:30"), "9:30 PM");
    assert.equal(H.formatAirClockTime("09:05"), "9:05 AM");
    assert.equal(H.formatAirClockTime("00:00"), "12 AM", "midnight is 12 AM, not 0 AM");
    assert.equal(H.formatAirClockTime("12:00"), "12 PM", "and noon is 12 PM");
  });

  it("has nothing to say about something that is not a time", () => {
    ["", null, undefined, "tonight", "25:00", "21:60", "9pm", "21:0"].forEach((bad) => {
      assert.equal(H.formatAirClockTime(bad), "", JSON.stringify(bad) + " is not a slot");
    });
  });

  it("names North American zones the way a schedule is spoken", () => {
    // Not "EDT"/"EST": a slot is 9 ET all year, and a label that flips twice a
    // year reads like the time moved.
    assert.equal(H.formatAirTimeLabel("21:00", "America/New_York"), "9 PM ET");
    assert.equal(H.formatAirTimeLabel("21:30", "America/Toronto"), "9:30 PM ET");
    assert.equal(H.formatAirTimeLabel("20:00", "America/Los_Angeles"), "8 PM PT");
    assert.equal(H.formatAirTimeLabel("20:00", "America/Chicago"), "8 PM CT");
    assert.equal(H.formatAirTimeLabel("19:00", "America/Phoenix"), "7 PM MST");
  });

  it("still says where a slot is outside North America", () => {
    const uk = H.formatAirTimeLabel("21:00", "Europe/London");
    assert.match(uk, /^9 PM (GMT|BST|GMT[+-]\d)/, "a reader has to see this is not their own clock: " + uk);
    const jp = H.formatAirTimeLabel("23:00", "Asia/Tokyo");
    assert.match(jp, /^11 PM [A-Z]{2,5}|^11 PM GMT[+-]\d/, jp);
  });

  it("prints the hour alone rather than a zone nobody would recognise", () => {
    assert.equal(H.formatAirTimeLabel("21:00", ""), "9 PM");
    assert.equal(H.formatAirTimeLabel("21:00", "Not/AZone"), "9 PM", "an unusable zone is dropped, not printed");
    assert.equal(H.airTimeZoneLabel(""), "");
  });

  it("says nothing at all without a time, whatever the zone", () => {
    assert.equal(H.formatAirTimeLabel("", "America/New_York"), "");
    assert.equal(H.formatAirTimeLabel(null, "America/New_York"), "");
  });
});
