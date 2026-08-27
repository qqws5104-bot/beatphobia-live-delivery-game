"use strict";
// Verifies REAL, live elevator movement: clicking vote-up/vote-down now moves the actual,
// server-authoritative floor by exactly one step immediately (no vote tally, no "resolve at the
// end of 5s" step) -- and that movement must be visible on BOTH players' screens right away,
// since either seat can move the shared car. Also checks the floor clamps at the top/bottom of the
// shaft instead of going out of bounds, and that only the raw per-click counter (not the real
// floor) is ever seat-private.
const { chromium } = require("playwright");

const BASE = "http://localhost:3000";
function log(...args) { console.log("[elevmove]", ...args); }
async function clickSel(page, selector) { return page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, selector); }
async function pressSpace(page) { await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }))); }
async function bodyText(page) { return page.evaluate(() => document.body.innerText); }
async function currentFloorLabel(page) { return page.evaluate(() => { const el = document.querySelector(".floor-stop.current"); return el ? el.textContent.trim() : null; }); }
async function currentFloorCount(page) { return page.evaluate(() => document.querySelectorAll(".floor-stop.current").length); }
// The gauge's fill must actually track the floor, not just the text label. Measured against the
// gauge's own box so this stays true whatever height the gauge is given. Read after the settle
// frame has run, so it reflects the target level rather than the level it was drawn at.
async function gaugeFillRatio(page) {
  return page.evaluate(() => {
    const fill = document.querySelector(".gauge-fill");
    const box = document.querySelector(".gauge");
    if (!fill || !box) return null;
    return fill.getBoundingClientRect().height / box.getBoundingClientRect().height;
  });
}
// floorIdx 0 (B1) -> 1/6 filled, floorIdx 5 (5F) -> 6/6. Tolerance covers sub-pixel rounding and
// any in-flight transition frame.
async function expectGaugeAtFloor(page, floorIdx, who) {
  const expected = (floorIdx + 1) / 6;
  const actual = await gaugeFillRatio(page);
  if (actual === null) throw new Error(`${who}: gauge elements (.gauge / .gauge-fill) not found`);
  if (Math.abs(actual - expected) > 0.02) {
    throw new Error(`${who}: gauge fill is ${(actual * 100).toFixed(1)}% but floor index ${floorIdx} needs ${(expected * 100).toFixed(1)}%`);
  }
}
async function waitFor(fn, { timeout = 15000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error("timeout: " + label); await new Promise((r) => setTimeout(r, interval)); }
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const http = require("http");
  const room = await new Promise((resolve, reject) => {
    http.get(BASE + "/", (res) => resolve(new URL(res.headers.location, BASE).searchParams.get("room"))).on("error", reject);
  });
  const roomUrl = BASE + "/?room=" + room;

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();
  await p1.goto(roomUrl);
  await p2.goto(roomUrl);
  await waitFor(async () => (await p1.locator(".seat-pick").count()) > 0, { label: "seat picker" });
  await clickSel(p1, '[data-action="pick-seat"][data-seat="1"]');
  await clickSel(p2, '[data-action="pick-seat"][data-seat="2"]');
  await waitFor(async () => (await bodyText(p1)).includes("좌석 · 플레이어 1"), { label: "p1 seat" });
  await pressSpace(p1);
  await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "secure phase" });
  await waitFor(async () => (await bodyText(p1)).includes("엘리베이터"), { label: "elevator phase", timeout: 15000 });
  await pressSpace(p1);
  await pressSpace(p2);
  await waitFor(async () => (await p1.locator('[data-action="vote-up"]').count()) > 0, { label: "round 1 voting starts" });

  // starting floor is 1F (START_FLOOR_IDX)
  const startFloor = await currentFloorLabel(p1);
  if (startFloor !== "1F") throw new Error("expected to start at 1F, got " + startFloor);
  await p1.waitForTimeout(350); // let the gauge's settle frame + transition finish
  await expectGaugeAtFloor(p1, 1, "p1 at start");
  log("starting floor confirmed: " + startFloor + " (gauge filled 2/6 to match)");

  // 1) MY OWN click should move the REAL current floor immediately -- not a cosmetic hop, the
  // actual ".current" row itself changes, and it must be exactly one row (no ambiguity/duplication)
  await clickSel(p1, '[data-action="vote-up"]');
  await waitFor(async () => (await currentFloorLabel(p1)) === "2F", { label: "p1's own click moved the real floor to 2F", timeout: 3000 });
  if ((await currentFloorCount(p1)) !== 1) throw new Error("expected exactly one .current row after moving");
  log("p1's own vote-up click moved the REAL floor from 1F to 2F");

  // 1b) this must be REAL, not a cosmetic effect that reverts -- wait well past any old animation
  // window and confirm the floor is still 2F, unprompted
  await p1.waitForTimeout(1500);
  if ((await currentFloorLabel(p1)) !== "2F") throw new Error("the real floor reverted on its own -- movement must be permanent (server-authoritative), not a transient animation");
  await expectGaugeAtFloor(p1, 2, "p1 after one up-click");
  log("floor stayed at 2F, gauge settled at 3/6 -- confirmed real, not a transient animation");

  // 2) the OPPONENT's click should ALSO move the real floor, visible on BOTH viewers immediately
  await clickSel(p2, '[data-action="vote-up"]');
  await waitFor(async () => (await currentFloorLabel(p1)) === "3F", { label: "p1 sees the real floor move to 3F after p2's (opponent's) click", timeout: 3000 });
  log("p2's (opponent's) vote-up click moved the shared real floor to 3F, visible on p1's screen");
  await waitFor(async () => (await currentFloorLabel(p2)) === "3F", { label: "p2 also sees 3F on its own view", timeout: 3000 });
  await p2.waitForTimeout(350);
  await expectGaugeAtFloor(p1, 3, "p1 after opponent's up-click");
  await expectGaugeAtFloor(p2, 3, "p2 after its own up-click");
  log("p2 also sees the real floor at 3F on its own view; both gauges filled 4/6");

  // 3) opposite-direction click steps it back down by exactly one, confirming each click is a
  // discrete +/-1 step (not a snap to some target)
  await clickSel(p1, '[data-action="vote-down"]');
  await waitFor(async () => (await currentFloorLabel(p2)) === "2F", { label: "p2 sees the floor step back down to 2F after p1's vote-down click", timeout: 3000 });
  await p2.waitForTimeout(350);
  await expectGaugeAtFloor(p2, 2, "p2 after the down-click");
  log("p1's vote-down click stepped the real floor back down to 2F, gauge drained to 3/6 on p2 too");

  // 3b) clamping: from 2F, five more down-clicks would run past B1 -- the gauge must stop at the
  // bottom notch (1/6 filled, never 0 or negative) rather than emptying out or breaking
  for (let i = 0; i < 5; i++) await clickSel(p1, '[data-action="vote-down"]');
  await waitFor(async () => (await currentFloorLabel(p1)) === "B1", { label: "floor clamps at B1", timeout: 3000 });
  await p1.waitForTimeout(350);
  await expectGaugeAtFloor(p1, 0, "p1 clamped at the bottom");
  if ((await currentFloorCount(p1)) !== 1) throw new Error("expected exactly one .current row while clamped at B1");
  log("over-clicking down clamped at B1 with the gauge at 1/6 (not empty) -- bottom bound holds");

  // 4) no click count shown at all -- neither mine nor the opponent's. Only the real, shared floor
  // position (the gauge) is ever the movement feedback during voting.
  const p1Text = await bodyText(p1);
  if (/[▲▼]\s*\d+/.test(p1Text.replace(/\n/g, " "))) {
    throw new Error("a raw click counter (mine or the opponent's) is still shown in the DOM");
  }
  log("confirmed: no click counter shown at all (mine or the opponent's)");

  // 5) my package list panel renders inside the left column, directly under the gauge -- not off
  // in the right-hand panel -- so both are visible in the same glance. (This test never secures any
  // cells, so the panel may legitimately show the empty-state text rather than a populated
  // .invoice-list -- what's being checked here is where the panel itself lives, not its contents;
  // test_hosted.js separately covers a populated list.)
  const listInLeftColumn = await p1.evaluate(() => !!document.querySelector(".elev-left .player-col.me"));
  if (!listInLeftColumn) throw new Error("my package-list panel is not rendered inside .elev-left (under the gauge)");
  log("confirmed: my package list panel renders directly under the gauge in the left column");

  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => { console.error("[elevmove] FAILED:", e); process.exit(1); });
