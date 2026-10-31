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
