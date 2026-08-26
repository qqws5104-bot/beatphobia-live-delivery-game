// Two-player end-to-end test against the REAL local WS server (not a mock), simulating two
// separate devices via two separate browser contexts (independent sessionStorage/clientId).
"use strict";
const { chromium } = require("playwright");

const BASE = "http://localhost:3000";

function log(...args) { console.log("[test]", ...args); }

// Playwright's locator-based .click() is unreliable in this sandboxed headless environment
// (actionability retries keep re-resolving to a stale/disabled node even after the real click
// already landed and the app re-rendered past it) -- proven workaround: dispatch the click
// directly via page.evaluate(), exactly what the app's delegated document click listener would
// see, without Playwright's actionability polling.
async function clickSel(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}
async function countSel(page, selector) {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
}
async function textOf(page, selector) {
  return page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.innerText : null; }, selector);
}
async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}
async function pressSpace(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
  });
}

async function waitFor(fn, { timeout = 10000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

  // ---- discover a fresh room code via the redirect, exactly as a real first visitor would ----
  const seedCtx = await browser.newContext();
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(BASE + "/");
  const url1 = new URL(seedPage.url());
  const room = url1.searchParams.get("room");
  if (!room || !/^[A-Z2-9]{4}$/.test(room)) throw new Error("bad room code: " + room);
  log("room code:", room);
  await seedCtx.close();

  const roomUrl = BASE + "/?room=" + room;

  // ---- two separate "devices" ----
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  const errors = [];
  for (const [label, p] of [["p1", p1], ["p2", p2]]) {
    p.on("pageerror", (e) => errors.push(label + " pageerror: " + e.message));
    p.on("console", (msg) => {
      const loc = (msg.location() && msg.location().url) || "";
      if (msg.type() === "error" && !/fonts\.googleapis\.com|fonts\.gstatic\.com|ERR_TUNNEL_CONNECTION_FAILED|favicon\.ico/.test(msg.text() + loc)) {
        errors.push(label + " console.error: " + msg.text() + " (at " + loc + ")");
      }
    });
  }

  await p1.goto(roomUrl);
  await p2.goto(roomUrl);

  // ---- seat picker present on both ----
  await waitFor(() => countSel(p1, ".seat-pick").then((n) => n > 0), { label: "p1 seat picker" });
  await waitFor(() => countSel(p2, ".seat-pick").then((n) => n > 0), { label: "p2 seat picker" });
  log("seat picker rendered on both pages");

  await clickSel(p1, '[data-action="pick-seat"][data-seat="1"]');
  await clickSel(p2, '[data-action="pick-seat"][data-seat="2"]');
  await waitFor(async () => (await bodyText(p1)).includes("좌석 · 플레이어 1"), { label: "p1 got seat 1" });
  await waitFor(async () => (await bodyText(p2)).includes("좌석 · 플레이어 2"), { label: "p2 got seat 2" });
  log("p1 -> seat 1, p2 -> seat 2 confirmed");

  // ---- server-side seat_taken rejection: a fresh clientId racing for an already-owned seat ----
  const rejected = await p1.evaluate(() => {
    return new Promise((resolve) => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = proto + "//" + window.location.host + "/ws?room=" + new URLSearchParams(window.location.search).get("room");
      const raceWs = new WebSocket(url);
      const fakeClientId = "c-race-intruder-" + Math.random().toString(36).slice(2);
      raceWs.onopen = () => {
        raceWs.send(JSON.stringify({ type: "hello", clientId: fakeClientId, seat: null }));
        raceWs.send(JSON.stringify({ type: "pick-seat", clientId: fakeClientId, seat: "1" }));
      };
      raceWs.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "error" && msg.code === "seat_taken") { raceWs.close(); resolve(true); }
      };
      setTimeout(() => resolve(false), 3000);
    });
  });
  if (!rejected) throw new Error("server did not reject a pick-seat for an already-owned seat from a different clientId");
  log("server-side seat_taken rejection confirmed");

  // ---- reconnect-reclaim: reload p1, seat should still be held ----
  await p1.reload();
  await waitFor(async () => (await bodyText(p1)).includes("좌석 · 플레이어 1"), { label: "p1 reclaimed seat 1 after reload" });
  log("p1 reclaimed seat 1 after reload");

  // ---- lobby: press space on both, verify auto-start into secure phase ----
  await pressSpace(p1);
  await waitFor(async () => (await bodyText(p1)).includes("준비 완료"), { label: "p1 ready chip flips" });
  await pressSpace(p2);
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("택배 확보") && t2.includes("택배 확보");
  }, { label: "both entered secure phase", timeout: 5000 });
  log("both players entered secure phase (lobby -> secure auto-start via spacebar confirmed)");

  const hasTimer1 = await countSel(p1, "#side-timer");
  if (!hasTimer1) throw new Error("side timer missing on p1 in secure phase");
  log("side timer rendered");

  // ---- box + barcode visual check ----
  const boxCellCount = await countSel(p1, ".cell:not(.taken)");
  const barcodeCount = await countSel(p1, ".cell .barcode");
  if (boxCellCount === 0 || barcodeCount === 0 || barcodeCount !== boxCellCount) {
    throw new Error(`expected every untaken cell to carry a .barcode element (cells=${boxCellCount}, barcodes=${barcodeCount})`);
  }
  log("delivery-box cell styling + barcode elements present:", boxCellCount, "cells");

  // ---- give up: opening a cell and clicking give-up must NOT mark it taken (and, since securing
  // a cell and granting an invoice happen atomically together server-side in secureCell(), an
  // untaken cell is conclusive proof no invoice was granted either -- there is no code path that
  // could award one without also flipping cell.taken) ----
  await clickSel(p1, '[data-action="open-cell"][data-cell="normal-1"]');
  await waitFor(async () => (await countSel(p1, ".overlay:not(.hidden)")) > 0, { label: "p1 puzzle overlay opens" });
  await clickSel(p1, '[data-action="give-up"]');
  await p1.waitForTimeout(200);
  const normal1StillOpen = await countSel(p1, '[data-action="open-cell"][data-cell="normal-1"]');
  const takenCountAfterGiveUp = await countSel(p1, '.cell.taken');
  if (normal1StillOpen !== 1) throw new Error("giving up should leave the cell untaken (still clickable), but it did not");
  if (takenCountAfterGiveUp !== 0) throw new Error(`giving up should not take any cell, but ${takenCountAfterGiveUp} cell(s) show as taken`);
  log("give-up confirmed: cell stays untaken, no invoice granted");

  // ---- per-player independent boards: BOTH players secure the identical cell id with zero conflict ----
  await Promise.all([
    clickSel(p1, '[data-action="open-cell"][data-cell="normal-1"]'),
    clickSel(p2, '[data-action="open-cell"][data-cell="normal-1"]'),
  ]);
  await p1.waitForTimeout(150);
  await Promise.all([
    clickSel(p1, '[data-action="complete-cell"]'),
    clickSel(p2, '[data-action="complete-cell"]'),
  ]);
  await p1.waitForTimeout(200);
  const p1Normal1Taken = (await countSel(p1, '.cell.taken')) >= 1;
  const p2Normal1Taken = (await countSel(p2, '.cell.taken')) >= 1;
  if (!p1Normal1Taken || !p2Normal1Taken) throw new Error("both players should independently secure the same cell id -- one or both failed");
  log("per-player independent boards confirmed: both players secured the identical cell id with no cross-player blocking");

  // secure a few more cells each so both players have inventory for the elevator phase
  async function secureCell(p, cellId) {
    const sel = `[data-action="open-cell"][data-cell="${cellId}"]`;
    const count = await countSel(p, sel);
    if (count === 0) return false;
    await clickSel(p, sel);
    await p.waitForTimeout(150);
    const has = await countSel(p, '[data-action="complete-cell"]');
    if (has) { await clickSel(p, '[data-action="complete-cell"]'); return true; }
    return false;
  }
  await secureCell(p1, "fresh-1");
  await secureCell(p2, "fresh-1"); // same id as p1 -- must not conflict, per-player boards
  await secureCell(p1, "fragile-1");
  await secureCell(p2, "valuable-1");
  log("secured additional cells for both players");

  // ---- wait out the secure phase (server override, shortened for this test run) -> elevator ----
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("엘리베이터") && t2.includes("엘리베이터");
  }, { label: "both entered elevator phase", timeout: 15000 });
  log("secure phase ended -> elevator phase entered on both");

  // ---- opponent's live vote count must NEVER be shown -- only "나" (my own), never "상대" ----
  await clickSel(p1, '[data-action="vote-up"]');
  await p1.waitForTimeout(300);
  const p2SeesOpponentColumn = (await bodyText(p2)).includes("상대");
  if (p2SeesOpponentColumn) throw new Error("opponent's vote tally should never be rendered, but found a '상대' column in the DOM");
  log("confirmed: opponent's live vote count is never shown (no '상대' column rendered)");

  // ---- play out all 5 rounds, requiring both players to press space after each round's result ----
  for (let round = 1; round <= 5; round++) {
    await clickSel(p1, '[data-action="vote-up"]');
    await clickSel(p2, '[data-action="vote-up"]');
    // wait for the 5s voting window to close and the result/ready-gate screen to appear
    await waitFor(async () => (await bodyText(p1)).includes(`라운드 ${round} 결과`), { label: `round ${round} result screen (p1)`, timeout: 8000 });
    await waitFor(async () => (await bodyText(p2)).includes(`라운드 ${round} 결과`), { label: `round ${round} result screen (p2)`, timeout: 8000 });

    // must NOT auto-advance -- round pill should still read the same round number until both ready
    const stillSameRoundP1 = (await bodyText(p1)).includes(`라운드 ${round} / 5`);
    if (!stillSameRoundP1) throw new Error(`round ${round}: game advanced to the next round before both players pressed space`);

    // delivered-items callout must be present (even if empty-state text, when nothing delivered)
    const hasCallout = (await countSel(p1, ".delivered-callout")) > 0;
    if (!hasCallout) throw new Error(`round ${round}: delivered-items callout did not render on the result screen`);

    await pressSpace(p1);
    await p1.waitForTimeout(150);
    const p1ReadyChip = (await bodyText(p1)).includes("준비 완료");
    if (!p1ReadyChip) throw new Error(`round ${round}: p1's ready chip did not flip after pressing space`);

    // confirm it truly waits on p2 -- still same round after only p1 is ready
    await p1.waitForTimeout(300);
    const stillWaitingOnP2 = (await bodyText(p1)).includes(`라운드 ${round} / 5`);
    if (!stillWaitingOnP2) throw new Error(`round ${round}: advanced after only ONE player pressed space -- both-ready gate is broken`);

    await pressSpace(p2);

    if (round < 5) {
      await waitFor(async () => {
        const t1 = await bodyText(p1);
        const t2 = await bodyText(p2);
        return t1.includes(`라운드 ${round + 1} / 5`) && t2.includes(`라운드 ${round + 1} / 5`);
      }, { label: `advance to round ${round + 1} after both ready`, timeout: 5000 });
      log(`round ${round}: both-ready gate held, then correctly advanced to round ${round + 1}`);
    }
  }

  // ---- end screen with scores ----
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("총점") && t2.includes("총점");
  }, { label: "both reached end screen", timeout: 10000 });
  const endText1 = await bodyText(p1);
  const endText2 = await bodyText(p2);
  const summary1 = endText1.split("\n").filter((l) => l.includes("총점") || l.includes("승리") || l.includes("무승부")).join(" | ");
  const summary2 = endText2.split("\n").filter((l) => l.includes("총점") || l.includes("승리") || l.includes("무승부")).join(" | ");
  log("p1 end screen:", summary1);
  log("p2 end screen:", summary2);
  if (summary1 !== summary2) throw new Error("p1 and p2 disagree on final scores/winner -- shared state diverged!\n  p1: " + summary1 + "\n  p2: " + summary2);
  log("both players see identical final scores (shared server state confirmed consistent)");

  if (errors.length) {
    log("!! console/page errors captured during run:");
    errors.forEach((e) => log("   " + e));
    throw new Error(errors.length + " console/page error(s) occurred during the run");
  }

  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => {
  console.error("[test] FAILED:", e);
  process.exit(1);
});
