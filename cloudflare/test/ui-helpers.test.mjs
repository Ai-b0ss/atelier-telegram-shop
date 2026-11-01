import test from "node:test";
import assert from "node:assert/strict";
import {productCountLabel, syncTelegramBackButton, configureTelegramBackNavigation} from "../public/ui-helpers.js";

test("Russian product count is correct for empty, singular, 2-4, and teens", () => {
  const cases = new Map([
    [0, "0 изделий"], [1, "1 изделие"], [2, "2 изделия"], [3, "3 изделия"],
    [4, "4 изделия"], [5, "5 изделий"], [11, "11 изделий"], [12, "12 изделий"],
    [14, "14 изделий"], [21, "21 изделие"], [22, "22 изделия"],
    [101, "101 изделие"], [111, "111 изделий"], [112, "112 изделий"],
  ]);
  for (const [count, expected] of cases) assert.equal(productCountLabel(count), expected);
  assert.equal(productCountLabel(-1), "Количество уточняется");
  assert.equal(productCountLabel("invalid"), "Количество уточняется");
});

test("Telegram BackButton is hidden in catalogue and visible in inner views", () => {
  const events = [];
  const webApp = {BackButton: {
    hide(){events.push("hide")},
    show(){events.push("show")}
  }};
  syncTelegramBackButton(webApp, "catalog");
  syncTelegramBackButton(webApp, "cart");
  syncTelegramBackButton(webApp, "tailor");
  syncTelegramBackButton(webApp, "admin");
  assert.deepEqual(events, ["hide", "show", "show", "show"]);
});

test("Telegram BackButton routes inner views back to catalogue", () => {
  let handler;
  const calls = [];
  const webApp = {BackButton:{onClick(callback){handler = callback}}};
  assert.equal(configureTelegramBackNavigation(webApp, value => calls.push(value)), true);
  handler();
  handler();
  assert.deepEqual(calls, ["catalog","catalog"]);
});

test("Missing and partial Telegram APIs cannot break the Mini App", () => {
  assert.equal(configureTelegramBackNavigation(undefined, () => {}), false);
  assert.equal(configureTelegramBackNavigation({}, () => {}), false);
  assert.doesNotThrow(() => syncTelegramBackButton({}, "catalog"));
  assert.doesNotThrow(() => syncTelegramBackButton({BackButton:{show(){throw Error("unsupported")}}}, "cart"));
});
