/* Telegram Mini App initData validation using the official double-HMAC algorithm. */
const encoder=new TextEncoder();
const key=async(raw)=>crypto.subtle.importKey("raw",raw,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
const sign=async(k,text)=>new Uint8Array(await crypto.subtle.sign("HMAC",k,encoder.encode(text)));
const bytesFromHex=hex=>new Uint8Array(hex.match(/../g).map(h=>parseInt(h,16)));
const equal=(a,b)=>{
  if(a.length!==b.length)return false;
  let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i];
  return difference===0;
};
export async function verifyTelegramInitData(initData,token,now=Math.floor(Date.now()/1000)){
  if(typeof initData!=="string"||initData.length===0||initData.length>8192||!token)return null;
  const params=new URLSearchParams(initData);
  const hash=params.get("hash");
  if(!hash||!/^[a-fA-F0-9]{64}$/.test(hash)||params.getAll("hash").length!==1)return null;
  const date=params.get("auth_date");
  if(!/^\d{10}$/.test(date||"")||params.getAll("auth_date").length!==1)return null;
  const ts=Number(date);
  if(!Number.isSafeInteger(ts)||ts>now+30||now-ts>600)return null;
  const fields=[];
  for(const [k,v] of params.entries()){
    if(k==="hash"||k==="signature")continue;
    if(!/^[a-zA-Z_]{1,48}$/.test(k)||params.getAll(k).length!==1)return null;
    fields.push([k,v]);
  }
  fields.sort((a,b)=>a[0].localeCompare(b[0],"en"));
  const data=fields.map(([k,v])=>k+"="+v).join("\n");
  const derivation=await key(encoder.encode("WebAppData"));
  const secret=await sign(derivation,token);
  const verifyKey=await key(secret);
  const expected=await sign(verifyKey,data);
  if(!equal(expected,bytesFromHex(hash)))return null;
  let user;
  try{user=JSON.parse(params.get("user")||"null")}catch{return null}
  if(!user||!Number.isSafeInteger(user.id)||user.id<=0||user.is_bot)return null;
  return {id:user.id,first_name:String(user.first_name||"").slice(0,80),
    username:String(user.username||"").slice(0,80)};
}
export function isAdmin(env,id){
  return String(env.ADMIN_IDS||"").split(",").some(x=>x.trim()===String(id));
}

export function demoMode(env){return env.DEMO_MODE!=="0"||env.STORE_READY!=="1"}
