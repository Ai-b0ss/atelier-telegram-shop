import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import worker from "../src/index.js";

const token="not-a-real-Telegram-bot-token";
function authorization(){
  const fields={auth_date:String(Math.floor(Date.now()/1000)),
    user:JSON.stringify({id:777,first_name:"Synthetic"})};
  const payload=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b,"en")).map(([k,v])=>k+"="+v).join("\n");
  const key=createHmac("sha256","WebAppData").update(token).digest();
  return "tma "+new URLSearchParams({...fields,
    hash:createHmac("sha256",key).update(payload).digest("hex")}).toString();
}
async function call(body,extraHeaders={},duplex=false){
  const request=new Request("https://synthetic.invalid/api/cart",{
    method:"POST",
    headers:{"Authorization":authorization(),"Content-Type":"application/json",...extraHeaders},
    body,...(duplex?{duplex:"half"}:{})
  });
  return worker.fetch(request,{BOT_TOKEN:token,DB:{},ADMIN_IDS:"777",DEMO_MODE:"1"},{});
}
test("malformed JSON and non-object JSON are client errors, never HTTP 500",async()=>{
  for(const body of ["[1,2,3]","null","{\"variantId\":"]){
    const r=await call(body);
    assert.equal(r.status,400,"incorrect user JSON is not a server failure");
  }
});
test("JSON payload advertised larger than 16KiB is rejected before parsing",async()=>{
  const r=await call("{}",{"Content-Length":"20000"});
  assert.equal(r.status,413);
  const result=await r.json();
  assert.equal(result.ok,false);
  assert(!JSON.stringify(result).includes(token));
});
test("streamed oversized JSON without Content-Length is limited while reading",async()=>{
  let cancelled=false;
  const stream=new ReadableStream({
    start(controller){
      controller.enqueue(new TextEncoder().encode(" ".repeat(13000)));
      controller.enqueue(new TextEncoder().encode(" ".repeat(13000)));
      controller.close();
    },
    cancel(){cancelled=true}
  });
  const r=await call(stream,{},true);
  assert.equal(r.status,413);
  assert.equal((await r.json()).ok,false);
});
