// Realistic API responses so the frontend runs SUCCESS paths.
// XSS probes are embedded in every attacker-controllable text field.
export const XSS = `"><img src=x onerror="window.__XSS=(window.__XSS||0)+1"><svg/onload="window.__XSS=(window.__XSS||0)+1">`;
export const XSSJS = `');window.__XSS=(window.__XSS||0)+1;//`;

export function sampleItems(n = 12, hostile = false) {
  return Array.from({ length: n }, (_, i) => ({
    id: "tt" + String(1000000 + i),
    type: "movie",
    name: hostile ? XSS + " Movie " + i : "Movie " + i,
    poster: hostile ? "javascript:window.__XSSURL=1" : "http://127.0.0.1:8787/icon.png",
    year: hostile ? XSS : "20" + (10 + (i % 15)),
    posterShape: "poster",
  }));
}

export async function installMocks(page, { hostile = false, latency = 0, fail = null } = {}) {
  const state = { calls: [] };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch {}
    state.calls.push({ m: req.method(), p, body });
    if (latency) await new Promise((r) => setTimeout(r, latency));
    if (fail) {
      const f = fail(p, body, state.calls.length);
      if (f) return route.fulfill({ status: f.status || 500, contentType: f.ct || "application/json", body: f.body !== undefined ? f.body : JSON.stringify({ ok: false, error: "boom" }) });
    }
    const J = (o, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) });

    if (p === "/api/preview") {
      const items = sampleItems(12, hostile);
      return J({ ok: true, count: 60, totalItems: 60, maybeMore: true, sample: items,
        listName: hostile ? XSS + " List" : "A Nice List", creatorName: hostile ? XSS + " Creator" : "somebody" });
    }
    if (p === "/api/search" || p.startsWith("/api/search")) {
      return J({ ok: true, results: sampleItems(8, hostile), lists: [
        { id: "l1", name: hostile ? XSS + " SearchList" : "Search List 1", slug: "search-list-1",
          creatorName: hostile ? XSS + "creator" : "creator1", type: "movie", likes: 5, itemCount: 20,
          url: "https://example.com/lists/creator1/search-list-1", description: hostile ? XSS : "desc" },
      ] });
    }
    if (p.startsWith("/api/lists/browse") || p === "/api/lists") {
      return J({ ok: true, count: 1, total: 1, lists: [
        { id: "l1", name: hostile ? XSS + " Browse" : "Browse List", slug: "browse-list",
          creatorName: hostile ? XSS + "cre" : "creator1", type: "movie", likes: 3, itemCount: 10,
          url: "https://example.com/lists/creator1/browse-list" },
      ] });
    }
    if (p === "/api/toplists") return J({ ok: true, lists: [{ name: hostile ? XSS : "Top List", url: "https://mdblist.com/lists/x/y", type: "movie", items: 50 }] });
    if (p === "/api/details/batch") return J({ ok: true, results: {}, details: {} });
    if (p.startsWith("/api/details") || p.startsWith("/api/title") || p.startsWith("/api/show")) {
      return J({ ok: true, details: { id: "tt1000000", imdbId: "tt1000000", tmdbId: 1, title: hostile ? XSS + " Title" : "A Title",
        overview: hostile ? XSS : "overview", poster: "http://127.0.0.1:8787/icon.png", seasonsData: [{ season_number: 1, episode_count: 2 }] } });
    }
    if (p.startsWith("/api/season")) return J({ ok: true, season: { episodes: [
      { id: 1, name: hostile ? XSS : "Ep1", episode_number: 1, air_date: "2020-01-01" },
      { id: 2, name: hostile ? XSS : "Ep2", episode_number: 2, air_date: "2020-01-08" }] } });
    if (p.startsWith("/api/resolve") || p.startsWith("/api/external")) return J({ ok: true, results: [], id: "tt1000000" });
    if (p === "/api/feedback/threads") return J({ ok: true, threads: [] });
    if (p.startsWith("/api/creator/lists")) return J({ ok: true, lists: [] });
    return J({ ok: true });
  });
  return state;
}
