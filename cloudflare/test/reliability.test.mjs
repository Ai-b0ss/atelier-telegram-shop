import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {handleApi} from "../src/api.js";

// Dependency-free, reproducible model-based test. All requests and data are
// synthetic. Never run against a production endpoint or Cloudflare D1.
const token="only-a-synthetic-fixture-not-a-real-bot-token";
const userIds=[777,888,999];
const variants=[1,2,3,4];
const initialStock=[5,8,8,4];
const initialPrice=[250000,300000,300000,650000];
const scenarios=bounded(process.env.RELIABILITY_CASES,12,1,200);
const steps=bounded(process.env.RELIABILITY_STEPS,90,1,300);
const firstSeed=bounded(process.env.RELIABILITY_SEED,26011001,1,2147483647);
function bounded(s,defaultValue,min,max){
  if(s===undefined)return defaultValue;
  const n=Number(s);
  if(!Number.isSafeInteger(n)||n<min||n>max)throw Error("Invalid reliability test configuration");
  return n;
}
function random(seed){
  let x=seed>>>0;
  return ()=>{
    x=(x+0x6D2B79F5)>>>0;
    let t=Math.imul(x^(x>>>15),1|x);
    t=(t+Math.imul(t^(t>>>7),61|t))^t;
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}
function auth(id){
  const fields={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:"Synthetic",is_bot:false})};
  const check=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b,"en")).map(([k,v])=>k+"="+v).join("\n");
  const hmac=createHmac("sha256","WebAppData").update(token).digest();
  return new URLSearchParams({...fields,hash:createHmac("sha256",hmac).update(check).digest("hex")}).toString();
}
function database(){
  const raw=new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys=ON");
  for(const path of ["schema.sql","seed.sql","migrations/0001_order_status_triggers.sql",
                     "migrations/0002_miniapp.sql","migrations/0003_store_readiness.sql",
                     "migrations/0004_shipped_return.sql"])
    raw.exec(readFileSync(new URL("../"+path,import.meta.url),"utf8"));
  return {raw,
    prepare(sql){
      const stmt=raw.prepare(sql);let args=[];
      return {bind(...v){args=v;return this},
        async first(){return stmt.get(...args)||null},
        async all(){return {results:stmt.all(...args)}},
        async run(){const r=stmt.run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}
      };
    },
    async batch(statements){
      raw.exec("BEGIN IMMEDIATE");
      try{
        const results=[];
        for(const s of statements)results.push(await s.run());
        raw.exec("COMMIT");
        return results;
      }catch(error){raw.exec("ROLLBACK");throw error}
    }
  };
}
async function call(env,id,path,method="GET",body=null){
  const req=new Request("https://synthetic.invalid"+path,{
    method,headers:{"Authorization":"tma "+auth(id),...(body?{"Content-Type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const response=await handleApi(req,env,new URL(req.url));
  return {status:response.status,data:await response.json()};
}
function modelState(){
  return {stock:[...initialStock],active:[true,true,true,true],
    carts:new Map(userIds.map(id=>[id,[0,0,0,0]])),orders:[],nextKey:0};
}
function assertInvariants(raw,m,trace,seed){
  try{
    const actualStock=raw.prepare("SELECT id,stock FROM variants ORDER BY id").all();
    assert.deepEqual(actualStock.map(x=>x.stock),m.stock,"stock differs from the reference model");
    for(const id of userIds){
      const rows=raw.prepare("SELECT v.id,ci.quantity FROM cart_items ci JOIN customers c ON c.id=ci.customer_id JOIN variants v ON v.id=ci.variant_id WHERE c.telegram_id=? ORDER BY v.id").all(id);
      const actual=variants.map(v=>rows.find(x=>x.id===v)?.quantity||0);
      assert.deepEqual(actual,m.carts.get(id),"a buyer cart differs from the reference model");
    }
    const orders=raw.prepare("SELECT id,customer_id,status,total_cents,kind FROM orders WHERE kind='catalog' ORDER BY id").all();
    assert.equal(orders.length,m.orders.length,"unexpected number of orders");
    for(let j=0;j<orders.length;j++){
      const o=orders[j],expected=m.orders[j];
      assert.equal(o.id,expected.id,"unexpected order identity");
      assert.equal(o.status,expected.status,"unexpected order status");
      assert.equal(o.total_cents,expected.total,"unexpected order total");
      const buyer=raw.prepare("SELECT telegram_id FROM customers WHERE id=?").get(o.customer_id).telegram_id;
      assert.equal(buyer,expected.buyer,"order leaked to a different user");
      const details=raw.prepare("SELECT variant_id,quantity,unit_price_cents FROM order_items WHERE order_id=? ORDER BY variant_id").all(o.id);
      assert.deepEqual(details.map(x=>x.quantity),expected.lines.filter(n=>n>0),"order line quantity mismatch");
      assert.equal(details.reduce((n,x)=>n+x.quantity*x.unit_price_cents,0),expected.total,"order price/line mismatch");
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM status_history WHERE order_id=? AND new_status='new'").get(o.id).n,1,"order history missing");
    }
    const receipts=raw.prepare("SELECT COUNT(*) AS n FROM checkout_requests").get().n;
    assert.equal(receipts,m.orders.length,"checkout idempotency records mismatch");
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM variants WHERE stock<0").get().n,0);
    assert.equal(raw.prepare("PRAGMA foreign_key_check").all().length,0,"referential integrity failed");
  }catch(e){
    throw Error("Reliability invariant violated, seed="+seed+", trace="+JSON.stringify(trace.slice(-35))+"\n"+e.stack);
  }
}
test("model-based sequences preserve user isolation, stock, orders and idempotency",async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  try{
    for(let i=0;i<scenarios;i++){
      const seed=firstSeed+i, rng=random(seed),db=database(),raw=db.raw;
      const env={DB:db,BOT_TOKEN:token,ADMIN_IDS:"777",DEMO_MODE:"0",STORE_READY:"1"};
      const model=modelState(),trace=[];
      const pick=n=>Math.floor(rng()*n);
      try{
        for(let step=0;step<steps;step++){
          const buyer=userIds[pick(userIds.length)],variant=pick(4),action=pick(100);
          const cart=model.carts.get(buyer),record={step,buyer,variant:variant+1};
          if(action<39){ // add
            record.action="add";
            const expected=model.active[variant]&&model.stock[variant]>cart[variant];
            const r=await call(env,buyer,"/api/cart","POST",{variantId:variant+1,delta:1});
            const expectedStatus=!model.active[variant]?404:expected?200:409;
            assert.equal(r.status,expectedStatus,"add must respect stock and active state");
            if(expected)cart[variant]++;
          }else if(action<61){ // remove, including absent or archived
            record.action="remove";
            const r=await call(env,buyer,"/api/cart","POST",{variantId:variant+1,delta:-1});
            assert.equal(r.status,200);
            cart[variant]=Math.max(0,cart[variant]-1);
          }else if(action<79){ // checkout, including empty and stale carts
            record.action="checkout";
            const lineCount=cart.reduce((n,x)=>n+x,0);
            const possible=lineCount>0&&cart.every((q,j)=>q===0||(model.active[j]&&q<=model.stock[j]));
            const key="fuzz_"+seed+"_"+step+"_req_key";
            const payload={requestKey:key,name:"Synthetic person",phone:"@synthetic",address:"Test pickup"};
            const response=await call(env,buyer,"/api/checkout","POST",payload);
            assert.equal(response.status,possible?200:409,"checkout eligibility mismatch");
            if(possible){
              const lines=[...cart],total=lines.reduce((n,q,j)=>n+q*initialPrice[j],0);
              const id=response.data.orderId;
              assert(Number.isSafeInteger(id)&&id>0);
              const retry=await call(env,buyer,"/api/checkout","POST",payload);
              assert.equal(retry.status,200,"idempotent retry must succeed");
              assert.equal(retry.data.orderId,id,"retry must refer to same order");
              assert.equal(retry.data.duplicate,true);
              for(let j=0;j<4;j++){model.stock[j]-=cart[j];cart[j]=0}
              model.orders.push({id,buyer,status:"new",lines,total});
            }
          }else if(action<91){ // cancel exactly once
            const active=model.orders.filter(o=>o.status==="new");
            record.action="cancel";
            if(active.length){
              const o=active[pick(active.length)];record.order=o.id;
              const r=await call(env,777,"/api/admin/order/status","POST",{id:o.id,status:"canceled"});
              assert.equal(r.status,200,"new order should cancel");
              for(let j=0;j<4;j++)model.stock[j]+=o.lines[j];
              o.status="canceled";
              const duplicate=await call(env,777,"/api/admin/order/status","POST",{id:o.id,status:"canceled"});
              assert.equal(duplicate.status,409,"second cancellation must fail");
            }
          }else{ // seller archives/restores a variant
            record.action="toggle-active";
            model.active[variant]=!model.active[variant];
            raw.prepare("UPDATE variants SET active=? WHERE id=?").run(model.active[variant]?1:0,variant+1);
          }
          trace.push(record);
          assertInvariants(raw,model,trace,seed);
        }
      }catch(error){
        throw Error("Replay: RELIABILITY_SEED="+seed+" RELIABILITY_CASES=1 RELIABILITY_STEPS="+steps+
          " node --test cloudflare/test/reliability.test.mjs\n"+error.stack);
      }finally{raw.close()}
    }
  }finally{globalThis.fetch=originalFetch}
});
test("the invariant checker actually detects corrupted stock and missing records",()=>{
  const db=database(),m=modelState();
  try{
    assertInvariants(db.raw,m,[],"self-test");
    db.raw.exec("UPDATE variants SET stock=stock+3 WHERE id=1");
    assert.throws(()=>assertInvariants(db.raw,m,[],"self-test"),/stock differs/);
    db.raw.exec("UPDATE variants SET stock=stock-3 WHERE id=1");
    assertInvariants(db.raw,m,[],"self-test");
    db.raw.exec("PRAGMA foreign_keys=OFF");
    db.raw.exec("INSERT INTO order_items(order_id,variant_id,product_name,size,color,quantity,unit_price_cents,unit_cost_cents) VALUES(987,1,'synthetic','one','test',1,100,50)");
    assert.throws(()=>assertInvariants(db.raw,m,[],"self-test"),/referential integrity failed/);
  }finally{db.raw.close()}
});
