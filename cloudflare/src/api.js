import {verifyTelegramInitData,isAdmin,demoMode} from "./auth.js";
import {managerUsername,managerUrl,orderDraft,customDraft} from "./manager.js";
import {outboxStatements,deliverOutbox,outboxHealth} from "./outbox.js";

const STATIC_PHOTO=/^\/products\/[a-z0-9-]+\/[a-z0-9-]+\.webp$/;
// Only well-formed local paths reach the page, whatever is stored in the column.
export function withGallery(row){
  let images=[];
  try{images=JSON.parse(row.images||"[]")}catch{}
  images=Array.isArray(images)?images.filter(x=>typeof x==="string"&&STATIC_PHOTO.test(x)).slice(0,8):[];
  let uploaded=[];
  try{uploaded=JSON.parse(row.photo_ids||"[]")}catch{}
  const owner=row.product_id??row.id;
  if(Array.isArray(uploaded)&&owner)uploaded.slice(0,8).forEach((fileId,index)=>{
    // The version makes a replaced photo at the same position bypass the phone's cache.
    images.push("/media/product/"+Number(owner)+"/"+index+"?v="+String(fileId).slice(-10).replace(/[^a-zA-Z0-9_-]/g,""));
  });
  const {photo_ids,...visible}=row;
  return {...visible,images,size_chart:STATIC_PHOTO.test(row.size_chart||"")?row.size_chart:null};
}

const json=(data,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store","x-content-type-options":"nosniff"}});
const err=(message,status=400)=>json({ok:false,error:message},status);
const first=(db,sql,...values)=>db.prepare(sql).bind(...values).first();
const rows=async(db,sql,...values)=>(await db.prepare(sql).bind(...values).all()).results||[];
const run=(db,sql,...values)=>db.prepare(sql).bind(...values).run();
const integer=(v,min=1,max=2147483647)=>Number.isSafeInteger(Number(v))&&Number(v)>=min&&Number(v)<=max?Number(v):null;
const text=(x,max)=>typeof x==="string"?x.trim().slice(0,max):"";
const money=(x)=>Number.isSafeInteger(x)&&x>=0&&x<=1e11?x:null;
const statusTransitions={
  new:["confirmed","canceled"],confirmed:["in_production","ready","canceled"],
  in_production:["ready","canceled"],ready:["shipped","completed","canceled"],
  shipped:["completed","canceled"],completed:[],canceled:[]
};
const escaped=(e)=>e?.message||"error";
class RequestBodyError extends Error{
  constructor(message,status){super(message);this.name="RequestBodyError";this.status=status}
}
const MAX_JSON_BODY_BYTES=16*1024;
async function safeBody(request){
  // A valid Telegram signature is not permission to exhaust the Worker by
  // submitting unbounded JSON. Limit actual streamed bytes, not only headers.
  const length=request.headers.get("content-length");
  if(length&&/^\d+$/.test(length)&&Number(length)>MAX_JSON_BODY_BYTES)
    throw new RequestBodyError("Request body too large",413);
  const reader=request.body?.getReader();
  if(!reader)throw new RequestBodyError("Invalid JSON body",400);
  let bytes=0;
  const buffers=[];
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>MAX_JSON_BODY_BYTES){
        await reader.cancel().catch(()=>{});
        throw new RequestBodyError("Request body too large",413);
      }
      buffers.push(value);
    }
  }finally{reader.releaseLock()}
  const combined=new Uint8Array(bytes);
  let offset=0;
  for(const chunk of buffers){combined.set(chunk,offset);offset+=chunk.byteLength}
  let value;
  try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(combined))}
  catch{throw new RequestBodyError("Invalid JSON body",400)}
  if(!value||Array.isArray(value)||typeof value!=="object")
    throw new RequestBodyError("Invalid JSON body",400);
  return value;
}
async function getCustomer(db,u){
  await run(db,"INSERT INTO customers(telegram_id,full_name,username) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET full_name=excluded.full_name,username=excluded.username",
    u.id,text(u.first_name,80),text(u.username,80));
  return first(db,"SELECT id FROM customers WHERE telegram_id=?",u.id);
}
async function telegramSend(env,chatId,message,replyMarkup){
  const response=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendMessage",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text:message,...(replyMarkup?{reply_markup:replyMarkup}:{})})
  });
  if(!response.ok)throw Error("Telegram delivery unsuccessful");
  const out=await response.json();
  if(out.ok!==true)throw Error("Telegram delivery rejected");
}
export async function handleApi(request,env,url){
  if(!env.DB||!env.BOT_TOKEN)return err("Service unavailable",503);
  const path=url.pathname;
  if(request.method==="GET"&&path==="/api/catalog"){
    const [categories,products,variants,ratings]=await Promise.all([
      rows(env.DB,"SELECT id,name FROM categories ORDER BY id"),
      rows(env.DB,"SELECT p.id,p.category_id,p.name,p.description,p.images,p.photo_ids,p.size_chart,CASE WHEN p.images IS NOT NULL OR (p.photo_file_id IS NOT NULL AND p.photo_file_id<>'') THEN 1 ELSE 0 END AS photo_available FROM products p WHERE p.active=1 ORDER BY photo_available DESC,p.id LIMIT 150").then(list=>list.map(withGallery)),
      rows(env.DB,"SELECT v.id,v.product_id,v.size,v.color,v.price_cents,v.stock FROM variants v JOIN products p ON p.id=v.product_id WHERE v.active=1 AND p.active=1 ORDER BY v.id LIMIT 600"),
      rows(env.DB,"SELECT product_id,ROUND(AVG(rating),1) AS rating,COUNT(*) AS reviews FROM reviews WHERE hidden=0 GROUP BY product_id")
    ]);
    const rated=new Map(ratings.map(x=>[x.product_id,x]));
    const withRating=products.map(p=>({...p,rating:rated.get(p.id)?.rating??null,reviews:rated.get(p.id)?.reviews??0}));
    return json({ok:true,demo:demoMode(env),manager:managerUsername(env),categories,products:withRating,variants});
  }
  if(request.method==="GET"&&path==="/api/reviews"){
    if(!url.searchParams.has("product")){
      const reviews=await rows(env.DB,"SELECT r.id,r.product_id,p.name AS product_name,r.author_name,r.rating,r.body,r.updated_at FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.hidden=0 AND p.active=1 ORDER BY r.updated_at DESC,r.id DESC LIMIT 100");
      return json({ok:true,reviews});
    }
    const productId=Number(url.searchParams.get("product"));
    if(!Number.isSafeInteger(productId)||productId<1)return err("Unknown product");
    const reviews=await rows(env.DB,"SELECT id,author_name,rating,body,updated_at FROM reviews WHERE product_id=? AND hidden=0 ORDER BY updated_at DESC,id DESC LIMIT 50",productId);
    return json({ok:true,reviews});
  }
  const auth=request.headers.get("Authorization")||"";
  if(!auth.startsWith("tma "))return err("Open via Telegram",401);
  const u=await verifyTelegramInitData(auth.slice(4),env.BOT_TOKEN);
  if(!u)return err("Invalid Telegram authorization",401);
  const admin=isAdmin(env,u.id);
  if(request.method==="GET"&&path==="/api/me")return json({ok:true,user:{id:u.id,name:u.first_name,username:u.username},admin,demo:demoMode(env)});
  if(demoMode(env)&&!admin)return err("Demo mode: administrator only",403);
  if(path.startsWith("/api/admin/")&&!admin)return err("Administrator only",403);

  if(request.method==="GET"&&path==="/api/cart"){
    const c=await getCustomer(env.DB,u);
    const items=(await rows(env.DB,"SELECT ci.variant_id,ci.quantity,v.price_cents,v.stock,v.size,v.color,p.id AS product_id,p.name,p.images,p.photo_ids,CASE WHEN p.images IS NOT NULL OR (p.photo_file_id IS NOT NULL AND p.photo_file_id<>'') THEN 1 ELSE 0 END AS photo_available,CASE WHEN v.active=1 AND p.active=1 AND ci.quantity<=v.stock THEN 1 ELSE 0 END AS available FROM cart_items ci JOIN variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id WHERE ci.customer_id=? ORDER BY ci.variant_id",c.id)).map(withGallery);
    return json({ok:true,items,total_cents:items.reduce((n,x)=>n+x.quantity*x.price_cents,0)});
  }
  if(request.method==="POST"&&path==="/api/cart"){
    const b=await safeBody(request),variantId=integer(b.variantId),delta=integer(Math.abs(b.delta),1,20);
    if(!variantId||!delta||![1,-1].includes(b.delta))return err("Invalid cart item");
    const c=await getCustomer(env.DB,u);
    // Never do read-modify-write with stale quantity: two concurrent requests
    // otherwise both return 200 but only one increment is recorded.
    // Each decrement uses conditional SQL updates; removed/archive items
    // remain removable, regardless of their current availability.
    if(b.delta===-1){
      const changed=await run(env.DB,
        "UPDATE cart_items SET quantity=quantity-1 WHERE customer_id=? AND variant_id=? AND quantity>1",
        c.id,variantId);
      if(changed.meta.changes===0)await run(env.DB,
        "DELETE FROM cart_items WHERE customer_id=? AND variant_id=? AND quantity=1",c.id,variantId);
      const remaining=await first(env.DB,"SELECT quantity FROM cart_items WHERE customer_id=? AND variant_id=?",c.id,variantId);
      return json({ok:true,quantity:remaining?.quantity||0});
    }
    const v=await first(env.DB,"SELECT v.stock,v.active,p.active AS product_active FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?",variantId);
    if(!v||!v.active||!v.product_active)return err("Unavailable variant",404);
    const added=await run(env.DB,
      "INSERT INTO cart_items(customer_id,variant_id,quantity) "+
      "SELECT ?,v.id,1 FROM variants v JOIN products p ON p.id=v.product_id "+
      "WHERE v.id=? AND v.active=1 AND p.active=1 AND v.stock>0 "+
      "ON CONFLICT(customer_id,variant_id) DO UPDATE SET quantity=cart_items.quantity+1 "+
      "WHERE cart_items.quantity < (SELECT stock FROM variants WHERE id=excluded.variant_id)",
      c.id,variantId);
    if(added.meta.changes!==1)return err("Insufficient stock or product unavailable",409);
    const updated=await first(env.DB,"SELECT quantity FROM cart_items WHERE customer_id=? AND variant_id=?",c.id,variantId);
    return json({ok:true,quantity:updated?.quantity||0});
  }
  if(request.method==="POST"&&path==="/api/checkout"){
    const b=await safeBody(request),requestKey=text(b.requestKey,64);
    const name=text(b.name,120),phone=text(b.phone,120),address=text(b.address,300);
    if(!/^[a-zA-Z0-9_-]{16,64}$/.test(requestKey)||name.length<2||phone.length<3||address.length<3)
      return err("Fill in name, contact and delivery method");
    const previous=await first(env.DB,"SELECT q.order_id,o.kind FROM checkout_requests q JOIN orders o ON o.id=q.order_id WHERE q.telegram_id=? AND q.request_key=?",u.id,requestKey);
    if(previous){
      if(previous.kind!=="catalog")return err("Request key already used for tailoring",409);
      return json({ok:true,orderId:previous.order_id,duplicate:true,managerUrl:managerUrl(env,"Здравствуйте! Хочу оплатить заказ №"+previous.order_id+".")});
    }
    const c=await getCustomer(env.DB,u);
    const cartLines=await first(env.DB,"SELECT COUNT(*) AS n FROM cart_items WHERE customer_id=?",c.id);
    const items=await rows(env.DB,"SELECT ci.variant_id,ci.quantity,v.stock,v.price_cents,v.cost_cents,p.name,v.size,v.color FROM cart_items ci JOIN variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id WHERE ci.customer_id=? AND v.active=1 AND p.active=1",c.id);
    // Never silently omit an archived product: all cart lines must be
    // available before creating an order for any of them.
    if(!items.length||items.length!==Number(cartLines?.n||0)||items.some(x=>x.stock<x.quantity))
      return err("Cart has unavailable items or stock changed. Review the cart.",409);
    const total=items.reduce((n,x)=>n+x.price_cents*x.quantity,0);
    const cost=items.reduce((n,x)=>n+x.cost_cents*x.quantity,0);
    // Order header, idempotency, stock reservation, line items and cart
    // clearance must share ONE D1 transaction. A second cleanup query is
    // unsafe if the database becomes unavailable after a failed batch.
    let orderId;
    try{
      const results=await env.DB.batch([
        dbStatement(env.DB,"INSERT INTO orders(customer_id,kind,status,total_cents,cost_cents,contact_name,contact_phone,delivery_address) VALUES(?,'catalog','new',?,?,?,?,?)",
          c.id,total,cost,name,phone,address),
        // D1 batch executes statements sequentially in one SQLite transaction;
        // last_insert_rowid() still refers to the preceding orders INSERT.
        dbStatement(env.DB,"INSERT INTO checkout_requests(telegram_id,request_key,order_id) VALUES(?,?,last_insert_rowid())",
          u.id,requestKey),
        ...items.map(x=>dbStatement(env.DB,
          "UPDATE variants SET stock=CASE WHEN active=1 AND price_cents=? AND cost_cents=? "+
          "AND EXISTS(SELECT 1 FROM products p WHERE p.id=variants.product_id AND p.active=1) "+
          "AND EXISTS(SELECT 1 FROM cart_items ci WHERE ci.customer_id=? AND ci.variant_id=variants.id AND ci.quantity=?) "+
          "AND (SELECT COUNT(*) FROM cart_items WHERE customer_id=?)=? "+
          "THEN stock-? ELSE -1 END WHERE id=?",
          x.price_cents,x.cost_cents,c.id,x.quantity,c.id,Number(cartLines.n),x.quantity,x.variant_id)),
        ...items.map(x=>dbStatement(env.DB,
          "INSERT INTO order_items(order_id,variant_id,product_name,size,color,quantity,unit_price_cents,unit_cost_cents) "+
          "VALUES((SELECT order_id FROM checkout_requests WHERE telegram_id=? AND request_key=?),?,?,?,?,?,?,?)",
          u.id,requestKey,x.variant_id,x.name,x.size,x.color,x.quantity,x.price_cents,x.cost_cents)),
        dbStatement(env.DB,"DELETE FROM cart_items WHERE customer_id=?",c.id),
        dbStatement(env.DB,
          "INSERT INTO status_history(order_id,new_status) "+
          "VALUES((SELECT order_id FROM checkout_requests WHERE telegram_id=? AND request_key=?),'new')",
          u.id,requestKey),
        ...outboxStatements(env.DB,env,"catalog",u.id,"SELECT order_id FROM checkout_requests WHERE telegram_id=? AND request_key=?",[u.id,requestKey])
      ]);
      orderId=Number(results[0]?.meta?.last_row_id||0);
      if(!orderId){
        const committed=await first(env.DB,"SELECT q.order_id,o.kind FROM checkout_requests q JOIN orders o ON o.id=q.order_id WHERE q.telegram_id=? AND q.request_key=?",u.id,requestKey);
        orderId=committed?.order_id;
      }
    }catch{
      // A failed D1 batch rolls everything back, including the order header
      // and personal information. No compensating DELETE is necessary.
      const found=await first(env.DB,"SELECT q.order_id,o.kind FROM checkout_requests q JOIN orders o ON o.id=q.order_id WHERE q.telegram_id=? AND q.request_key=?",u.id,requestKey);
      if(found){
        if(found.kind!=="catalog")return err("Request key already used for tailoring",409);
        return json({ok:true,orderId:found.order_id,duplicate:true,managerUrl:managerUrl(env,"Здравствуйте! Хочу оплатить заказ №"+found.order_id+".")});
      }
      return err("Stock or cart changed during checkout. Your cart is preserved.",409);
    }
    if(!orderId)return err("Order committed but confirmation could not be retrieved; contact support.",503);
    try{await deliverOutbox(env,{orderId})}catch{}
    return json({ok:true,orderId,managerUrl:managerUrl(env,orderDraft(orderId,items,total))});
  }
  if(request.method==="GET"&&path==="/api/orders"){
    const c=await getCustomer(env.DB,u);
    const orders=await rows(env.DB,"SELECT id,kind,status,total_cents,custom_details,created_at FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 20",c.id);
    const [items,history]=orders.length?await Promise.all([
      rows(env.DB,"SELECT i.order_id,i.product_name AS name,i.size,i.color,i.quantity FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.customer_id=? ORDER BY i.id",c.id),
      rows(env.DB,"SELECT h.order_id,h.new_status FROM status_history h JOIN orders o ON o.id=h.order_id WHERE o.customer_id=? ORDER BY h.id",c.id)
    ]):[[],[]];
    return json({ok:true,orders:orders.map(o=>{
      const lines=items.filter(x=>x.order_id===o.id);
      return {...o,items:lines,statuses:history.filter(x=>x.order_id===o.id).map(x=>x.new_status),
        managerUrl:managerUrl(env,o.kind==="custom"?customDraft(o.id):orderDraft(o.id,lines,o.total_cents))};
    })});
  }
  if(request.method==="POST"&&path==="/api/reviews"){
    const b=await safeBody(request),productId=Number(b.productId),rating=Number(b.rating),body=text(b.text,1000);
    if(!Number.isSafeInteger(productId)||productId<1||!Number.isInteger(rating)||rating<1||rating>5)return err("Поставьте оценку от 1 до 5");
    if(body.length<3)return err("Напишите пару слов о вещи");
    const product=await first(env.DB,"SELECT id,name FROM products WHERE id=? AND active=1",productId);
    if(!product)return err("Товар не найден",404);
    const c=await getCustomer(env.DB,u);
    // A second review of the same product replaces the first and is published again.
    await run(env.DB,"INSERT INTO reviews(product_id,customer_id,author_name,rating,body) VALUES(?,?,?,?,?) "+
      "ON CONFLICT(product_id,customer_id) DO UPDATE SET author_name=excluded.author_name,rating=excluded.rating,body=excluded.body,hidden=0,updated_at=CURRENT_TIMESTAMP",
      productId,c.id,text(u.first_name,40)||"Покупатель",rating,body);
    for(const adminId of String(env.ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean)){
      try{await telegramSend(env,adminId,"Новый отзыв на «"+product.name+"», оценка "+rating+":\n"+body)}catch{}
    }
    return json({ok:true});
  }
  if(request.method==="POST"&&path==="/api/admin/review/hide"){
    const b=await safeBody(request),id=Number(b.id);
    if(!Number.isSafeInteger(id)||id<1)return err("Unknown review");
    const done=await run(env.DB,"UPDATE reviews SET hidden=1 WHERE id=?",id);
    return done.meta.changes===1?json({ok:true}):err("Отзыв не найден",404);
  }
  if(request.method==="POST"&&path==="/api/custom"){
    const b=await safeBody(request),requestKey=text(b.requestKey,64);
    const description=text(b.description,2500),measurements=text(b.measurements,2000),
      name=text(b.name,120),phone=text(b.phone,120),address=text(b.address,300);
    if(!/^[a-zA-Z0-9_-]{16,64}$/.test(requestKey)||description.length<10||
       name.length<2||phone.length<3||measurements.length<3||address.length<3)
      return err("Complete the tailoring request");
    const previous=await first(env.DB,"SELECT q.order_id,o.kind FROM checkout_requests q JOIN orders o ON o.id=q.order_id WHERE q.telegram_id=? AND q.request_key=?",u.id,requestKey);
    if(previous){
      if(previous.kind!=="custom")return err("Request key already used for catalog checkout",409);
      return json({ok:true,orderId:previous.order_id,duplicate:true});
    }
    const c=await getCustomer(env.DB,u);
    let orderId;
    try{
      const results=await env.DB.batch([
        dbStatement(env.DB,
          "INSERT INTO orders(customer_id,kind,status,contact_name,contact_phone,delivery_address,custom_details,custom_measurements) "+
          "VALUES(?,'custom','new',?,?,?,?,?)",
          c.id,name,phone,address,description,measurements),
        dbStatement(env.DB,
          "INSERT INTO checkout_requests(telegram_id,request_key,order_id) VALUES(?,?,last_insert_rowid())",
          u.id,requestKey),
        ...outboxStatements(env.DB,env,"custom",u.id,"SELECT order_id FROM checkout_requests WHERE telegram_id=? AND request_key=?",[u.id,requestKey])
      ]);
      orderId=Number(results[0]?.meta?.last_row_id||0);
      if(!orderId){
        const committed=await first(env.DB,"SELECT q.order_id,o.kind FROM checkout_requests q JOIN orders o ON o.id=q.order_id WHERE q.telegram_id=? AND q.request_key=?",u.id,requestKey);
        orderId=committed?.order_id;
      }
    }catch{
      // No orphan or personal data remains after a failed D1 transaction.
      const existing=await first(env.DB,"SELECT q.order_id,o.kind FROM checkout_requests q JOIN orders o ON o.id=q.order_id WHERE q.telegram_id=? AND q.request_key=?",u.id,requestKey);
      if(existing){
        if(existing.kind!=="custom")return err("Request key already used for catalog checkout",409);
        return json({ok:true,orderId:existing.order_id,duplicate:true});
      }
      return err("Request could not be saved; retry",409);
    }
    if(!orderId)return err("Request saved but confirmation unavailable; contact support.",503);
    try{await deliverOutbox(env,{orderId})}catch{}
    return json({ok:true,orderId,managerUrl:managerUrl(env,customDraft(orderId))});
  }
  if(request.method==="GET"&&path==="/api/admin/dashboard"){
    const products=await rows(env.DB,"SELECT p.id,p.name,p.description,p.category_id,p.active,p.photo_file_id,p.images,p.photo_ids,p.size_chart,c.name AS category_name FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.id LIMIT 200").then(list=>list.map(withGallery));
    const sizeCharts=(await rows(env.DB,"SELECT DISTINCT size_chart FROM products WHERE size_chart IS NOT NULL")).map(x=>x.size_chart);
    const variants=await rows(env.DB,"SELECT v.id,v.product_id,v.sku,v.size,v.color,v.price_cents,v.cost_cents,v.stock,v.active FROM variants v ORDER BY v.id LIMIT 600");
    const categories=await rows(env.DB,"SELECT id,name FROM categories ORDER BY id");
    const settings=await first(env.DB,"SELECT * FROM store_settings WHERE id=1");
    const orders=await rows(env.DB,"SELECT o.id,o.kind,o.status,o.total_cents,o.cost_cents,o.contact_name,o.contact_phone,o.delivery_address,o.created_at,o.custom_details,o.custom_measurements,(SELECT COUNT(*) FROM custom_attachments a WHERE a.order_id=o.id) AS attachment_count,(SELECT COUNT(*) FROM inventory_return_receipts r WHERE r.order_id=o.id) AS return_receipt_count,(SELECT COUNT(*) FROM status_history h WHERE h.order_id=o.id AND h.new_status='shipped') AS shipping_event_count,c.telegram_id FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC LIMIT 100");
    // Lists are deliberately bounded for mobile performance. Metrics are NOT:
    // calculating totals from the latest 100 orders/1000 payments understates
    // lifetime figures as soon as the shop has more history.
    const totals=await first(env.DB,
      "SELECT COUNT(*) AS order_count, "+
      "COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed_count, "+
      "COALESCE(SUM(CASE WHEN status!='canceled' THEN total_cents ELSE 0 END),0) AS booked_revenue_cents, "+
      "COALESCE(SUM(CASE WHEN status='completed' THEN total_cents-cost_cents ELSE 0 END),0) AS gross_margin_cents "+
      "FROM orders");
    const counts=await rows(env.DB,"SELECT status,COUNT(*) AS n FROM orders GROUP BY status");
    const payments=await first(env.DB,
      "SELECT COALESCE(SUM(CASE WHEN kind='received' THEN amount_cents ELSE -amount_cents END),0) AS net_cents FROM payments");
    const lowStock=await first(env.DB,"SELECT COUNT(*) AS n FROM variants WHERE stock<=3 AND active=1");
    const statuses=["new","confirmed","in_production","ready","shipped","completed","canceled"];
    const metrics={
      orderCount:Number(totals?.order_count||0),
      completedCount:Number(totals?.completed_count||0),
      bookedRevenueCents:Number(totals?.booked_revenue_cents||0),
      grossMarginCents:Number(totals?.gross_margin_cents||0),
      paidNetCents:Number(payments?.net_cents||0),
      notifications:await outboxHealth(env.DB),
      lowStockCount:Number(lowStock?.n||0),
      ordersByStatus:Object.fromEntries(statuses.map(status=>
        [status,Number(counts.find(x=>x.status===status)?.n||0)]))
    };
    return json({ok:true,metrics,orders,products,variants,categories,sizeCharts,settings,demo:demoMode(env)});
  }
  if(request.method==="POST"&&path==="/api/admin/settings"){
    const b=await safeBody(request);
    const legalName=text(b.legalName,200),taxId=text(b.taxId,80),
      supportContact=text(b.supportContact,180),pickupAddress=text(b.pickupAddress,350),
      deliveryPolicy=text(b.deliveryPolicy,2500),returnPolicy=text(b.returnPolicy,2500),
      privacyUrl=text(b.privacyUrl,500);
    if(privacyUrl && !/^https:\/\/[^\s<>]+$/.test(privacyUrl))return err("Privacy URL must be HTTPS");
    await run(env.DB,"UPDATE store_settings SET legal_name=?,tax_id=?,support_contact=?,pickup_address=?,delivery_policy=?,return_policy=?,privacy_policy_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=1",
      legalName,taxId,supportContact,pickupAddress,deliveryPolicy,returnPolicy,privacyUrl);
    return json({ok:true,readyForReview:Boolean(legalName&&taxId&&supportContact&&deliveryPolicy&&returnPolicy&&privacyUrl),
      productionEnabled:!demoMode(env)});
  }
  if(request.method==="POST"&&path==="/api/admin/product"){
    const b=await safeBody(request);
    const name=text(b.name,100),description=text(b.description,1000),newCategory=text(b.newCategory,60);
    let categoryId=integer(b.categoryId);
    if(newCategory.length>=2){
      await run(env.DB,"INSERT OR IGNORE INTO categories(name) VALUES(?)",newCategory);
      categoryId=(await first(env.DB,"SELECT id FROM categories WHERE name=?",newCategory))?.id;
    }
    if(!categoryId||name.length<2)return err("Укажите название и категорию");
    const sizeChart=STATIC_PHOTO.test(b.sizeChart||"")?b.sizeChart:null;
    const category=await first(env.DB,"SELECT id FROM categories WHERE id=?",categoryId);
    if(!category)return err("Unknown category",404);
    let itemId=integer(b.id);
    if(itemId){
      const changed=await run(env.DB,"UPDATE products SET name=?,description=?,category_id=?,active=?,size_chart=? WHERE id=?",name,description,categoryId,b.active===false?0:1,sizeChart,itemId);
      if(changed.meta.changes!==1)return err("Product not found",404);
    }else{
      const ins=await run(env.DB,"INSERT INTO products(category_id,name,description,active,size_chart) VALUES(?,?,?,?,?)",categoryId,name,description,b.active===false?0:1,sizeChart);
      itemId=ins.meta.last_row_id;
      // One form creates every size, so a new item is on sale without entering article numbers.
      const sizes=[...new Set(text(b.sizes,200).split(",").map(x=>x.trim().slice(0,50)).filter(Boolean))].slice(0,12);
      const price=money(b.priceCents),cost=money(b.costCents??0),stock=integer(b.stock,0,100000),color=text(b.color,80);
      if(sizes.length&&price!==null&&cost!==null&&stock!==null&&color){
        await env.DB.batch(sizes.map((size,index)=>env.DB.prepare("INSERT INTO variants(product_id,sku,size,color,price_cents,cost_cents,stock,active) VALUES(?,?,?,?,?,?,?,1)")
          .bind(itemId,"P"+itemId+"-"+(index+1),size,color,price,cost,stock)));
      }
    }
    return json({ok:true,id:itemId});
  }
  if(request.method==="POST"&&path==="/api/admin/product/photo-remove"){
    const b=await safeBody(request),id=integer(b.id),index=integer(b.index,0,20);
    if(!id||index===null)return err("Unknown photo");
    const product=await first(env.DB,"SELECT images,photo_ids FROM products WHERE id=?",id);
    if(!product)return err("Product not found",404);
    let fixed=[],uploaded=[];
    try{fixed=JSON.parse(product.images||"[]")}catch{}
    try{uploaded=JSON.parse(product.photo_ids||"[]")}catch{}
    if(index<fixed.length)fixed.splice(index,1);
    else if(index-fixed.length<uploaded.length)uploaded.splice(index-fixed.length,1);
    else return err("Unknown photo",404);
    await run(env.DB,"UPDATE products SET images=?,photo_ids=?,photo_file_id=? WHERE id=?",
      fixed.length?JSON.stringify(fixed):null,uploaded.length?JSON.stringify(uploaded):null,uploaded[0]||null,id);
    return json({ok:true});
  }
  if(request.method==="POST"&&path==="/api/admin/variant"){
    const b=await safeBody(request),id=integer(b.id),productId=integer(b.productId),
      price=money(b.priceCents),cost=money(b.costCents),stock=integer(b.stock,0,100000),
      sku=text(b.sku,64)||"P"+productId+"-"+Date.now().toString(36),size=text(b.size,50),color=text(b.color,80);
    if(!productId||price===null||cost===null||stock===null||sku.length<2||size.length<1||color.length<1)return err("Invalid variant");
    if(!/^[a-zA-Z0-9_-]{2,64}$/.test(sku))return err("Invalid SKU");
    const product=await first(env.DB,"SELECT id FROM products WHERE id=?",productId);
    if(!product)return err("Product not found",404);
    try{
      let updated;
      if(id){
        updated=await run(env.DB,"UPDATE variants SET product_id=?,sku=?,size=?,color=?,price_cents=?,cost_cents=?,stock=?,active=? WHERE id=?",
          productId,sku,size,color,price,cost,stock,b.active===false?0:1,id);
        if(updated.meta.changes!==1)return err("Variant not found",404);
      }else{
        updated=await run(env.DB,"INSERT INTO variants(product_id,sku,size,color,price_cents,cost_cents,stock,active) VALUES(?,?,?,?,?,?,?,?)",
          productId,sku,size,color,price,cost,stock,b.active===false?0:1);
      }
      return json({ok:true,id:id||updated.meta.last_row_id});
    }catch{return err("SKU already exists or invalid",409)}
  }
  if(request.method==="POST"&&path==="/api/admin/order/status"){
    const b=await safeBody(request),id=integer(b.id),status=text(b.status,32);
    if(!id||!Object.hasOwn(statusTransitions,status))return err("Invalid order status");
    const o=await first(env.DB,"SELECT o.*,c.telegram_id FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?",id);
    if(!o)return err("Order not found",404);
    if(!statusTransitions[o.status]?.includes(status))return err("Invalid transition",409);
    const updated=await run(env.DB,
      "UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? AND ("+
      "?!='canceled' OR COALESCE((SELECT SUM(CASE WHEN kind='received' THEN amount_cents ELSE -amount_cents END) FROM payments WHERE order_id=?),0)<=0)",
      status,id,o.status,status,id);
    if(updated.meta.changes!==1)return err("Status or payments changed",409);
    try{await telegramSend(env,o.telegram_id,"Статус заказа №"+id+": "+status);}catch{}
    return json({ok:true,id,status});
  }
  if(request.method==="POST"&&path==="/api/admin/order/return"){
    const b=await safeBody(request);
    const id=integer(b.id),note=text(b.note,300);
    if(!id||b.physicallyReceived!==true||note.length<4)
      return err("Confirm actual receipt and add a note");
    const order=await first(env.DB,
      "SELECT o.id,o.kind,o.status, "+
      "EXISTS(SELECT 1 FROM status_history h WHERE h.order_id=o.id AND h.new_status='shipped') AS dispatched, "+
      "EXISTS(SELECT 1 FROM inventory_return_receipts r WHERE r.order_id=o.id) AS already_returned "+
      "FROM orders o WHERE o.id=?",id);
    if(!order)return err("Order not found",404);
    if(order.kind!=="catalog"||order.status!=="canceled"||!order.dispatched||order.already_returned)
      return err("This order is not awaiting a physical return",409);
    try{
      const result=await run(env.DB,
        "INSERT INTO inventory_return_receipts(order_id,accepted_by,note) VALUES(?,?,?)",
        id,u.id,note);
      return json({ok:true,id,receiptId:result.meta.last_row_id});
    }catch{return err("Return already processed or order changed",409)}
  }
  if(request.method==="POST"&&path==="/api/admin/quote"){
    const b=await safeBody(request),id=integer(b.id),price=money(b.priceCents),cost=money(b.costCents);
    if(!id||price===null||price<100||cost===null)return err("Invalid quote");
    const o=await first(env.DB,"SELECT o.*,c.telegram_id FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?",id);
    if(!o||o.kind!=="custom"||o.status!=="new")return err("Tailoring request unavailable",409);
    const version=o.quote_revision+1;
    const updated=await run(env.DB,"UPDATE orders SET total_cents=?,cost_cents=?,quote_revision=? WHERE id=? AND quote_revision=? AND status='new'",price,cost,version,id,o.quote_revision);
    if(updated.meta.changes!==1)return err("Quote already changed",409);
    try{await telegramSend(env,o.telegram_id,"Смета по заявке №"+id+": "+(price/100).toFixed(2)+" ₽. Подтвердите или отклоните предложение.",{
      inline_keyboard:[[{text:"Согласен",callback_data:"qa:"+id+":"+version+":"+price},{text:"Отклонить",callback_data:"qr:"+id+":"+version+":"+price}]]
    });return json({ok:true,version,delivered:true})}
    catch{return json({ok:true,version,delivered:false})}
  }
  return err("Not found",404);
}
function dbStatement(db,sql,...values){return db.prepare(sql).bind(...values)}
