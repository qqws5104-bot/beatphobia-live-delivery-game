// 2026-10-08 (배치 v2): 라이브 게임에서 종류별 난이도가 사용자 지정대로 적용되는지.
//   일반택배 = 빙판 배송(보통, L2) / 깨지기 = 지도 배달(어려움, L3: 7x5·송장 4·공사장 6) / 확정 층수 = 배달 경로(어려움: 6x5·막힘 3) /
//   귀중품 = 창고 정리(어려움: 박스 3). miniLevel이 숫자 하나라 전반과 후반의 난이도는 같다 (후반 보드에서 확인).
// 전반 7라운드를 빠르게 흘려보낸 뒤(test_theft_e2e.js와 같은 흐름) 후반 보드에서 각 종류 칸을 열어 직접 센다.
// 사전 준비: SECURE_PHASE_MS를 임시로 단축(예: 10 * 1000) + build_client.py 재빌드 + 서버 재시작. 끝나면 원복.
"use strict";
const { chromium } = require("playwright");
const { COURIERS } = require("./game-data.js");
const { iceSolve } = require("./test_puzzle_solvers.js");
const COURIER_NAME = {};
COURIERS.forEach((c) => { COURIER_NAME[c.key] = c.name; });

const BASE = "http://localhost:3000";
function log(...args) { console.log("[test-half-diff]", ...args); }

async function clickSel(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}
async function countSel(page, selector) { return page.evaluate((sel) => document.querySelectorAll(sel).length, selector); }
async function bodyText(page) { return page.evaluate(() => document.body.innerText); }
async function pressSpace(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
  });
}
async function waitFor(fn, { timeout = 15000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// 2026-10-06: 라운드 준비(스페이스) 직후 우선 택배 지정 10초 창이 열린다 -- 지정할 택배가 있는 쪽은 "확정"으로 통과시킨다.
async function passPriority(p1, p2, nextSel) {
  await waitFor(async () => (await countSel(p1, ".priority-window")) > 0 || (await countSel(p1, nextSel)) > 0, { label: "priority window (or straight on)", timeout: 8000 });
  if ((await countSel(p1, ".priority-window")) === 0) return;
  if (await countSel(p1, '[data-action="confirm-priority"]')) await clickSel(p1, '[data-action="confirm-priority"]');
  if (await countSel(p2, '[data-action="confirm-priority"]')) await clickSel(p2, '[data-action="confirm-priority"]');
  await waitFor(async () => (await countSel(p1, ".priority-window")) === 0, { label: "priority window closes", timeout: 4000 });
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const seedCtx = await browser.newContext();
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(BASE + "/");
  const room = new URL(seedPage.url()).searchParams.get("room");
  await seedCtx.close();
  log("room:", room);
  const roomUrl = BASE + "/?room=" + room + "&mgtest=1"; // 미니게임 칸 빠른 처리용 테스트 훅

  const ctx1 = await browser.newContext(), ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage(), p2 = await ctx2.newPage();
  const errors = [];
  for (const [label, p] of [["p1", p1], ["p2", p2]]) {
    p.on("pageerror", (e) => errors.push(label + " pageerror: " + e.message));
  }

  await p1.goto(roomUrl);
  await p2.goto(roomUrl);
  await waitFor(() => countSel(p1, ".seat-pick").then((n) => n > 0), { label: "seat picker" });

  await clickSel(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await bodyText(p1)).includes(COURIER_NAME.cookbang), { label: "p1 picks cookbang" });
  await clickSel(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await bodyText(p2)).includes(COURIER_NAME.cheonil), { label: "p2 picks cheonil" });

  await pressSpace(p1); await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "전반 secure phase" });
  log("전반 secure phase 진입 -- 아무것도 확보하지 않음(전반 결과는 이 테스트와 무관)");

  await waitFor(async () => {
    const t1 = await bodyText(p1), t2 = await bodyText(p2);
    return t1.includes("엘리베이터") && t2.includes("엘리베이터");
  }, { label: "전반 elevator phase (idle gate) 도달", timeout: 15000 });
  log("전반 elevator phase 진입");

  // 전반 5라운드: 확보한 게 없어 배송도 없다 -- idle/result 게이트만 통과시키며 흘려보낸다.
  for (let round = 1; round <= 7; round++) {
    await pressSpace(p1); await pressSpace(p2); // idle 또는 이전 라운드의 result 게이트 통과
    await passPriority(p1, p2, '[data-action="vote-up"]');
    await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: `전반 round ${round} voting 시작`, timeout: 8000 });
    await clickSel(p1, '[data-action="vote-up"]');
    await clickSel(p2, '[data-action="vote-up"]');
    await waitFor(async () => (await bodyText(p1)).includes(`라운드 ${round} 결과`), { label: `전반 round ${round} 결과`, timeout: 8000 });
  }
  log("전반 7라운드 통과");
  // 7라운드 결과 게이트도 다른 라운드와 동일하게 "둘 다 스페이스"로 넘겨야 half가 끝난다
  // (setElevatorReady: el.state==="result"이고 round>=ELEVATOR_ROUNDS일 때 비로소 _finishHalf 호출).
  await pressSpace(p1); await pressSpace(p2);

  await waitFor(async () => (await bodyText(p1)).includes("전반 종료"), { label: "halftime 화면", timeout: 8000 });
  await pressSpace(p1); await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "후반 secure phase", timeout: 8000 });
  log("후반 secure phase 진입");

  // ---- 후반 보드에서 종류별 게임 열어서 난이도 확인 ----
  const CAT_IDX = { normal: 0, fragile: 1, valuable: 2 };
  const openCell = async (id) => { // 레일 화면: 확정 층수는 층 버튼(open-cell), 나머지는 종류 버튼(open-type)
    const kind = id.replace(/-\d+$/, "");
    await clickSel(p1, kind === "fixed-floor" ? '[data-action="open-cell"][data-cell="' + id + '"]' : '.rail-btn[data-action="open-type"][data-cat="' + CAT_IDX[kind] + '"]');
    await p1.waitForTimeout(500);
  };
  const giveUp = async () => {
    // 미니게임의 포기 버튼(텍스트 '포기')을 누른다
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll("#mg-layer button")).find((x) => x.textContent.trim() === "포기"); if (b) b.click(); });
    await p1.waitForTimeout(300);
  };

  // 2026-10-08 배치 v2: miniLevel이 숫자 하나라 후반도 전반과 같은 난이도다 (일반 = 빙판 배송 보통 / 나머지 어려움).
  await openCell("normal-1");
  const iceRows = JSON.parse(await p1.getAttribute("#mg-layer .mg-body", "data-plan")).rows;
  const iceLen = iceSolve(iceRows).length;
  assert_(await countSel(p1, "#mg-layer .mg-kind-ice") === 1 && iceLen >= 6 && iceLen <= 9, `일반택배 빙판 배송은 보통(L2, 최적 6~9번 미끄러짐)이어야 함, got ${iceLen}`);
  log(`후반 일반택배(빙판 배송, 보통): 최적 ${iceLen}번 미끄러짐`);
  await giveUp();

  await openCell("fragile-1");
  const mapInfo = await p1.evaluate(() => {
    const b = document.querySelector("#mg-layer .mg-body");
    return b ? { grid: b.dataset.grid, targets: b.dataset.targets.split(";").length, blocked: b.dataset.blocked.split(";").filter(Boolean).length } : null;
  });
  assert_(mapInfo && mapInfo.grid === "7,5" && mapInfo.targets === 4 && mapInfo.blocked === 6, `깨지기 지도 배달(어려움): 7x5 지도 / 목표 4개 / 공사장 6칸이어야 함, got ${JSON.stringify(mapInfo)}`);
  assert_((await countSel(p1, "#mg-layer .mg-map.is-covered")) === 1 && (await countSel(p1, "#mg-layer .mg-parcel")) === 4, "지도 배달은 송장 택배 4개가 먼저 뜨고 지도는 가려져 있어야 함");
  await p1.waitForTimeout(3100); // 송장 단계(2.5초)가 끝나면 지도가 뜬다
  assert_((await countSel(p1, "#mg-layer .mg-map.is-covered")) === 0, "송장 단계가 끝나면 지도가 떠야 함");
  log("후반 깨지기(지도 배달, 어려움): 7x5 지도, 송장 4장, 공사장 6칸, 송장 -> 지도 순서");
  await giveUp();

  await openCell("fixed-floor-3");
  const rt = JSON.parse(await p1.getAttribute("#mg-layer .mg-body", "data-plan"));
  assert_(await countSel(p1, "#mg-layer .mg-kind-route") === 1 && rt.rows.length === 5 && rt.rows[0].length === 6 && rt.rows.join("").split("#").length - 1 === 3, `확정 층수 배달 경로(어려움): 6x5 / 막힌 칸 3이어야 함, got ${rt.rows.join("/")}`);
  log("후반 확정 층수(배달 경로, 어려움): 6x5, 막힌 칸 3");
  await giveUp();

  await openCell("valuable-1");
  const skBoxes = await countSel(p1, "#mg-layer .sk-box");
  assert_(skBoxes === 3, `귀중품 창고 정리(어려움): 박스 3개여야 함, got ${skBoxes}`);
  log("후반 귀중품(창고 정리, 어려움): 박스 3개");
  await giveUp();

  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}
function assert_(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
main().catch((e) => { console.error("[test-half-diff] FAILED:", e); process.exit(1); });
