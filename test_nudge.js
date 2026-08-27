"use strict";
// Verifies the elevator car-hop feedback: clicking vote-up/vote-down (from EITHER player) should
// make the NEIGHBORING floor row (current floor +/-1) light up as ".hop-target" with a
// ".hop-up"/".hop-down" direction class shortly after, and it must react to the OPPONENT's clicks
// too (since the feedback is meant to reflect the combined aggregate, not just "my own" clicks) --
// while never exposing the raw vote numbers, and never moving the real ".current" floor marker.
// This version also verifies the "persistent, non-reverting" behavior: the hop must NOT auto-revert
// (it used to fade back out after ~550ms), it must stay lit indefinitely until countered by a click
// in the opposite direction, and a direction flip must leave no OTHER row stuck highlighted.
const { chromium } = require("playwright");

const BASE = "http://localhost:3000";
function log(...args) { console.log("[nudge]", ...args); }
async function clickSel(page, selector) { return page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, selector); }
async function pressSpace(page) { await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }))); }
async function bodyText(page) { return page.evaluate(() => document.body.innerText); }
async function hopTargetClasses(page) { return page.evaluate(() => { const el = document.querySelector(".floor-stop.hop-target"); return el ? el.className : null; }); }
async function hopTargetCount(page) { return page.evaluate(() => document.querySelectorAll(".floor-stop.hop-target").length); }
async function currentFloorStillIntact(page) { return page.evaluate(() => document.querySelectorAll(".floor-stop.current").length === 1); }
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

  // 1) my own (p1) click should hop the neighboring (one-floor-up) row on p1's own view, while
  // the real current-floor marker stays exactly where it was (still exactly one ".current" row)
  await clickSel(p1, '[data-action="vote-up"]');
  await waitFor(async () => {
    const cls = await hopTargetClasses(p1);
    return cls && cls.includes("hop-up");
  }, { label: "p1 sees hop-up on the floor above after its own vote-up click", timeout: 3000 });
  if (!(await currentFloorStillIntact(p1))) throw new Error("the real current-floor marker moved/duplicated during the hop animation");
  log("p1's own vote-up click hopped the floor above on p1's view, real current floor unchanged");

  // 1b) PERSISTENCE: the hop must NOT auto-revert. Wait well past the old 550ms auto-revert window
  // and confirm the hop-up highlight is still there, unprompted by any further click.
  await p1.waitForTimeout(1500);
  {
    const cls = await hopTargetClasses(p1);
    if (!cls || !cls.includes("hop-up")) throw new Error("the hop-up highlight auto-reverted -- it must persist until countered by an opposite-direction click");
  }
  log("hop-up highlight persisted past the old 550ms auto-revert window (no auto-revert) -- OK");

  // 2) the OPPONENT's click in the OPPOSITE direction should clear p1's stale hop-up target and
  // hop to the floor BELOW instead, on BOTH viewers -- confirms it reflects the combined aggregate
  // (both players contribute), not just "my own" clicks, and that a direction flip works.
  await clickSel(p2, '[data-action="vote-down"]');
  await waitFor(async () => {
    const cls1 = await hopTargetClasses(p1);
    return cls1 && cls1.includes("hop-down");
  }, { label: "p1 sees hop-down after p2's (opponent's) vote-down click", timeout: 3000 });
  log("p2's (opponent's) vote-down click correctly hopped the floor below on p1's view too");

  // 2b) DIRECTION-FLIP SAFETY: exactly one row should carry .hop-target after the flip -- the old
  // (now-stale) hop-up row on the floor above must have been cleared, not left stuck highlighted.
  {
    const count = await hopTargetCount(p1);
    if (count !== 1) throw new Error("expected exactly 1 .hop-target row after a direction flip, found " + count + " -- the old target was left stuck highlighted");
  }
  log("direction flip left exactly one .hop-target row (old stale target was correctly cleared)");

  await waitFor(async () => {
    const cls2 = await hopTargetClasses(p2);
    return cls2 && cls2.includes("hop-down");
  }, { label: "p2 also sees the hop on its own view", timeout: 3000 });
  log("p2 also sees the hop on its own view (own click)");

  // 2c) the flipped hop-down state must ALSO persist without auto-reverting
  await p1.waitForTimeout(1500);
  {
    const cls = await hopTargetClasses(p1);
    if (!cls || !cls.includes("hop-down")) throw new Error("the hop-down highlight (after the direction flip) auto-reverted -- it must persist too");
  }
  log("hop-down highlight (post-flip) also persisted past the old auto-revert window -- OK");

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
