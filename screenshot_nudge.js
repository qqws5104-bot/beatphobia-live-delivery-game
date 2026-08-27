"use strict";
const { chromium } = require("playwright");
const path = require("path");
const OUT = "/tmp/shots_nudge";
require("fs").mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:3000";

async function clickSel(page, selector) { return page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, selector); }
async function pressSpace(page) { await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }))); }
async function bodyText(page) { return page.evaluate(() => document.body.innerText); }
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

  const ctx1 = await browser.newContext({ viewport: { width: 900, height: 700 } });
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

  await clickSel(p1, '[data-action="vote-up"]');
  await p1.waitForTimeout(120); // just after the landing pop
  await p1.locator(".shaft").screenshot({ path: path.join(OUT, "nudge_up_just_after_click.png") });

  await p1.waitForTimeout(1800); // well past the old 550ms auto-revert window -- should still be lit
  await p1.locator(".shaft").screenshot({ path: path.join(OUT, "nudge_up_persisted_1.8s_later.png") });

  // now flip direction via the opponent (p2) -- the old hop-up target must clear and the highlight
  // must move to the floor below instead, with no row left stuck
  await clickSel(p2, '[data-action="vote-down"]');
  await p1.waitForTimeout(200);
  await p1.locator(".shaft").screenshot({ path: path.join(OUT, "nudge_down_after_opponent_flip.png") });

  await browser.close();
  console.log("saved to", OUT);
}

main().catch((e) => { console.error("FAILED", e); process.exit(1); });
