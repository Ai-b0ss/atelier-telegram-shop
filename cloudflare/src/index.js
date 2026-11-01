import { makeXlsx } from "./xlsx.js";
import { handleApi } from "./api.js";
import { demoMode } from "./auth.js";
import { outboxStatements, deliverOutbox } from "./outbox.js";

const statuses = ["new","confirmed","in_production","ready","shipped","completed","canceled"];
const nextStatuses = {
  new:["confirmed","canceled"], confirmed:["in_production","ready","canceled"],
  in_production:["ready","canceled"],ready:["shipped","completed","canceled"],
  shipped:["completed","canceled"],completed:[],canceled:[]
};
const ru={new:"Новый",confirmed:"Подтверждён",in_production:"В работе",ready:"Готов",shipped:"Отправлен",completed:"Завершён",canceled:"Отменён"};
const rub=n=>(Number(n||0)/100).toLocaleString("ru-RU",{minimumFractionDigits:2,maximumFractionDigits:2})+" ₽";
const adminIds=env=>new Set(String(env.ADMIN_IDS||"").split(",").map(s=>Number(s.trim())).filter(Number.isSafeInteger));
const demo=demoMode;
const rows=async(db,q,...values)=>(await db.prepare(q).bind(...values).all()).results||[];
const first=async(db,q,...values)=>await db.prepare(q).bind(...values).first();
const run=async(db,q,...values)=>await db.prepare(q).bind(...values).run();
const kb=(entries)=>({inline_keyboard:entries.map(([text,data])=>[{text,callback_data:data}])});
const safeInt=v=>/^[1-9][0-9]{0,10}$/.test(String(v||""))?Number(v):null;
const money=v=>{
  const s=String(v||"").replace(",",".");
  if(!/^\d{1,8}(?:\.\d{1,2})?$/.test(s))return null;
  const [a,b=""]=s.split("."); return Number(a)*100+Number((b+"00").slice(0,2));
};
const textLimit=(s,n)=>String(s||"").trim().slice(0,n);
const SHOP="https://atelier-customwear-demo-2026.igorekglukhovskii43.workers.dev";
const PICKUP_ASK="Когда удобно забрать вещь у метро Беляево? Напишите дату и время, например: 18 ноября, 15:00.";
const COMMANDS=[
  ["start","Главное меню"],["catalog","Каталог с фото"],["cart","Корзина"],["orders","Мои заказы"],
  ["custom","Заказать пошив"],["reviews","Отзывы покупателей"],["help","Что умеет бот"],["privacy","Данные и условия"],["cancel","Отменить ввод"]
];
const HELP="Что можно сделать:\n\n/catalog — посмотреть вещи с фото и выбрать размер\n/cart — корзина и оформление заказа\n/custom — заказать пошив по своей идее\n/orders — ваши заказы\n/reviews — отзывы покупателей\n/privacy — данные и условия\n/cancel — отменить ввод\n\nОплату и встречу у метро Беляево вы согласуете с менеджером в Telegram: @onlyrazor.";
const MENU={"🛍 Каталог":"catalog","🧺 Корзина":"cart","✂️ Пошив":"custom","📦 Мои заказы":"orders","⭐ Отзывы":"reviews","💬 Менеджер":"manager","❓ Помощь":"help"};
const MENU_KEYBOARD={keyboard:[["🛍 Каталог","🧺 Корзина"],["✂️ Пошив","📦 Мои заказы"],["⭐ Отзывы","💬 Менеджер"],["❓ Помощь"]].map(row=>row.map(text=>({text}))),
  resize_keyboard:true,is_persistent:true,input_field_placeholder:"Выберите раздел внизу"};
const chatPhoto=path=>SHOP+String(path).replace(/\.webp$/,".jpg");
const firstImage=p=>{try{return JSON.parse(p.images||"[]")[0]||null}catch{return null}};
export function makeHandler(env) {
  const db=env.DB, admins=adminIds(env);
  async function api(method,payload){
    const r=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/"+method,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(payload)
    });
    const j=await r.json();
    if(!r.ok||!j.ok)throw new Error("Telegram method "+method+" failed: "+r.status);
    return j.result;
  }
  const send=(id,text,reply_markup)=>api("sendMessage",{chat_id:id,text:String(text).slice(0,4000),...(reply_markup?{reply_markup}:{})});
  const answer=(id,text="",show_alert=false)=>api("answerCallbackQuery",{callback_query_id:id,text,show_alert});
  const notify=async(text)=>{
    for(const id of admins){try{await send(id,text)}catch(e){console.warn("Admin delivery unavailable")}}
  };
  async function customer(u) {
    await run(db,"INSERT INTO customers(telegram_id,full_name,username) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET full_name=excluded.full_name,username=excluded.username",
      u.id,textLimit([u.first_name,u.last_name].filter(Boolean).join(" "),128),textLimit(u.username,64));
    return await first(db,"SELECT id FROM customers WHERE telegram_id=?",u.id);
  }
  const session=async id=>await first(db,"SELECT * FROM sessions WHERE telegram_id=?",id);
  const setSession=async (id,flow,step,data={})=>run(db,
    "INSERT INTO sessions(telegram_id,flow,step,payload) VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET flow=excluded.flow,step=excluded.step,payload=excluded.payload,updated_at=CURRENT_TIMESTAMP",
    id,flow,step,JSON.stringify(data));
  const delSession=id=>run(db,"DELETE FROM sessions WHERE telegram_id=?",id);
  const shopButton=text=>({text,web_app:{url:SHOP+"/app"}});
  const fillButtons=(...rows)=>({inline_keyboard:rows.map(([text,data])=>[{text,callback_data:data}])});
  const contactButtons=u=>u.username?fillButtons(["Использовать мой Telegram @"+u.username,"fill:tg"]):undefined;
  const nameButtons=u=>u.first_name?fillButtons(["Меня зовут "+textLimit(u.first_name,40),"fill:name"]):undefined;
  const pickupButtons=()=>fillButtons(["Договоримся с менеджером","fill:later"]);
  const sendWithPhoto=async(id,path,caption,reply_markup)=>{
    if(path){
      const extra={caption:String(caption).slice(0,1000),...(reply_markup?{reply_markup}:{})};
      const known=await first(db,"SELECT file_id FROM photo_cache WHERE path=?",path);
      if(known){
        try{return await api("sendPhoto",{chat_id:id,photo:known.file_id,...extra})}
        catch{console.warn("Cached photo rejected")}
      }
      try{
        const sent=await api("sendPhoto",{chat_id:id,photo:chatPhoto(path),...extra});
        const fileId=sent?.photo?.at?.(-1)?.file_id;
        if(fileId)await run(db,"INSERT INTO photo_cache(path,file_id) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET file_id=excluded.file_id",path,fileId);
        return sent;
      }catch{console.warn("Product photo unavailable")}
    }
    return send(id,caption,reply_markup);
  };
  async function reviewsMessage(id){
    const list=await rows(db,"SELECT r.author_name,r.rating,r.body,p.name FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.hidden=0 AND p.active=1 ORDER BY r.updated_at DESC LIMIT 5");
    const markup={inline_keyboard:[[shopButton("Все отзывы и новый отзыв")]]};
    if(!list.length)return send(id,"Отзывов пока нет. Ваш может быть первым.",markup);
    return send(id,list.map(x=>"★".repeat(x.rating)+" "+x.name+"\n"+x.body+"\n— "+x.author_name).join("\n\n"),markup);
  }
  // Bot profile settings live in Telegram, so they are applied from here where the token is available.
  async function setupBot(){
    const steps=[
      ["команды",()=>api("setMyCommands",{commands:COMMANDS.map(([command,description])=>({command,description}))})],
      ["описание",()=>api("setMyDescription",{description:"Авторская одежда и пошив по вашей идее. Самовывоз у метро Беляево, детали с менеджером в Telegram. Нажмите «Старт»."})],
      ["короткое описание",()=>api("setMyShortDescription",{short_description:"Авторская одежда и пошив. Самовывоз у метро Беляево."})],
      ["кнопка витрины",()=>api("setChatMenuButton",{menu_button:{type:"web_app",text:"Витрина",web_app:{url:SHOP+"/app"}}})],
      ["аватарка",async()=>{
        const image=await env.ASSETS.fetch(new Request(SHOP+"/brand/avatar.jpg"));
        if(!image.ok)throw new Error("Avatar asset missing");
        const body=new FormData();
        body.append("photo",JSON.stringify({type:"static",photo:"attach://avatar"}));
        body.append("avatar",new Blob([await image.arrayBuffer()],{type:"image/jpeg"}),"avatar.jpg");
        const r=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/setMyProfilePhoto",{method:"POST",body});
        const result=await r.json().catch(()=>null);
        if(!r.ok||result?.ok!==true)throw new Error(result?.description||"Avatar rejected");
      }]
    ];
    const report=[];
    for(const [name,step] of steps){
      try{await step();report.push(name+": готово")}catch(e){report.push(name+": не получилось"+(name==="аватарка"?" ("+String(e?.message||"").slice(0,120)+")":""))}
    }
    return report.join("\n");
  }
  const home=async id=>{
    await send(id,(demo(env)?"ДЕМО-РЕЖИМ: товары тестовые, реальные заказы не принимаются.\n":"")+"Привет! Это ателье авторской одежды.\n\nРазделы — на кнопках внизу экрана. Выберите вещь, оформите заказ или пошив, а об оплате и встрече у метро Беляево договоритесь с менеджером.",MENU_KEYBOARD);
    return send(id,"Вещи с фото и отзывы удобнее смотреть в витрине:",{inline_keyboard:[[shopButton("Открыть витрину")]]});
  };
  async function catalogue(id) {
    const cs=await rows(db,"SELECT c.id,c.name,COUNT(p.id) AS items FROM categories c LEFT JOIN products p ON p.category_id=c.id AND p.active=1 GROUP BY c.id ORDER BY c.name");
    await send(id,"Категории:",kb([...cs.filter(c=>c.items>0).map(c=>[c.name+" ("+c.items+")","cat:"+c.id]),["Главное меню","home"]]));
  }
  async function cart(id,u) {
    const c=await customer(u);
    const items=await rows(db,"SELECT c.variant_id,c.quantity,p.name,v.size,v.color,v.price_cents,v.stock FROM cart_items c JOIN variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id WHERE c.customer_id=? ORDER BY c.variant_id",c.id);
    if(!items.length)return send(id,"Корзина пуста.",kb([["Каталог","cats"]]));
    const total=items.reduce((sum,r)=>sum+r.quantity*r.price_cents,0);
    await send(id,"Корзина\n"+items.map(x=>x.name+" ("+x.size+", "+x.color+") × "+x.quantity+" — "+rub(x.quantity*x.price_cents)).join("\n")+"\n\nИтого: "+rub(total),
      kb([...items.map(x=>["Удалить "+x.name,"rm:"+x.variant_id]),["Оформить заказ","checkout"],["Каталог","cats"]]));
  }
  async function allMine(id,u){
    const c=await customer(u);
    const orders=await rows(db,"SELECT id,kind,status,total_cents FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 20",c.id);
    await send(id,orders.length?"Ваши заказы:\n"+orders.map(o=>"№"+o.id+" · "+o.kind+" · "+ru[o.status]+" · "+(o.total_cents?rub(o.total_cents):"цена согласуется")).join("\n"):"Заказов ещё нет.");
  }
  async function checkout(id,u,data,addr) {
    const c=await customer(u);
    const cartLines=await first(db,"SELECT COUNT(*) AS n FROM cart_items WHERE customer_id=?",c.id);
    const items=await rows(db,"SELECT ci.quantity,ci.variant_id,v.stock,v.price_cents,v.cost_cents,p.name,v.size,v.color FROM cart_items ci JOIN variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id WHERE ci.customer_id=? AND v.active=1 AND p.active=1",c.id);
    if(!items.length&&Number(cartLines?.n||0)===0)return send(id,"Корзина пуста.");
    // The user must explicitly remove archived products, rather than having
    // the bot silently submit only the other items in the same cart.
    if(items.length!==Number(cartLines?.n||0))
      return send(id,"Некоторые изделия в корзине больше недоступны. Удалите их в корзине и повторите оформление.");
    if(items.some(x=>x.stock<x.quantity))return send(id,"Недостаточно изделий на складе — проверьте корзину.");
    const total=items.reduce((v,x)=>v+x.quantity*x.price_cents,0),cost=items.reduce((v,x)=>v+x.quantity*x.cost_cents,0);
    const botKey="bot_"+crypto.randomUUID().replaceAll("-","");
    // Store the header and all related records in ONE transactional D1 batch.
    // The idempotency row gives every later statement a stable reference to
    // the new order even after last_insert_rowid() changes on another INSERT.
    const statements=[
      db.prepare("INSERT INTO orders(customer_id,kind,status,total_cents,cost_cents,contact_name,contact_phone,delivery_address) VALUES(?,'catalog','new',?,?,?,?,?)")
        .bind(c.id,total,cost,data.name,data.phone,addr),
      db.prepare("INSERT INTO checkout_requests(telegram_id,request_key,order_id) VALUES(?,?,last_insert_rowid())")
        .bind(u.id,botKey),
      ...items.map(x=>db.prepare(
        "UPDATE variants SET stock=CASE WHEN active=1 AND price_cents=? AND cost_cents=? AND EXISTS("+
        "SELECT 1 FROM products p WHERE p.id=variants.product_id AND p.active=1"+
        ") AND EXISTS(SELECT 1 FROM cart_items ci WHERE ci.customer_id=? AND ci.variant_id=variants.id AND ci.quantity=?)"+
        " AND (SELECT COUNT(*) FROM cart_items WHERE customer_id=?)=?"+
        " THEN stock-? ELSE -1 END WHERE id=?"
      ).bind(x.price_cents,x.cost_cents,c.id,x.quantity,c.id,Number(cartLines.n),x.quantity,x.variant_id)),
      ...items.map(x=>db.prepare(
        "INSERT INTO order_items(order_id,variant_id,product_name,size,color,quantity,unit_price_cents,unit_cost_cents) "+
        "VALUES((SELECT order_id FROM checkout_requests WHERE telegram_id=? AND request_key=?),?,?,?,?,?,?,?)"
      ).bind(u.id,botKey,x.variant_id,x.name,x.size,x.color,x.quantity,x.price_cents,x.cost_cents)),
      db.prepare("DELETE FROM cart_items WHERE customer_id=?").bind(c.id),
      db.prepare("INSERT INTO status_history(order_id,new_status) "+
        "VALUES((SELECT order_id FROM checkout_requests WHERE telegram_id=? AND request_key=?),'new')")
        .bind(u.id,botKey),
      ...outboxStatements(db,env,"catalog",u.id,"SELECT order_id FROM checkout_requests WHERE telegram_id=? AND request_key=?",[u.id,botKey])
    ];
    let oid;
    try {
      const results=await db.batch(statements);
      oid=Number(results[0]?.meta?.last_row_id||0);
      if(!oid){
        const saved=await first(db,"SELECT order_id FROM checkout_requests WHERE telegram_id=? AND request_key=?",u.id,botKey);
        oid=saved?.order_id;
      }
    } catch {
      // All statements (including the contact data) rolled back together.
      await send(id,"Склад или корзина изменились. Заказ не оформлен, позиции в корзине сохранены.");
      return;
    }
    if(!oid)throw new Error("Committed order ID unavailable");
    try{await deliverOutbox(env,{orderId:oid})}catch{console.warn("Notification delivery deferred")}
  }
  async function createCustom(id,u,data,addr) {
    const c=await customer(u);
    // MAX(id) resolves inside this transaction, so it is this customer's new order.
    const [ins]=await db.batch([
      db.prepare("INSERT INTO orders(customer_id,kind,status,contact_name,contact_phone,delivery_address,custom_details,custom_measurements) VALUES(?,'custom','new',?,?,?,?,?)")
        .bind(c.id,data.name,data.phone,addr,data.details,data.measures),
      ...outboxStatements(db,env,"custom",u.id,"SELECT MAX(id) FROM orders WHERE customer_id=?",[c.id])
    ]);
    const orderId=ins.meta.last_row_id;
    const photos=Array.isArray(data.photos)?data.photos.slice(0,4):[];
    if(photos.length){
      await db.batch(photos.map(fileId=>db.prepare(
        "INSERT OR IGNORE INTO custom_attachments(order_id,telegram_file_id) VALUES(?,?)").bind(orderId,fileId)));
    }
    try{await deliverOutbox(env,{orderId})}catch{console.warn("Notification delivery deferred")}
    for(const admin of admins){
      for(const fileId of photos){
        try{await api("sendPhoto",{chat_id:admin,photo:fileId,caption:"Референс к заявке №"+orderId})}
        catch{console.warn("Reference delivery failed")}
      }
    }
  }
  async function startCustom(id){
    await setSession(id,"custom","details");
    return send(id,"Опишите вещь одним сообщением: что это, ткань, крой, цвет.\nНапример: льняные брюки, широкий крой, коричневые.\n\nМожно приложить до 4 фото-примеров. /cancel — отмена");
  }
  async function flowMessage(id,u,text){
    const s=await session(id);if(!s)return false;
    let d={};try{d=JSON.parse(s.payload)}catch{}
    const v=textLimit(text,3000);
    if(!v){await send(id,"Введите текст или используйте /cancel.");return true}
    if(s.flow==="checkout"){
      if(s.step==="name"){d.name=v.slice(0,160);await setSession(id,"checkout","phone",d);await send(id,"Телефон или Telegram для связи:",contactButtons(u));return true}
      if(s.step==="phone"){d.phone=v.slice(0,160);await setSession(id,"checkout","address",d);await send(id,PICKUP_ASK,pickupButtons());return true}
      if(s.step==="address"){
        // Only one final message may consume this checkout session.
        const claim=await run(db,"DELETE FROM sessions WHERE telegram_id=? AND flow='checkout' AND step='address'",id);
        if(claim.meta.changes!==1)return true;
        await checkout(id,u,d,v.slice(0,300));return true
      }
    }
    if(s.flow==="custom"){
      if(s.step==="details"){if(v.length<10){await send(id,"Расскажите чуть подробнее: нужно хотя бы 10 символов.");return true}d.details=v;await setSession(id,"custom","measures",d);await send(id,"Укажите размер или мерки: рост, обхваты. Если не знаете, нажмите кнопку.",fillButtons(["Нужна консультация","fill:consult"]));return true}
      if(s.step==="measures"){d.measures=v;await setSession(id,"custom","name",d);await send(id,"Как к вам обращаться?",nameButtons(u));return true}
      if(s.step==="name"){d.name=v.slice(0,160);await setSession(id,"custom","phone",d);await send(id,"Телефон или Telegram для связи:",contactButtons(u));return true}
      if(s.step==="phone"){d.phone=v.slice(0,160);await setSession(id,"custom","address",d);await send(id,PICKUP_ASK,pickupButtons());return true}
      if(s.step==="address"){
        const claim=await run(db,"DELETE FROM sessions WHERE telegram_id=? AND flow='custom' AND step='address'",id);
        if(claim.meta.changes!==1)return true;
        await createCustom(id,u,d,v.slice(0,300));return true
      }
    }
    await delSession(id);return false;
  }
  async function setStatus(id,order,status){
    if(!nextStatuses[order.status]?.includes(status))return send(id,"Нельзя перевести заказ из "+ru[order.status]+" в "+(ru[status]||status)+".");
    if(status==="canceled"){
      const payments=await rows(db,"SELECT kind,amount_cents FROM payments WHERE order_id=?",order.id);
      const outstanding=payments.reduce((sum,p)=>sum+(p.kind==="received"?p.amount_cents:-p.amount_cents),0);
      if(outstanding>0)return send(id,"Сначала зафиксируйте возврат: оплаченный заказ отменять нельзя.");
    }
    // The D1 migration installs AFTER UPDATE triggers for both status history
    // and exact-once inventory restoration. Keep every status transition
    // a single atomic statement; never restock from JavaScript.
    const res=await run(db,
      "UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? AND ("+
      "?!='canceled' OR COALESCE((SELECT SUM(CASE WHEN kind='received' THEN amount_cents ELSE -amount_cents END) FROM payments WHERE order_id=?),0)<=0)",
      status,order.id,order.status,status,order.id);
    if(res.meta.changes!==1)return send(id,"Статус или оплаты изменились. Обновите /order и повторите.");
    const c=await first(db,"SELECT telegram_id FROM customers WHERE id=?",order.customer_id);
    await send(id,"Заказ №"+order.id+": "+ru[status]);
    if(c&&c.telegram_id!==id)try{await send(c.telegram_id,"Статус заказа №"+order.id+": "+ru[status])}catch{}
  }
  async function report(id){
    const orders=await rows(db,"SELECT o.id,o.kind,o.status,o.total_cents,o.cost_cents,o.contact_name,o.contact_phone,o.delivery_address,o.created_at FROM orders o ORDER BY o.id DESC LIMIT 1000");
    const stocks=await rows(db,"SELECT p.name,v.sku,v.size,v.color,v.price_cents,v.cost_cents,v.stock FROM variants v JOIN products p ON p.id=v.product_id ORDER BY p.name,v.sku");
    const payments=await rows(db,"SELECT id,order_id,kind,amount_cents,reference,created_at FROM payments ORDER BY id DESC LIMIT 1000");
    // Detailed sheets show only the most recent 1000 rows. The summary
    // MUST represent the entire ledger, not the limited export slices.
    const orderStats=await first(db,"SELECT COUNT(*) AS n FROM orders");
    const paymentStats=await first(db,
      "SELECT COUNT(*) AS n,COALESCE(SUM(CASE WHEN kind='received' THEN amount_cents ELSE -amount_cents END),0) AS net FROM payments");
    const totals={orders:Number(orderStats?.n||0),net:Number(paymentStats?.net||0),payments:Number(paymentStats?.n||0)};
    const partial=totals.orders>orders.length||totals.payments>payments.length;
    const data=makeXlsx([
      ["Заказы",["ID","Вид","Статус","Цена коп.","Себестоимость коп.","Имя","Контакт","Доставка","Дата"],orders.map(x=>[x.id,x.kind,x.status,x.total_cents,x.cost_cents,x.contact_name,x.contact_phone,x.delivery_address,x.created_at])],
      ["Остатки",["Изделие","SKU","Размер","Цвет","Цена коп.","Себестоимость коп.","Остаток"],stocks.map(x=>[x.name,x.sku,x.size,x.color,x.price_cents,x.cost_cents,x.stock])],
      ["Оплаты",["ID","Заказ","Тип","Сумма коп.","Номер","Дата"],payments.map(x=>[x.id,x.order_id,x.kind,x.amount_cents,x.reference,x.created_at])],
      ["Итоги",["Показатель","Значение"],[
        ["Количество заказов",totals.orders],
        ["Чистые поступления (коп.)",totals.net],
        ["Выведено заказов в XLSX",orders.length],
        ["Всего учётных операций",totals.payments],
        ["Выведено учётных операций в XLSX",payments.length],
        ["Списки деталей неполные",partial?"Да — показаны только последние 1000 записей":"Нет"],
        ["Режим",demo(env)?"Демо":"Боевой"]
      ]]
    ]);
    const body=new FormData();body.append("chat_id",String(id));
    body.append("caption",partial?
      "Демо-отчёт: сводные показатели за всё время, детализация только по последним 1000 строкам. Платежи — ручной учёт.":
      "Демо-отчёт. Платежи — ручной учёт, не операции банка.");
    body.append("document",new Blob([data],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),"atelier-cloud-report.xlsx");
    const response=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendDocument",{method:"POST",body});
    if(!response.ok)throw new Error("Excel delivery failed: "+response.status);
  }
  async function adminCommand(id,u,txt){
    const p=txt.split(/\s+/),cmd=p[0].split("@")[0];
    if(cmd==="/admin")return send(id,(demo(env)?"Управление демо:":"Управление:")+"\n/orders — заказы\n/order ID — детали\n/status ID статус — сменить\n/return ID ПОЛУЧЕНО — учесть физический возврат отправленного товара\n/quote ID цена себестоимость — смета\n/payment ID received|refunded сумма [номер] — ручной учёт\n/report — Excel\n/stats — сводка");
    if(cmd==="/orders"){
      const filter=p[1],valid=!filter||statuses.includes(filter);
      if(!valid)return send(id,"Неизвестный статус.");
      const orders=filter?await rows(db,"SELECT id,kind,status,total_cents FROM orders WHERE status=? ORDER BY id DESC LIMIT 30",filter):await rows(db,"SELECT id,kind,status,total_cents FROM orders ORDER BY id DESC LIMIT 30");
      return send(id,orders.length?"Заказы:\n"+orders.map(o=>"№"+o.id+" "+ru[o.status]+" "+o.kind+" "+rub(o.total_cents)+" · /order "+o.id).join("\n"):"Заказов нет.");
    }
    if(cmd==="/order"){
      const oid=safeInt(p[1]);if(!oid)return send(id,"Пример: /order 1");
      const o=await first(db,"SELECT o.*,c.telegram_id FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?",oid);
      return send(id,o?"№"+o.id+" "+ru[o.status]+" "+o.kind+"\nЦена: "+rub(o.total_cents)+"\nКонтакт: "+o.contact_name+" "+o.contact_phone+"\nДоставка: "+o.delivery_address+"\n"+(o.kind==="custom"?"Пошив: "+o.custom_details+"\nМерки: "+o.custom_measurements:""):"Заказ не найден.");
    }
    if(cmd==="/status"){
      const oid=safeInt(p[1]);const status=p[2];
      if(!oid||!statuses.includes(status))return send(id,"Пример: /status 1 confirmed");
      const o=await first(db,"SELECT * FROM orders WHERE id=?",oid);
      return o?setStatus(id,o,status):send(id,"Заказ не найден.");
    }
    if(cmd==="/return"){
      const oid=safeInt(p[1]);
      if(!oid||p[2]!=="ПОЛУЧЕНО")return send(id,"Только после фактического получения вещи: /return ID ПОЛУЧЕНО");
      const order=await first(db,"SELECT id,kind,status FROM orders WHERE id=?",oid);
      if(!order||order.kind!=="catalog"||order.status!=="canceled")
        return send(id,"Заказ недоступен для возврата на склад.");
      try{
        const result=await run(db,
          "INSERT INTO inventory_return_receipts(order_id,accepted_by,note) VALUES(?,?,?)",
          oid,id,"Подтверждено менеджером в Telegram");
        return send(id,"Физический возврат заказа №"+oid+" учтён (акт №"+result.meta.last_row_id+"). Остатки восстановлены.");
      }catch{return send(id,"Возврат невозможен: заказ не отправлялся, уже возвращён или изменён.")}
    }
    if(cmd==="/quote"){
      const oid=safeInt(p[1]),price=money(p[2]),cost=money(p[3]);
      if(!oid||price===null||cost===null||price<=0)return send(id,"Пример: /quote 2 8500 3900");
      const o=await first(db,"SELECT o.*,c.telegram_id FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?",oid);
      if(!o||o.kind!=="custom"||o.status!=="new")return send(id,"Заявка недоступна для сметы.");
      const revision=o.quote_revision+1;
      const applied=await run(db,"UPDATE orders SET total_cents=?,cost_cents=?,quote_revision=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND quote_revision=? AND status='new'",price,cost,revision,oid,o.quote_revision);
      if(applied.meta.changes!==1)return send(id,"Смета не отправлена: заявка уже изменилась. Проверьте /order "+oid+" и повторите /quote.");
      await send(id,"Смета №"+oid+": "+rub(price)+", себестоимость "+rub(cost));
      try{await send(o.telegram_id,"Предложение по индивидуальному заказу №"+oid+": "+rub(price)+". Подтвердите цену:",kb([
        ["Согласен с ценой","qa:"+oid+":"+revision+":"+price],["Отменить заявку","qr:"+oid+":"+revision+":"+price]
      ]))}catch{await send(id,"Не удалось доставить предложение заказчику.")}
      return;
    }
    if(cmd==="/payment"){
      const oid=safeInt(p[1]),kind=p[2],amount=money(p[3]),ref=textLimit(p[4]||"",100);
      if(!oid||!["received","refunded"].includes(kind)||!amount||amount<=0)return send(id,"Пример: /payment 1 received 100 TXN-001");
      const o=await first(db,"SELECT * FROM orders WHERE id=?",oid);
      if(!o)return send(id,"Заказ не найден.");
      if(kind==="received"&&o.status==="canceled")return send(id,"Нельзя записать поступление за отменённый заказ.");
      // Pre-reading the ledger is unsafe: two simultaneous refunds can both
      // pass and exceed the received amount. Check its net balance atomically
      // inside the INSERT statement, and forbid late receipts on cancellations.
      try{
        const ins=await run(db,
          "INSERT INTO payments(order_id,kind,amount_cents,reference) "+
          "SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND (status!='canceled' OR ?!='received')) "+
          "AND (?!='refunded' OR ?<=COALESCE((SELECT SUM(CASE WHEN kind='received' THEN amount_cents ELSE -amount_cents END) FROM payments WHERE order_id=?),0))",
          oid,kind,amount,ref,oid,kind,kind,amount,oid);
        if(ins.meta.changes!==1)return send(id,"Операция не записана: возврат превышает поступления или статус заказа изменился.");
        return send(id,"Учётная операция №"+ins.meta.last_row_id+": "+rub(amount)+". Реальные деньги не переводились.");
      }catch{return send(id,"Не удалось записать операцию: проверьте уникальность номера.")}
    }
    if(cmd==="/stats"){
      const os=await rows(db,"SELECT status,total_cents,cost_cents FROM orders");
      const ps=await rows(db,"SELECT kind,amount_cents FROM payments");
      const completed=os.filter(x=>x.status==="completed");
      return send(id,"Финансовая сводка (ручной учёт):\nПоступления за вычетом возвратов: "+rub(ps.reduce((v,p)=>v+(p.kind==="received"?p.amount_cents:-p.amount_cents),0))+"\nЗавершённые заказы: "+rub(completed.reduce((v,o)=>v+o.total_cents,0))+"\nВаловая маржа: "+rub(completed.reduce((v,o)=>v+o.total_cents-o.cost_cents,0))+"\nВсего заказов: "+os.length);
    }
    if(cmd==="/report")return report(id);
    return send(id,"Неизвестная команда. /admin");
  }
  async function callback(cb){
    const u=cb.from,id=u.id,data=String(cb.data||"");
    if(data==="home"){await delSession(id);return home(id)}
    if(data==="cats")return catalogue(id);
    if(data==="cart")return cart(id,u);
    if(data==="mine")return allMine(id,u);
    if(data==="custom")return startCustom(id);
    if(data==="reviews")return reviewsMessage(id);
    if(data==="help")return send(id,HELP);
    if(data.startsWith("fill:")){
      const values={tg:u.username?"@"+u.username:"",name:u.first_name,consult:"нужна консультация",later:"согласовать с менеджером"};
      const value=values[data.slice(5)];
      if(value)await flowMessage(id,u,value);
      return;
    }
    if(data==="checkout"){const c=await customer(u);const items=await rows(db,"SELECT variant_id FROM cart_items WHERE customer_id=?",c.id);if(!items.length)return send(id,"Корзина пуста.");await setSession(id,"checkout","name");return send(id,"Как к вам обращаться? /cancel — отмена",nameButtons(u))}
    const [action,value,...rest]=data.split(":");const n=safeInt(value);if(!n)return;
    if(action==="cat"){
      const ps=await rows(db,"SELECT p.id,p.name,p.images,MIN(v.price_cents) AS price FROM products p JOIN variants v ON v.product_id=p.id AND v.active=1 AND v.stock>0 WHERE p.category_id=? AND p.active=1 GROUP BY p.id ORDER BY p.id",n);
      if(!ps.length)return send(id,"Изделий пока нет.",kb([["Назад","cats"]]));
      for(const x of ps)await sendWithPhoto(id,firstImage(x),x.name+"\n"+rub(x.price),kb([["Выбрать размер","p:"+x.id]]));
      return send(id,"Другие категории:",kb([["Категории","cats"],["Главное меню","home"]]));
    }
    if(action==="p"){
      const p=await first(db,"SELECT * FROM products WHERE id=? AND active=1",n);if(!p)return send(id,"Изделие снято с продажи.");
      const vs=await rows(db,"SELECT * FROM variants WHERE product_id=? AND active=1 AND stock>0 ORDER BY size,color",n);
      const buttons=kb([...vs.map(v=>[v.size+" · "+v.color+" — "+rub(v.price_cents),"add:"+v.id]),...(p.size_chart?[["Таблица размеров","sz:"+p.id]]:[]),["Категории","cats"]]);
      const caption=p.name+"\n"+p.description+"\n\nНажмите на размер, и вещь добавится в корзину:";
      if(p.photo_file_id&&!p.images){
        try{return await api("sendPhoto",{chat_id:id,photo:p.photo_file_id,caption,reply_markup:buttons})}catch{}
      }
      return sendWithPhoto(id,firstImage(p),caption,buttons);
    }
    if(action==="sz"){
      const p=await first(db,"SELECT size_chart FROM products WHERE id=? AND active=1",n);
      if(!p?.size_chart)return send(id,"Таблицы размеров пока нет.");
      return sendWithPhoto(id,p.size_chart,"Размеры в сантиметрах");
    }
    if(action==="add"){
      const c=await customer(u),v=await first(db,"SELECT v.*,p.active AS product_active FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?",n);
      if(!v||!v.active||!v.product_active||v.stock<=0)return send(id,"Товар закончился.");
      const cur=await first(db,"SELECT quantity FROM cart_items WHERE customer_id=? AND variant_id=?",c.id,n);
      if((cur?.quantity||0)+1>v.stock)return send(id,"В наличии меньше товара, чем в корзине.");
      await run(db,"INSERT INTO cart_items(customer_id,variant_id,quantity) VALUES(?,?,1) ON CONFLICT(customer_id,variant_id) DO UPDATE SET quantity=quantity+1",c.id,n);
      return send(id,"Изделие добавлено.",kb([["Открыть корзину","cart"],["Продолжить покупки","cats"]]));
    }
    if(action==="st"||action==="stc"){
      if(!admins.has(id))return send(id,"Доступ запрещён.");
      const order=await first(db,"SELECT * FROM orders WHERE id=?",n);
      if(!order)return send(id,"Заказ не найден.");
      if(action==="stc")return send(id,"Точно отменить заказ №"+n+"? Покупатель получит уведомление.",kb([["Да, отменить","st:"+n+":canceled"]]));
      const status=String(rest[0]||"");
      await setStatus(id,order,status);
      const updated=await first(db,"SELECT status FROM orders WHERE id=?",n);
      if(updated?.status!==status)return;
      const following=(nextStatuses[status]||[]).filter(x=>x!=="canceled");
      if(following.length)return send(id,"Следующий шаг по заказу №"+n+":",kb(following.map(x=>[ru[x],"st:"+n+":"+x])));
      return;
    }
    if(action==="rm"){
      const c=await customer(u);await run(db,"DELETE FROM cart_items WHERE customer_id=? AND variant_id=?",c.id,n);
      return cart(id,u);
    }
    if(action==="qa"||action==="qr"){
      const revision=safeInt(rest[0]),price=Number(rest[1]);
      const o=await first(db,"SELECT o.*,c.telegram_id FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?",n);
      if(!o||o.kind!=="custom"||o.status!=="new"||o.telegram_id!==id||o.quote_revision!==revision||o.total_cents!==price)return send(id,"Предложение устарело или недоступно.");
      const st=action==="qa"?"confirmed":"canceled";
      const res=await run(db,"UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND quote_revision=? AND status='new'",st,n,revision);
      if(res.meta.changes!==1)return send(id,"Решение уже принято.");
      // The D1 trigger records this transition with the status update.
      await send(id,"Ваш ответ по заявке №"+n+": "+ru[st]);
      await notify("Ответ клиента по заявке №"+n+": "+ru[st]);
    }
  }
  async function beginProductPhoto(id,productId){
    if(!admins.has(id))return send(id,"Только администратор может загружать фотографии изделий.");
    if(!productId)return send(id,"Пример: /photo 1");
    const product=await first(db,"SELECT id,name FROM products WHERE id=?",productId);
    if(!product)return send(id,"Изделие не найдено.");
    await setSession(id,"product_photo","await_photo",{productId});
    return send(id,"Отправьте фотографию изделия «"+product.name+"». Она будет показана в каталоге. /cancel — отмена.");
  }
  async function message(m){
    const u=m.from,id=m.chat?.id,txt=textLimit(m.text,3500);
    if(!u||!id||m.chat.type!=="private")return;
    if(Array.isArray(m.photo)&&m.photo.length){
      const current=await session(id);
      const fileId=String(m.photo.at(-1)?.file_id||"");
      if(fileId.length<5||fileId.length>1024)return send(id,"Не получилось прочитать фотографию.");
      if(current?.flow==="product_photo"&&admins.has(id)){
        let values={};
        try{values=JSON.parse(current.payload)}catch{}
        const productId=safeInt(values.productId);
        if(!productId)return send(id,"Неверный идентификатор изделия. /cancel");
        const updated=await run(db,"UPDATE products SET photo_file_id=? WHERE id=?",fileId,productId);
        await delSession(id);
        return send(id,updated.meta.changes===1?"Фотография изделия №"+productId+" обновлена.":"Изделие не найдено.");
      }
      if(!current||current.flow!=="custom")
        return send(id,"Для референсов начните оформление: /start → Индивидуальный пошив.");
      let data={};
      try{data=JSON.parse(current.payload)}catch{}
      const photos=Array.isArray(data.photos)?data.photos:[];
      if(photos.includes(fileId))return send(id,"Этот референс уже добавлен.");
      if(photos.length>=4)return send(id,"Лимит: не больше четырёх референсов.");
      photos.push(fileId);data.photos=photos;
      await setSession(id,current.flow,current.step,data);
      return send(id,"Референс сохранён ("+photos.length+"/4). Продолжайте заполнение заявки.");
    }
    if(!txt)return;
    const pressed=MENU[txt];
    if(pressed){
      // A menu button always wins over a half-finished form.
      await delSession(id);
      if(pressed==="catalog")return catalogue(id);
      if(pressed==="cart")return cart(id,u);
      if(pressed==="custom")return startCustom(id);
      if(pressed==="orders")return allMine(id,u);
      if(pressed==="reviews")return reviewsMessage(id);
      if(pressed==="manager")return send(id,"Вопрос по вещи, размеру или встрече? Напишите менеджеру:",{inline_keyboard:[[{text:"Написать менеджеру",url:"https://t.me/"+String(env.MANAGER_USERNAME||"onlyrazor").replace(/^@/,"")}]]});
      return send(id,HELP);
    }
    const cmd=txt.split(/\s+/)[0].split("@")[0].toLowerCase();
    if(cmd==="/start"){
      await delSession(id);await customer(u);
      const photoMatch=txt.match(/^\/start\s+photo_([1-9][0-9]{0,10})$/);
      if(photoMatch&&admins.has(id))return beginProductPhoto(id,safeInt(photoMatch[1]));
      return home(id);
    }
    if(cmd==="/photo"){
      if(!admins.has(id))return send(id,"Доступ запрещён.");
      return beginProductPhoto(id,safeInt(txt.split(/\s+/)[1]));
    }
    if(cmd==="/help")return send(id,HELP);
    if(cmd==="/catalog"){await delSession(id);return catalogue(id)}
    if(cmd==="/cart"){await delSession(id);return cart(id,u)}
    if(cmd==="/orders"){await delSession(id);return allMine(id,u)}
    if(cmd==="/custom")return startCustom(id);
    if(cmd==="/setup"){
      if(!admins.has(id))return send(id,"Доступ запрещён.");
      return send(id,await setupBot());
    }
    if(cmd==="/cancel"){await delSession(id);return send(id,"Ввод отменён. /start — главное меню.")}
    if(cmd==="/privacy")return send(id,"Храним данные Telegram, контакты, сведения о заказах и мерках в Cloudflare D1. Данные видны администратору. Оплаты учитываются только вручную. /forgetme — обезличить закрытые заказы.");
    if(cmd==="/reviews")return reviewsMessage(id);
    if(cmd==="/forgetme"){
      const c=await customer(u);
      const open=await first(db,"SELECT COUNT(*) n FROM orders WHERE customer_id=? AND status NOT IN ('completed','canceled')",c.id);
      if(open.n>0)return send(id,"У вас есть незавершённые заказы. Свяжитесь с менеджером для удаления.");
      // Customer identity is their positive Telegram ID. Blank names alone
      // are not anonymization while orders still link to that ID. Retain the
      // internal accounting customer row, but pseudonymize its external key
      // with a unique negative internal ID (legitimate Telegram IDs > 0).
      await db.batch([
        db.prepare("DELETE FROM custom_attachments WHERE order_id IN (SELECT id FROM orders WHERE customer_id=?)").bind(c.id),
        db.prepare("UPDATE orders SET contact_name='',contact_phone='',delivery_address='',custom_details='',custom_measurements='' WHERE customer_id=?").bind(c.id),
        db.prepare("DELETE FROM cart_items WHERE customer_id=?").bind(c.id),
        db.prepare("DELETE FROM checkout_requests WHERE telegram_id=?").bind(id),
        db.prepare("DELETE FROM sessions WHERE telegram_id=?").bind(id),
        db.prepare("DELETE FROM reviews WHERE customer_id=?").bind(c.id),
        db.prepare("UPDATE customers SET telegram_id=-id,full_name='',username='' WHERE id=?").bind(c.id)
      ]);
      return send(id,"Контакты, мерки и связь закрытых заказов с вашим Telegram ID удалены. Учётные записи операций сохраняются без ваших контактных данных.");
    }
    if(cmd.startsWith("/")&&["/admin","/orders","/order","/status","/quote","/payment","/report","/stats"].includes(cmd))
      return admins.has(u.id)?adminCommand(id,u,txt):send(id,"Доступ запрещён.");
    if(await flowMessage(id,u,txt))return;
    return send(id,"Не понял сообщение. Все команды: /help");
  }
  return {
    async handle(update) {
      if(!env.BOT_TOKEN||!env.DB||!env.WEBHOOK_SECRET)throw new Error("Worker secrets or D1 missing");
      if(!Number.isSafeInteger(update?.update_id))return;
      const event=update.message||update.callback_query;
      if(!event?.from) return;
      const u=event.from;
      if(demo(env)&&!admins.has(u.id)){
        // Do not collect any visitor data or accept orders while the catalogue is synthetic.
        if(update.callback_query){try{await answer(update.callback_query.id,"Пока только демо для администратора.",true)}catch{}}
        else if(update.message?.chat?.type==="private")await send(update.message.chat.id,"Магазин пока в тестовом режиме. Реальные заказы не принимаются.");
        return;
      }
      // Stop the button spinner before any database work so a press feels immediate.
      if(update.callback_query){try{await answer(update.callback_query.id)}catch{console.warn("Callback answer unavailable")}}
      const dedup=await run(db,"INSERT OR IGNORE INTO processed_updates(update_id) VALUES(?)",update.update_id);
      if(dedup.meta.changes===0)return;
      try{
        if(update.callback_query)await callback(update.callback_query);
        else if(update.message)await message(update.message);
      }catch(e){
        await run(db,"DELETE FROM processed_updates WHERE update_id=?",update.update_id);
        throw e;
      }
    }
  };
}

async function productImage(id,env){
  const db=env.DB;
  if(!db||!env.BOT_TOKEN||!id)return new Response("Not Found",{status:404});
  const product=await db.prepare("SELECT photo_file_id FROM products WHERE id=? AND active=1").bind(id).first();
  if(!product?.photo_file_id)return new Response("Not Found",{status:404});
  try{
    const infoResponse=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/getFile",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({file_id:product.photo_file_id})
    });
    if(!infoResponse.ok)return new Response("Image unavailable",{status:502});
    const meta=await infoResponse.json();
    const file=meta?.result;
    if(!meta.ok||!file||file.file_size>8_000_000||!/^photos\/[a-zA-Z0-9_.-]+\.(jpg|jpeg|png|webp)$/.test(file.file_path||""))
      return new Response("Image unavailable",{status:404});
    const payload=await fetch("https://api.telegram.org/file/bot"+env.BOT_TOKEN+"/"+file.file_path);
    if(!payload.ok)return new Response("Image unavailable",{status:502});
    const content=payload.headers.get("content-type")||"";
    if(!/^image\/(jpeg|png|webp)(;|$)/i.test(content))return new Response("Invalid image",{status:502});
    return new Response(payload.body,{status:200,headers:{
      "Content-Type":content,"Cache-Control":"public, max-age=120",
      "X-Content-Type-Options":"nosniff"
    }});
  }catch{return new Response("Image unavailable",{status:502})}
}
export default {
  async fetch(request, env, context) {
    const url=new URL(request.url);
    if(request.method==="GET"&&url.pathname==="/health"){
      // A bound D1 object does not prove D1 is available. Perform one small
      // read so monitoring detects database failures instead of reporting 200.
      let database=false;
      if(env.DB){
        try{
          const result=await env.DB.prepare("SELECT 1 AS alive").first();
          database=Number(result?.alive)===1;
        }catch{
          console.error("Database health check failed");
        }
      }
      return Response.json(
        {ok:database,bot:"atelier",mode:demo(env)?"demo":"production",database},
        {status:database?200:503,headers:{"Cache-Control":"no-store"}}
      );
    }
    if(request.method==="GET"&&url.pathname.startsWith("/media/product/")){
      const id=safeInt(url.pathname.slice("/media/product/".length));
      return productImage(id,env);
    }
    if(url.pathname.startsWith("/api/")){
      try{return await handleApi(request,env,url)}
      catch(e){
        const clientStatus=e?.name==="RequestBodyError"&&[400,413].includes(e.status)
          ?e.status:e instanceof SyntaxError?400:0;
        if(!clientStatus)console.error("Mini App API request failed:",e?.name||"Unknown");
        return Response.json({ok:false,error:clientStatus===413?"Request body too large":
          clientStatus===400?"Invalid JSON":"Server error"},
          {status:clientStatus||500,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
      }
    }
    if(request.method==="GET"&&["/","/app","/admin"].includes(url.pathname)){
      if(!env.ASSETS)return new Response("Mini App assets unavailable",{status:503});
      const page=new URL("/",url);
      const asset=await env.ASSETS.fetch(new Request(page,request));
      const headers=new Headers(asset.headers);
      headers.set("Content-Security-Policy",
        "default-src 'self'; script-src 'self' https://telegram.org; "+
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; "+
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      headers.set("Referrer-Policy","no-referrer");
      headers.set("X-Content-Type-Options","nosniff");
      headers.set("Cache-Control","no-store");
      return new Response(asset.body,{status:asset.status,headers});
    }
    if(url.pathname!=="/webhook"||request.method!=="POST"){
      if(request.method!=="GET"||!env.ASSETS)return new Response("Not Found",{status:404});
      const file=await env.ASSETS.fetch(request);
      // Photos and fonts rarely change, so phones should not fetch them again on every open.
      if(!file.ok||!/^\/(products|brand|fonts)\//.test(url.pathname))return file;
      const cached=new Response(file.body,file);
      cached.headers.set("Cache-Control","public, max-age=604800");
      return cached;
    }
    if(!env.WEBHOOK_SECRET||request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.WEBHOOK_SECRET)
      return new Response("Forbidden",{status:403});
    let update;
    try{update=await request.json()}catch{return new Response("Bad Request",{status:400})}
    try{await makeHandler(env).handle(update);return new Response("OK")}catch(e){console.error("Webhook handler failed:",e?.message?.replace(env.BOT_TOKEN||"\u0000","[REDACTED]")||"unknown");return new Response("Error",{status:500})}
  },
  async scheduled(event,env,ctx){
    if(!env.DB)return;
    await deliverOutbox(env);
    // Workers Free limits cron triggers per account, so one schedule also runs the daily cleanup.
    const now=new Date(event.scheduledTime);
    if(event.cron&&!(now.getUTCHours()===2&&now.getUTCMinutes()===15))return;
    // Bounded retention for technical metadata; customer orders are preserved.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM processed_updates WHERE processed_at < datetime('now','-14 days')"),
      env.DB.prepare("DELETE FROM sessions WHERE updated_at < datetime('now','-30 days')"),
      env.DB.prepare("DELETE FROM notification_outbox WHERE delivered_at < datetime('now','-30 days')"),
      env.DB.prepare("DELETE FROM checkout_requests WHERE created_at < datetime('now','-90 days')")
    ]);
  }
};
