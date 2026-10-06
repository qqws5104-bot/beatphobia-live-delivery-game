// 2026-10-06: 라이브 게임 안에서 "택배 종류별 미니게임"이 실제로 도는지 검증 (진짜 브라우저 2개 + 진짜 WS 서버).
//
// test_minigames.js는 시험장 페이지에서 게임 자체를 검증하고, 이 파일은 그 게임이 실제 게임에 붙었을 때의
// 통합 문제를 본다:
//   - 카테고리별로 올바른 게임이 뜨는가 (일반=박스 포장 / 깨지기=이상 확인 / 확정 층수=송장 붙이기 / 귀중품=우봉고)
//   - 진짜로 풀면 칸이 확보되고(secure-cell), 포기하면 확보되지 않는가
//   - ★ 플레이 도중에 상대가 칸을 확보해 서버 상태 브로드캐스트가 와도 내 게임이 안 날아가는가
//     (render()가 #app을 통째로 갈아엎기 때문에, 미니게임을 #app 안에 두면 이게 깨진다)
//   - 확보 시간이 끝나면 열려 있던 게임이 닫히는가
//
// 사전 준비: game-data.js의 SECURE_PHASE_MS를 임시로 25초로 줄이고(`25 * 1000`) build_client.py 재빌드 +
// 서버 재시작. 끝나면 반드시 원복 (HANDOVER 5.3).
"use strict";
const { chromium } = require("playwright");
const { COURIERS, FLOORS, TYPES } = require("./game-data.js");
const COURIER_NAME = {};
COURIERS.forEach((c) => { COURIER_NAME[c.key] = c.name; });

const BASE = "http://localhost:3000";
function log(...a) { console.log("[test-minigames-live]", ...a); }
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", space: "Space" };

async function clickSel(page, sel) {
  return page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);
}
const countSel = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const bodyText = (page) => page.evaluate(() => document.body.innerText);
async function pressSpace(page) {
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })));
}
async function waitFor(fn, { timeout = 8000, interval = 80, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label);
    await sleep(interval);
  }
}

// 확보된 칸은 클라이언트가 data-cell/data-action을 떼어낸다(renderBoard) -- 그래서 "확보됨"은 열기 버튼이 사라진 것으로 판단.
const isOpenable = (page, id) => countSel(page, `[data-action="open-cell"][data-cell="${id}"]`).then((n) => n === 1);
const isTaken = (page, id) => countSel(page, `[data-action="open-cell"][data-cell="${id}"]`).then((n) => n === 0);

// 열려 있는 미니게임을 진짜로 푼다 (사람이 하는 것과 같은 입력: 키보드 / 마우스 드래그).
async function playOpenGame(page) {
  const kind = await page.evaluate(() => {
    const r = document.querySelector("#mg-layer .mg-root");
    const m = r && r.className.match(/mg-kind-(\w+)/);
    return m ? m[1] : null;
  });
  if (kind === "pack" || kind === "inspect") {
    const seq = (await page.getAttribute("#mg-layer .mg-body", "data-seq")).split(",");
    for (const k of seq) await page.keyboard.press(KEY[k]);
  } else if (kind === "sticker") {
    const geom = () => page.evaluate(() => {
      const t = document.querySelector(".mg-target.is-on");
      const l = document.querySelector(".mg-label[data-label]:not([data-stuck])");
      const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      return { t: t ? rect(t) : null, l: l ? rect(l) : null };
    });
    const total = await page.evaluate(() => document.querySelectorAll(".mg-label[data-label]").length); // 시작 시점엔 1장
    let stuck = 0;
    for (;;) {
      await waitFor(async () => { const g = await geom(); return g.l && g.t; }, { label: "sticker label ready" });
      const g = await geom();
      await page.mouse.move(g.l.x + g.l.w / 2, g.l.y + g.l.h / 2);
      await page.mouse.down();
      await page.mouse.move(g.t.x + g.t.w / 2, g.t.y + g.t.h / 2, { steps: 10 });
      await page.mouse.up();
      stuck++;
      await sleep(350); // 다음 송장이 나오거나(레벨 2~3) 게임이 끝나길 기다림
      if (!(await page.$("#mg-layer .mg-root")) || (await page.$(".mg-done.is-on"))) break;
    }
  }
  return kind;
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const seedCtx = await browser.newContext();
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(BASE + "/");
  const room = new URL(seedPage.url()).searchParams.get("room");
  await seedCtx.close();
  const roomUrl = BASE + "/?room=" + room + "&mgtest=1";
  log("room:", room);

  const ctx1 = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const p1 = await ctx1.newPage(), p2 = await ctx2.newPage();
  const errors = [];
  for (const [label, p] of [["p1", p1], ["p2", p2]]) {
    p.on("pageerror", (e) => errors.push(label + " pageerror: " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource|favicon/.test(m.text())) errors.push(label + " console: " + m.text()); });
  }
  await p1.goto(roomUrl); await p2.goto(roomUrl);
  await waitFor(() => countSel(p1, ".seat-pick").then((n) => n > 0), { label: "seat picker" });
  await clickSel(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await bodyText(p1)).includes(COURIER_NAME.cookbang), { label: "p1 courier" });
  await clickSel(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await bodyText(p2)).includes(COURIER_NAME.cheonil), { label: "p2 courier" });
  await pressSpace(p1); await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "secure phase" });
  log("확보 단계 진입");

  // ---- a. 보드의 카테고리별 게임 이름 표시 ----
  const board = await bodyText(p1);
  for (const name of ["박스 포장", "이상 확인", "송장 붙이기", "우봉고"]) assert(board.includes(name), `board should name the game '${name}'`);
  log("보드에 카테고리별 게임 이름 표시: 박스 포장 / 이상 확인 / 송장 붙이기 / 우봉고");

  // ---- b. 일반택배 -> 박스 포장, 남은 확보 시간 표시 ----
  await clickSel(p1, '[data-action="open-cell"][data-cell="normal-1"]');
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-pack")) === 1, { label: "일반택배 = 박스 포장" });
  const clock = await p1.textContent("#mg-clock");
  assert(/^\d:\d\d$/.test(clock), "secure-phase clock shown inside the game layer, got: " + clock);
  log(`일반택배 칸 -> 박스 포장 열림, 확보 남은 시간 ${clock} 표시`);

  // ---- c. ★ 플레이 도중 상대의 확보로 상태 브로드캐스트가 와도 내 게임이 유지되는가 ----
  const seq = (await p1.getAttribute("#mg-layer .mg-body", "data-seq")).split(",");
  await p1.keyboard.press(KEY[seq[0]]); await p1.keyboard.press(KEY[seq[1]]);
  assert((await countSel(p1, "#mg-layer .mg-chip.is-done")) === 2, "2 chips done before the broadcast");
  await clickSel(p2, '[data-action="open-cell"][data-cell="normal-2"]');
  await waitFor(async () => (await countSel(p2, "#mg-layer .mg-root")) === 1, { label: "p2 game open" });
  await p2.evaluate(() => window.__mgFinish());                      // p2가 칸 하나 확보 -> 서버가 p1에게도 state 브로드캐스트
  await waitFor(async () => (await countSel(p2, ".cell.taken")) === 1, { label: "p2 secured normal-2" });
  await sleep(300);                                                   // p1 쪽 render() 이후까지 여유
  assert((await countSel(p1, "#mg-layer .mg-kind-pack")) === 1, "p1's game must still be open after a state broadcast");
  assert((await countSel(p1, "#mg-layer .mg-chip.is-done")) === 2, "p1's progress (2 chips) must survive the broadcast");
  log("★ 플레이 도중 상대가 칸을 확보해 상태 브로드캐스트가 와도 내 게임/진행도 유지됨");

  // ---- d. 박스 포장을 진짜로 끝내면 확보 ----
  for (let i = 2; i < seq.length; i++) await p1.keyboard.press(KEY[seq[i]]);
  await p1.keyboard.press("Space");
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-root")) === 0, { label: "pack closes after completion" });
  await waitFor(async () => (await countSel(p1, '.cell.taken')) === 1, { label: "normal-1 secured on p1" });
  assert(await isTaken(p1, "normal-1"), "normal-1 must be the taken cell");
  assert(await isOpenable(p1, "normal-3"), "other cells stay untaken");
  log("박스 포장 완주 -> 레이어 닫힘 + normal-1 확보");

  // ---- e. 깨지기 -> 이상 확인 (진짜로 분류/폐기) ----
  await clickSel(p1, '[data-action="open-cell"][data-cell="fragile-1"]');
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-inspect")) === 1, { label: "깨지기 = 이상 확인" });
  assert((await p1.$$("#mg-layer .mg-pkg")).length === 8, "fragile starts at level 2 (8 packages)");
  await playOpenGame(p1);
  await waitFor(() => isTaken(p1, "fragile-1"), { label: "fragile-1 secured" });
  log("깨지기 택배 칸 -> 이상 확인(8개) 완주 -> fragile-1 확보");

  // ---- f. 확정 층수 -> 송장 붙이기 (송장에 그 칸의 층이 찍힘) ----
  await clickSel(p1, '[data-action="open-cell"][data-cell="fixed-floor-2"]');
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-sticker")) === 1, { label: "확정 층수 = 송장 붙이기" });
  const labelText = await p1.textContent("#mg-layer .mg-label .lb-room");
  assert(labelText === FLOORS[1], `sticker label should show this cell's floor (${FLOORS[1]}), got ${labelText}`);
  await playOpenGame(p1);
  await waitFor(() => isTaken(p1, "fixed-floor-2"), { label: "fixed-floor-2 secured" });
  // 확보된 칸의 얼굴에는 송장 목적지(호수)가 찍힌다 -- 보드에서 1F 행 칸(fixed-floor 행의 2번째)의 .invoice-label을 읽는다.
  const faceText = await p1.evaluate(() => {
    const row = Array.from(document.querySelectorAll(".board-row")).find((r) => r.textContent.includes("확정 층수"));
    const cells = row.querySelectorAll(".cell");
    const lab = cells[1].querySelector(".invoice-label");
    return lab ? lab.textContent : null;
  });
  assert(/^10\d호$/.test(faceText), `invoice on fixed-floor-2 must be a 1F room (10N호), got ${faceText}`);
  log(`확정 층수 칸 -> 송장 붙이기(송장에 '${labelText}') 완주 -> 확보, 송장 목적지 ${faceText} (1F)`);

  // ---- g. 귀중품은 우봉고 그대로 ----
  await clickSel(p1, '[data-action="open-cell"][data-cell="valuable-1"]');
  await waitFor(async () => (await countSel(p1, ".puzzle-frame")) === 1, { label: "귀중품 = 우봉고 퍼즐 이미지" });
  assert((await countSel(p1, "#mg-layer .mg-root")) === 0, "valuable must not open a mini-game");
  await clickSel(p1, '[data-action="complete-cell"]');
  await waitFor(() => isTaken(p1, "valuable-1"), { label: "valuable-1 secured via 완료" });
  log("귀중품 칸 -> 우봉고(퍼즐 이미지 + 완료 버튼) 그대로 동작");

  // ---- h. 포기: 확보되지 않음 ----
  await clickSel(p1, '[data-action="open-cell"][data-cell="fixed-floor-3"]');
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-sticker")) === 1, { label: "sticker open for give-up" });
  await clickSel(p1, "#mg-layer .mg-giveup");
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-root")) === 0, { label: "give-up closes" });
  assert(await isOpenable(p1, "fixed-floor-3"), "giving up must not secure the cell");
  log("포기 -> 레이어 닫힘, 칸 미확보");

  // ---- i. 확보 시간이 끝나면 열려 있던 게임이 닫힌다 ----
  await clickSel(p1, '[data-action="open-cell"][data-cell="normal-3"]');
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-root")) === 1, { label: "game open at the end" });
  await waitFor(async () => (await bodyText(p1)).includes("엘리베이터"), { timeout: 40000, label: "secure phase ends -> elevator" });
  assert((await countSel(p1, "#mg-layer .mg-root")) === 0, "an open game must be closed when the secure phase ends");
  assert(await p1.evaluate(() => document.getElementById("mg-layer").classList.contains("hidden")), "layer hidden after the phase ended");
  log("확보 시간 종료 -> 열려 있던 게임이 자동으로 닫히고 엘리베이터 단계로 넘어감");

  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => { console.error("[test-minigames-live] FAILED:", e); process.exit(1); });
