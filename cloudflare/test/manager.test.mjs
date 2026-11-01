import test from "node:test";
import assert from "node:assert/strict";
import {managerUsername,managerUrl,orderDraft,managerKeyboard} from "../src/manager.js";

test("manager username accepts Telegram handles and rejects anything else",()=>{
  assert.equal(managerUsername({MANAGER_USERNAME:"@seller_01"}),"seller_01");
  assert.equal(managerUsername({MANAGER_USERNAME:""}),null);
  assert.equal(managerUsername({}),null);
  assert.equal(managerUsername({MANAGER_USERNAME:"evil.com/x"}),null);
  assert.equal(managerUsername({MANAGER_USERNAME:"abc"}),null,"Telegram handles have at least 5 characters");
});

test("manager link carries an encoded draft with the order contents",()=>{
  const draft=orderDraft(12,[{name:"Жакет",size:"M",color:"чёрный",quantity:2}],900000);
  assert.match(draft,/заказ №12/);
  assert.match(draft,/Жакет, M, чёрный × 2/);
  const url=new URL(managerUrl({MANAGER_USERNAME:"seller_01"},draft));
  assert.equal(url.origin+url.pathname,"https://t.me/seller_01");
  assert.equal(url.searchParams.get("text"),draft);
});

test("without a configured manager there is no link and no button",()=>{
  assert.equal(managerUrl({},"text"),null);
  assert.equal(managerKeyboard(null),undefined);
});
