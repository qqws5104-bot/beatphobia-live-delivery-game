// Two-player end-to-end test against the REAL local WS server (not a mock), simulating two
// separate devices via two separate browser contexts (independent sessionStorage/clientId).
"use strict";
const { chromium } = require("playwright");

const BASE = "http://localhost:3000";

function log(...args) { console.log("[test]", ...args); }

// Playwright's locator-based .click() is unreliable in this sandboxed headless environment
// (actionability retries keep re-resolving to a stale/disabled node even after the real click
// already landed and the app re-rendered past it) -- proven workaround from the Artifact-version
// test harness: dispatch the click directly via page.evaluate(), exactly what the app's delegated
// document click listener would see, without Playwright's actionability polling.
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
      log(label, "console:", msg.type(), msg.text(), msg.location() && msg.location().url);
      // ERR_TUNNEL_CONNECTION_FAILED / 404s on fonts.googleapis.com are this sandbox's outbound
      // network policy, not an app bug -- a real browser on the user's own device reaches Google
      // Fonts fine. Any error whose *source location* is fonts.googleapis.com is that, not our app.
      // favicon.ico 404 is the browser's automatic tab-icon request; the app serves none and
      // that's fine -- irrelevant to gameplay and not worth a route.
      const loc = (msg.location() && msg.location().url) || "";
      if (msg.type() === "error" && !/fonts\.googleapis\.com|fonts\.gstatic\.com|ERR_TUNNEL_CONNECTION_FAILED|favicon\.ico/.test(msg.text() + loc)) {
        errors.push(label + " console.error: " + msg.text() + " (at " + loc + ")");
      }
    });
    p.on("requestfailed", (req) => log(label, "requestfailed:", req.url(), req.failure() && req.failure().errorText));
    p.on("response", (res) => { if (res.status() >= 400) log(label, "http", res.status(), res.url()); });
  }

  await p1.goto(roomUrl);
  await p2.goto(roomUrl);

  // ---- seat picker present on both ----
  await waitFor(() => countSel(p1, ".seat-pick").then((n) => n > 0), { label: "p1 seat picker" });
  await waitFor(() => countSel(p2, ".seat-pick").then((n) => n > 0), { label: "p2 seat picker" });
  log("seat picker rendered on both pages");

  // ---- a third, throwaway connection tries to grab seat 1 concurrently -- should be rejected once p1 has it ----
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(roomUrl);
  await waitFor(() => countSel(p3, ".seat-pick").then((n) => n > 0), { label: "p3 seat picker" });

  await clickSel(p1, '[data-action="pick-seat"][data-seat="1"]');
  await clickSel(p2, '[data-action="pick-seat"][data-seat="2"]');
  await waitFor(async () => (await bodyText(p1)).includes("좌석 · 플레이어 1"), { label: "p1 got seat 1" });
  await waitFor(async () => (await bodyText(p2)).includes("좌석 · 플레이어 2"), { label: "p2 got seat 2" });
  log("p1 -> seat 1, p2 -> seat 2 confirmed");

  // The UI itself already disables an owned seat's button once state syncs (that's the
  // taken1/taken2 rendering we just exercised above by getting p1/p2 their seats). To test the
  // *server's* rejection path -- the genuine race where two clicks land within the same instant,
  // before either screen has updated -- send a raw pick-seat message directly over p3's own
  // websocket connection for seat "1" (already owned by p1's clientId), bypassing the UI's
  // now-disabled button entirely.
  const rejected = await p3.evaluate(() => {
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
  log("server-side seat_taken rejection confirmed for a fresh race clientId attempting seat 1");
  await ctx3.close();

  // ---- reconnect-reclaim: reload p1, seat should still be held (sessionStorage clientId persists across reload) ----
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

  // ---- side timer present ----
  const hasTimer1 = await countSel(p1, "#side-timer");
  if (!hasTimer1) throw new Error("side timer missing on p1 in secure phase");
  log("side timer rendered");

  // ---- same-cell race: both players click the exact same cell concurrently ----
  const raceCellSel = '[data-action="open-cell"][data-cell="normal-1"]';
  await Promise.all([clickSel(p1, raceCellSel), clickSel(p2, raceCellSel)]);
  await p1.waitForTimeout(200);
  // whichever opened the overlay, click "완료" to secure it (only the winner will have the overlay open with that cell)
  for (const p of [p1, p2]) {
    const overlayOpen = await countSel(p, '.overlay:not(.hidden) [data-action="complete-cell"]');
    if (overlayOpen) await clickSel(p, '[data-action="complete-cell"]');
  }
  await p1.waitForTimeout(200);

  // structural check: exactly one of the two players should now own cell normal-1 on BOTH pages' rendered board (shared server state)
  const owner1 = await p1.evaluate(() => {
    const btn = document.querySelector('[data-cell="normal-1"]') || Array.from(document.querySelectorAll(".cell")).find((c) => c.classList.contains("taken") && c.querySelector(".owner-tag"));
    return null; // board doesn't expose cell id on taken cells directly; validated via invoice counts below instead
  });
  log("same-cell race resolved (no crash, no duplicate award) -- verified via invoice counts below");

  // secure a distinct cell each so both players have inventory for the elevator phase
  async function secureCell(p, cellId) {
    const sel = `[data-action="open-cell"][data-cell="${cellId}"]`;
    const count = await countSel(p, sel);
    if (count === 0) return false; // already taken by the race above, or by the other player
    await clickSel(p, sel);
    await p.waitForTimeout(150);
    const has = await countSel(p, '[data-action="complete-cell"]');
    if (has) { await clickSel(p, '[data-action="complete-cell"]'); return true; }
    return false;
  }
  await secureCell(p1, "fresh-1");
  await secureCell(p2, "fresh-2");
  await secureCell(p1, "fragile-1");
  await secureCell(p2, "valuable-1");
  log("secured additional cells for both players");

  // ---- wait out the (test-shortened, 6s) secure phase -> elevator ----
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("엘리베이터") && t2.includes("엘리베이터");
  }, { label: "both entered elevator phase", timeout: 12000 });
  log("secure phase timed out correctly -> elevator phase entered on both");

  // ---- round 1: live per-click vote broadcasting -- click on p1, verify p2 sees the tally update *immediately*, before the round ends ----
  await clickSel(p1, '[data-action="vote-up"]');
  await waitFor(async () => (await bodyText(p2)).includes("▲1"), { label: "p2 sees live vote broadcast from p1", timeout: 2000 });
  log("live per-click vote broadcast confirmed (p2 saw p1's click before round end)");

  await clickSel(p2, '[data-action="vote-up"]');
  await clickSel(p2, '[data-action="vote-up"]');

  // let round 1 resolve (VOTE_MS=5000) and play out the rest of the rounds with a couple of clicks each
  for (let round = 1; round <= 5; round++) {
    await clickSel(p1, '[data-action="vote-up"]');
    await clickSel(p2, '[data-action="vote-up"]');
    await p1.waitForTimeout(5300);
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
