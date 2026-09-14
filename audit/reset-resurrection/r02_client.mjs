// The other half: what the CLIENT does when it meets an account that was reset
// while it was asleep. Runs the real bundle against a stubbed server.
import { loadClient } from "../../tests/client-harness.mjs";

const LOCAL_LISTS = JSON.stringify({
  "my-favourites": { slug: "my-favourites", name: "My Favourites", type: "movie",
                     items: [{ id: "tt0111161", name: "Shawshank" }], updatedAt: 1000 },
});
const LOCAL_PRESETS = JSON.stringify({ "Movie Night": { entries: [{ id: "x", name: "x", type: "movie", url: "tmdb:chart:popular" }] } });

function run(label, { resetAt, seenResetAt }) {
  const storage = {
    "myListAddon:creatorName": "resetuser",
    "myListAddon:creatorDisplayName": "Reset User",
    "myListAddon:creatorKey": "MYL-AAAA-BBBB-CCCC",
    "localCustomLists": LOCAL_LISTS,
    "presets": LOCAL_PRESETS,
  };
  if (seenResetAt) storage["myListAddon:accountResetAt"] = String(seenResetAt);

  const c = loadClient({
    storage,
    routes: {
      // The account is empty -- exactly what it looks like after a reset.
      "/api/creator/sync/load": () => ({ json: {
        ok: true,
        data: { config: [], collapsedPanels: {}, likedLists: [], presets: {}, presetsB64: null,
                watchHistory: [], continueWatching: [], airingNext: [], watchlist: [],
                updatedAt: 0, trackingUpdatedAt: 0, presetsUpdatedAt: 0, channelsUpdatedAt: 0 },
        resetAt,
      }}),
      "/api/creator/lists": () => ({ json: { ok: true, displayName: "Reset User", lists: [], order: [], deletedSlugs: [] } }),
      "/api/creator/sync/save": () => ({ json: { ok: true, updatedAt: Date.now() } }),
      "/api/creator/sync/save-presets": () => ({ json: { ok: true } }),
      "/api/creator/sync/save-channels": () => ({ json: { ok: true } }),
      "/api/creator/sync/save-tracking": () => ({ json: { ok: true, clientVersion: 1 } }),
      "/api/creator/lists/save": () => ({ json: { ok: true, slug: "my-favourites" } }),
    },
  });

  c.__scopeSet("activeCreator", { creatorName: "resetuser", displayName: "Reset User" });
  return c;
}

async function report(label, opts) {
  const c = run(label, opts);
  await c.__scopeCall("loadCreatorSync", [{ background: true }]);
  const uploads = c.requests.filter((r) => /save|lists\/save/.test(r.url)).map((r) => r.url.replace("https://example.com", ""));
  const listsLeft = (() => {
    try { return Object.keys(JSON.parse(c.localStorage.getItem("localCustomLists") || "{}")).length; } catch { return "?"; }
  })();
  const presetsLeft = (() => {
    try { return Object.keys(JSON.parse(c.localStorage.getItem("presets") || "{}")).length; } catch { return "?"; }
  })();
  console.log(`${label}
    uploads triggered: ${uploads.length ? uploads.join(", ") : "(none)"}
    local lists left:  ${listsLeft}
    local presets left:${presetsLeft}
    seen resetAt now:  ${c.localStorage.getItem("myListAddon:accountResetAt")}`);
}

await report("A. account reset at T=5000, this browser has never seen it", { resetAt: 5000, seenResetAt: 0 });
console.log();
await report("B. same reset, already applied on this browser", { resetAt: 5000, seenResetAt: 5000 });
console.log();
await report("C. genuinely new account (no reset ever)", { resetAt: 0, seenResetAt: 0 });
