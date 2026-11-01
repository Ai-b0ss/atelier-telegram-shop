import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

function database(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../seed.sql',import.meta.url),'utf8'));
  return {
    raw: db,
    prepare(sql){
      const st=db.prepare(sql);let vals=[];
      return {
        bind(...v){vals=v;return this},
        async first(){return st.get(...vals)||null},
        async all(){return {results:st.all(...vals)}},
        async run(){const r=st.run(...vals);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}
      };
    },
    async batch(queries){const results=[];db.exec('BEGIN IMMEDIATE');try{
      for(const q of queries)results.push(await q.run());
      db.exec('COMMIT');
      return results;
    }catch(e){db.exec('ROLLBACK');throw e}}
  };
}
const makeUpdate=(id,msg)=>({update_id:id,message:{message_id:id,chat:{id:msg.user??777,type:"private"},from:{id:msg.user??777,first_name:"Admin",username:"owner"},text:msg.text}});
const makeCallback=(id,data,user=777)=>({update_id:id,callback_query:{id:String(id),from:{id:user,first_name:"Admin",username:"owner"},data,message:{message_id:1,chat:{id:user,type:"private"}}}});
test('cloud worker demo: webhook auth, checkout, cancellation, quote revision, xlsx',async()=>{
  const storage=database();
  const env={DB:storage,BOT_TOKEN:"123:demo_test_token_not_real",WEBHOOK_SECRET:"test-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  const sent=[];
  const prior=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{
    const method=String(url).split('/').pop();
    const data=opts.body instanceof FormData?Object.fromEntries(opts.body.entries()):JSON.parse(opts.body);
    sent.push({method,data});
    return Response.json({ok:true,result:true});
  };
  let update=1;
  const call=async(evt,secret=env.WEBHOOK_SECRET)=>{
    const req=new Request('https://example.com/webhook',{method:"POST",headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(evt)});
    return worker.fetch(req,env,{waitUntil(){}});
  };
  try{
    assert.equal((await call(makeUpdate(update++,{text:"/start"}),"wrong")).status,403);
    assert.equal((await call(makeUpdate(update++,{text:"/start",user:999}))).status,200);
    assert.equal(storage.raw.prepare('SELECT COUNT(*) n FROM customers').get().n,0,'demo stranger must not be persisted');
    assert.equal((await call(makeUpdate(update++,{text:"/start"}))).status,200);
    assert.equal((await call(makeCallback(update++,"cats"))).status,200);
    assert.equal((await call(makeCallback(update++,"cat:1"))).status,200);
    assert.equal((await call(makeCallback(update++,"p:1"))).status,200);
    assert.equal((await call(makeCallback(update++,"add:1"))).status,200);
    assert.equal((await call(makeCallback(update++,"cart"))).status,200);
    assert.equal((await call(makeCallback(update++,"checkout"))).status,200);
    for(const text of ["Demo Name","@contact","самовывоз"])assert.equal((await call(makeUpdate(update++,{text}))).status,200);
    assert.equal(storage.raw.prepare('SELECT status FROM orders WHERE id=1').get().status,"new");
    assert.equal(storage.raw.prepare('SELECT stock FROM variants WHERE id=1').get().stock,4);
    const prev=update++;
    await call(makeUpdate(prev,{text:"/orders"}));
    const c1=storage.raw.prepare('SELECT COUNT(*) n FROM processed_updates').get().n;
    await call(makeUpdate(prev,{text:"/orders"}));
    assert.equal(storage.raw.prepare('SELECT COUNT(*) n FROM processed_updates').get().n,c1,'duplicate update ignored');
    await call(makeUpdate(update++,{text:"/payment 1 received 1000 DEMO-PAY-001"}));
    assert.equal((await call(makeUpdate(update++,{text:"/status 1 canceled"}))).status,200);
    assert.equal(storage.raw.prepare('SELECT status FROM orders WHERE id=1').get().status,"new","paid order must not cancel");
    await call(makeUpdate(update++,{text:"/payment 1 refunded 1000 DEMO-RFD-001"}));
    assert.equal((await call(makeUpdate(update++,{text:"/status 1 canceled"}))).status,200);
    assert.equal(storage.raw.prepare('SELECT status FROM orders WHERE id=1').get().status,"canceled");
    assert.equal(storage.raw.prepare('SELECT stock FROM variants WHERE id=1').get().stock,5);
    await call(makeCallback(update++,"custom"));
    for(const text of ["Куртка ручной работы","Рост 177, обхват 70","Demo Custom","@custom","Самовывоз"])assert.equal((await call(makeUpdate(update++,{text}))).status,200);
    assert.equal(storage.raw.prepare('SELECT kind FROM orders WHERE id=2').get().kind,"custom");
    await call(makeUpdate(update++,{text:"/quote 2 8500 3900"}));
    const old=sent.filter(s=>s.method==="sendMessage"&&s.data.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("qa:")).at(-1).data.reply_markup.inline_keyboard[0][0].callback_data;
    await call(makeUpdate(update++,{text:"/quote 2 8500 4200"}));
    const fresh=sent.filter(s=>s.method==="sendMessage"&&s.data.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("qa:")).at(-1).data.reply_markup.inline_keyboard[0][0].callback_data;
    assert.notEqual(old,fresh);
    await call(makeCallback(update++,old));
    assert.equal(storage.raw.prepare('SELECT status FROM orders WHERE id=2').get().status,'new');
    await call(makeCallback(update++,fresh));
    assert.equal(storage.raw.prepare('SELECT status FROM orders WHERE id=2').get().status,'confirmed');
    const report=await call(makeUpdate(update++,{text:"/report"}));
    assert.equal(report.status,200);
    const excel=sent.find(s=>s.method==="sendDocument");
    assert(excel,"real XLSX must be sent");
    const file=excel.data.document;
    assert.equal(file.name,"atelier-cloud-report.xlsx");
    assert.equal(file.type,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }finally{
    globalThis.fetch=prior;
    storage.raw.close();
  }
});

test('race: order must not consume some inventory when another item sells out',async()=>{
  const storage=database();
  const env={DB:storage,BOT_TOKEN:"123:demo_test_token_not_real",WEBHOOK_SECRET:"secret-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  const prior=globalThis.fetch;
  const deliveries=[];
  globalThis.fetch=async (url,opts)=>{
    const method=String(url).split('/').pop();
    const data=JSON.parse(opts.body);
    deliveries.push({method,data});
    return Response.json({ok:true,result:true});
  };
  const c=storage.raw;
  c.prepare("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Test')").run();
  c.prepare("INSERT INTO cart_items(customer_id,variant_id,quantity) VALUES(1,1,1),(1,2,1)").run();
  c.prepare("UPDATE variants SET stock=1 WHERE id=2").run();
  const originalBatch=storage.batch;
  let competitorRaced=false;
  storage.batch=async(statements)=>{
    if(!competitorRaced){
      competitorRaced=true;
      // Simulate another buyer grabbing variant #2 after the cart was read.
      c.prepare("UPDATE variants SET stock=0 WHERE id=2").run();
    }
    return originalBatch(statements);
  };
  let seq=100;
  const call=async(evt)=>{
    const req=new Request('https://example.com/webhook',{
      method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},
      body:JSON.stringify(evt)
    });
    return worker.fetch(req,env,{waitUntil(){}});
  };
  try{
    assert.equal((await call(makeCallback(seq++,"checkout"))).status,200);
    assert.equal((await call(makeUpdate(seq++,{text:"Buyer"}))).status,200);
    assert.equal((await call(makeUpdate(seq++,{text:"@buyer"}))).status,200);
    assert.equal((await call(makeUpdate(seq++,{text:"Самовывоз"}))).status,200);
    assert(competitorRaced,"race was not injected");
    const order=c.prepare("SELECT status FROM orders ORDER BY id DESC LIMIT 1").get();
    assert.equal(order.status,"canceled");
    assert.equal(c.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5,
      "available item must not be deducted when second item fails");
    assert.equal(c.prepare("SELECT stock FROM variants WHERE id=2").get().stock,0);
    assert.equal(c.prepare("SELECT COUNT(*) n FROM order_items").get().n,0);
    assert.equal(c.prepare("SELECT COUNT(*) n FROM cart_items").get().n,2);
    assert(deliveries.some(e=>e.method==="sendMessage"&&e.data.text?.includes("Склад изменился")));
  }finally{globalThis.fetch=prior;storage.raw.close()}
});

test('stale concurrent quote must not send an invalid offer',async()=>{
  const storage=database();
  const env={DB:storage,BOT_TOKEN:"123:demo_test_token_not_real",WEBHOOK_SECRET:"secret-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  const sql=storage.raw;
  sql.prepare("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Demo')").run();
  sql.prepare("INSERT INTO orders(id,customer_id,kind,status,quote_revision) VALUES(1,1,'custom','new',1)").run();
  let raced=false;
  const basePrepare=storage.prepare.bind(storage);
  storage.prepare=(query)=>{
    if(query.startsWith("UPDATE orders SET total_cents=")&&!raced){
      raced=true;
      sql.prepare("UPDATE orders SET quote_revision=2 WHERE id=1").run();
    }
    return basePrepare(query);
  };
  const sent=[];
  const old=globalThis.fetch;
  globalThis.fetch=async (url,opts)=>{
    const method=String(url).split('/').pop();
    const data=JSON.parse(opts.body);
    sent.push({method,data});
    return Response.json({ok:true,result:true});
  };
  try{
    const update=makeUpdate(900,{text:"/quote 1 8500 3900"});
    const request=new Request("https://example.com/webhook",{
      method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},
      body:JSON.stringify(update)
    });
    assert.equal((await worker.fetch(request,env,{waitUntil(){}})).status,200);
    assert(raced);
    assert.equal(sql.prepare("SELECT quote_revision FROM orders WHERE id=1").get().quote_revision,2);
    const quoteMessages=sent.filter(x=>x.method==="sendMessage"&&
      x.data.reply_markup?.inline_keyboard?.some(row=>row.some(b=>b.callback_data?.startsWith("qa:"))));
    assert.equal(quoteMessages.length,0,"must not deliver a stale quote with another revision");
  }finally{globalThis.fetch=old;sql.close()}
});

test('two simultaneous final checkout messages must create one order',async()=>{
  const storage=database();
  const env={DB:storage,BOT_TOKEN:"123:demo_test_token_not_real",WEBHOOK_SECRET:"test-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  const sql=storage.raw;
  sql.prepare("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Demo')").run();
  sql.prepare("INSERT INTO cart_items(customer_id,variant_id,quantity) VALUES(1,1,1)").run();
  const old=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  let seq=200;
  const call=async(evt)=>{
    const req=new Request("https://example.com/webhook",{
      method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},
      body:JSON.stringify(evt)
    });
    return worker.fetch(req,env,{waitUntil(){}});
  };
  try{
    await call(makeCallback(seq++,"checkout"));
    await call(makeUpdate(seq++,{text:"Buyer"}));
    await call(makeUpdate(seq++,{text:"@buyer"}));
    const pair=await Promise.all([
      call(makeUpdate(seq++,{text:"Самовывоз"})),
      call(makeUpdate(seq++,{text:"Самовывоз"}))
    ]);
    assert.deepEqual(pair.map(r=>r.status),[200,200]);
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM orders WHERE kind='catalog'").get().n,1,
      "two simultaneous checkout updates must not create two orders");
    assert.equal(sql.prepare("SELECT stock FROM variants WHERE id=1").get().stock,4);
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM order_items").get().n,1);
  }finally{globalThis.fetch=old;sql.close()}
});
