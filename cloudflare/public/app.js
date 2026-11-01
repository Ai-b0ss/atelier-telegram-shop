import {productCountLabel, syncTelegramBackButton, configureTelegramBackNavigation} from "./ui-helpers.js";
const $=id=>document.getElementById(id);
const app=window.Telegram?.WebApp;
const state={reviews:{},reviewDraft:{rating:0,text:""},catalog:null,cart:null,me:null,dashboard:null,view:"catalog",category:0,selected:{},requestKey:null,panel:"orders",pendingCart:false};
if(app){try{app.ready();app.expand();app.setHeaderColor("#f3f0e9");app.setBackgroundColor("#f3f0e9")}catch{}}
const initData=app?.initData||"";
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=amount=>new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB",minimumFractionDigits:0,maximumFractionDigits:2}).format((Number(amount)||0)/100);
const labels={new:"Новый",confirmed:"Подтверждён",in_production:"В работе",ready:"Готов",shipped:"Отправлен",completed:"Завершён",canceled:"Отменён"};
const next={new:["confirmed","canceled"],confirmed:["in_production","ready","canceled"],in_production:["ready","canceled"],ready:["shipped","completed","canceled"],shipped:["completed","canceled"]};
const toast=(text,error=false)=>{const t=$("toast");t.textContent=text;t.classList.add("show");t.style.background=error?"#9f3013":"#141412";clearTimeout(window.toastTimeout);window.toastTimeout=setTimeout(()=>t.classList.remove("show"),4000);};
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
const haptic=kind=>{try{kind==="success"?app?.HapticFeedback?.notificationOccurred("success"):app?.HapticFeedback?.impactOccurred(kind||"light")}catch{}};
function openLink(url){
  if(app?.openTelegramLink)app.openTelegramLink(url);
  else window.open(url,"_blank","noopener,noreferrer");
}
const isDemo=()=>state.catalog?.demo!==false;
function applyMode(){
  const demo=isDemo();
  $("environment").hidden=!demo;
  $("demo-notice").hidden=!demo;
  $("checkout-submit").textContent=demo?"Создать тестовый заказ":"Оформить заказ";
}
const photoHtml=(p,alt=true)=>p.photo_available?
  '<img class="product-image" '+(alt?'alt="'+esc(p.name)+'"':'alt=""')+' decoding="async" loading="lazy" src="'+esc(p.images?.[0]||"/media/product/"+Number(p.product_id??p.id))+'" data-photo>':
  '<span class="photo-empty"><b>'+esc(String(p.name||"A").slice(0,1))+'</b><small>Фото скоро</small></span>';
function setCartCount(n){
  const badge=$("cart-count");
  const changed=badge.textContent!==String(n);
  badge.textContent=n;
  badge.classList.toggle("is-empty",!n);
  if(changed&&n){badge.classList.remove("bump");void badge.offsetWidth;badge.classList.add("bump")}
}
const canUse=()=>Boolean(state.me?.admin||(!state.me?.demo&&state.me?.user));
function go(view){
  if(view==="admin"&&!state.me?.admin){toast("Управление доступно только администратору",true);return}
  state.view=view;
  syncTelegramBackButton(app,view);
  document.body.classList.toggle("is-inner-view",view!=="catalog");
  document.querySelectorAll(".view").forEach(e=>e.classList.toggle("active",e.id==="view-"+view));
  document.querySelectorAll("[data-view]").forEach(e=>{
    const active=e.dataset.view===view;
    e.classList.toggle("selected",active);
    e.setAttribute("aria-pressed",String(active));
  });
  if(view==="cart")safeRun(loadCart);
  if(view==="reviews")safeRun(loadAllReviews);
  if(view==="admin"&&state.me?.admin)safeRun(loadAdmin);
  window.scrollTo({top:0,behavior:"smooth"});
}
const categoryName=id=>state.catalog?.categories?.find(c=>c.id===id)?.name||"Коллекция";
async function loadCatalog(){
  state.catalog=await api("/api/catalog");
  applyMode();
  $("product-count").textContent=productCountLabel(state.catalog.products.length);
  const stocked=new Set(state.catalog.products.map(p=>p.category_id));
  const categories=[{id:0,name:"Всё"},...state.catalog.categories.filter(c=>stocked.has(c.id))];
  $("filters").innerHTML=categories.map(c=>'<button data-cat="'+c.id+'" aria-pressed="'+(state.category===c.id)+'" class="'+(state.category===c.id?"selected":"")+'">'+esc(c.name)+'</button>').join("");
  renderProducts();
  renderHero();
}
const heroState={slides:[],at:0,timer:0};
const SLIDE_MS=5000;
function showSlide(at){
  heroState.at=at;
  $("hero-media").querySelectorAll(".hero-slide").forEach((el,i)=>el.classList.toggle("on",i===at));
  $("hero-bars").querySelectorAll("i").forEach((el,i)=>{el.classList.toggle("seen",i<at);el.classList.toggle("on",i===at)});
  clearTimeout(heroState.timer);
  if(heroState.slides.length>1&&!matchMedia("(prefers-reduced-motion:reduce)").matches)
    heroState.timer=setTimeout(()=>showSlide((at+1)%heroState.slides.length),SLIDE_MS);
}
const heroSlide=x=>'<button type="button" class="hero-slide" data-open="'+x.id+'" aria-label="'+esc(x.name)+'"><img alt="" src="'+esc(x.src)+'"></button>';
function renderHero(){
  if(heroState.slides.length)return; // Refreshing the catalogue must not restart the slideshow.
  const shots=(state.catalog?.products||[]).flatMap(p=>p.images?.length?[{id:p.id,name:p.name,src:p.images[0]}]:[]);
  if(!shots.length)return;
  // The first photo appears at once so the page does not jump when it loads.
  heroState.slides=[shots[0]];
  $("hero").classList.add("has-media");
  $("hero-media").innerHTML=heroSlide(shots[0]);
  showSlide(0);
  // Low-resolution shots would look soft at full width, so later slides must be sharp.
  shots.slice(1).forEach(shot=>{
    const probe=new Image();
    probe.onload=()=>{
      if(probe.naturalWidth<600)return;
      heroState.slides.push(shot);
      $("hero-media").insertAdjacentHTML("beforeend",heroSlide(shot));
      $("hero-bars").innerHTML=heroState.slides.map(()=>'<i></i>').join("");
      showSlide(heroState.at);
    };
    probe.src=shot.src;
  });
}
const stars=n=>"★".repeat(n)+"☆".repeat(5-n);
const reviewDate=value=>{const d=new Date(String(value).replace(" ","T")+"Z");return isNaN(d)?"":d.toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"})};
function reviewsHtml(p){
  const list=state.reviews[p.id];
  const items=!list?'<p class="review-note">Загружаем отзывы…</p>':list.length?list.map(r=>'<article class="review"><div class="review-top"><b>'+esc(r.author_name)+'</b><span class="review-stars" aria-label="Оценка '+Number(r.rating)+' из 5">'+stars(Number(r.rating))+'</span></div><p>'+esc(r.body)+'</p><small>'+esc(reviewDate(r.updated_at))+'</small>'+(state.me?.admin?'<button type="button" class="quiet" data-hide-review="'+Number(r.id)+'" data-product="'+p.id+'">Скрыть</button>':'')+'</article>').join(""):'<p class="review-note">Отзывов пока нет. Ваш может быть первым.</p>';
  const form=canUse()?reviewForm(p.id):'<p class="review-note">Оставить отзыв можно в Telegram.</p>';
  return '<section class="reviews"><h4>Отзывы'+(p.reviews?' <span>'+esc(String(p.rating).replace(".",","))+' ★ · '+Number(p.reviews)+'</span>':'')+'</h4>'+items+form+'</section>';
}
function reviewForm(product,picker=""){
  const draft=state.reviewDraft;
  return '<form class="review-form"'+(product?' data-product="'+product+'"':'')+'>'+picker+'<div class="star-pick" role="radiogroup" aria-label="Оценка">'+[1,2,3,4,5].map(n=>'<button type="button" role="radio" aria-checked="'+(draft.rating===n)+'" aria-label="'+n+' из 5" data-star="'+n+'" class="'+(draft.rating>=n?"on":"")+'">★</button>').join("")+'</div><textarea name="text" maxlength="1000" rows="3" placeholder="Как сидит, что понравилось…">'+esc(draft.text)+'</textarea><button type="submit" class="primary">Оставить отзыв</button></form>';
}
async function loadAllReviews(){
  const result=await api("/api/reviews");
  $("reviews-count").textContent=result.reviews.length?String(result.reviews.length):"";
  const products=state.catalog?.products||[];
  const picker='<label class="review-pick">Какую вещь оцениваете<select name="product">'+products.map(p=>'<option value="'+p.id+'">'+esc(p.name)+'</option>').join("")+'</select></label>';
  $("reviews-page").innerHTML=
    (result.reviews.length?result.reviews.map(r=>'<article class="review"><div class="review-top"><b>'+esc(r.author_name)+'</b><span class="review-stars" aria-label="Оценка '+Number(r.rating)+' из 5">'+stars(Number(r.rating))+'</span></div><button type="button" class="review-product" data-open="'+Number(r.product_id)+'">'+esc(r.product_name)+'</button><p>'+esc(r.body)+'</p><small>'+esc(reviewDate(r.updated_at))+'</small>'+(state.me?.admin?'<button type="button" class="quiet" data-hide-review="'+Number(r.id)+'" data-product="'+Number(r.product_id)+'">Скрыть</button>':'')+'</article>').join(""):'<p class="review-note">Отзывов пока нет. Ваш может быть первым.</p>')+
    (canUse()&&products.length?'<h4 class="review-new">Оставить отзыв</h4>'+reviewForm(0,picker):canUse()?'':'<p class="review-note">Оставить отзыв можно в Telegram.</p>');
}
async function loadReviews(productId){
  const result=await api("/api/reviews?product="+productId);
  state.reviews[productId]=result.reviews;
  const sheet=$("product-sheet");
  const holder=$("sheet-content").querySelector(".reviews");
  const product=state.catalog?.products.find(x=>x.id===productId);
  if(sheet.open&&holder&&product&&state.openProduct===productId)holder.outerHTML=reviewsHtml(product);
}
function renderProducts(){
  if(!state.catalog){
    $("products").innerHTML='<div class="card padded empty">Не удалось загрузить коллекцию. <button class="quiet" type="button" data-retry-catalog>Повторить загрузку</button></div>';
    return;
  }
  const list=state.catalog.products.filter(p=>!state.category||p.category_id===state.category);
  $("products").removeAttribute("aria-busy");
  $("products").innerHTML=list.length?list.map((p,idx)=>{
    const variants=state.catalog.variants.filter(v=>v.product_id===p.id&&v.stock>0);
    const prices=variants.map(v=>v.price_cents);
    const low=prices.length?Math.min(...prices):0;
    const label=!variants.length?"Нет в наличии":(Math.max(...prices)>low?"от ":"")+money(low);
    return '<button type="button" class="product-card'+(variants.length?"":" is-sold")+'" style="--i:'+idx+'" data-open="'+p.id+'">'+
      '<span class="product-photo">'+photoHtml(p)+'</span>'+
      '<span class="product-meta"><b>'+esc(p.name)+'</b><span>'+esc(label)+(p.reviews?' · ★ '+esc(String(p.rating).replace(".",",")):'')+'</span></span></button>';
  }).join(""):'<div class="card padded empty">В этой категории пока ничего нет.</div>';
}
function galleryHtml(p){
  if(!(p.images?.length>1))return '<div class="sheet-photo">'+photoHtml(p)+'</div>';
  return '<div class="sheet-photo gallery"><div class="gallery-track" tabindex="0" aria-label="Фотографии товара">'+
    p.images.map((src,i)=>'<div class="gallery-slide"><img class="product-image" alt="'+esc(p.name)+', фото '+(i+1)+'" decoding="async" '+(i?'loading="lazy" ':'')+'src="'+esc(src)+'" data-photo></div>').join("")+
    '</div><div class="gallery-dots" aria-hidden="true">'+p.images.map((_,i)=>'<i class="'+(i?"":"on")+'"></i>').join("")+'</div></div>';
}
function openSheet(productId){
  const p=state.catalog?.products.find(x=>x.id===productId);if(!p)return;
  if(state.openProduct!==productId)state.reviewDraft={rating:0,text:""};
  state.openProduct=productId;
  const variants=state.catalog.variants.filter(v=>v.product_id===p.id&&v.stock>0);
  const remembered=state.selected[p.id];
  const choice=variants.find(v=>v.id===remembered)||variants[0];
  if(choice)state.selected[p.id]=choice.id;
  const action=!variants.length?"Нет в наличии":canUse()?"Добавить в корзину":"Открыть в Telegram";
  // Choosing a size re-renders the sheet: keep the photo and open chart where they were.
  const swiped=$("sheet-content").querySelector(".gallery-track")?.scrollLeft||0;
  const chartOpen=Boolean($("sheet-content").querySelector(".size-chart")?.open);
  $("sheet-content").innerHTML='<button type="button" class="sheet-close" data-sheet-close aria-label="Закрыть">×</button>'+
    galleryHtml(p)+'<div class="sheet-body"><h3 id="sheet-title">'+esc(p.name)+'</h3>'+
    '<div class="sheet-price">'+(choice?money(choice.price_cents):"Нет в наличии")+'</div>'+
    (p.description?'<p>'+esc(p.description)+'</p>':'')+
    (variants.length?'<span class="sheet-label">Размер и цвет</span><div class="variants">'+variants.map(v=>'<button type="button" class="variant-pill '+(choice.id===v.id?"selected":"")+'" aria-pressed="'+(choice.id===v.id)+'" data-choice="'+v.id+'" data-product="'+p.id+'">'+esc(v.size)+'<small>'+esc(v.color)+'</small></button>').join("")+'</div>':'')+
    (p.size_chart?'<details class="size-chart"'+(chartOpen?" open":"")+'><summary>Таблица размеров</summary><img alt="Таблица размеров: талия, бёдра, посадка и длина в сантиметрах" decoding="async" src="'+esc(p.size_chart)+'"></details>':'')+
    '<div class="stock-hint">'+(choice&&choice.stock<=3?(choice.stock===1?"Последняя вещь":"Осталось: "+choice.stock):"")+'</div>'+
    '<button type="button" class="primary" data-add="'+p.id+'" '+(variants.length?"":"disabled")+'>'+action+'</button>'+reviewsHtml(p)+'</div>';
  if(!state.reviews[productId])safeRun(()=>loadReviews(productId));
  const sheet=$("product-sheet");
  sheet.classList.remove("closing");
  if(!sheet.open)sheet.showModal();
  const track=$("sheet-content").querySelector(".gallery-track");
  if(track){
    track.scrollLeft=swiped;
    track.addEventListener("scroll",()=>{
      const at=Math.round(track.scrollLeft/Math.max(track.clientWidth,1));
      $("sheet-content").querySelectorAll(".gallery-dots i").forEach((dot,i)=>dot.classList.toggle("on",i===at));
    },{passive:true});
  }
}
function closeSheet(){
  const sheet=$("product-sheet");
  if(!sheet.open||sheet.classList.contains("closing"))return;
  if(matchMedia("(prefers-reduced-motion:reduce)").matches){sheet.close();return}
  sheet.classList.add("closing");
  setTimeout(()=>{sheet.close();sheet.classList.remove("closing")},210);
}
function showDone({title,text,url}){
  $("done-body").innerHTML='<svg class="done-mark" viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="30"/><path d="M24 37l8 8 16-18"/></svg>'+
    '<h2>'+esc(title)+'</h2><p>'+esc(text)+'</p>'+
    (url?'<a class="primary" href="'+esc(url)+'" data-manager-link>Написать менеджеру</a>':'')+
    '<button type="button" class="quiet" data-view-link="catalog">Вернуться в каталог</button>';
  haptic("success");
  go("done");
}
const doneCopy=(result,kind)=>{
  const custom=kind==="custom";
  if(isDemo())return {title:(custom?"Тестовая заявка №":"Тестовый заказ №")+result.orderId,text:"Это демо: настоящий заказ не создан, деньги никуда не отправляются.",url:null};
  return {title:(custom?"Заявка №":"Заказ №")+result.orderId+(custom?" получена":" принят"),
    text:result.managerUrl?(custom?"Остался один шаг: напишите менеджеру, чтобы обсудить детали и цену. Текст сообщения уже готов.":"Остался один шаг: напишите менеджеру, чтобы договориться об оплате и получении. Текст сообщения уже готов."):"Менеджер свяжется с вами по указанному контакту.",
    url:result.managerUrl};
};
async function loadMe(){
  if(!initData){
    state.me={user:null,admin:false,demo:true};
    $("admin-gate").textContent="Откройте магазин из Telegram, чтобы войти в защищённую панель.";
    return;
  }
  const result=await api("/api/me").catch(()=>null);
  if(!result){
    toast("Не удалось войти. Закройте витрину и откройте её заново",true);
    renderProducts();
    return;
  }
  state.me=result;
  // Spare customers from retyping the contact Telegram already knows.
  if(result.user?.username)document.querySelectorAll('input[name="phone"]').forEach(input=>{if(!input.value)input.value="@"+result.user.username});
  if(result.user?.name)document.querySelectorAll('#checkout-form input[name="name"],#tailor-form input[name="name"]').forEach(input=>{if(!input.value)input.value=result.user.name});
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
    $("cart-body").innerHTML='<div class="empty">'+(isDemo()?"Магазин пока работает в тестовом режиме, заказы скоро откроются.":"Откройте магазин через Telegram, чтобы оформить заказ.")+'</div>';
    $("checkout-form").hidden=true;return;
  }
  state.cart=await api("/api/cart");
  setCartCount(state.cart.items.reduce((n,x)=>n+x.quantity,0));
  if(!state.cart.items.length){
    $("cart-body").innerHTML='<div class="empty">Пока пусто. Выберите изделие в каталоге.</div>';
    $("checkout-form").hidden=true;return;
  }
  const hasUnavailable=state.cart.items.some(x=>Number(x.available)===0);
  $("cart-body").innerHTML=(hasUnavailable?'<div class="notice" role="alert">Некоторые изделия недоступны или их осталось меньше, чем в корзине. Уменьшите количество или удалите эти позиции перед оформлением.</div>':"")+
    state.cart.items.map(x=>'<div class="cart-row"><span class="cart-thumb">'+photoHtml(x,false)+'</span><div class="cart-info"><b>'+esc(x.name)+'</b><small>'+esc(x.size)+' · '+esc(x.color)+' · '+money(x.price_cents)+'</small>'+
    (Number(x.available)===0?'<small class="error">Временно недоступно — уменьшите количество или удалите</small>':"")+
    '</div><div class="qty-buttons">'+
    '<button data-qty="'+x.variant_id+'" data-delta="-1" aria-label="Уменьшить">−</button><span>'+x.quantity+'</span>'+
    '<button data-qty="'+x.variant_id+'" data-delta="1" aria-label="Добавить">+</button></div></div>').join("")+
    '<div class="cart-total"><span>Итого</span><span>'+money(state.cart.total_cents)+'</span></div>';
  $("checkout-form").hidden=hasUnavailable;
}
async function loadAdmin(){
  state.dashboard=await api("/api/admin/dashboard");
  const m=state.dashboard.metrics;
  $("metrics").innerHTML=[
    ["Заказов",String(m.orderCount),"за всё время"],
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
  if(state.panel==="orders")$("panel-orders").innerHTML='<div class="table-top"><h3>Последние заказы</h3><span class="muted">'+(isDemo()?"Тестовые операции":"")+'</span></div>'+
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
      '<p class="muted">'+(d.metrics.notifications?'Уведомления: в очереди '+d.metrics.notifications.pending+', не доставлено '+d.metrics.notifications.failed+'. ':'')+'Демо-режим принудительно включён. Ниже — подготовительные задачи, а не переключатели реальных платежей.</p>'+
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
  const extra=type==="number"?' min="0" step="'+(name==="stock"?"1":"0.01")+'"':"";
  return '<label>'+esc(label)+'<input type="'+type+'" name="'+esc(name)+'" value="'+esc(value??"")+'"'+extra+' required></label>';
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
      (o.kind==="custom"&&o.status==="new"?'<label>Предложить цену, ₽<input type="number" min="1" step="0.01" name="quoteRub" placeholder="Например, 8000"></label><label>Себестоимость, ₽<input type="number" min="0" step="0.01" name="costRub" placeholder="Например, 3400"></label>':'');
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
    if(!confirm("Подтвердить изменение заказа №"+id+"?"))return;
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
  // Focus events work even in embedded WebViews where CSS :focus can be
  // temporarily out of sync with document.activeElement.
  const isEditingField=e=>e?.matches?.('input:not([type="hidden"]),textarea,select');
  document.addEventListener("focusin",e=>{
    if(isEditingField(e.target))document.body.classList.add("is-editing-field");
  });
  document.addEventListener("focusout",e=>{
    if(!isEditingField(e.relatedTarget))document.body.classList.remove("is-editing-field");
  });
  configureTelegramBackNavigation(app,go);
  syncTelegramBackButton(app,state.view);
  document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>go(b.dataset.view)));
  $("explore").addEventListener("click",()=>{haptic();$("view-catalog").scrollIntoView({behavior:"smooth",block:"start"})});
  $("cart-top").addEventListener("click",()=>go("cart"));
  $("refresh-admin").addEventListener("click",()=>safeRun(loadAdmin));
  $("filters").addEventListener("click",e=>{
    const target=e.target.closest("[data-cat]");if(!target)return;
    state.category=Number(target.dataset.cat);
    document.querySelectorAll("[data-cat]").forEach(x=>{
      x.classList.toggle("selected",x===target);
      x.setAttribute("aria-pressed",String(x===target));
    });renderProducts();
  });
  // Telegram can fail to fetch a file_id image; preserve a readable, non-broken card.
  document.addEventListener("error",event=>{
    const image=event.target;
    if(image?.matches?.("img[data-photo]"))image.replaceWith(Object.assign(document.createElement("span"),{className:"photo-empty",innerHTML:"<b></b><small>Фото недоступно</small>"}));
  },true);
  document.addEventListener("load",event=>{
    if(event.target?.matches?.("img[data-photo]"))event.target.classList.add("loaded");
  },true);
  $("products").addEventListener("click",e=>{
    if(e.target.closest("[data-retry-catalog]")){safeRun(loadCatalog);return}
    const card=e.target.closest("[data-open]");
    if(card){haptic();openSheet(Number(card.dataset.open))}
  });
  $("hero-media").addEventListener("click",e=>{
    const slide=e.target.closest("[data-open]");
    if(slide){haptic();openSheet(Number(slide.dataset.open))}
  });
  const sheet=$("product-sheet");
  [sheet,$("view-reviews")].forEach(root=>{
    root.addEventListener("input",e=>{if(e.target.matches(".review-form textarea"))state.reviewDraft.text=e.target.value});
    root.addEventListener("click",e=>{
      const star=e.target.closest("[data-star]");
      if(star){
        haptic();
        state.reviewDraft.rating=Number(star.dataset.star);
        star.parentElement.querySelectorAll("[data-star]").forEach(el=>{
          const n=Number(el.dataset.star);
          el.classList.toggle("on",n<=state.reviewDraft.rating);
          el.setAttribute("aria-checked",String(n===state.reviewDraft.rating));
        });
        return;
      }
      const hide=e.target.closest("[data-hide-review]");
      if(hide){
        const productId=Number(hide.dataset.product);
        safeRun(async()=>{
          await api("/api/admin/review/hide","POST",{id:Number(hide.dataset.hideReview)});
          await loadCatalog();
          await loadReviews(productId);
          if(state.view==="reviews")await loadAllReviews();
        });
        return;
      }
      const open=e.target.closest(".review-product[data-open]");
      if(open){haptic();openSheet(Number(open.dataset.open))}
    });
    root.addEventListener("submit",e=>{
      const form=e.target.closest(".review-form");
      if(!form)return;
      e.preventDefault();
      const submit=form.querySelector('[type="submit"]');
      const productId=Number(form.dataset.product||form.elements.product?.value);
      if(!state.reviewDraft.rating){toast("Поставьте оценку",true);return}
      submit.disabled=true;
      safeRun(async()=>{
        await api("/api/reviews","POST",{productId,rating:state.reviewDraft.rating,text:state.reviewDraft.text});
        state.reviewDraft={rating:0,text:""};
        haptic("success");
        toast("Спасибо за отзыв");
        await loadCatalog();
        await loadReviews(productId);
        if(state.view==="reviews")await loadAllReviews();
      }).finally(()=>{submit.disabled=false});
    });
  });
  sheet.addEventListener("cancel",e=>{e.preventDefault();closeSheet()});
  sheet.addEventListener("click",e=>{
    if(e.target===sheet||e.target.closest("[data-sheet-close]")){closeSheet();return}
    const select=e.target.closest("[data-choice]");
    if(select){haptic();state.selected[Number(select.dataset.product)]=Number(select.dataset.choice);openSheet(Number(select.dataset.product));return}
    const add=e.target.closest("[data-add]");
    if(add)safeRun(async()=>{
      if(!canUse()){
        // Inside Telegram the bot link would reopen this same chat and appear to do nothing.
        if(initData)throw Error("Не удалось войти. Закройте витрину и откройте её заново");
        openLink("https://t.me/atelier_customwear_2611_bot");
        return;
      }
      const variantId=state.selected[Number(add.dataset.add)];
      if(!variantId||state.pendingCart)return;
      state.pendingCart=true;
      add.disabled=true;
      try{
        await api("/api/cart","POST",{variantId,delta:1});
        haptic("medium");
        closeSheet();
        toast("Добавлено в корзину");
        await loadCart();
      }finally{
        state.pendingCart=false;
        add.disabled=false;
      }
    });
  });
  $("done-body").addEventListener("click",e=>{
    const link=e.target.closest("[data-manager-link]");
    if(link){e.preventDefault();openLink(link.href);return}
    if(e.target.closest("[data-view-link]"))go("catalog");
  });
  $("cart-body").addEventListener("click",e=>{
    const b=e.target.closest("[data-qty]");
    if(b)safeRun(async()=>{await api("/api/cart","POST",{variantId:Number(b.dataset.qty),delta:Number(b.dataset.delta)});await loadCart()})
  });
  $("checkout-form").addEventListener("submit",e=>{
    e.preventDefault();
    const form=e.currentTarget,submit=form.querySelector('[type="submit"]');
    if(submit?.disabled)return;
    if(submit)submit.disabled=true;
    safeRun(async()=>{
      if(!canUse())throw Error("Войдите через Telegram");
      const fd=new FormData(form);
      state.requestKey ||= crypto.randomUUID().replace(/-/g,"");
      const result=await api("/api/checkout","POST",{requestKey:state.requestKey,name:fd.get("name"),phone:fd.get("phone"),address:fd.get("address")});
      state.requestKey=null;form.reset();await loadCart();showDone(doneCopy(result,"catalog"));
    }).finally(()=>{if(submit)submit.disabled=false})
  });
  $("tailor-form").addEventListener("submit",e=>{
    e.preventDefault();
    const form=e.currentTarget,submit=form.querySelector('[type="submit"]');
    if(submit?.disabled)return;
    if(submit)submit.disabled=true;
    safeRun(async()=>{
      if(!canUse())throw Error(isDemo()?"Заявки скоро откроются":"Откройте магазин через Telegram");
      const fd=new FormData(form);
      state.tailorRequestKey ||= crypto.randomUUID().replace(/-/g,"");
      const result=await api("/api/custom","POST",{...Object.fromEntries(fd),requestKey:state.tailorRequestKey});
      state.tailorRequestKey=null;
      form.reset();showDone(doneCopy(result,"custom"));
    }).finally(()=>{if(submit)submit.disabled=false})
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
  if(!state.catalog)renderProducts();
  await loadMe();
  await safeRun(loadCart);
}
init();
