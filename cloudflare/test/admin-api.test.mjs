import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {verifyTelegramInitData} from "../src/auth.js";
import {handleApi} from "../src/api.js";

const TOKEN="fixture-value-not-a-credential";
const WEB="just-a-test-not-a-real-secret-123456789";
const workerUrl="https://example.test";
function makeInitData(id=777,date=Math.floor(Date.now()/1000)){
  const fields={auth_date:String(date),user:JSON.stringify({id,first_name:"Demo",username:"tester",is_bot:false})};
  const check=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b,"en")).map(([k,v])=>k+"="+v).join("\n");
  const key=createHmac("sha256","WebAppData").update(TOKEN).digest();
  const hash=createHmac("sha256",key).update(check).digest("hex");
  return new URLSearchParams({...fields,hash}).toString();
}
function localDB(){
  const db=new DatabaseSync(":memory:");
  for(const file of ["schema.sql","seed.sql","migrations/0001_order_status_triggers.sql","migrations/0002_miniapp.sql","migrations/0003_store_readiness.sql","migrations/0004_shipped_return.sql"]){
    db.exec(readFileSync(new URL("../"+file,import.meta.url),"utf8"));
  }
  return {
    raw:db,
    prepare(sql){const s=db.prepare(sql);let args=[];
      return {bind(...v){args=v;return this},
        async first(){return s.get(...args)||null},
        async all(){return {results:s.all(...args)}},
        async run(){const a=s.run(...args);return {meta:{changes:Number(a.changes),last_row_id:Number(a.lastInsertRowid)}}}};
    },
    async batch(steps){db.exec("BEGIN IMMEDIATE");try{
      const r=[];for(const s of steps)r.push(await s.run());db.exec("COMMIT");return r;
    }catch(e){db.exec("ROLLBACK");throw e}}
  };
}
async function call(env,path,method="GET",body=null,auth=makeInitData()){
  const request=new Request(workerUrl+path,{
    method,headers:{"Authorization":"tma "+auth,...(body?{"Content-Type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  return handleApi(request,env,new URL(request.url));
}
test("Telegram Mini App signed initData validates auth_date, signature and admin",async()=>{
  assert.deepEqual((await verifyTelegramInitData(makeInitData(),TOKEN))?.id,777);
  assert.equal(await verifyTelegramInitData(makeInitData(777,Math.floor(Date.now()/1000)-900),TOKEN),null);
  assert.equal(await verifyTelegramInitData(makeInitData().replace("tester","hacker"),TOKEN),null);
  assert.equal(await verifyTelegramInitData(makeInitData(),TOKEN+"x"),null);
  assert.equal(await verifyTelegramInitData("",TOKEN),null);
  // Telegram may include an Ed25519 signature for third-party validation.
  // Bot-token HMAC verification excludes it and still authenticates the user.
  const sigUser=JSON.stringify({id:777,first_name:"Demo",username:"tester",is_bot:false});
  const sigFields={auth_date:String(Math.floor(Date.now()/1000)),signature:"Ed25519_demo_signature",user:sigUser};
  const sigCheck=Object.entries(sigFields).filter(([key])=>key!=="signature").sort(([a],[b])=>a.localeCompare(b,"en")).map(([k,v])=>k+"="+v).join("\n");
  const sigKey=createHmac("sha256","WebAppData").update(TOKEN).digest();
  const sigHash=createHmac("sha256",sigKey).update(sigCheck).digest("hex");
  assert.equal((await verifyTelegramInitData(new URLSearchParams({...sigFields,hash:sigHash}).toString(),TOKEN))?.id,777);
});
test("Mini App public demo catalogue, protected admin operations and idempotent orders",async()=>{
  const db=localDB();
  const env={DB:db,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",WEBHOOK_SECRET:WEB,DEMO_MODE:"1"};
  const sent=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    sent.push({method:String(url).split("/").pop(),body:JSON.parse(options.body)});
    return Response.json({ok:true,result:true});
  };
  try{
    const catalogue=await call(env,"/api/catalog","GET",null,"");
    assert.equal(catalogue.status,200);
    assert((await catalogue.json()).products.length>=3);
    assert.equal((await call(env,"/api/admin/dashboard","GET",null,"")).status,401);
    assert.equal((await call(env,"/api/admin/dashboard","GET",null,makeInitData(999))).status,403);
    assert.equal((await call(env,"/api/cart","GET",null,makeInitData(999))).status,403);
    const me=await (await call(env,"/api/me")).json();
    assert.equal(me.admin,true);
    let added=await call(env,"/api/cart","POST",{variantId:1,delta:1});
    assert.equal(added.status,200);
    let cart=await (await call(env,"/api/cart")).json();
    assert.equal(cart.items.length,1);
    const key="testCheckoutKey_0123456789";
    const payload={requestKey:key,name:"Demo Tester",phone:"@demo",address:"Самовывоз"};
    let order=await call(env,"/api/checkout","POST",payload);
    assert.equal(order.status,200);
    const newId=(await order.json()).orderId;
    assert.equal(db.raw.prepare("SELECT status FROM orders WHERE id=?").get(newId).status,"new");
    assert.equal(db.raw.prepare("SELECT stock FROM variants WHERE id=1").get().stock,4);
    let retry=await (await call(env,"/api/checkout","POST",payload)).json();
    assert.equal(retry.orderId,newId);
    assert.equal(retry.duplicate,true);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE kind='catalog'").get().n,1);
    const dashboard=await call(env,"/api/admin/dashboard");
    assert.equal(dashboard.status,200);
    assert.equal((await dashboard.json()).orders.length,1);
    let status=await call(env,"/api/admin/order/status","POST",{id:newId,status:"canceled"});
    assert.equal(status.status,200);
    assert.equal(db.raw.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
    assert.equal((await call(env,"/api/admin/order/status","POST",{id:newId,status:"canceled"})).status,409);
    assert.equal(db.raw.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
    const created=await call(env,"/api/admin/product","POST",{name:"Демо куртка",categoryId:1,description:"Плотный хлопок"});
    assert.equal(created.status,200);
    const newProduct=(await created.json()).id;
    assert(newProduct>3);
    const v=await call(env,"/api/admin/variant","POST",{productId:newProduct,sku:"DEMO-JACKET-1",size:"M",color:"чёрный",priceCents:1200000,costCents:750000,stock:2});
    assert.equal(v.status,200);
    assert.equal(db.raw.prepare("SELECT stock FROM variants WHERE sku='DEMO-JACKET-1'").get().stock,2);
    const customPayload={requestKey:"customRequest123456789",description:"Индивидуальный жакет с вышивкой",measurements:"Рост 180",name:"Demo",phone:"@demo",address:"Самовывоз"};
    const custom=await call(env,"/api/custom","POST",customPayload);
    assert.equal(custom.status,200);
    const customId=(await custom.json()).orderId;
    const customAgain=await (await call(env,"/api/custom","POST",customPayload)).json();
    assert.equal(customAgain.orderId,customId);
    assert.equal(customAgain.duplicate,true);
    assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM orders WHERE kind='custom'").get().n,1);
    assert.equal((await call(env,"/api/admin/settings","POST",{legalName:"Example atelier"},makeInitData(999))).status,403);
    const seller=await call(env,"/api/admin/settings","POST",{
      legalName:"Demo seller",taxId:"TEST-TAX",supportContact:"@test",
      pickupAddress:"Demo showroom",deliveryPolicy:"No real delivery in demo",
      returnPolicy:"No real sales",privacyUrl:"https://example.test/privacy"
    });
    assert.equal(seller.status,200);
    assert.equal((await seller.json()).productionEnabled,false);
    assert.equal(db.raw.prepare("SELECT legal_name FROM store_settings WHERE id=1").get().legal_name,"Demo seller");
    assert.equal((await call(env,"/api/admin/settings","POST",{privacyUrl:"javascript:alert(1)"})).status,400);
    const accidentallyConfigured={...env,DEMO_MODE:"0"};
    assert.equal((await (await call(accidentallyConfigured,"/api/me")).json()).demo,true,
      "Disabling only DEMO_MODE must not enable real sales");
    const quote=await call(env,"/api/admin/quote","POST",{id:customId,priceCents:900000,costCents:450000});
    assert.equal(quote.status,200);
    assert.equal((await quote.json()).delivered,true);
    assert(sent.some(s=>s.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("qa:")));
  }finally{globalThis.fetch=originalFetch;db.raw.close()}
});

test("Mini App return endpoint never double restocks shipped orders",async()=>{
  const storage=localDB(),env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  const db=storage.raw;
  db.exec("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Demo')");
  db.exec("INSERT INTO orders(id,customer_id,kind,status) VALUES(1,1,'catalog','new')");
  db.exec("INSERT INTO order_items(order_id,variant_id,product_name,size,color,quantity,unit_price_cents,unit_cost_cents) VALUES(1,1,'Bag','one size','beige',1,100000,50000)");
  db.exec("UPDATE variants SET stock=stock-1 WHERE id=1");
  for(const st of ["confirmed","ready","shipped","canceled"])db.prepare("UPDATE orders SET status=? WHERE id=1").run(st);
  assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,4);
  const endpoint="/api/admin/order/return";
  assert.equal((await call(env,endpoint,"POST",{id:1,physicallyReceived:true,note:"Received"},makeInitData(1234))).status,403);
  assert.equal((await call(env,endpoint,"POST",{id:1,note:"Received"})).status,400);
  assert.equal((await call(env,endpoint,"POST",{id:1,physicallyReceived:true,note:"Received by manager"})).status,200);
  assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
  assert.equal((await call(env,endpoint,"POST",{id:1,physicallyReceived:true,note:"Received again"})).status,409);
  assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_return_receipts").get().n,1);
  db.close();
});

test("isolated simulated identities: administrator and two separate buyers",async()=>{
 const storage=localDB(),db=storage.raw;
 // Only the in-memory test DB enables simulated buyers; production remains demo-only.
 const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"0",STORE_READY:"1"};
 const saved=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({ok:true,result:true});
 try{
  const buyers=[888,999];
  const sharedKey="identicalRequestKey_A123456";
  const orderIds=[];
  for(const uid of buyers){
   const auth=makeInitData(uid);
   assert.equal((await call(env,"/api/admin/dashboard","GET",null,auth)).status,403);
   assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1},auth)).status,200);
   const cart=await (await call(env,"/api/cart","GET",null,auth)).json();
   assert.equal(cart.items.length,1);
   assert.equal(cart.items[0].quantity,1);
  }
  for(const uid of buyers){
   const auth=makeInitData(uid);
   const resp=await call(env,"/api/checkout","POST",{
     requestKey:sharedKey,name:"Synthetic user",phone:"@testing",address:"Test pickup"
   },auth);
   assert.equal(resp.status,200);
   const orderId=(await resp.json()).orderId;
   orderIds.push(orderId);
   assert.equal((await (await call(env,"/api/cart","GET",null,auth)).json()).items.length,0);
  }
  assert.notEqual(orderIds[0],orderIds[1],"distinct Telegram users must not share orders");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE kind='catalog'").get().n,2);
  assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM checkout_requests WHERE request_key=?").get(sharedKey).n,2);
  const dashboard=await call(env,"/api/admin/dashboard","GET",null,makeInitData(777));
  assert.equal(dashboard.status,200);
  assert.equal((await dashboard.json()).orders.length,2);
 }finally{globalThis.fetch=saved;db.close()}
});
