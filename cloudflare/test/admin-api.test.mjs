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


test("dashboard aggregates include history beyond recent list limits",async()=>{
  const storage=localDB(), db=storage.raw;
  const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  try{
    db.exec(`
      INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Test admin');
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<120)
      INSERT INTO orders(id,customer_id,kind,status,total_cents,cost_cents)
      SELECT i,1,'custom',CASE WHEN i<=50 THEN 'completed' ELSE 'new' END,2000,800 FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1005)
      INSERT INTO payments(order_id,kind,amount_cents,reference)
      SELECT 1,'received',10,'' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<605)
      INSERT INTO variants(product_id,sku,size,color,price_cents,cost_cents,stock,active)
      SELECT 1,'EXTRA-'||i,'one size','test',100,10,1,1 FROM n;
    `);
    const response=await call(env,"/api/admin/dashboard");
    assert.equal(response.status,200);
    const d=await response.json();
    assert.equal(d.orders.length,100,"recent orders should still be bounded");
    assert.equal(d.variants.length,600,"editing list should still be bounded");
    assert.equal(d.metrics.orderCount,120,"total order count must include old orders");
    assert.equal(d.metrics.completedCount,50,"completed count must include old orders");
    assert.equal(d.metrics.ordersByStatus.new,70);
    assert.equal(d.metrics.ordersByStatus.completed,50);
    assert.equal(d.metrics.bookedRevenueCents,240000);
    assert.equal(d.metrics.grossMarginCents,60000);
    assert.equal(d.metrics.paidNetCents,10050,"more than 1000 payment rows must be summed");
    assert.equal(d.metrics.lowStockCount,605,"low stock count must include undisplayed variants");
  }finally{db.close()}
});


test("cart can discard an archived variant but cannot add it again",async()=>{
  const storage=localDB(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  try{
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
    db.exec("UPDATE variants SET active=0 WHERE id=1");
    let cart=await (await call(env,"/api/cart")).json();
    assert.equal(cart.items.length,1,"archived variants remain visible until removed");
    assert.equal(cart.items[0].available,0,"archived cart line is marked unavailable");
    let removed=await call(env,"/api/cart","POST",{variantId:1,delta:-1});
    assert.equal(removed.status,200,"a user must be able to remove an archived variant");
    assert.equal((await removed.json()).quantity,1);
    removed=await call(env,"/api/cart","POST",{variantId:1,delta:-1});
    assert.equal(removed.status,200);
    assert.equal((await removed.json()).quantity,0);
    cart=await (await call(env,"/api/cart")).json();
    assert.equal(cart.items.length,0);
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,404,
      "an archived variant must never be purchasable again");
  }finally{db.close()}
});


test("Mini App rejects partial checkout if any item became inactive",async()=>{
  const storage=localDB(), db=storage.raw;
  const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  try{
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
    assert.equal((await call(env,"/api/cart","POST",{variantId:2,delta:1})).status,200);
    db.exec("UPDATE variants SET active=0 WHERE id=2");
    const response=await call(env,"/api/checkout","POST",{
      requestKey:"partial_order_guard_0123456789",
      name:"Test Buyer",phone:"@example",address:"Демо-самовывоз"
    });
    assert.equal(response.status,409,"one archived item must reject whole checkout");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cart_items").get().n,2);
    assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
    assert.equal(db.prepare("SELECT stock FROM variants WHERE id=2").get().stock,8);
  }finally{db.close()}
});


test("cart reflects stock shortage and recovers after reducing quantity",async()=>{
  const storage=localDB(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  try{
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
    db.exec("UPDATE variants SET stock=1 WHERE id=1");
    let cart=await (await call(env,"/api/cart")).json();
    assert.equal(cart.items.length,1);
    assert.equal(cart.items[0].available,0,"stock shortage must be visible before checkout");
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:-1})).status,200);
    cart=await (await call(env,"/api/cart")).json();
    assert.equal(cart.items[0].quantity,1);
    assert.equal(cart.items[0].available,1,"reducing quantity must unblock checkout");
  }finally{db.close()}
});


test("checkout rejects a cart changed between snapshot and atomic commit",async()=>{
  const db=localDB(),raw=db.raw;
  const env={DB:db,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  try{
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
    let inserted=false;
    const underlying=db.batch.bind(db);
    db.batch=async statements=>{
      if(!inserted){
        inserted=true;
        // Another action on the same account adds a second product while the
        // first checkout is waiting to commit. It must NOT disappear for free.
        raw.prepare("INSERT INTO cart_items(customer_id,variant_id,quantity) SELECT id,2,1 FROM customers WHERE telegram_id=777").run();
      }
      return underlying(statements);
    };
    const response=await call(env,"/api/checkout","POST",{
      requestKey:"cart_snapshot_race_012345678",
      name:"Synthetic Buyer",phone:"@test",address:"Test pickup"
    });
    assert.equal(inserted,true);
    assert.equal(response.status,409,"changed cart must be retried rather than silently truncated");
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM order_items").get().n,0);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM orders").get().n,0,
      "failed checkout must not retain a phantom order with contact data");
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_items").get().n,2);
    assert.equal(raw.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
  }finally{globalThis.fetch=originalFetch;raw.close()}
});


test("concurrent add-to-cart requests must not overwrite each other",async()=>{
  const storage=localDB(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  const originalPrepare=storage.prepare.bind(storage);
  let arrivals=0;let release;
  const gate=new Promise(resolve=>{release=resolve});
  storage.prepare=sql=>{
    const stmt=originalPrepare(sql);
    if(sql.startsWith("SELECT quantity FROM cart_items WHERE customer_id")){
      const originalFirst=stmt.first.bind(stmt);
      stmt.first=async()=>{
        const read=await originalFirst();
        if(++arrivals===2)release();
        await gate;  // Both requests observe the same original cart before either writes.
        return read;
      };
    }
    return stmt;
  };
  try{
    const responses=await Promise.all([
      call(env,"/api/cart","POST",{variantId:1,delta:1}),
      call(env,"/api/cart","POST",{variantId:1,delta:1})
    ]);
    assert.deepEqual(responses.map(r=>r.status),[200,200]);
    assert.equal(db.prepare("SELECT quantity FROM cart_items WHERE variant_id=1").get().quantity,2,
      "two accepted increments must result in quantity two, not one");
  }finally{db.close()}
});


test("checkout also rejects changed quantity or seller price before commit",async()=>{
  for(const mutation of ["quantity","price"]){
    const storage=localDB(),db=storage.raw;
    const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async()=>Response.json({ok:true,result:true});
    try{
      assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
      const beforeStock=db.prepare("SELECT stock FROM variants WHERE id=1").get().stock;
      let raced=false;
      const base=storage.batch.bind(storage);
      storage.batch=async commands=>{
        if(!raced){
          raced=true;
          if(mutation==="quantity")db.exec("UPDATE cart_items SET quantity=2 WHERE variant_id=1");
          else db.exec("UPDATE variants SET price_cents=price_cents+100 WHERE id=1");
        }
        return base(commands);
      };
      const resp=await call(env,"/api/checkout","POST",{
        requestKey:"verify_snapshot_"+mutation+"_abcdef01234",
        name:"Demo User",phone:"@demo",address:"Самовывоз"
      });
      assert.equal(resp.status,409,"checkout must reject mid-flight "+mutation+" changes");
      assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,beforeStock);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM order_items").get().n,0);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM cart_items").get().n,1);
    }finally{globalThis.fetch=originalFetch;db.close()}
  }
});


test("checkout is atomic even if D1 fails and no cleanup query is possible",async()=>{
  const storage=localDB(), db=storage.raw;
  const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  const prepare=storage.prepare.bind(storage);
  const batch=storage.batch.bind(storage);
  let failed=false;
  storage.prepare=sql=>{
    if(failed && /^(DELETE FROM orders|UPDATE orders SET contact_name)/.test(sql))
      throw new Error("Synthetic D1 outage during attempted cleanup");
    return prepare(sql);
  };
  storage.batch=async statements=>{
    // Deliberately execute the first statement, then fail the same
    // transaction. A safe checkout must not leave an order header behind.
    try{
      return await batch([statements[0],
        prepare("INSERT INTO categories(id,name) VALUES(1,'duplicate-fixture-key')")]);
    }finally{failed=true}
  };
  try{
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
    const response=await call(env,"/api/checkout","POST",{
      requestKey:"atomic_d1_outage_1234567890",name:"Private Sample",
      phone:"@contact",address:"Synthetic pickup"
    });
    assert.equal(response.status,409);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM orders").get().n,0,
      "failed transaction must not leave order header or personal data");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM checkout_requests").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM cart_items").get().n,1);
    assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
  }finally{db.close()}
});


test("tailoring submission also rolls back its header on a failed D1 batch",async()=>{
  const storage=localDB(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  const batch=storage.batch.bind(storage);
  storage.batch=async statements=>batch([statements[0],
    storage.prepare("INSERT INTO categories(id,name) VALUES(1,'duplicated-category')")]);
  try{
    const response=await call(env,"/api/custom","POST",{
      requestKey:"atomic_tailoring_fail_123456789",
      description:"Synthetic custom tailored jacket with lining",
      measurements:"Chest 100 cm",name:"Synthetic Buyer",
      phone:"@example",address:"Test pickup"
    });
    assert.equal(response.status,409);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM orders").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM checkout_requests").get().n,0);
  }finally{db.close()}
});


test("atomic multi-item checkout links both lines and idempotency to one order",async()=>{
  const storage=localDB(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  try{
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
    assert.equal((await call(env,"/api/cart","POST",{variantId:2,delta:1})).status,200);
    const key="atomic_two_lines_123456789";
    const payload={requestKey:key,name:"Synthetic Multi Buyer",phone:"@fixture",address:"Pickup"};
    const response=await call(env,"/api/checkout","POST",payload);
    assert.equal(response.status,200);
    const {orderId}=await response.json();
    assert(Number.isSafeInteger(orderId)&&orderId>0);
    const row=db.prepare("SELECT kind,total_cents,status FROM orders WHERE id=?").get(orderId);
    assert.equal(row.kind,"catalog");
    assert.equal(row.status,"new");
    const lines=db.prepare("SELECT variant_id,quantity FROM order_items WHERE order_id=? ORDER BY variant_id").all(orderId);
    assert.deepEqual(lines.map(x=>x.variant_id),[1,2]);
    assert.deepEqual(lines.map(x=>x.quantity),[1,1]);
    const expected=db.prepare("SELECT SUM(price_cents) AS n FROM variants WHERE id IN(1,2)").get().n;
    assert.equal(row.total_cents,expected);
    const idem=db.prepare("SELECT order_id FROM checkout_requests WHERE telegram_id=777 AND request_key=?").get(key);
    assert.equal(idem.order_id,orderId);
    const history=db.prepare("SELECT new_status FROM status_history WHERE order_id=?").all(orderId);
    assert.deepEqual(history.map(x=>x.new_status),["new"]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cart_items").get().n,0);
    const retry=await call(env,"/api/checkout","POST",payload);
    assert.equal(retry.status,200);
    assert.deepEqual(await retry.json(),{ok:true,orderId,duplicate:true,managerUrl:null});
    assert.ok(db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE order_id=? AND event_type='catalog_customer'").get(orderId).n===1,"notification is committed with the order, once");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders").get().n,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_items").get().n,2);
  }finally{globalThis.fetch=originalFetch;db.close()}
});


test("idempotency keys cannot silently alias different order kinds",async()=>{
  const storage=localDB(),raw=storage.raw;
  const env={DB:storage,BOT_TOKEN:TOKEN,ADMIN_IDS:"777",DEMO_MODE:"1"};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  const key="shared_cross_operation_12345";
  try{
    const tailoring={requestKey:key,name:"Synthetic Buyer",phone:"@test",address:"Pickup",
      description:"A synthetic custom-made coat with embroidery",
      measurements:"Chest 100"};
    const custom=await call(env,"/api/custom","POST",tailoring);
    assert.equal(custom.status,200);
    assert.equal((await call(env,"/api/cart","POST",{variantId:1,delta:1})).status,200);
    const checkout=await call(env,"/api/checkout","POST",{
      requestKey:key,name:"Synthetic Buyer",phone:"@test",address:"Pickup"
    });
    assert.equal(checkout.status,409,"catalog checkout must not masquerade as a custom request");
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM orders").get().n,1);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_items").get().n,1);
    assert.equal(raw.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
    const originalCustom=await call(env,"/api/custom","POST",tailoring);
    assert.equal(originalCustom.status,200);
    assert.equal((await originalCustom.json()).duplicate,true);
  }finally{globalThis.fetch=originalFetch;raw.close()}
});

test("customers review a product once, abuse can be hidden and anyone can read",async()=>{
  const DB=localDB();
  const env={DB,BOT_TOKEN:TOKEN,ADMIN_IDS:"100",DEMO_MODE:"0",STORE_READY:"1"};
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true});
  try{
    const product=DB.raw.prepare("SELECT id FROM products WHERE active=1 LIMIT 1").get().id;
    const buyer=makeInitData(200);
    const post=(body,auth=buyer)=>call(env,"/api/reviews","POST",body,auth);
    assert.equal((await post({productId:product,rating:6,text:"Отлично сидит"})).status,400);
    assert.equal((await post({productId:product,rating:5,text:"  "})).status,400);
    assert.equal((await post({productId:999999,rating:5,text:"Отлично сидит"})).status,404);
    assert.equal((await post({productId:product,rating:5,text:"<b>Отлично</b> сидит"})).status,200);
    assert.equal((await post({productId:product,rating:3,text:"Подумал ещё раз"})).status,200);
    const read=async()=>{
      const request=new Request(workerUrl+"/api/reviews?product="+product);
      return (await (await handleApi(request,env,new URL(request.url))).json()).reviews;
    };
    const [review,...others]=await read();
    assert.equal(others.length,0,"a repeat review replaces the first");
    assert.equal(review.rating,3);
    assert.equal(review.telegram_id,undefined);
    const catalogRequest=new Request(workerUrl+"/api/catalog");
    const catalog=await (await handleApi(catalogRequest,env,new URL(catalogRequest.url))).json();
    assert.equal(catalog.products.find(p=>p.id===product).reviews,1);
    assert.equal((await call(env,"/api/admin/review/hide","POST",{id:review.id},buyer)).status,403);
    assert.equal((await call(env,"/api/admin/review/hide","POST",{id:review.id},makeInitData(100))).status,200);
    assert.equal((await read()).length,0);
  }finally{globalThis.fetch=original}
});
