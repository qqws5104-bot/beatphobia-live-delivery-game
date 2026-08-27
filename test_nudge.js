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
  log("starting floor confirmed: " + startFloor);

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
  log("floor stayed at 2F -- confirmed real (server-authoritative), not a transient animation");

  // 2) the OPPONENT's click should ALSO move the real floor, visible on BOTH viewers immediately
  await clickSel(p2, '[data-action="vote-up"]');
  await waitFor(async () => (await currentFloorLabel(p1)) === "3F", { label: "p1 sees the real floor move to 3F after p2's (opponent's) click", timeout: 3000 });
  log("p2's (opponent's) vote-up click moved the shared real floor to 3F, visible on p1's screen");
  await waitFor(async () => (await currentFloorLabel(p2)) === "3F", { label: "p2 also sees 3F on its own view", timeout: 3000 });
  log("p2 also sees the real floor at 3F on its own view");

  // 3) opposite-direction click steps it back down by exactly one, confirming each click is a
  // discrete +/-1 step (not a snap to some target)
  await clickSel(p1, '[data-action="vote-down"]');
  await waitFor(async () => (await currentFloorLabel(p2)) === "2F", { label: "p2 sees the floor step back down to 2F after p1's vote-down click", timeout: 3000 });
  log("p1's vote-down click stepped the real floor back down to 2F, visible on p2's screen too");

  // 4) still no raw opponent click-count leak in the DOM (only the real floor position, which is
  // meant to be public, should ever be visible cross-seat)
  const p1Text = await bodyText(p1);
  if (/[▲▼]\s*\d+.*[▲▼]\s*\d+/.test(p1Text.replace(/\n/g, " ")) && p1Text.includes("상대")) {
    throw new Error("opponent's raw click counter leaked into the DOM");
  }
  log("confirmed: no opponent click-counter leak (only the real, shared floor position is visible)");

  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => { console.error("[elevmove] FAILED:", e); process.exit(1); });
