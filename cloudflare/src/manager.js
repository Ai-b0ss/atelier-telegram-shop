/** Payment and delivery are agreed in a private chat with the seller, not in the shop. */
const USERNAME=/^[A-Za-z][A-Za-z0-9_]{4,31}$/;

export function managerUsername(env){
  const value=String(env.MANAGER_USERNAME||"").trim().replace(/^@/,"");
  return USERNAME.test(value)?value:null;
}

export function managerUrl(env,draft){
  const username=managerUsername(env);
  if(!username)return null;
  return "https://t.me/"+username+(draft?"?text="+encodeURIComponent(draft):"");
}

const rubles=cents=>(Number(cents||0)/100).toLocaleString("ru-RU",{maximumFractionDigits:2})+" ₽";

export function orderDraft(orderId,items,totalCents){
  const lines=(items||[]).map(x=>"• "+x.name+", "+x.size+", "+x.color+" × "+x.quantity);
  return ["Здравствуйте! Хочу оплатить заказ №"+orderId+":",...lines,"Итого: "+rubles(totalCents)].join("\n");
}

export function customDraft(orderId){
  return "Здравствуйте! Оставил заявку на индивидуальный пошив №"+orderId+". Хочу обсудить детали.";
}

/** Inline keyboard for the bot's confirmation; undefined keeps the plain message. */
export function managerKeyboard(url){
  return url?{inline_keyboard:[[{text:"Написать менеджеру",url}]]}:undefined;
}
