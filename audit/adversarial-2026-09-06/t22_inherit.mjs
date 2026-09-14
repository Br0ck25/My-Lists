import { makeKv, makeEnv, call, createUser } from "./kit.mjs";
// C continued: after a purge whose KV enumeration failed, the username is
// free -- what does the next person to register it get?
const env = makeEnv({ CONFIGS: makeKv() });
const victim = await createUser(env, "alice", { displayName: "Alice One" });
const K = { creatorName: "alice", creatorKey: victim.creatorKey };
await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Holiday Photos", type: "movie", visibility: "public", items: [{ id: "tt1" }, { id: "tt2" }] } });
await call(env, "/api/creator/lists/save", { method: "POST", json: { ...K, name: "Private Notes", type: "movie", visibility: "private", items: [{ id: "tt9" }] } });

env.CONFIGS._hooks.beforeList = async (p) => { if (String(p).startsWith("creatorlist:alice:")) throw new Error("KV list failed"); };
const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { ...K, confirm: "DELETE" } });
env.CONFIGS._hooks.beforeList = null;
console.log("delete ->", JSON.stringify(del.body));
console.log("orphaned KV records:", [...env.CONFIGS._store.keys()].filter(k => k.startsWith("creatorlist:alice:")));

const stranger = await createUser(env, "alice", { displayName: "Somebody Else" });
console.log("username reclaimed by a stranger:", stranger.creatorName, "/", stranger.displayName);
const dash = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: "alice", creatorKey: stranger.creatorKey } });
console.log("their dashboard now contains:");
for (const l of dash.body.lists || []) console.log("   ", l.slug, "|", l.name, "|", l.visibility, "|", l.itemCount, "items |", JSON.stringify(l.items));
