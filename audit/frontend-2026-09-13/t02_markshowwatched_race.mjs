import { loadClient } from "../../tests/client-harness.mjs";
const E1=[{id:101,name:"Pilot",episode_number:1,air_date:"2008-01-20"},{id:102,name:"Cat's",episode_number:2,air_date:"2008-01-27"}];
const E2=[{id:201,name:"737",episode_number:1,air_date:"2009-03-08"},{id:202,name:"Grilled",episode_number:2,air_date:"2009-03-15"}];
async function run(settleMs){
  const client = loadClient({ routes: { "/api/season": (req) => {
    const s = new URL(req.url,"https://example.com").searchParams.get("seasonNum");
    if (s==="1") return {json:{ok:true,season:{episodes:E1}}};
    if (s==="2") return {json:{ok:true,season:{episodes:E2}}};
    return {json:{ok:false,error:"Not found"}}; } } });
  const d={id:"tt0903747",tmdbId:1396,title:"Breaking Bad",seasonsData:[{season_number:1,episode_count:2},{season_number:2,episode_count:2}]};
  client.set("_currentItemDetails", d);
  const btn=client.get("document").getElementById("btnMarkShowWatched");
  btn.classList.add("primary"); btn.innerHTML="Mark Show Watched";
  const L=client.call("loadLocalCustomLists");
  L["continue-watching"]={id:"continue-watching",name:"Continue Watching",items:[{id:"tt0903747:2:2",showId:"tt0903747",name:"Grilled",seasonNum:2,episodeNum:2,type:"episode"}]};
  client.call("saveLocalCustomListsMap", L);
  await client.call("markShowWatched","tt0903747");
  if (settleMs) await new Promise(r=>setTimeout(r,settleMs));
  await client.call("markShowWatched","tt0903747");
  await new Promise(r=>setTimeout(r,80));
  const cw=(client.call("loadLocalCustomLists")["continue-watching"]?.items||[]);
  return { settleMs,
    fullyWatched: [...(client.get("_fullyWatchedShowIds")||[])],
    cwIds: cw.map(i=>i.id),
    companionLeft: cw.some(i=>i.precedingShowId==="tt0903747"),
    btn: btn.innerHTML.includes("Unwatched") ? "says-Unwatched" : "says-Watch" };
}
for (const ms of [0, 1, 5, 25, 100]) console.log(JSON.stringify(await run(ms)));
