const $=id=>document.getElementById(id);
const app=window.Telegram?.WebApp;
const state={catalog:null,cart:null,me:null,dashboard:null,view:"catalog",category:0,selected:{},requestKey:null,panel:"orders"};
if(app){try{app.ready();app.expand();app.setHeaderColor("#f7f5f1");app.setBackgroundColor("#f7f5f1")}catch{}}
const initData=app?.initData||"";
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=amount=>new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB",minimumFractionDigits:0,maximumFractionDigits:2}).format((Number(amount)||0)/100);
const labels={new:"Новый",confirmed:"Подтверждён",in_production:"В работе",ready:"Готов",shipped:"Отправлен",completed:"Завершён",canceled:"Отменён"};
const next={new:["confirmed","canceled"],confirmed:["in_production","ready","canceled"],in_production:["ready","canceled"],ready:["shipped","completed","canceled"],shipped:["completed","canceled"]};
const toast=(text,error=false)=>{const t=$("toast");t.textContent=text;t.classList.add("show");t.style.background=error?"#813d30":"#242420";clearTimeout(window.toastTimeout);window.toastTimeout=setTimeout(()=>t.classList.remove("show"),4000);};
async function api(path,method="GET",body){
  const response=await fetch(path,{method,headers:{
    ...(initData?{"Authorization":"tma "+initData}:{}),
    ...(body?{"Content-Type":"application/json"}:{})
  },...(body?{body:JSON.stringify(body)}:{}),cache:"no-store"});
  const result=await response.json().catch(()=>({ok:false,error:"Ошибка ответа сервера"}));
  if(!response.ok||!result.ok)throw Error(result.error||"Ошибка соединения");
  return result;
}
const safeRun=async(fn)=>{try{return await fn()}catch(error){toast(error.message||"Не удалось выполнить запрос",true);return null}};
const canUse=()=>Boolean(state.me?.admin||(!state.me?.demo&&state.me?.user));
function go(view){
  if(view==="admin"&&!state.me?.admin){toast("Управление доступно только администратору",true);return}
  state.view=view;
  document.querySelectorAll(".view").forEach(e=>e.classList.toggle("active",e.id==="view-"+view));
  document.querySelectorAll("[data-view]").forEach(e=>e.classList.toggle("selected",e.dataset.view===view));
  if(view==="cart")safeRun(loadCart);
  if(view==="admin"&&state.me?.admin)safeRun(loadAdmin);
  window.scrollTo({top:0,behavior:"smooth"});
}
const categoryName=id=>state.catalog?.categories?.find(c=>c.id===id)?.name||"Коллекция";
async function loadCatalog(){
  state.catalog=await api("/api/catalog");
  $("product-count").textContent=(state.catalog.products.length||0)+" изделий";
  const categories=[{id:0,name:"Всё"},...state.catalog.categories];
  $("filters").innerHTML=categories.map(c=>'<button data-cat="'+c.id+'" class="'+(state.category===c.id?"selected":"")+'">'+esc(c.name)+'</button>').join("");
  renderProducts();
}
function renderProducts(){
  const list=state.catalog.products.filter(p=>!state.category||p.category_id===state.category);
  $("products").innerHTML=list.length?list.map((p,idx)=>{
    const variants=state.catalog.variants.filter(v=>v.product_id===p.id&&v.stock>0);
    const choice=state.selected[p.id]||variants[0]?.id;
    state.selected[p.id]=choice;
    const minimum=Math.min(...variants.map(v=>v.price_cents));
    return '<article class="product-card"><div class="product-photo p'+((idx%3)+1)+'">'+
      '<span class="photo-tag">ДЕМО · '+esc(categoryName(p.category_id))+'</span><span class="symbol">'+(p.photo_available?'<img class="product-image" loading="lazy" alt="'+esc(p.name)+'" src="/media/product/'+p.id+'">':(["A.","✦","○"][idx%3]))+'</span></div>'+
      '<div class="product-details"><h3>'+esc(p.name)+'</h3><p>'+esc(p.description)+'</p>'+
      '<div class="price">'+(variants.length?money(minimum):"Нет в наличии")+'</div>'+
      '<div class="variants">'+variants.map(v=>'<button class="variant-pill '+(choice===v.id?"selected":"")+'" data-choice="'+v.id+'" data-product="'+p.id+'" type="button">'+esc(v.size)+' · '+esc(v.color)+'</button>').join("")+'</div>'+
      '<button class="add-button" data-add="'+p.id+'" '+(!variants.length?"disabled":"")+'>'+(canUse()?"В корзину +":"Посмотреть в Telegram ↗")+'</button></div></article>'
  }).join(""):'<div class="card padded empty">Изделия этой категории пока не добавлены.</div>';
}
async function loadMe(){
  if(!initData){
    state.me={user:null,admin:false,demo:true};
    $("admin-gate").textContent="Откройте магазин из Telegram, чтобы войти в защищённую панель.";
    return;
  }
  const result=await safeRun(()=>api("/api/me"));
  if(!result)return;
  state.me=result;
  if(result.admin){
    $("admin-nav").hidden=false;
    $("admin-gate").hidden=true;
    $("admin-data").hidden=false;
    if(location.pathname==="/admin")go("admin");
  }
  renderProducts();
}
async function loadCart(){
  if(!canUse()){
    $("cart-body").innerHTML='<div class="empty">Для тестовой корзины откройте Mini App через Telegram из аккаунта администратора. Настоящие покупки пока недоступны.</div>';
    $("checkout-form").hidden=true;return;
  }
  state.cart=await api("/api/cart");
  $("cart-count").textContent=state.cart.items.reduce((n,x)=>n+x.quantity,0);
  if(!state.cart.items.length){
    $("cart-body").innerHTML='<div class="empty">Пока пусто. Выберите изделие в каталоге.</div>';
    $("checkout-form").hidden=true;return;
  }
  $("cart-body").innerHTML=state.cart.items.map(x=>'<div class="cart-row"><div><b>'+esc(x.name)+'</b><small>'+esc(x.size)+' · '+esc(x.color)+' · '+money(x.price_cents)+'</small></div><div class="qty-buttons">'+
    '<button data-qty="'+x.variant_id+'" data-delta="-1" aria-label="Уменьшить">−</button><span>'+x.quantity+'</span>'+
    '<button data-qty="'+x.variant_id+'" data-delta="1" aria-label="Добавить">+</button></div></div>').join("")+
    '<div class="cart-total"><span>Итого</span><span>'+money(state.cart.total_cents)+'</span></div>';
  $("checkout-form").hidden=false;
}
async function loadAdmin(){
  state.dashboard=await api("/api/admin/dashboard");
  const m=state.dashboard.metrics;
  $("metrics").innerHTML=[
    ["Заказов",String(m.orderCount),"за всё время (до 100)"],
    ["Новые",String(m.ordersByStatus.new||0),"требуют внимания"],
    ["Учётные поступления",money(m.paidNetCents),"вручную, не от банка"],
    ["Мало на складе",String(m.lowStockCount),"варианты ≤ 3 шт."]
  ].map(x=>'<div class="metric"><span class="metric-label">'+esc(x[0])+'</span><strong>'+esc(x[1])+'</strong><small>'+esc(x[2])+'</small></div>').join("");
  renderPanel();
}
const orderRow=o=>'<tr><td><strong>№'+o.id+'</strong><small>'+esc(o.created_at)+'</small></td><td>'+esc(o.kind==="custom"?"Инд. пошив":"Каталог")+'<small>'+esc(o.contact_name)+'</small></td><td><span class="status '+esc(o.status)+'">'+esc(labels[o.status]||o.status)+'</span></td><td>'+money(o.total_cents)+'</td>'+
  '<td><button class="link-action" data-order="'+o.id+'">Подробнее</button></td></tr>';
function renderPanel(){
  document.querySelectorAll(".panel-view").forEach(e=>e.classList.toggle("active",e.id==="panel-"+state.panel));
  document.querySelectorAll("[data-panel]").forEach(e=>e.classList.toggle("selected",e.dataset.panel===state.panel));
  const d=state.dashboard;if(!d)return;
  if(state.panel==="orders")$("panel-orders").innerHTML='<div class="table-top"><h3>Последние заказы</h3><span class="muted">Тестовые операции</span></div>'+
    '<div class="table-card"><table><thead><tr><th>Заказ</th><th>Вид</th><th>Статус</th><th>Сумма</th><th></th></tr></thead><tbody>'+d.orders.map(orderRow).join("")+'</tbody></table></div>';
  if(state.panel==="catalog")$("panel-catalog").innerHTML='<div class="table-top"><h3>Ассортимент</h3><button class="quiet" data-create-product="1">+ Добавить изделие</button></div>'+
    '<div class="table-card"><table><thead><tr><th>Название</th><th>Категория</th><th>Статус</th><th>Варианты</th><th></th></tr></thead><tbody>'+
    d.products.map(p=>{
      const vs=d.variants.filter(x=>x.product_id===p.id);
      return '<tr><td><strong>'+esc(p.name)+'</strong><small>'+esc(p.description.slice(0,80))+'</small></td><td>'+esc(p.category_name)+'</td><td>'+esc(p.active?"Активен":"Скрыт")+'</td><td>'+vs.map(v=>'<button class="link-action" data-variant="'+v.id+'">'+esc(v.size)+' / '+v.stock+' шт.</button>').join(" ")+'<button class="link-action" data-new-variant="'+p.id+'">+ Вариант</button></td><td><button class="link-action" data-product-edit="'+p.id+'">Изменить</button><button class="link-action" data-photo-product="'+p.id+'">Фото ↗</button></td></tr>'
    }).join("")+'</tbody></table></div>';
  if(state.panel==="settings"){
    const p=d.settings||{};
    $("panel-settings").innerHTML='<div class="analytics-grid"><form id="settings-form" class="card form-card"><h3>Данные продавца</h3>'+
      '<p class="muted">Заполните достоверные реквизиты и условия до запуска продаж. Пустые поля допустимы в демо.</p>'+
      '<label>Наименование продавца<input name="legalName" maxlength="200" value="'+esc(p.legal_name||"")+'"></label>'+
      '<label>ИНН / регистрационный номер<input name="taxId" maxlength="80" value="'+esc(p.tax_id||"")+'"></label>'+
      '<label>Контакт для покупателей<input name="supportContact" maxlength="180" value="'+esc(p.support_contact||"")+'"></label>'+
      '<label>Адрес самовывоза<input name="pickupAddress" maxlength="350" value="'+esc(p.pickup_address||"")+'"></label>'+
      '<label>Условия доставки<textarea name="deliveryPolicy" rows="4" maxlength="2500">'+esc(p.delivery_policy||"")+'</textarea></label>'+
      '<label>Возврат и обмен<textarea name="returnPolicy" rows="4" maxlength="2500">'+esc(p.return_policy||"")+'</textarea></label>'+
      '<label>HTTPS-ссылка на полную политику ПД<input name="privacyUrl" type="url" maxlength="500" value="'+esc(p.privacy_policy_url||"")+'"></label>'+
      '<button type="submit" class="primary">Сохранить настройки ↗</button>'+
      '</form><div class="analytics-card"><h3>Контроль запуска</h3>'+
      '<p class="muted">Демо-режим принудительно включён. Ниже — подготовительные задачи, а не переключатели реальных платежей.</p>'+
      '<div class="cart-row"><span>Витрина и заказы</span><strong class="success">Демо</strong></div>'+
      '<div class="cart-row"><span>Банковский эквайринг</span><strong class="error">Не подключён</strong></div>'+
      '<div class="cart-row"><span>Реальные данные продавца</span><strong class="'+(p.legal_name&&p.tax_id?"success":"error")+'">'+(p.legal_name&&p.tax_id?"Заполнены":"Не заполнены")+'</strong></div>'+
      '<div class="cart-row"><span>Доставка и возвраты</span><strong class="'+(p.delivery_policy&&p.return_policy?"success":"error")+'">'+(p.delivery_policy&&p.return_policy?"Заполнены":"Не заполнены")+'</strong></div>'+
      '<div class="cart-row"><span>Политика обработки данных</span><strong class="'+(p.privacy_policy_url?"success":"error")+'">'+(p.privacy_policy_url?"Ссылка указана":"Не указана")+'</strong></div>'+
      '<p class="small">Для открытия реальных заказов дополнительно требуется успешная приёмка, подтверждённый продавец и две независимые настройки развёртывания: DEMO_MODE=0 и STORE_READY=1. Из панели включить продажи нельзя.</p></div></div>';
  }
  if(state.panel==="analytics"){
    const statuses=Object.entries(d.metrics.ordersByStatus);
    const max=Math.max(1,...statuses.map(x=>x[1]));
    const chart='<div class="chart">'+statuses.map(([key,n])=>'<div class="chart-col"><b>'+n+'</b><div class="chart-bar" style="height:'+Math.max(3,Math.round(n/max*115))+'px"></div><span>'+esc(labels[key]||key)+'</span></div>').join("")+'</div>';
    const popular=d.variants.filter(v=>v.active).sort((a,b)=>a.stock-b.stock).slice(0,7);
    $("panel-analytics").innerHTML='<div class="analytics-grid"><div class="analytics-card"><h3>Стадии заказов</h3>'+chart+'</div>'+
      '<div class="analytics-card"><h3>Проверка остатков</h3>'+popular.map(v=>'<div class="cart-row"><div><b>'+esc(d.products.find(p=>p.id===v.product_id)?.name||v.sku)+'</b><small>'+esc(v.sku)+'</small></div><strong class="'+(v.stock<=3?"error":"success")+'">'+v.stock+' шт.</strong></div>').join("")+'</div>'+
      '<div class="analytics-card"><h3>Экономика</h3><div class="cart-row"><span>Плановая выручка открытых заказов</span><b>'+money(d.metrics.bookedRevenueCents)+'</b></div><div class="cart-row"><span>Валовая маржа завершённых</span><b>'+money(d.metrics.grossMarginCents)+'</b></div><p class="small">Фактические банковские платежи не подключены. Метрики — только данные ручного учёта и тестовые заказы.</p></div></div>';
  }
}
function field(label,name,value,type="text"){
  return '<label>'+esc(label)+'<input type="'+type+'" name="'+esc(name)+'" value="'+esc(value??"")+'" required></label>';
}
function openEditor(kind,id=0,selectedProductId=0){
  if(!state.me?.admin)return;
  const d=state.dashboard;
  const dialog=$("editor");
  let html="";
  if(kind==="product"){
    const p=d.products.find(x=>x.id===id)||{name:"",description:"",category_id:d.categories[0]?.id,active:1};
    $("editor-title").textContent=id?"Изменить изделие":"Новое изделие";
    html=field("Название","name",p.name)+
      '<label>Категория<select name="categoryId">'+d.categories.map(c=>'<option value="'+c.id+'" '+(c.id===p.category_id?"selected":"")+'>'+esc(c.name)+'</option>').join("")+'</select></label>'+
      '<label>Описание<textarea name="description" rows="3">'+esc(p.description)+'</textarea></label>'+
      '<label><input type="checkbox" name="active" '+(p.active?"checked":"")+' style="width:auto;display:inline"> Показывать в каталоге</label>';
  }else if(kind==="variant"){
    const v=d.variants.find(x=>x.id===id);
    const current=v||{product_id:selectedProductId,sku:"",size:"one size",color:"",price_cents:0,cost_cents:0,stock:0,active:1};
    $("editor-title").textContent=v?"Изменить вариант":"Новый вариант";
    html='<label>Изделие<select name="productId">'+d.products.map(x=>'<option value="'+x.id+'" '+(x.id===current.product_id?"selected":"")+'>'+esc(x.name)+'</option>').join("")+'</select></label>'+
      field("Артикул (латиница, цифры, - и _)","sku",current.sku)+field("Размер","size",current.size)+field("Цвет","color",current.color)+
      field("Цена, ₽","priceRub",(current.price_cents/100).toFixed(2),"number")+
      field("Себестоимость, ₽","costRub",(current.cost_cents/100).toFixed(2),"number")+
      field("Остаток, шт.","stock",current.stock,"number")+
      '<label><input type="checkbox" name="active" '+(current.active?"checked":"")+' style="width:auto;display:inline"> Активный вариант</label>';
  }else if(kind==="order"){
    const o=d.orders.find(x=>x.id===id);if(!o)return;
    $("editor-title").textContent="Заказ №"+id;
    html='<p class="muted">'+esc(o.kind==="custom"?"Индивидуальный пошив":"Каталог")+'</p>'+
      '<p><b>'+esc(o.contact_name)+'</b> · '+esc(o.contact_phone)+'<br>'+esc(o.delivery_address)+'</p>'+
      (o.kind==="custom"?'<p><b>Пожелания:</b> '+esc(o.custom_details)+'</p><p><b>Мерки:</b> '+esc(o.custom_measurements)+'</p>':'')+
      '<p>Текущий статус: '+esc(labels[o.status])+'</p>'+
      (o.kind==="catalog"&&o.status==="canceled"&&Number(o.shipping_event_count)>0?
       '<p class="small">После отправки заказ не возвращается на склад автоматически.</p>'+
       (Number(o.return_receipt_count)>0?'<p class="success">Возврат изделия уже учтён.</p>':
        '<div class="return-form"><label>Примечание о приёмке<input name="returnNote" maxlength="300" placeholder="Где и кем получен товар"></label><label class="return-check"><input type="checkbox" name="returnConfirm"> Подтверждаю фактическое получение возвращённого изделия</label><button class="quiet" type="button" data-inventory-return="'+o.id+'">Учесть возврат на склад</button></div>'):"")+
      '<label>Новый статус<select name="status"><option value="">Без изменения</option>'+(next[o.status]||[]).map(st=>'<option value="'+st+'">'+esc(labels[st])+'</option>').join("")+'</select></label>'+
      (o.kind==="custom"&&o.status==="new"?'<label>Предложить цену, ₽<input type="number" min="1" name="quoteRub" placeholder="Например, 8000"></label><label>Себестоимость, ₽<input type="number" min="0" name="costRub" placeholder="Например, 3400"></label>':'');
  }
  dialog.dataset.kind=kind;
  dialog.dataset.id=String(id);
  $("editor-fields").innerHTML=html;
  dialog.showModal();
}
async function saveEditor(e){
  e.preventDefault();const dialog=$("editor");
  const submit=e.submitter;
  if(submit?.value==="cancel"){dialog.close();return}
  const kind=dialog.dataset.kind,id=Number(dialog.dataset.id);
  const form=new FormData(e.currentTarget),get=k=>String(form.get(k)||"").trim();
  let path,body;
  if(kind==="product"){
    path="/api/admin/product";body={id,name:get("name"),categoryId:Number(get("categoryId")),description:get("description"),active:form.has("active")};
  }else if(kind==="variant"){
    path="/api/admin/variant";body={id:state.dashboard.variants.some(x=>x.id===id)?id:0,productId:Number(get("productId")),
      sku:get("sku"),size:get("size"),color:get("color"),
      priceCents:Math.round(Number(get("priceRub"))*100),costCents:Math.round(Number(get("costRub"))*100),
      stock:Number(get("stock")),active:form.has("active")};
  }else if(kind==="order"){
    const price=get("quoteRub");
    if(price){
      path="/api/admin/quote";body={id,priceCents:Math.round(Number(price)*100),costCents:Math.round(Number(get("costRub"))*100)};
    }else if(get("status")){
      path="/api/admin/order/status";body={id,status:get("status")};
    }else {dialog.close();return}
    if(!confirm("Подтвердить изменение тестового заказа №"+id+"?"))return;
  }else return;
  $("editor-save").disabled=true;
  try{
    const result=await api(path,"POST",body);
    dialog.close();
    toast(result.delivered===false?"Сохранено, но Telegram не доставил сообщение":"Изменения сохранены");
    await loadCatalog();await loadAdmin();
  }catch(e){toast(e.message,true)}
  finally{$("editor-save").disabled=false}
}
async function init(){
  document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>go(b.dataset.view)));
  $("explore").addEventListener("click",()=>go("catalog"));
  $("cart-top").addEventListener("click",()=>go("cart"));
  $("refresh-admin").addEventListener("click",()=>safeRun(loadAdmin));
  $("filters").addEventListener("click",e=>{
    const target=e.target.closest("[data-cat]");if(!target)return;
    state.category=Number(target.dataset.cat);
    document.querySelectorAll("[data-cat]").forEach(x=>x.classList.toggle("selected",x===target));renderProducts();
  });
  $("products").addEventListener("click",e=>{
    const select=e.target.closest("[data-choice]");
    if(select){state.selected[Number(select.dataset.product)]=Number(select.dataset.choice);renderProducts();return}
    const add=e.target.closest("[data-add]");
    if(add)safeRun(async()=>{
      if(!canUse()){toast("Тестовые заказы доступны только администратору Telegram",true);return}
      const variantId=state.selected[Number(add.dataset.add)];
      if(!variantId)return;
      await api("/api/cart","POST",{variantId,delta:1});toast("Добавлено в корзину");await loadCart();
    });
  });
  $("cart-body").addEventListener("click",e=>{
    const b=e.target.closest("[data-qty]");
    if(b)safeRun(async()=>{await api("/api/cart","POST",{variantId:Number(b.dataset.qty),delta:Number(b.dataset.delta)});await loadCart()})
  });
  $("checkout-form").addEventListener("submit",e=>{
    e.preventDefault();
    safeRun(async()=>{
      if(!canUse())throw Error("Войдите через Telegram");
      const form=e.currentTarget,fd=new FormData(form);
      state.requestKey ||= crypto.randomUUID().replace(/-/g,"");
      const result=await api("/api/checkout","POST",{requestKey:state.requestKey,name:fd.get("name"),phone:fd.get("phone"),address:fd.get("address")});
      toast("Тестовый заказ №"+result.orderId+" создан");state.requestKey=null;form.reset();await loadCart();go("catalog");
    })
  });
  $("tailor-form").addEventListener("submit",e=>{
    e.preventDefault();safeRun(async()=>{
      if(!canUse())throw Error("Заявка доступна только в Telegram-демо");
      const form=e.currentTarget,fd=new FormData(form);
      state.tailorRequestKey ||= crypto.randomUUID().replace(/-/g,"");
      const result=await api("/api/custom","POST",{...Object.fromEntries(fd),requestKey:state.tailorRequestKey});
      state.tailorRequestKey=null;
      toast("Заявка №"+result.orderId+" зарегистрирована");form.reset();
    })
  });
  $("panel-tabs").addEventListener("click",e=>{const b=e.target.closest("[data-panel]");if(b){state.panel=b.dataset.panel;renderPanel()}});
  $("admin-data").addEventListener("click",e=>{
    const b=e.target.closest("button");if(!b)return;
    if(b.dataset.productEdit)openEditor("product",Number(b.dataset.productEdit));
    if(b.dataset.photoProduct){
      const link="https://t.me/atelier_customwear_2611_bot?start=photo_"+Number(b.dataset.photoProduct);
      if(app?.openTelegramLink)app.openTelegramLink(link);
      else window.open(link,"_blank","noopener,noreferrer");
    }
    if(b.dataset.createProduct)openEditor("product",0);
    if(b.dataset.variant)openEditor("variant",Number(b.dataset.variant));
    if(b.dataset.newVariant)openEditor("variant",0,Number(b.dataset.newVariant));
    if(b.dataset.order)openEditor("order",Number(b.dataset.order));
  });
  $("admin-data").addEventListener("submit",e=>{
    if(e.target.id!=="settings-form")return;
    e.preventDefault();
    safeRun(async()=>{
      const fd=new FormData(e.target);
      const payload=Object.fromEntries(fd);
      const result=await api("/api/admin/settings","POST",payload);
      toast(result.readyForReview?"Реквизиты сохранены для проверки":"Настройки сохранены. Продажи ещё не включены.");
      await loadAdmin();
    });
  });
  $("editor-fields").addEventListener("click",e=>{
    const button=e.target.closest("[data-inventory-return]");
    if(!button)return;
    const id=Number(button.dataset.inventoryReturn);
    const note=$("editor-fields").querySelector('input[name="returnNote"]')?.value?.trim()||"";
    const confirmed=$("editor-fields").querySelector('input[name="returnConfirm"]')?.checked===true;
    if(note.length<4||!confirmed){toast("Укажите приёмку и подтвердите физический возврат",true);return}
    button.disabled=true;
    safeRun(async()=>{
      try{await api("/api/admin/order/return","POST",{id,physicallyReceived:true,note})}
      finally{button.disabled=false}
      $("editor").close();
      toast("Фактический возврат учтён, склад обновлён");
      await loadAdmin();
    });
  });
  $("editor-form").addEventListener("submit",saveEditor);
  await safeRun(loadCatalog);
  await loadMe();
  await safeRun(loadCart);
}
init();
