const { chromium } = require("playwright");
// 2026-10-23 한 화면 겨루기 e2e (re_duel1.sh). 원본: 엘리베이터 이동 전쟁 e2e (아파트 한 채). 서버: APT_WAR=1, SECURE_PHASE_MS 짧게 (re_war.sh). 앞부분은 test_wall_e2e와 같음
// (원본) 2026-10-16 벽 배송 e2e: 택배 쌓기 몫(3개 중 2개 / 5개 중 3개, 레일에서 고르기) -> 배송(메인 컴퓨터 키보드 Ctrl+호실 2초 유지) -> 오배송.
// 서버: SECURE_PHASE_MS 40초, TUTORIAL=0, WALL 기본(regress.sh 마지막 섹션).
const assert = require("assert");
const OUT = "/tmp/duel1_e2e_";
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
  await s.setViewportSize({ width: 1920, height: 1080 });
  await s.waitForSelector(".duel-arena", { timeout: 10000 });
  await p1.waitForSelector(".duel-pl", { timeout: 10000 });
  assert.strictEqual(await p1.locator(".mx-card").count(), 0, "각자 미니게임 카드 없음");
  const REL = { "윗집": [1, 0], "아랫집": [-1, 0], "왼쪽 옆집": [0, -1], "오른쪽 옆집": [0, 1] };
  const seen = {}; let soloOk = false;
  for (let k = 0; k < 14; k++) {
    await s.waitForSelector(".duel-arena:not(:has(.duel-res))", { timeout: 6000 });
    const kind = await s.evaluate(() => document.querySelector(".duel-arena").className.match(/k-(\w+)/)?.[1] || "none");
    const p1in = await p1.locator(".duel-pl [data-duel]").count() > 0, p2in = await p2.locator(".duel-pl [data-duel]").count() > 0;
    if (kind === "none") break;
    if (kind === "tug") {
      for (let i = 0; i < 4; i++) { if (p1in) await p1.keyboard.press(i % 2 ? "ArrowRight" : "ArrowLeft"); if (p2in) await p2.keyboard.press(i % 2 ? "ArrowRight" : "ArrowLeft"); }
      await s.waitForTimeout(150);
      if (!seen.tug) { seen.tug = 1; await s.screenshot({ path: OUT + "main_tug.png" }); await p1.screenshot({ path: OUT + "p1_tug.png" });
        const kx = await s.evaluate(() => document.querySelector(".tug-knot").style.left); console.log("knot", kx); }
      const P = p1in ? p1 : p2; for (let i = 0; i < 14; i++) { await P.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight"); await P.waitForTimeout(20); }
    } else {
      const q = await s.evaluate(() => ({ base: document.querySelector(".dq-bill b").textContent, memo: document.querySelector(".dq-bill em").textContent, opts: [...document.querySelectorAll(".dq-opt b")].map((e) => e.textContent) }));
      let f = +q.base[0], u = +q.base[2]; q.memo.split("의 ").forEach((m) => { f += REL[m][0]; u += REL[m][1]; });
      const ans = q.opts.indexOf(f + "0" + u + "호"); assert(ans >= 0, "정답이 보기에 있음 " + JSON.stringify(q));
      const P = p1in ? p1 : p2, O = p1in ? p2 : p1;
      if (!seen.quiz) { seen.quiz = 1; await s.screenshot({ path: OUT + "main_quiz.png" });
        if (p1in && p2in) { await O.keyboard.press(["ArrowLeft", "ArrowUp", "ArrowDown", "ArrowRight"][(ans + 1) % 4]); await O.waitForTimeout(200);
          assert.strictEqual(await O.locator(".dp-quiz.locked").count(), 1, "틀리면 잠김"); await O.screenshot({ path: OUT + "p_quiz_locked.png" }); } }
      await P.keyboard.press(["ArrowLeft", "ArrowUp", "ArrowDown", "ArrowRight"][ans]);
    }
    await s.waitForSelector(".duel-res", { timeout: 9000 }); if (!seen.res) { seen.res = 1; await s.screenshot({ path: OUT + "main_res.png" }); }
    if (!(p1in && p2in) && (p1in || p2in)) soloOk = true;
    console.log("problem", k, kind, "players", p1in, p2in, await s.locator(".duel-who.t1 span").textContent(), await s.locator(".duel-who.t2 span").textContent());
    await s.waitForTimeout(1400);
    if (!(await s.locator(".duel-arena.k-tug, .duel-arena.k-quiz").count())) break;
  }
  console.log("seen", JSON.stringify(seen), "solo", soloOk, "errs", errs);
  assert(seen.tug && seen.quiz, "두 겨루기 다 나옴"); assert(soloOk, "한 사람 다 모은 뒤 혼자 계속");
  assert.deepStrictEqual(errs, []);
  console.log("test_duel1_e2e OK");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
