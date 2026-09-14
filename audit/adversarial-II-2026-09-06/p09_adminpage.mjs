import { makeKv, makeD1, makeEnv, call, createUser } from "../../tests/harness.mjs";
const kv=makeKv(),db=makeD1(),env=makeEnv({CONFIGS:kv,DB:db});
const A=await createUser(env,"adminleak1");
await call(env,"/api/creator/lists/save",{method:"POST",json:{creatorName:"adminleak1",creatorKey:A.creatorKey,name:"Sensitive",type:"movie",visibility:"private",items:[]}});
await call(env,"/api/feedback",{method:"POST",json:{message:"my secret feedback",email:"leak@example.com"}});
const r=await call(env,"/admin");
const t=r.text;
console.log("status",r.status,"len",t.length);
for(const needle of ["adminleak1","Sensitive","leak@example.com","my secret feedback","test-admin-secret"]){
  console.log(t.includes(needle)?"LEAK  -":"clean -",needle);
}
console.log("contains a password/login form:", /type="password"|name="key"/.test(t));
console.log("first 300 chars:", t.slice(0,300).replace(/\s+/g," "));
