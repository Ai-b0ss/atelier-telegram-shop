import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

function database(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../seed.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../migrations/0001_order_status_triggers.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_miniapp.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_store_readiness.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../migrations/0004_shipped_return.sql',import.meta.url),'utf8'));
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
    assert.equal(c.prepare("SELECT COUNT(*) AS n FROM orders").get().n,0,
      "failed inventory batch must not persist a phantom order with contact data");
    assert.equal(c.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5,
      "available item must not be deducted when second item fails");
    assert.equal(c.prepare("SELECT stock FROM variants WHERE id=2").get().stock,0);
    assert.equal(c.prepare("SELECT COUNT(*) n FROM order_items").get().n,0);
    assert.equal(c.prepare("SELECT COUNT(*) n FROM cart_items").get().n,2);
    assert(deliveries.some(e=>e.method==="sendMessage"&&e.data.text?.includes("Заказ не оформлен")));
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

test('cancellation trigger restores each SKU exactly once and records one transition',async()=>{
  const storage=database(),sql=storage.raw;
  sql.prepare("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Test')").run();
  sql.prepare("INSERT INTO orders(id,customer_id,kind,status) VALUES(1,1,'catalog','new')").run();
  sql.prepare("INSERT INTO order_items(order_id,variant_id,product_name,size,color,quantity,unit_price_cents,unit_cost_cents) VALUES(1,1,'Bag','one size','beige',2,250000,100000),(1,2,'Tshirt','S','white',3,300000,140000)").run();
  sql.prepare("UPDATE variants SET stock=stock-2 WHERE id=1").run();
  sql.prepare("UPDATE variants SET stock=stock-3 WHERE id=2").run();
  const original = [sql.prepare("SELECT stock FROM variants WHERE id=1").get().stock,sql.prepare("SELECT stock FROM variants WHERE id=2").get().stock];
  assert.deepEqual(original,[3,5]);
  sql.prepare("UPDATE orders SET status='canceled' WHERE id=1 AND status='new'").run();
  assert.deepEqual([sql.prepare("SELECT stock FROM variants WHERE id=1").get().stock,sql.prepare("SELECT stock FROM variants WHERE id=2").get().stock],[5,8]);
  sql.prepare("UPDATE orders SET status='canceled' WHERE id=1").run();
  assert.deepEqual([sql.prepare("SELECT stock FROM variants WHERE id=1").get().stock,sql.prepare("SELECT stock FROM variants WHERE id=2").get().stock],[5,8]);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM status_history WHERE order_id=1").get().n,1);
  sql.prepare("INSERT INTO orders(id,customer_id,kind,status) VALUES(2,1,'custom','new')").run();
  sql.prepare("UPDATE orders SET status='canceled' WHERE id=2").run();
  assert.equal(sql.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5,"custom cancellation must not touch stock");
  storage.raw.close();
});

test('cancellation remains atomic if stock update is prevented by database constraint',async()=>{
  const storage=database(),sql=storage.raw;
  sql.prepare("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Test')").run();
  sql.prepare("INSERT INTO orders(id,customer_id,kind,status) VALUES(1,1,'catalog','new')").run();
  sql.prepare("INSERT INTO order_items(order_id,variant_id,product_name,size,color,quantity,unit_price_cents,unit_cost_cents) VALUES(1,1,'Bag','one size','beige',2,250000,100000)").run();
  sql.exec("CREATE TRIGGER force_restoration_failure BEFORE UPDATE OF stock ON variants WHEN NEW.stock > OLD.stock BEGIN SELECT RAISE(ABORT, 'fault injection'); END;");
  assert.throws(()=>sql.prepare("UPDATE orders SET status='canceled' WHERE id=1").run(),/fault injection/);
  assert.equal(sql.prepare("SELECT status FROM orders WHERE id=1").get().status,'new',
    "status change must roll back with stock");
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM status_history WHERE order_id=1").get().n,0);
  storage.raw.close();
});

test('Telegram photo reference is captured in tailoring application',async()=>{
  const storage=database(),env={DB:storage,BOT_TOKEN:"123:demo_test_token_not_real",WEBHOOK_SECRET:"secret-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  const old=globalThis.fetch;
  const send=[];
  globalThis.fetch=async(url,opts)=>{send.push({method:String(url).split("/").pop(),body:JSON.parse(opts.body)});return Response.json({ok:true,result:true})};
  let n=300;
  const call=async(update)=>{
    const req=new Request("https://example.com/webhook",{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},body:JSON.stringify(update)});
    return worker.fetch(req,env,{waitUntil(){}});
  };
  try{
    await call(makeCallback(n++,"custom"));
    const photo=makeUpdate(n++,{text:""});
    delete photo.message.text;
    photo.message.photo=[{file_id:"TINY_REFERENCE",width:100,height:100},{file_id:"LARGE_REFERENCE",width:1000,height:800}];
    assert.equal((await call(photo)).status,200);
    for(const t of ["Хочу пальто из мягкой ткани","Рост 185, размер 50","Demo Person","@demo","Самовывоз"]){
      assert.equal((await call(makeUpdate(n++,{text:t}))).status,200);
    }
    const order=storage.raw.prepare("SELECT id FROM orders WHERE kind='custom' ORDER BY id DESC LIMIT 1").get();
    assert(order);
    const attaches=storage.raw.prepare("SELECT telegram_file_id FROM custom_attachments WHERE order_id=?").all(order.id);
    assert.deepEqual(attaches.map(a=>a.telegram_file_id),["LARGE_REFERENCE"]);
    assert(send.some(s=>s.method==="sendMessage"&&s.body.text?.includes("Референс")));
  }finally{globalThis.fetch=old;storage.raw.close()}
});

test('admin uploads a product photo via Telegram and media proxy protects bot token',async()=>{
  const storage=database(),env={DB:storage,BOT_TOKEN:"123:demo_test_token_not_real",WEBHOOK_SECRET:"secret-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  const old=globalThis.fetch;
  const seen=[];
  globalThis.fetch=async(url,opts)=>{
    seen.push(String(url).split("/").pop());
    if(String(url).endsWith("/getFile"))return Response.json({ok:true,result:{file_path:"photos/file_123.jpg",file_size:3}});
    if(String(url).includes("/file/bot"))return new Response(new Uint8Array([255,216,255]),{headers:{"Content-Type":"image/jpeg"}});
    return Response.json({ok:true,result:true});
  };
  let n=510;
  const call=async(update)=>{
    const req=new Request("https://example.com/webhook",{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},body:JSON.stringify(update)});
    return worker.fetch(req,env,{waitUntil(){}});
  };
  try{
    const result=await call(makeUpdate(n++,{text:"/photo 1"}));
    assert.equal(result.status,200);
    const photo=makeUpdate(n++,{text:""});delete photo.message.text;
    photo.message.photo=[{file_id:"TELEGRAM-PRODUCT-FILE-ID-12345",width:400,height:400}];
    assert.equal((await call(photo)).status,200);
    assert.equal(storage.raw.prepare("SELECT photo_file_id FROM products WHERE id=1").get().photo_file_id,"TELEGRAM-PRODUCT-FILE-ID-12345");
    const image=await worker.fetch(new Request("https://example.com/media/product/1"),env,{});
    assert.equal(image.status,200);
    assert.equal(image.headers.get("Content-Type"),"image/jpeg");
    assert(!Array.from(image.headers.values()).join(" ").includes(env.BOT_TOKEN));
    assert.deepEqual(Array.from(new Uint8Array(await image.arrayBuffer())),[255,216,255]);
  }finally{globalThis.fetch=old;storage.raw.close()}
});

test('scheduled cleanup removes old Telegram technical records but retains orders',async()=>{
  const storage=database(),db=storage.raw;
  db.exec("INSERT INTO processed_updates(update_id,processed_at) VALUES(1,datetime('now','-20 days')),(2,datetime('now'));");
  db.exec("INSERT INTO sessions(telegram_id,flow,step,payload,updated_at) VALUES(111,'custom','name','{}',datetime('now','-45 days')),(222,'custom','name','{}',datetime('now'));");
  db.exec("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'test')");
  db.exec("INSERT INTO orders(id,customer_id,kind,status) VALUES(1,1,'custom','new')");
  db.exec("INSERT INTO checkout_requests(telegram_id,request_key,order_id,created_at) VALUES(777,'oldkey',1,datetime('now','-100 days')),(777,'newkey',1,datetime('now'));");
  await worker.scheduled({scheduledTime:Date.now()},{DB:storage},{});
  assert.deepEqual(db.prepare("SELECT update_id FROM processed_updates ORDER BY update_id").all().map(x=>x.update_id),[2]);
  assert.deepEqual(db.prepare("SELECT telegram_id FROM sessions").all().map(x=>x.telegram_id),[222]);
  assert.deepEqual(db.prepare("SELECT request_key FROM checkout_requests").all().map(x=>x.request_key),["newkey"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders").get().n,1);
  storage.raw.close();
});

test('forgetme removes photos and tailoring measurements from completed records',async()=>{
  const storage=database(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:"123:demo_test_token_not_real",WEBHOOK_SECRET:"secret-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  const old=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  const call=async(up)=>{
    const req=new Request("https://example.com/webhook",{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},body:JSON.stringify(up)});
    return worker.fetch(req,env,{waitUntil(){}});
  };
  try{
    db.prepare("INSERT INTO customers(id,telegram_id,full_name,username) VALUES(1,777,'Demo','demo')").run();
    db.prepare("INSERT INTO orders(id,customer_id,kind,status,contact_name,contact_phone,custom_details,custom_measurements) VALUES(1,1,'custom','completed','Demo','@demo','Wool jacket','Chest 100')").run();
    db.prepare("INSERT INTO custom_attachments(order_id,telegram_file_id) VALUES(1,'TELEGRAM_IMAGE_FILE')").run();
    assert.equal((await call(makeUpdate(811,{text:"/forgetme"}))).status,200);
    const order=db.prepare("SELECT contact_name,contact_phone,custom_details,custom_measurements FROM orders WHERE id=1").get();
    assert.equal(order.contact_name,"");
    assert.equal(order.contact_phone,"");
    assert.equal(order.custom_details,"");
    assert.equal(order.custom_measurements,"");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM custom_attachments").get().n,0);
  }finally{globalThis.fetch=old;db.close()}
});

test('shipped cancellation requires a physical inventory return and cannot duplicate the receipt',async()=>{
 const storage=database(),db=storage.raw;
 db.prepare("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Admin')").run();
 db.prepare("INSERT INTO orders(id,customer_id,kind,status) VALUES(1,1,'catalog','new')").run();
 db.prepare("INSERT INTO order_items(order_id,variant_id,product_name,size,color,quantity,unit_price_cents,unit_cost_cents) VALUES(1,1,'Bag','one size','beige',2,250000,100000),(1,2,'Shirt','M','white',3,350000,170000)").run();
 db.exec("UPDATE variants SET stock=stock-2 WHERE id=1");
 db.exec("UPDATE variants SET stock=stock-3 WHERE id=2");
 for(const status of ["confirmed","in_production","ready","shipped"])db.prepare("UPDATE orders SET status=? WHERE id=1").run(status);
 const expected=[3,5];
 db.exec("UPDATE orders SET status='canceled' WHERE id=1");
 assert.deepEqual([db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,db.prepare("SELECT stock FROM variants WHERE id=2").get().stock],expected,
  "shipped items must not return to warehouse merely because order was cancelled");
 assert.throws(()=>db.prepare("INSERT INTO inventory_return_receipts(order_id,accepted_by,note) VALUES(99,777,'Missing')").run(),/FOREIGN KEY|Physical return|constraint/i);
 const result=db.prepare("INSERT INTO inventory_return_receipts(order_id,accepted_by,note) VALUES(1,777,'Received and counted')").run();
 assert(result.changes===1);
 assert.deepEqual([db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,db.prepare("SELECT stock FROM variants WHERE id=2").get().stock],[5,8]);
 assert.throws(()=>db.prepare("INSERT INTO inventory_return_receipts(order_id,accepted_by,note) VALUES(1,777,'Second attempt')").run(),/UNIQUE/);
 assert.deepEqual([db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,db.prepare("SELECT stock FROM variants WHERE id=2").get().stock],[5,8]);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_return_receipts WHERE order_id=1").get().n,1);
 db.close();
});
test('unshipped canceled order restocks automatically and cannot be manually returned again',()=>{
 const storage=database(),db=storage.raw;
 db.exec("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Admin')");
 db.exec("INSERT INTO orders(id,customer_id,kind,status) VALUES(1,1,'catalog','new')");
 db.exec("INSERT INTO order_items(order_id,variant_id,product_name,size,color,quantity,unit_price_cents,unit_cost_cents) VALUES(1,1,'Bag','one size','beige',2,250000,100000)");
 db.exec("UPDATE variants SET stock=stock-2 WHERE id=1");
 db.exec("UPDATE orders SET status='canceled' WHERE id=1");
 assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
 assert.throws(()=>db.exec("INSERT INTO inventory_return_receipts(order_id,accepted_by,note) VALUES(1,777,'Wrong')"),/Physical return/);
 assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
 db.close();
});


test('Telegram checkout rejects partial cart when a variant is archived',async()=>{
  const storage=database(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:"fixture-test-token-not-real",WEBHOOK_SECRET:"fixture-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  db.exec("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Synthetic buyer')");
  db.exec("INSERT INTO cart_items(customer_id,variant_id,quantity) VALUES(1,1,1),(1,2,1)");
  db.exec("UPDATE variants SET active=0 WHERE id=2");
  const sent=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    sent.push({url:String(url),body:JSON.parse(options.body)});
    return Response.json({ok:true,result:true});
  };
  const send=async update=>{
    const req=new Request("https://example.com/webhook",{
      method:"POST",
      headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},
      body:JSON.stringify(update)
    });
    return worker.fetch(req,env,{waitUntil(){}});
  };
  try{
    assert.equal((await send(makeCallback(6001,"checkout"))).status,200);
    for(const [i,text] of ["Demo Buyer","@demo","Самовывоз"].entries())
      assert.equal((await send(makeUpdate(6002+i,{text}))).status,200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cart_items").get().n,2);
    assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
    assert.equal(db.prepare("SELECT stock FROM variants WHERE id=2").get().stock,8);
    assert(sent.some(x=>x.body?.text?.includes("недоступ")),
      "buyer must receive a clear warning about unavailable items");
  }finally{globalThis.fetch=originalFetch;db.close()}
});


test("two simultaneous manual refunds cannot exceed the received amount",async()=>{
  const storage=database(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:"fixture-token-not-real",WEBHOOK_SECRET:"fixture-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  db.exec("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Test')");
  db.exec("INSERT INTO orders(id,customer_id,kind,status) VALUES(1,1,'custom','new')");
  db.exec("INSERT INTO payments(order_id,kind,amount_cents,reference) VALUES(1,'received',10000,'FAKE-ORIGINAL')");
  const base=storage.prepare.bind(storage);let arrivals=0,release;
  const gate=new Promise(r=>{release=r});
  storage.prepare=sql=>{
    const stmt=base(sql);
    if(sql.startsWith("SELECT kind,amount_cents FROM payments WHERE order_id=")){
      const old=stmt.all.bind(stmt);
      stmt.all=async()=>{
        const result=await old();
        if(++arrivals===2)release();
        await gate;
        return result;
      };
    }
    return stmt;
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  const call=async(id,ref)=>{
    const req=new Request("https://example.test/webhook",{
      method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},
      body:JSON.stringify(makeUpdate(id,{text:"/payment 1 refunded 80 "+ref}))
    });
    return worker.fetch(req,env,{waitUntil(){}});
  };
  try{
    const rs=await Promise.all([call(77001,"FAKE-REF-1"),call(77002,"FAKE-REF-2")]);
    assert(rs.every(x=>x.status===200));
    const total=db.prepare("SELECT SUM(CASE WHEN kind='received' THEN amount_cents ELSE -amount_cents END) AS n FROM payments WHERE order_id=1").get().n;
    assert(total>=0,"two accepted refund requests cannot push the ledger negative");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payments WHERE kind='refunded'").get().n,1);
  }finally{globalThis.fetch=originalFetch;db.close()}
});


test("Excel summary reports complete history when order and payment tabs are capped",async()=>{
  const storage=database(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:"fixture-token-not-real",WEBHOOK_SECRET:"fixture-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  db.exec("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Synthetic accountant')");
  db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1005) "+
    "INSERT INTO orders(id,customer_id,kind,status,total_cents,cost_cents) SELECT i,1,'custom','new',100,50 FROM n");
  db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1005) "+
    "INSERT INTO payments(order_id,kind,amount_cents,reference) SELECT 1,'received',10,'' FROM n");
  let xlsx=null;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(String(url).endsWith("/sendDocument"))
      xlsx=Buffer.from(await options.body.get("document").arrayBuffer());
    return Response.json({ok:true,result:true});
  };
  try{
    const req=new Request("https://example.test/webhook",{
      method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},
      body:JSON.stringify(makeUpdate(99001,{text:"/report"}))
    });
    assert.equal((await worker.fetch(req,env,{waitUntil(){}})).status,200);
    assert(xlsx,"Expected a generated real XLSX file");
    // This XLSX writer uses stored (uncompressed) ZIP entries, so the sheet
    // XML appears in the buffer and can be inspected without extra packages.
    const raw=xlsx.toString("utf8");
    assert.match(raw,/Количество заказов<\/t><\/is><\/c><c r="B2" t="n"><v>1005<\/v>/);
    assert.match(raw,/Чистые поступления \(коп\.\)<\/t><\/is><\/c><c r="B3" t="n"><v>10050<\/v>/);
  }finally{globalThis.fetch=originalFetch;db.close()}
});


test("Telegram checkout preserves cart additions made before its stock transaction",async()=>{
  const storage=database(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:"fixture-token-not-real",WEBHOOK_SECRET:"fixture-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  db.exec("INSERT INTO customers(id,telegram_id,full_name) VALUES(1,777,'Test')");
  db.exec("INSERT INTO cart_items(customer_id,variant_id,quantity) VALUES(1,1,1)");
  const originalBatch=storage.batch.bind(storage);
  let raced=false;
  storage.batch=async commands=>{
    if(!raced){
      raced=true;
      db.exec("INSERT INTO cart_items(customer_id,variant_id,quantity) VALUES(1,2,1)");
    }
    return originalBatch(commands);
  };
  const originalFetch=globalThis.fetch;
  const sent=[];
  globalThis.fetch=async(url,opts)=>{
    sent.push({url:String(url),body:JSON.parse(opts.body)});
    return Response.json({ok:true,result:true});
  };
  const dispatch=async update=>{
    const req=new Request("https://example.test/webhook",{
      method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},
      body:JSON.stringify(update)
    });
    return worker.fetch(req,env,{waitUntil(){}});
  };
  try{
    assert.equal((await dispatch(makeCallback(88001,"checkout"))).status,200);
    for(const [i,text] of ["Synthetic Client","@synthetic","Самовывоз"].entries())
      assert.equal((await dispatch(makeUpdate(88002+i,{text}))).status,200);
    assert.equal(raced,true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cart_items").get().n,2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_items").get().n,0);
    assert.equal(db.prepare("SELECT stock FROM variants WHERE id=1").get().stock,5);
    assert(sent.some(x=>x.body?.text?.includes("Заказ не оформлен")),
      "buyer must be warned of an interrupted checkout");
  }finally{globalThis.fetch=originalFetch;db.close()}
});


test("forgetme unlinks Telegram identity and clears hidden cart/session/idempotency data",async()=>{
  const storage=database(),db=storage.raw;
  const env={DB:storage,BOT_TOKEN:"fixture-token-not-real",WEBHOOK_SECRET:"fixture-"+"x".repeat(35),ADMIN_IDS:"777",DEMO_MODE:"1"};
  db.exec("INSERT INTO customers(id,telegram_id,full_name,username) VALUES(1,777,'Real Name','username')");
  db.exec("INSERT INTO orders(id,customer_id,kind,status,contact_name,contact_phone,delivery_address) VALUES(1,1,'catalog','completed','Real Name','@username','Address')");
  db.exec("INSERT INTO checkout_requests(telegram_id,request_key,order_id) VALUES(777,'old_key_1234567890',1)");
  db.exec("INSERT INTO cart_items(customer_id,variant_id,quantity) VALUES(1,1,1)");
  db.exec("INSERT INTO sessions(telegram_id,flow,step,payload) VALUES(777,'custom','details','{}')");
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  try{
    const req=new Request("https://example.test/webhook",{
      method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},
      body:JSON.stringify(makeUpdate(121001,{text:"/forgetme"}))
    });
    assert.equal((await worker.fetch(req,env,{waitUntil(){}})).status,200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers WHERE telegram_id=777").get().n,0,
      "a completed customer should no longer be linked to Telegram ID after forgetting");
    assert.equal(db.prepare("SELECT telegram_id FROM customers WHERE id=1").get().telegram_id,-1,
      "keep internal order link but replace externally identifying Telegram ID");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checkout_requests WHERE telegram_id=777").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE telegram_id=777").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE customer_id=1").get().n,0);
    const order=db.prepare("SELECT contact_name,contact_phone,delivery_address FROM orders WHERE id=1").get();
    assert.equal(order.contact_name,"");
    assert.equal(order.contact_phone,"");
    assert.equal(order.delivery_address,"");
  }finally{globalThis.fetch=oldFetch;db.close()}
});
