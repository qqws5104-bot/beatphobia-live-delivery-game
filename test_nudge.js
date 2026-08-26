"use strict";
// Verifies the elevator car-nudge feedback: clicking vote-up/vote-down (from EITHER player)
// should give the current-floor row a "nudge-up"/"nudge-down" class shortly after, and it must
// react to the OPPONENT's clicks too (since the direction feedback is meant to reflect the
// combined aggregate, not just "my own" clicks) -- while never exposing the raw vote numbers.
const { chromium } = require("playwright");

const BASE = "http://localhost:3000";
function log(...args) { console.log("[nudge]", ...args); }
async function clickSel(page, selector) { return page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, selector); }
async function pressSpace(page) { await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }))); }
async function bodyText(page) { return page.evaluate(() => document.body.innerText); }
async function currentFloorClasses(page) { return page.evaluate(() => { const el = document.querySelector(".floor-stop.current"); return el ? el.className : null; }); }
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

  // 1) my own (p1) click should nudge p1's own view
  await clickSel(p1, '[data-action="vote-up"]');
  await waitFor(async () => {
    const cls = await currentFloorClasses(p1);
    return cls && cls.includes("nudge-up");
  }, { label: "p1 sees nudge-up after its own vote-up click", timeout: 3000 });
  log("p1's own vote-up click triggered nudge-up on p1's view");

  // 2) the OPPONENT's click should also nudge, on BOTH viewers -- confirms it reflects the
  // combined aggregate (both players contribute), not just "my own" clicks
  await p1.waitForTimeout(500); // let the previous animation fully finish
  await clickSel(p2, '[data-action="vote-down"]');
  await waitFor(async () => {
    const cls1 = await currentFloorClasses(p1);
    return cls1 && cls1.includes("nudge-down");
  }, { label: "p1 sees nudge-down after p2's (opponent's) vote-down click", timeout: 3000 });
  log("p2's (opponent's) vote-down click correctly triggered nudge-down on p1's view too");

  await waitFor(async () => {
    const cls2 = await currentFloorClasses(p2);
    return cls2 && cls2.includes("nudge-down");
  }, { label: "p2 also sees nudge-down on its own view", timeout: 3000 });
  log("p2 also sees the nudge on its own view (own click)");

  // 3) still no raw vote numbers exposed anywhere during this
  const p1Text = await bodyText(p1);
  if (/[▲▼]\s*\d+.*[▲▼]\s*\d+/.test(p1Text.replace(/\n/g, " ")) && p1Text.includes("상대")) {
    throw new Error("opponent's vote tally leaked into the DOM alongside the nudge feature");
  }
  log("confirmed: no opponent vote-count leak introduced by the nudge feature");

  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => { console.error("[nudge] FAILED:", e); process.exit(1); });
