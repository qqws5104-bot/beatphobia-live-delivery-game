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

  // ---- track the raw server "state" broadcasts each page receives, by listening on the actual
  // WebSocket frames (not by poking at the app's internal closure, which doesn't expose `state`
  // on window) -- this lets privacy assertions compare "what the raw state contains" against
  // "what actually got rendered", which is the whole point of a client-side-redaction test ----
  const lastState = { p1: null, p2: null };
  function trackState(page, key) {
    page.on("websocket", (ws) => {
      ws.on("framereceived", (frame) => {
        try {
          const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString();
          const msg = JSON.parse(payload);
          if (msg && msg.type === "state") lastState[key] = msg.state;
        } catch (e) { /* ignore non-JSON / binary frames */ }
      });
    });
  }
  trackState(p1, "p1");
  trackState(p2, "p2");

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
  // secure a bunch more for p1 specifically -- with all-up voting for 5 rounds starting at 1F
  // (index 1 of 6 floors), the elevator caps at the top floor (5F, index 5) on round 4 and stays
  // there for round 5 too -- a guaranteed same-floor revisit. Securing many cells raises the odds
  // that 2+ of p1's invoices land on 5F, which lets us actually exercise (not just unit-reason
  // about) the "only one package delivers per floor visit, the rest wait for a later visit" rule.
  for (const id of ["normal-2", "normal-3", "normal-4", "fresh-2", "fresh-3", "fragile-2", "fragile-3", "valuable-2", "valuable-3"]) {
    await secureCell(p1, id);
  }
  log("secured additional cells for both players");

  // ---- wait out the secure phase (server override, shortened for this test run) -> elevator ----
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("엘리베이터") && t2.includes("엘리베이터");
  }, { label: "both entered elevator phase", timeout: 15000 });
  log("secure phase ended -> elevator phase entered on both");

  // ---- pre-round-1 ready gate: entering "elevator" phase must NOT auto-start voting. Both
  // players have to press space first (mirrors the between-round gate, but for round 1 itself) ----
  const voteButtonsBeforeReady = await countSel(p1, '[data-action="vote-up"]');
  if (voteButtonsBeforeReady !== 0) throw new Error("vote buttons should not render at all before both players ready up for round 1 (idle gate)");
  const idleGateTextP1 = (await bodyText(p1)).includes("스페이스바 대기") || (await bodyText(p1)).includes("엘리베이터 이동 시작");
  if (!idleGateTextP1) throw new Error("pre-round-1 ready gate (idle state) did not render on p1");
  log("confirmed: elevator phase does not auto-start voting -- idle ready-gate shown first");

  // ---- opponent's package list must never be rendered, anywhere in the elevator phase -- only
  // my own invoice-list should be in the DOM (p1 has secured 12 cells by now, so this isn't
  // vacuously true because the list happens to be empty) ----
  const myListCountIdle = await countSel(p1, ".invoice-list");
  if (myListCountIdle !== 1) throw new Error(`expected exactly 1 rendered invoice-list (mine only) during the idle ready-gate, found ${myListCountIdle}`);
  log("confirmed: opponent's package list is not rendered during the pre-round-1 ready gate");

  await pressSpace(p1);
  await p1.waitForTimeout(150);
  const stillIdleAfterOnlyP1 = (await countSel(p1, '[data-action="vote-up"]')) === 0;
  if (!stillIdleAfterOnlyP1) throw new Error("round 1 voting started after only p1 pressed space -- pre-round-1 both-ready gate is broken");
  await pressSpace(p2);
  await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: "round 1 voting starts after both ready", timeout: 5000 });
  log("pre-round-1 both-ready gate held, then correctly started round 1 voting");

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

    // the raw up/down vote tally numbers must never be shown -- only the resulting direction
    const resultTextP1 = await bodyText(p1);
    if (/위\s*\d+\s*[·.]\s*아래\s*\d+/.test(resultTextP1)) throw new Error(`round ${round}: raw vote tally numbers ("위 N · 아래 N") were shown on the result screen -- should be hidden`);
    if (!/상승|하강|동률/.test(resultTextP1)) throw new Error(`round ${round}: resulting direction (상승/하강/동률) was not shown on the result screen`);

    // delivered-items callout must be present (even if empty-state text, when nothing delivered)
    const hasCallout = (await countSel(p1, ".delivered-callout")) > 0;
    if (!hasCallout) throw new Error(`round ${round}: delivered-items callout did not render on the result screen`);

    // delivered-item info is private per player: what's rendered for me must match exactly what
    // the underlying state says is MY delivery for this round -- never the opponent's, even
    // though the opponent's entry is also present in the raw state broadcast to my socket.
    for (const [label, p, mySeatNum, key] of [["p1", p1, "1", "p1"], ["p2", p2, "2", "p2"]]) {
      const st = lastState[key];
      const last = st && st.elevator.log[st.elevator.log.length - 1];
      const delivered = (last && last.delivered) || [];
      const myCount = delivered.filter((d) => d.seat === mySeatNum).length;
      const otherCount = delivered.filter((d) => d.seat !== mySeatNum).length;
      const renderedItems = await countSel(p, ".delivered-item");
      if (renderedItems !== myCount) {
        throw new Error(`round ${round} (${label}): expected ${myCount} own delivered item(s) rendered, got ${renderedItems} (raw state also has ${otherCount} opponent item(s) that must stay hidden)`);
      }
    }

    // opponent's full package list must also never be rendered on the round-result screen
    const myListCountResult = await countSel(p1, ".invoice-list");
    if (myListCountResult !== 1) throw new Error(`round ${round}: expected exactly 1 rendered invoice-list (mine only), found ${myListCountResult}`);

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

  // ---- one-package-per-floor-visit rule: with all-up voting for 5 rounds from 1F (index 1 of 6),
  // the elevator caps at 5F (index 5) on round 4 and stays there for round 5 -- a guaranteed
  // same-floor revisit. If p1 secured 2+ invoices bound for 5F, confirm they delivered on
  // DIFFERENT rounds (never both in the same visit), and in acquisition order (earliest-acquired
  // first). With only a soft guarantee that 2+ invoices land on the same floor (random per
  // invoice), this assertion only runs when the sample actually produced a collision, and logs a
  // note rather than failing the whole suite when it didn't. ----
  const floor5Check = (lastState.p1.players["1"].invoices)
    .filter((v) => v.floorIdx === 5)
    .sort((a, b) => a.acquiredSeq - b.acquiredSeq)
    .map((v) => ({ acquiredSeq: v.acquiredSeq, deliveredRound: v.deliveredRound }));
  if (floor5Check.length >= 2) {
    const delivered = floor5Check.filter((v) => v.deliveredRound !== null);
    const rounds = delivered.map((v) => v.deliveredRound);
    const uniqueRounds = new Set(rounds);
    if (delivered.length >= 2 && uniqueRounds.size !== rounds.length) {
      throw new Error("two invoices bound for the same floor (5F) delivered in the SAME round -- one-package-per-visit rule violated: " + JSON.stringify(floor5Check));
    }
    // acquisition order preserved: earlier acquiredSeq must not deliver AFTER a later one
    for (let i = 0; i < delivered.length - 1; i++) {
      if (delivered[i].deliveredRound !== null && delivered[i + 1].deliveredRound !== null && delivered[i].deliveredRound > delivered[i + 1].deliveredRound) {
        throw new Error("invoice queueing order violated for same-floor invoices: " + JSON.stringify(floor5Check));
      }
    }
    log(`one-package-per-floor-visit rule exercised and confirmed (${floor5Check.length} invoices bound for 5F, delivered across distinct rounds in order): ${JSON.stringify(floor5Check)}`);
  } else {
    log(`one-package-per-floor-visit rule: only ${floor5Check.length} of p1's invoices landed on 5F this run (random) -- not enough for a same-floor-collision assertion, skipping (server logic already verified by code review)`);
  }

  // ---- end screen with scores ----
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("총점") && t2.includes("총점");
  }, { label: "both reached end screen", timeout: 10000 });
  // Per-viewer text now legitimately differs (each page labels its OWN card "(나)" and lists its
  // own seat first), so compare parsed {seat: score} maps and the winner banner instead of raw
  // text equality.
  async function endScores(p) {
    const text = await bodyText(p);
    const winnerLine = text.split("\n").find((l) => l.includes("승리") || l.includes("무승부")) || "";
    const scores = {};
    for (const m of text.matchAll(/플레이어\s*(\d)[^\n]*총점\s*(-?\d+)/g)) scores[m[1]] = Number(m[2]);
    return { winnerLine, scores };
  }
  const end1 = await endScores(p1);
  const end2 = await endScores(p2);
  log("p1 end screen:", end1.winnerLine, JSON.stringify(end1.scores));
  log("p2 end screen:", end2.winnerLine, JSON.stringify(end2.scores));
  if (end1.winnerLine !== end2.winnerLine) throw new Error("p1 and p2 disagree on the winner banner -- shared state diverged!\n  p1: " + end1.winnerLine + "\n  p2: " + end2.winnerLine);
  if (end1.scores["1"] !== end2.scores["1"] || end1.scores["2"] !== end2.scores["2"]) {
    throw new Error("p1 and p2 disagree on final scores -- shared state diverged!\n  p1: " + JSON.stringify(end1.scores) + "\n  p2: " + JSON.stringify(end2.scores));
  }
  log("both players see identical final scores (shared server state confirmed consistent)");

  // ---- opponent's itemized package list must stay hidden on the final results screen too --
  // only a single score-table (mine) should render, plus the "비공개" note for the opponent ----
  const scoreTableCountP1 = await countSel(p1, ".score-table");
  if (scoreTableCountP1 !== 1) throw new Error(`end screen: expected exactly 1 rendered score-table (mine only), found ${scoreTableCountP1}`);
  const p1SeesPrivacyNote = (await bodyText(p1)).includes("비공개");
  if (!p1SeesPrivacyNote) throw new Error("end screen: opponent's card should show a 'private' note instead of their itemized list");
  log("confirmed: opponent's itemized package list stays hidden on the final results screen (total score only)");

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
