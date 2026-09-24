import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { loadClient } = await import("./client-harness.mjs");

// btttr.cc draws a title's artwork on first request, which took 40-50s for
// titles it had not drawn yet -- with no error, so the tile sat blank. The
// website now shows the poster a Better Poster replaced until it arrives
// (startBetterPosterTimer, 19_client-search-and-likes.js; the timing itself
// needs a real browser and was verified in Chromium). These pin the part that
// decides WHAT is shown meanwhile.
describe("the poster shown while a Better Poster is still being drawn", () => {
  const bpOn = { "myListAddon:betterPosters": "1" };

  it("is the poster the Better Poster replaced", () => {
    const c = loadClient({ storage: bpOn });
    const url = c.call("applyBetterPosterWeb", { id: "tt10986410", type: "series" }, "https://image.tmdb.org/t/p/w500/ted.jpg");
    assert.match(url, /^https:\/\/btttr\.cc\/.*tt10986410\.jpg/);
    assert.equal(c.call("plainPosterFor", url), "https://image.tmdb.org/t/p/w500/ted.jpg");
  });

  it("falls back to the generic poster for the same IMDb id when the original is unknown", () => {
    const c = loadClient({ storage: bpOn });
    assert.equal(
      c.call("plainPosterFor", "https://btttr.cc/poster/imdb/poster-default/tt5875444.jpg?lang=de"),
      "https://images.metahub.space/poster/medium/tt5875444/img"
    );
    assert.equal(c.call("plainPosterFor", "https://btttr.cc/poster/elsewhere.jpg"), "");
  });

  it("never records a Better Poster as its own original", () => {
    const c = loadClient({ storage: bpOn });
    const url = "https://btttr.cc/poster/imdb/poster-default/tt1745960.jpg";
    c.call("rememberBetterPosterOriginal", url, url);
    assert.equal(c.call("plainPosterFor", url), "https://images.metahub.space/poster/medium/tt1745960/img");
  });
});
