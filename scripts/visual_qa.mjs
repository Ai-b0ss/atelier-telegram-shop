import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const chrome=process.env.CHROME_PATH||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
const target=process.env.PREVIEW_URL||'http://127.0.0.1:8769/app';
const url=new URL(target);
if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Visual QA requires a local HTTP fixture, not a deployed store');
const dir=resolve('out','visual-qa');mkdirSync(dir,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'atelier-visual-'));
const flags=['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'];
if(process.platform!=='win32'&&process.getuid?.()===0) flags.push('--no-sandbox');
const child=spawn(chrome,flags,{stdio:'ignore',windowsHide:true});
let ws,seq=1;const inflight=new Map();let exceptions=[];
try{
 let port;
 for(let i=0;i<65;i++){
  try{port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port>0)break;}catch{}
  await delay(100);
 }
 if(!port)throw Error('No DevTools port');
 const tabs=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
 const page=tabs.find(t=>t.type==='page');if(!page)throw Error('No headless Chrome page');
 ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});
 ws.addEventListener('message',event=>{
  const msg=JSON.parse(event.data);
  if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);
  if(msg.id&&inflight.has(msg.id)){
   const [res,rej]=inflight.get(msg.id);inflight.delete(msg.id);msg.error?rej(Error(msg.error.message)):res(msg.result);
  }
 });
 const call=(method,params={})=>new Promise((res,rej)=>{const id=seq++;inflight.set(id,[res,rej]);ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
 await call('Page.enable');await call('Runtime.enable');
 const report=[];
 for(const width of [375,390,430,768,1280]){
  exceptions=[];
  await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<768,screenWidth:width,screenHeight:900});
  await call('Emulation.setTouchEmulationEnabled',{enabled:width<768,maxTouchPoints:1});
  await call('Page.navigate',{url:target});
  let state;for(let wait=0;wait<25;wait++){await delay(150);state=await evaluate('(()=>{const b=document.body,d=document.documentElement;const cards=[...document.querySelectorAll(".product-card")];const rect=cards[0]?.getBoundingClientRect();const nav=document.querySelector(".bottom-nav");return {viewport:innerWidth,scrollWidth:Math.max(b.scrollWidth,d.scrollWidth),products:cards.length,names:cards.map(e=>e.querySelector("h3")?.textContent),priceText:cards.map(e=>e.querySelector(".price")?.textContent),variantCount:cards.map(e=>e.querySelectorAll(".variant-pill").length),firstCardRight:rect?.right,bottomNavVisible:!!nav&&nav.getBoundingClientRect().height>0,buttonHeights:[...document.querySelectorAll(".bottom-nav button,.filters button,.variant-pill,.add-button")].map(e=>Math.round(e.getBoundingClientRect().height)).filter(h=>h>0)};})()');
  if(state?.products===3)break;}
  const nav=await evaluate("(()=>{\n  const hero=document.querySelector(\".hero\");\n  const cart=document.querySelector('[data-view=\"cart\"]');\n  const catalog=document.querySelector('[data-view=\"catalog\"]');\n  cart.click();\n  const hidden=getComputedStyle(hero).display===\"none\"\n    &&document.querySelector(\"#view-cart\").classList.contains(\"active\")\n    &&cart.getAttribute(\"aria-pressed\")===\"true\";\n  catalog.click();\n  const restored=getComputedStyle(hero).display!==\"none\"\n    &&catalog.getAttribute(\"aria-pressed\")===\"true\";\n  return {hidden,restored};\n})()");
  const shot=(await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true})).data;
  writeFileSync(join(dir,'editorial-cdp-'+width+'.png'),Buffer.from(shot,'base64'));
  const filtered=await evaluate('(()=>{const b=document.querySelector("[data-cat=\'2\']");if(!b)return null;b.click();return {count:document.querySelectorAll(".product-card").length,title:document.querySelector(".product-card h3")?.textContent};})()');
  const link=await evaluate('(()=>{window.__qaLink=null;window.open=(url)=>{window.__qaLink=url;return null;};if(window.Telegram?.WebApp){try{window.Telegram.WebApp.openTelegramLink=(url)=>{window.__qaLink=url;};}catch{}}document.querySelector(".add-button")?.click();return window.__qaLink;})()');
  const ok=state?.viewport===width&&state?.scrollWidth<=width+1&&state?.products===3&&state?.bottomNavVisible&&state?.firstCardRight<=width+1&&state?.buttonHeights.length>=10&&state?.buttonHeights.every(h=>h>=44)&&filtered?.count===1&&filtered?.title==='Футболка с принтом'&&nav?.hidden===true&&nav?.restored===true&&link==='https://t.me/atelier_customwear_2611_bot'&&exceptions.length===0;
  report.push({width,ok,state,filtered,link,nav,exceptions});
  console.log(JSON.stringify({width,ok,scrollWidth:state?.scrollWidth,products:state?.products,filtered:filtered?.count,link,nav,firstCardRight:state?.firstCardRight,viewport:state?.viewport,minButton:Math.min(...(state?.buttonHeights??[])),exceptions}));
 }
 writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2),'utf8');
 if(report.some(x=>!x.ok))process.exitCode=1;
}catch(error){console.error(error?.stack||String(error));process.exitCode=2;}
finally{try{ws?.close()}catch{}try{child.kill()}catch{}await delay(150);try{rmSync(profile,{recursive:true,force:true,maxRetries:2})}catch{}}
