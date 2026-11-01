import {demoMode} from "./auth.js";
import {managerUrl,orderDraft,customDraft,managerKeyboard} from "./manager.js";

/**
 * At-least-once delivery: a crash between Telegram's reply and the commit below
 * can repeat one message, but a committed order never loses its notification.
 */
const MAX_ATTEMPTS=12;
const LEASE_SECONDS=60;
const BACKOFF_MAX_MINUTES=360;

const adminIds=env=>String(env.ADMIN_IDS||"").split(",").map(x=>Number(x.trim())).filter(x=>Number.isSafeInteger(x)&&x>0);
const rubles=cents=>(Number(cents||0)/100).toLocaleString("ru-RU",{maximumFractionDigits:2})+" ₽";

/** Statements for the order's own batch. orderIdSql must resolve inside that transaction. */
export function outboxStatements(db,env,kind,customerTelegramId,orderIdSql,orderIdBinds){
  const recipients=[[kind+"_customer",customerTelegramId],
    ...adminIds(env).filter(id=>id!==customerTelegramId).map(id=>[kind+"_admin",id])];
  return recipients.map(([eventType,recipient])=>db.prepare(
    "INSERT OR IGNORE INTO notification_outbox(event_type,order_id,recipient_id) VALUES(?,("+orderIdSql+"),?)"
  ).bind(eventType,...orderIdBinds,recipient));
}

async function render(env,row){
  const demo=demoMode(env);
  const order=await env.DB.prepare("SELECT id,kind,total_cents FROM orders WHERE id=?").bind(row.order_id).first();
  if(!order)return null;
  if(row.event_type==="catalog_customer"){
    if(demo)return {text:"Тестовый заказ №"+order.id+" создан. Оплата не проводилась."};
    const items=(await env.DB.prepare("SELECT product_name AS name,size,color,quantity FROM order_items WHERE order_id=? ORDER BY id").bind(order.id).all()).results||[];
    return {text:"Заказ №"+order.id+" принят на сумму "+rubles(order.total_cents)+". Оплату и получение согласуйте с менеджером в личных сообщениях.",
      reply_markup:managerKeyboard(managerUrl(env,orderDraft(order.id,items,order.total_cents)))};
  }
  if(row.event_type==="catalog_admin")
    return {text:(demo?"Новый демо-заказ №":"Новый заказ №")+order.id+" (каталог), сумма "+rubles(order.total_cents)+"\n/admin — управление"};
  if(row.event_type==="custom_customer"){
    if(demo)return {text:"Тестовая заявка на индивидуальный пошив №"+order.id+" получена. Цену и сроки согласует менеджер."};
    return {text:"Заявка на индивидуальный пошив №"+order.id+" получена. Цену и сроки согласует менеджер.",
      reply_markup:managerKeyboard(managerUrl(env,customDraft(order.id)))};
  }
  if(row.event_type==="custom_admin")
    return {text:(demo?"Новая демо-заявка на пошив №":"Новая заявка на пошив №")+order.id+"\n/admin — управление"};
  return null;
}

async function sendTelegram(env,chatId,message){
  const response=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendMessage",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text:message.text,...(message.reply_markup?{reply_markup:message.reply_markup}:{})})
  });
  if(response.ok)return "delivered";
  // A blocked bot or a deleted chat will not recover on its own; 429 and 5xx will.
  return response.status>=400&&response.status<500&&response.status!==429?"rejected":"retry";
}

/** Delivers due rows; a concurrent webhook and Cron cannot claim the same row. */
export async function deliverOutbox(env,{orderId=null,limit=20}={}){
  const summary={delivered:0,retried:0,failed:0};
  if(!env.DB||!env.BOT_TOKEN)return summary;
  const due=(await env.DB.prepare(
    "SELECT id,event_type,order_id,recipient_id,attempts FROM notification_outbox "+
    "WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at<=datetime('now') "+
    "AND (lease_until IS NULL OR lease_until<datetime('now')) AND (?1 IS NULL OR order_id=?1) ORDER BY id LIMIT ?2"
  ).bind(orderId,limit).all()).results||[];
  for(const row of due){
    const claim=await env.DB.prepare(
      "UPDATE notification_outbox SET attempts=attempts+1,lease_until=datetime('now','+"+LEASE_SECONDS+" seconds') "+
      "WHERE id=? AND delivered_at IS NULL AND failed_at IS NULL AND (lease_until IS NULL OR lease_until<datetime('now'))"
    ).bind(row.id).run();
    if(claim.meta.changes!==1)continue;
    let outcome;
    try{
      const message=await render(env,row);
      outcome=message?await sendTelegram(env,row.recipient_id,message):"rejected";
    }catch{outcome="retry"}
    const attempts=row.attempts+1;
    if(outcome==="delivered"){
      await env.DB.prepare("UPDATE notification_outbox SET delivered_at=datetime('now'),lease_until=NULL WHERE id=?").bind(row.id).run();
      summary.delivered++;
    }else if(outcome==="rejected"||attempts>=MAX_ATTEMPTS){
      await env.DB.prepare("UPDATE notification_outbox SET failed_at=datetime('now'),lease_until=NULL WHERE id=?").bind(row.id).run();
      summary.failed++;
    }else{
      const minutes=Math.min(2**attempts,BACKOFF_MAX_MINUTES);
      await env.DB.prepare("UPDATE notification_outbox SET next_attempt_at=datetime('now','+"+minutes+" minutes'),lease_until=NULL WHERE id=?").bind(row.id).run();
      summary.retried++;
    }
  }
  return summary;
}

export async function outboxHealth(db){
  const row=await db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN delivered_at IS NULL AND failed_at IS NULL THEN 1 ELSE 0 END),0) AS pending,"+
    "COALESCE(SUM(CASE WHEN failed_at IS NOT NULL THEN 1 ELSE 0 END),0) AS failed FROM notification_outbox"
  ).first();
  return {pending:Number(row?.pending||0),failed:Number(row?.failed||0)};
}
