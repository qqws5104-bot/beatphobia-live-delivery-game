const { chromium } = require("playwright");
// 2026-10-23 같은 문제 실시간 겨루기 e2e (re_duel.sh). 원본: 엘리베이터 이동 전쟁 e2e (아파트 한 채). 서버: APT_WAR=1, SECURE_PHASE_MS 짧게 (re_war.sh). 앞부분은 test_wall_e2e와 같음
// (원본) 2026-10-16 벽 배송 e2e: 택배 쌓기 몫(3개 중 2개 / 5개 중 3개, 레일에서 고르기) -> 배송(메인 컴퓨터 키보드 Ctrl+호실 2초 유지) -> 오배송.
// 서버: SECURE_PHASE_MS 40초, TUTORIAL=0, WALL 기본(regress.sh 마지막 섹션).
const assert = require("assert");
const OUT = "/tmp/duel_e2e_";
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const mk = async (w, h) => (await b.newContext({ viewport: { width: w || 1280, height: h || 900 } })).newPage();
  const errs = [];
  const s = await mk(); await s.goto("http://localhost:3000/?view=main"); const room = new URL(s.url()).searchParams.get("room");
  s.on("pageerror", e => errs.push("main " + e.message));
  const p1 = await mk(820, 1000), p2 = await mk(820, 1000), rail = await mk(1500, 950);
  [p1, p2, rail].forEach((p, i) => p.on("pageerror", e => errs.push(i + " " + e.message)));
  await p1.goto("http://localhost:3000/?mgtest=1&room=" + room); await p2.goto("http://localhost:3000/?mgtest=1&room=" + room);
  await rail.goto("http://localhost:3000/rail?room=" + room);
  await p1.waitForSelector("[data-courier]"); await p1.click('[data-courier="cookbang"]'); await p1.waitForTimeout(400);
  await p2.click('[data-courier="cheonil"]'); await p2.waitForTimeout(400);
  await p1.keyboard.press("Space"); await p2.keyboard.press("Space"); await p1.waitForTimeout(800);
  // 2026-10-16: 택배 쌓기 전에 첫 미니게임 (테스트 훅으로 바로 끝냄) -> 택배 수는 조각 수로 (2조각 3개 / 3조각 5개)
  // 2026-10-16: 조각마다 반응형 미니게임 -- 조각을 다 모을 때까지 하나씩 끝낸다(테스트 훅). 다 모으면 투입 버튼.
  let shotKinds = {};
  const fin = async (p) => {
    for (let k = 0; k < 6; k++) {
      await p.waitForFunction(() => !!document.querySelector("#mx-layer.on .mx-card:not(.won)") || !!document.querySelector('.race-blank [data-action="race-done"]'), null, { timeout: 8000 });
      if (await p.locator('.race-blank [data-action="race-done"]').count() && !(await p.locator("#mx-layer.on .mx-card:not(.won)").count())) return;
      const name = await p.locator("#mx-layer .mx-name").textContent();
      if (!shotKinds[name]) { shotKinds[name] = 1; await p.screenshot({ path: OUT + "mx_" + Object.keys(shotKinds).length + ".png" }); await p.screenshot({ path: OUT + "mxn_" + name.replace(/ /g, "") + ".png" }); }
      await p.evaluate(() => window.__mxFinish()); await p.waitForTimeout(1300);
    }
  };
  // 두 사람 다 미니게임 카드가 뜰 때까지
  const card = async (p) => { await p.waitForSelector("#mx-layer.on .mx-card:not(.won)", { timeout: 10000 }); return p.evaluate(() => ({ name: document.querySelector("#mx-layer .mx-name").textContent, piece: document.querySelector("#mx-layer .mx-piece").textContent,
    addr: (document.querySelector(".mx-waybill") || {}).textContent || null, opts: [...document.querySelectorAll(".mx-plate b")].map((e) => e.textContent).join(","), seq: [...document.querySelectorAll(".mx-memo-seq span")].map((e) => e.textContent).join("") })); };
  let checkedSame = 0, checkedLive = false, checkedFirst = false;
  for (let k = 0; k < 8 && !(checkedSame && checkedLive && checkedFirst); k++) {
    const a = await card(p1), c = await card(p2);
    console.log("p1", JSON.stringify(a), "\np2", JSON.stringify(c));
    if (a.piece === c.piece && a.name === c.name) {
      if (a.name === "송장 주소 확인" || a.name === "배달 길 외우기") { assert.strictEqual(a.addr + a.opts + a.seq, c.addr + c.opts + c.seq, "같은 문제: " + a.name); checkedSame++; }
      // p1이 진행하면 p2 카드의 상대 막대가 움직인다
      if (a.name === "테이프 붙이기" && !checkedLive) {
        for (const kk of ["ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "ArrowLeft"]) { await p1.keyboard.press(kk); await p1.waitForTimeout(40); }
        await p2.waitForTimeout(350);
        const w = await p2.evaluate(() => document.querySelector(".mxd-row.opp .mxd-bar i").style.width);
        console.log("p2 sees opp", w); assert(parseInt(w, 10) > 0, "상대 진행 실시간 표시");
        await p2.screenshot({ path: OUT + "p2_live.png" }); checkedLive = true;
      }
      // p1이 먼저 끝내면 p2에 "상대가 먼저"
      await p1.evaluate(() => window.__mxFinish()); await p2.waitForTimeout(400);
      if ((await p2.locator(".mxd-alert").count()) > 0) { checkedFirst = true; await p2.screenshot({ path: OUT + "p2_oppfirst.png" }); await p1.screenshot({ path: OUT + "p1_mefirst.png" }); }
      await p2.evaluate(() => window.__mxFinish());
    } else { await p1.evaluate(() => window.__mxFinish()); await p2.evaluate(() => window.__mxFinish()); }
    await p1.waitForTimeout(1400);
    if (await p1.locator('.race-blank [data-action="race-done"]').count()) { await p1.keyboard.press("Space"); await p2.keyboard.press("Space"); await p1.waitForTimeout(600);
      for (const kk of ["KeyA", "KeyS"]) { await rail.keyboard.press(kk); await rail.waitForTimeout(200); } await p1.waitForTimeout(2500); }
  }
  console.log("same", checkedSame, "live", checkedLive, "first", checkedFirst, "errs", errs);
  assert(checkedLive, "실시간 막대 확인"); assert(checkedFirst, "상대 먼저 알림 확인");
  assert.deepStrictEqual(errs, []);
  console.log("test_duel_e2e OK");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
