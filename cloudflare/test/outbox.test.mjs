import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {deliverOutbox,outboxStatements,outboxHealth} from "../src/outbox.js";
import {encryptBackup,decryptBackup} from "../../scripts/d1-backup.mjs";

const bound=(stmt,v=[])=>({
  first:async()=>stmt.get(...v)??null,
  all:async()=>({results:stmt.all(...v)}),
  run:async()=>{const r=stmt.run(...v);return {meta:{changes:Number(r.changes)}}}
});
const wrap=stmt=>({...bound(stmt),bind:(...v)=>bound(stmt,v)});
function makeEnv(){
  const db=new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0005_notification_outbox.sql",import.meta.url),"utf8"));
  db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY,kind TEXT,total_cents INTEGER,contact_name TEXT,contact_phone TEXT,delivery_address TEXT,custom_details TEXT,custom_measurements TEXT);CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER,product_name TEXT,size TEXT,color TEXT,quantity INTEGER);");
  db.exec("INSERT INTO orders(id,kind,total_cents) VALUES(7,'catalog',500000);INSERT INTO order_items VALUES(1,7,'Жакет','M','чёрный',1);");
  const DB={prepare:sql=>wrap(db.prepare(sql))};
  return {db,env:{DB,BOT_TOKEN:"t",ADMIN_IDS:"100,200",DEMO_MODE:"0",STORE_READY:"1",MANAGER_USERNAME:"seller_01"}};
}
async function queue(env,customer=100){
  for(const s of outboxStatements(env.DB,env,"catalog",customer,"SELECT ?",[7]))await s.run();
}
function withFetch(handler,work){
  const original=globalThis.fetch;
  globalThis.fetch=handler;
  return work().finally(()=>{globalThis.fetch=original});
}

test("the customer who is also an admin gets one message, other admins are queued",async()=>{
  const {db,env}=makeEnv();
  await queue(env);
  assert.deepEqual(db.prepare("SELECT event_type,recipient_id FROM notification_outbox ORDER BY id").all().map(x=>[x.event_type,x.recipient_id]),
    [["catalog_customer",100],["catalog_admin",200]]);
  await queue(env);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_outbox").get().n,2,"retried order must not duplicate events");
});

test("a Bot API outage loses nothing: the message is retried and sent once",async()=>{
  const {db,env}=makeEnv();
  await queue(env);
  const bodies=[];
  await withFetch(async()=>new Response("{}",{status:502}),async()=>{
    assert.deepEqual(await deliverOutbox(env),{delivered:0,retried:2,failed:0});
  });
  assert.equal((await outboxHealth(env.DB)).pending,2);
  await withFetch(async()=>{throw new Error("network")},async()=>{
    assert.equal((await deliverOutbox(env)).delivered,0,"backoff keeps rows out until they are due");
  });
  db.exec("UPDATE notification_outbox SET next_attempt_at=datetime('now','-1 minute')");
  await withFetch(async(_,init)=>{bodies.push(JSON.parse(init.body));return new Response("{}")},async()=>{
    assert.equal((await deliverOutbox(env)).delivered,2);
    assert.equal((await deliverOutbox(env)).delivered,0,"delivered rows are never sent again");
  });
  assert.equal(bodies.length,2);
  const button=bodies[0].reply_markup.inline_keyboard[0][0];
  assert.match(button.url,/^https:\/\/t\.me\/seller_01\?text=/);
  assert.match(decodeURIComponent(button.url),/Жакет, M, чёрный × 1/);
  assert.deepEqual(await outboxHealth(env.DB),{pending:0,failed:0});
});

test("the seller's notification carries the order, the buyer's contact and action buttons",async()=>{
  const {db,env}=makeEnv();
  db.exec("UPDATE orders SET contact_name='Анна',contact_phone='@anna',delivery_address='18 ноября, 15:00' WHERE id=7");
  await queue(env);
  const bodies=[];
  await withFetch(async(_,init)=>{bodies.push(JSON.parse(init.body));return new Response("{}")},async()=>{await deliverOutbox(env)});
  const seller=bodies.find(x=>x.chat_id===200);
  assert.match(seller.text,/Жакет, M, чёрный × 1/);
  assert.match(seller.text,/@anna/);
  assert.match(seller.text,/18 ноября, 15:00/);
  assert.deepEqual(seller.reply_markup.inline_keyboard.flat().map(x=>x.callback_data),["st:7:confirmed","stc:7"]);
});

test("network errors are retried, permanent refusals and exhausted rows stop",async()=>{
  const {db,env}=makeEnv();
  await queue(env);
  await withFetch(async()=>new Response("{}",{status:403}),async()=>{
    assert.equal((await deliverOutbox(env)).failed,2,"a blocked bot will not recover by retrying");
  });
  db.exec("DELETE FROM notification_outbox");
  await queue(env);
  db.exec("UPDATE notification_outbox SET attempts=11");
  await withFetch(async()=>{throw new Error("network")},async()=>{
    assert.equal((await deliverOutbox(env)).failed,2);
  });
  assert.equal((await outboxHealth(env.DB)).failed,2);
});

test("a live lease stops a second worker from sending the same row",async()=>{
  const {db,env}=makeEnv();
  await queue(env);
  db.exec("UPDATE notification_outbox SET lease_until=datetime('now','+1 minute')");
  let calls=0;
  await withFetch(async()=>{calls++;return new Response("{}")},async()=>{await deliverOutbox(env)});
  assert.equal(calls,0);
  db.exec("UPDATE notification_outbox SET lease_until=datetime('now','-1 minute')");
  await withFetch(async()=>{calls++;return new Response("{}")},async()=>{await deliverOutbox(env)});
  assert.equal(calls,2,"an expired lease from a crashed worker is taken over");
});

test("backup archive round-trips and refuses a wrong key or tampering",()=>{
  const plain=Buffer.from("CREATE TABLE заказы(id);");
  const archive=encryptBackup(plain,"correct horse");
  assert.ok(!archive.includes(plain),"archive must not contain plain SQL");
  assert.deepEqual(decryptBackup(archive,"correct horse"),plain);
  assert.throws(()=>decryptBackup(archive,"wrong"));
  const broken=Buffer.from(archive);broken[broken.length-1]^=1;
  assert.throws(()=>decryptBackup(broken,"correct horse"));
  assert.throws(()=>decryptBackup(plain,"correct horse"),/Not an Atelier backup/);
});
