// 2026-10-06: 미니게임 3종(박스 포장 / 불량 검수 / 송장 붙이기) 시험장 검증.
//
// minigame_proto.html(로컬 파일)을 진짜 브라우저로 열어서 3종을 난이도 1~3 전부 실제로 "플레이"한다
// (키보드/클릭/마우스 드래그). 정상 클리어뿐 아니라 오입력 3규칙, 잘못된 클릭 잠금, 빗나간 드래그 복귀,
// destroy() 후 키 리스너 정리까지 확인한다. 서버는 필요 없다 (정적 파일).
//   사전: python3 build_minigame_proto.py
"use strict";
const path = require("path");
const { chromium } = require("playwright");

const URL = "file://" + path.join(__dirname, "minigame_proto.html");
const SHOT_DIR = process.env.SHOT_DIR || null;
function log(...a) { console.log("[test-minigames]", ...a); }
function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", space: "Space" };

async function waitFor(fn, { timeout = 5000, interval = 50, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label);
    await sleep(interval);
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.goto(URL);

  // ---- 헬퍼: API로 직접 게임을 띄운다 (testHooks로 정답 위치를 노출) ----
  async function launch(kind, level, rule) {
    await page.evaluate(({ kind, level, rule }) => {
      if (window.__ctl) { window.__ctl.destroy(); window.__ctl = null; }
      document.getElementById("menu").hidden = true;
      document.getElementById("play").hidden = false;
      MiniGames.setMistakeRule(rule || "reset");
      window.__res = null;
      window.__ctl = MiniGames.start(document.getElementById("host"), {
        kind, level, testHooks: true, label: "1F", onDone: (r) => { window.__res = r; }, onCancel: () => { window.__cancelled = true; },
      });
    }, { kind, level, rule });
  }
  const result = () => page.evaluate(() => window.__res);
  const miss = async () => parseInt((await page.textContent(".mg-miss")).replace(/\D/g, ""), 10);
  async function shot(name) { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, name + ".png") }); }

  // ================= 박스 포장 =================
  const PACK_LEN = [4, 6, 8];
  for (let lv = 1; lv <= 3; lv++) {
    await launch("pack", lv);
    const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
    assert(seq.length === PACK_LEN[lv - 1], `pack L${lv} should have ${PACK_LEN[lv - 1]} arrows, got ${seq.length}`);
    for (let i = 2; i < seq.length; i++) assert(!(seq[i] === seq[i - 1] && seq[i] === seq[i - 2]), "no 3 identical keys in a row");
    if (lv === 2) await shot("pack_L2_start");
    for (const k of seq) await page.keyboard.press(KEY[k]);
    assert(!(await result()), "pack must NOT finish before the final SPACE");
    assert((await page.$$(".mg-chip.is-done")).length === seq.length, "all arrow chips done before SPACE");
    if (lv === 2) await shot("pack_L2_before_tape");
    await page.keyboard.press("Space");
    await waitFor(result, { label: `pack L${lv} done` });
    const r = await result();
    assert(r.ok && r.kind === "pack" && r.level === lv && r.mistakes === 0, "pack clean run result: " + JSON.stringify(r));
    if (lv === 2) await shot("pack_L2_done");
    log(`pack L${lv}: ${seq.length}키+SPACE 클리어 (${r.ms}ms, 실수 0)`);
  }

  // 오입력 규칙 1: reset -- 처음부터
  await launch("pack", 2, "reset");
  {
    const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
    await page.keyboard.press(KEY[seq[0]]); await page.keyboard.press(KEY[seq[1]]);
    assert((await page.$$(".mg-chip.is-done")).length === 2, "2 chips done before the mistake");
    const wrong = ["up", "down", "left", "right"].find((d) => d !== seq[2]);
    await page.keyboard.press(KEY[wrong]);
    await sleep(250);
    assert((await page.$$(".mg-chip.is-done")).length === 0, "reset rule: all chips must reset to start after a wrong key");
    assert((await page.$$(".mg-flap.is-closed")).length === 0, "reset rule: flaps must reopen");
    assert((await miss()) === 1, "mistake counter should be 1");
    for (const k of seq) await page.keyboard.press(KEY[k]);
    await page.keyboard.press("Space");
    await waitFor(result, { label: "pack reset-rule done" });
    assert((await result()).mistakes === 1, "recorded mistakes should be 1");
    log("pack 오입력=reset: 틀리면 입력 전체가 처음부터 다시, 이후 정상 클리어 + 실수 1회 기록");
  }
  // 규칙 2: freeze -- 0.5초 멈췄다가 이어서
  await launch("pack", 1, "freeze");
  {
    const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
    await page.keyboard.press(KEY[seq[0]]);
    const wrong = ["up", "down", "left", "right"].find((d) => d !== seq[1]);
    await page.keyboard.press(KEY[wrong]);
    await page.keyboard.press(KEY[seq[1]]); // 정지 중이라 무시돼야 함
    assert((await page.$$(".mg-chip.is-done")).length === 1, "freeze rule: input during the 0.5s freeze must be ignored");
    await sleep(650);
    await page.keyboard.press(KEY[seq[1]]);
    assert((await page.$$(".mg-chip.is-done")).length === 2, "freeze rule: progress resumes where it left off (not reset)");
    for (let i = 2; i < seq.length; i++) await page.keyboard.press(KEY[seq[i]]);
    await page.keyboard.press("Space");
    await waitFor(result, { label: "pack freeze-rule done" });
    log("pack 오입력=freeze: 0.5초 정지 중 입력 무시, 풀리면 있던 자리부터 이어서");
  }
  // 규칙 3: ignore
  await launch("pack", 1, "ignore");
  {
    const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
    await page.keyboard.press(KEY[seq[0]]);
    const wrong = ["up", "down", "left", "right"].find((d) => d !== seq[1]);
    await page.keyboard.press(KEY[wrong]);
    await sleep(250);
    assert((await page.$$(".mg-chip.is-done")).length === 1, "ignore rule: progress untouched by a wrong key");
    assert((await miss()) === 1, "ignore rule still counts the mistake");
    for (let i = 1; i < seq.length; i++) await page.keyboard.press(KEY[seq[i]]);
    await page.keyboard.press("Space");
    await waitFor(result, { label: "pack ignore-rule done" });
    log("pack 오입력=ignore: 진행 그대로, 실수만 기록");
  }
  // 스페이스를 너무 일찍 눌러도 오입력 취급 + 키 반복(e.repeat)은 무시
  await launch("pack", 1, "reset");
  {
    await page.keyboard.press("Space"); // 첫 키는 화살표여야 하므로 오입력
    assert((await miss()) === 1, "early SPACE counts as a mistake");
    await page.evaluate(() => {
      const want = document.querySelector(".mg-body").getAttribute("data-seq").split(",")[0];
      const key = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[want];
      document.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true, repeat: true }));
    });
    await sleep(100);
    assert((await page.$$(".mg-chip.is-done")).length === 0, "auto-repeat keydown must be ignored (holding a key must not spam inputs)");
    log("pack: 너무 이른 스페이스=오입력, 키 꾹 누름(repeat)은 무시");
  }

  // ================= 이상 확인 (벨트 분류) =================
  const INSPECT = [{ n: 6, bad: 1 }, { n: 8, bad: 2 }, { n: 10, bad: 3 }];
  const inspectSeq = async () => (await page.getAttribute(".mg-body", "data-seq")).split(",");
  for (let lv = 1; lv <= 3; lv++) {
    await launch("inspect", lv);
    const seq = await inspectSeq();
    assert(seq.length === INSPECT[lv - 1].n, `inspect L${lv} should queue ${INSPECT[lv - 1].n} packages, got ${seq.length}`);
    assert(seq.filter((a) => a === "space").length === INSPECT[lv - 1].bad, `inspect L${lv} should have ${INSPECT[lv - 1].bad} anomalies`);
    assert((await page.$$(".mg-pkg")).length === seq.length, "every queued package is rendered");
    if (lv === 2) await shot("inspect_L2_start");
    for (let i = 0; i < seq.length; i++) {
      await page.keyboard.press(KEY[seq[i]]);
      if (lv === 2 && i === 2) await shot("inspect_L2_mid");
    }
    await waitFor(result, { label: `inspect L${lv} done` });
    const r = await result();
    assert(r.ok && r.mistakes === 0, "inspect clean run: " + JSON.stringify(r));
    log(`inspect L${lv}: 택배 ${seq.length}개(이상 ${INSPECT[lv - 1].bad}개) 분류/폐기 클리어 (${r.ms}ms)`);
  }
  // 오입력: 실수 +1, 앞 택배는 그대로, 0.45초 잠금(그 사이 정답 키도 무시), 풀린 뒤엔 정상
  await launch("inspect", 2);
  {
    const seq = await inspectSeq();
    const wrong = ["left", "down", "right", "space"].find((a) => a !== seq[0]);
    await page.keyboard.press(KEY[wrong]);
    assert((await miss()) === 1, "wrong action counts as a mistake");
    await page.keyboard.press(KEY[seq[0]]); // 잠금 중
    assert((await page.textContent(".mg-found")) === "0", "the correct key during the lock must be ignored");
    await sleep(560);
    await page.keyboard.press(KEY[seq[0]]);
    assert((await page.textContent(".mg-found")) === "1", "after the lock the correct key is accepted");
    for (let i = 1; i < seq.length; i++) await page.keyboard.press(KEY[seq[i]]);
    await waitFor(result, { label: "inspect after-lock done" });
    assert((await result()).mistakes === 1, "inspect mistakes recorded");
    log("inspect: 틀린 칸=실수+0.45초 잠금(그 사이 입력 무시), 풀리면 정상 진행");
  }
  // 이상한 택배를 분류 키로 보내거나 멀쩡한 택배를 폐기하면 둘 다 실수
  await launch("inspect", 3);
  {
    const seq = await inspectSeq();
    const iBad = seq.indexOf("space"), iOk = seq.findIndex((a) => a !== "space");
    let pos = 0, expectedMiss = 0;
    const advanceTo = async (target) => { while (pos < target) { await page.keyboard.press(KEY[seq[pos]]); pos++; } };
    const first = Math.min(iBad, iOk), second = Math.max(iBad, iOk);
    for (const t of [first, second]) {
      await advanceTo(t);
      const wrongKey = seq[t] === "space" ? "left" : "space";   // 이상한 택배엔 분류 키, 멀쩡한 택배엔 폐기 키
      await page.keyboard.press(KEY[wrongKey]);
      expectedMiss++;
      assert((await miss()) === expectedMiss, `mistake #${expectedMiss} (${seq[t] === "space" ? "classified an anomaly" : "discarded a good package"})`);
      await sleep(560);
    }
    while (pos < seq.length) { await page.keyboard.press(KEY[seq[pos]]); pos++; }
    await waitFor(result, { label: "inspect mixed-mistake done" });
    assert((await result()).mistakes === 2, "both kinds of wrong action recorded");
    log("inspect: 이상한 택배를 분류 키로, 멀쩡한 택배를 폐기 키로 보내면 각각 실수");
  }
  // 터치/마우스용 칸 버튼도 같은 동작
  await launch("inspect", 1);
  {
    const seq = await inspectSeq();
    for (const a of seq) await page.dispatchEvent(`.mg-bin[data-a="${a}"]`, "pointerdown");
    await waitFor(result, { label: "inspect via on-screen buttons" });
    assert((await result()).mistakes === 0, "on-screen buttons work like the keys");
    log("inspect: 화면 버튼(포인터)으로도 클리어");
  }

  // ================= 송장 붙이기 (박스 찾아 붙이기) =================
  // 사람이 하는 것과 같은 방법: 송장의 배송코드를 읽고, 같은 코드가 적힌 박스 위로 마우스 드래그.
  async function stickerState() {
    return page.evaluate(() => {
      const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      const l = document.querySelector('.mg-label[data-label]:not([data-stuck])');
      const boxes = Array.from(document.querySelectorAll(".mg-bx")).map((b) => ({
        code: b.querySelector(".bx-addr b").textContent, done: b.classList.contains("is-done"), r: rect(b),
      }));
      return { l: l ? { r: rect(l), code: l.querySelector(".lb-room").textContent } : null, boxes };
    });
  }
  async function drag(from, to, steps = 12) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
  }
  const ctr = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const BOXES = [4, 5, 6], LABELS = [2, 3, 4];
  for (let lv = 1; lv <= 3; lv++) {
    await launch("sticker", lv);
    await page.evaluate(() => window.scrollTo(0, 0));
    const st0 = await stickerState();
    assert(st0.boxes.length === BOXES[lv - 1], `sticker L${lv}: ${BOXES[lv - 1]} boxes, got ${st0.boxes.length}`);
    assert(new Set(st0.boxes.map((b) => b.code)).size === st0.boxes.length, `sticker L${lv}: all box codes distinct`);
    if (lv === 2) await shot("sticker_L2_start");
    const seen = [];
    for (let n = 1; n <= LABELS[lv - 1]; n++) {
      await waitFor(async () => (await stickerState()).l, { label: `sticker L${lv} label #${n} ready` });
      const st = await stickerState();
      seen.push(st.l.code);
      const hits = st.boxes.filter((b) => b.code === st.l.code && !b.done);
      assert(hits.length === 1, `sticker L${lv}: label ${st.l.code} must match exactly one open box (got ${hits.length})`);
      await drag(ctr(st.l.r), ctr(hits[0].r));
      await waitFor(async () => (await page.$$('.mg-label[data-stuck]')).length === n, { label: `sticker L${lv} #${n} stuck` });
      if (lv === 2 && n === 1) await shot("sticker_L2_one_stuck");
    }
    assert(new Set(seen).size === seen.length, `sticker L${lv}: labels are all different codes`);
    await waitFor(result, { label: `sticker L${lv} done` });
    const r = await result();
    assert(r.ok && r.mistakes === 0, "sticker clean run: " + JSON.stringify(r));
    if (lv === 2) await shot("sticker_L2_done");
    log(`sticker L${lv}: 박스 ${BOXES[lv - 1]}개 중 송장 ${LABELS[lv - 1]}장 붙이기 클리어 (${r.ms}ms)`);
  }
  // 틀린 박스에 놓으면 실수 +1, 붙지 않고 트레이로 복귀. 빈 곳이나 트레이 근처에 놓는 건 실수 아님.
  await launch("sticker", 3);
  {
    const st = await stickerState();
    const wrong = st.boxes.find((b) => b.code !== st.l.code);
    const right = st.boxes.find((b) => b.code === st.l.code);
    await drag(ctr(st.l.r), ctr(wrong.r));
    assert((await miss()) === 1, "dropping on a wrong box is a mistake");
    assert((await page.$$('.mg-label[data-stuck]')).length === 0, "a wrong-box drop must not stick");
    assert((await page.$$('.mg-bx.is-done')).length === 0, "a wrong-box drop must not mark the box done");
    await sleep(350);
    const st2 = await stickerState();
    assert(Math.abs(st2.l.r.y - st.l.r.y) < 4 && Math.abs(st2.l.r.x - st.l.r.x) < 4, "wrong-box label must return to the tray");
    // 트레이 근처에서 그냥 놓는 건 실수 아님
    await drag(ctr(st2.l.r), { x: ctr(st2.l.r).x + 30, y: ctr(st2.l.r).y });
    assert((await miss()) === 1, "dropping near the tray must NOT count as a mistake");
    // 박스들 사이 빈 작업대(박스 영역 밖)에 놓는 것도 실수 아님: 스테이지 왼쪽 위 모서리 근처
    const sg = await page.evaluate(() => { const r = document.querySelector(".mg-stage").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const st3 = await stickerState();
    await drag(ctr(st3.l.r), { x: sg.x + 4, y: sg.y + 4 });
    assert((await miss()) === 1, "dropping on empty table must NOT count as a mistake");
    await sleep(350);
    // 마지막으로 정답 박스에는 붙는다 (실수 수는 그대로)
    const st4 = await stickerState();
    await drag(ctr(st4.l.r), ctr(right.r));
    await waitFor(async () => (await page.$$('.mg-label[data-stuck]')).length === 1, { label: "correct box accepts the label after mistakes" });
    assert((await miss()) === 1, "mistake count unchanged by a correct drop");
    log("sticker: 틀린 박스=실수+복귀, 트레이/빈 작업대에 놓은 건 실수 아님, 이후 정답 박스엔 붙음");
  }

  // ================= destroy 정리 =================
  await launch("pack", 1);
  await page.evaluate(() => { window.__ctl.destroy(); window.__ctl = null; });
  assert((await page.$$(".mg-root")).length === 0, "destroy() removes the game from the DOM");
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("Space"); // 리스너가 남아 있으면 에러/오동작
  log("destroy(): DOM 제거 + 이후 키 입력에 반응 없음 (리스너 정리됨)");

  // ================= 시험장 UI 전체 흐름 (실제 버튼) =================
  await page.goto(URL);
  await page.click('button[data-kind="pack"][data-lv="1"]');
  await page.click('button[data-go="pack"]');
  await waitFor(async () => (await page.$$(".mg-root")).length === 1, { label: "game opened from the UI" });
  const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
  for (const k of seq) await page.keyboard.press(KEY[k]);
  await page.keyboard.press("Space");
  await waitFor(async () => (await page.$$("table")).length > 0, { label: "log table after done", timeout: 4000 });
  const txt = await page.textContent("#tables");
  assert(txt.includes("박스 포장") && txt.includes("원/초"), "log shows the run and 원/초");
  assert((await page.$$('button[data-again]')).length === 1, "'같은 설정으로 한 번 더' button shown");
  await shot("proto_after_run");
  // Esc로 포기
  await page.click('button[data-go="inspect"]');
  await waitFor(async () => (await page.$$(".mg-root")).length === 1, { label: "inspect opened" });
  await page.keyboard.press("Escape");
  assert((await page.$$(".mg-root")).length === 0 && !(await page.$eval("#menu", (e) => e.hidden)), "Esc gives up and returns to the menu");
  log("시험장 UI: 시작 → 플레이 → 기록표(원/초) 갱신 → '한 번 더' 버튼, Esc 포기 모두 정상");

  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => { console.error("[test-minigames] FAILED:", e); process.exit(1); });
