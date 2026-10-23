// 2026-10-23 한 화면 겨루기 (서버 로직): 테이프 줄다리기 / 주소 퀴즈 버저. 실행: node test_duel.js
"use strict";
const { GameRoom } = require("./game-room.js");
const D = require("./game-data.js");
const assert = require("assert");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mk(rules) {
  const box = { st: null };
  const room = new GameRoom("D", (s) => { box.st = s; }, Object.assign({ wallMode: true, raceGrantPlan: D.RACE_GRANT_PLAN, raceGrantByPieces: D.RACE_GRANT_BY_PIECES, raceUnlimited: true, raceGamePool: [],
    racePieceGames: true, duelMode: true, duelTugMs: 600, duelQuizMs: 600, duelResultMs: 150, duelQuizLockMs: 300, contestRate: 0 }, rules));
  room.pickCourier("cookbang", "c1"); room.pickCourier("cheonil", "c2"); room.setReady("1"); room.setReady("2");
  return { room, box };
}
const pull = (room, s, n) => { for (let i = 0; i < n; i++) room.duelKey(s, i % 2 ? "ArrowRight" : "ArrowLeft"); };
const toKind = async (room, box, kind) => { for (let i = 0; i < 6 && box.st.race.duel.kind !== kind; i++) { box.st.race.duel.endsAt = 0; await sleep(130); if (box.st.race.duel.nextAt) { box.st.race.duel.nextAt = 1; await sleep(130); } } assert.strictEqual(box.st.race.duel.kind, kind); };
(async () => {
  // 1) 라운드 시작 = 겨루기 시작, 클라이언트 piece-done은 무시
  {
    const { room, box } = mk();
    const r = box.st.race;
    assert(r.duelMode && r.duel, "겨루기 문제가 있음"); assert.deepStrictEqual(r.duel.players, ["1", "2"]);
    room.raceStep("1", "piece-done", r.round); assert.strictEqual(r.got["1"], 0, "클라이언트 조각 신고는 무시");
    room.destroy();
  }
  // 2) 줄다리기: ← → 번갈아 = 한 칸, 같은 쪽 두 번 = 꼬임(안 움직임), 목표 칸 = 승리 + 조각
  {
    const { room, box } = mk();
    await toKind(room, box, "tug");
    const d = box.st.race.duel;
    room.duelKey("1", "ArrowLeft"); room.duelKey("1", "ArrowLeft"); assert.strictEqual(d.pos, -1, "같은 쪽 두 번은 안 당겨짐");
    pull(room, "2", 4); assert.strictEqual(d.pos, 3, "파랑이 당기면 파랑 쪽(+)");
    room.duelKey("1", "ArrowRight"); pull(room, "1", 12);
    assert.strictEqual(d.winner, "1"); assert.strictEqual(box.st.race.got["1"], 1); assert.strictEqual(box.st.race.got["2"], 0, "진 사람은 조각 없음");
    pull(room, "1", 3); assert.strictEqual(box.st.race.got["1"], 1, "결과 뒤 입력 무시");
    await sleep(300); assert.notStrictEqual(box.st.race.duel.n, d.n, "다음 문제");
    room.destroy();
  }
  // 3) 줄다리기 시간 끝: 테이프가 있는 쪽 승
  {
    const { room, box } = mk();
    await toKind(room, box, "tug");
    pull(room, "2", 3);
    await sleep(750);
    assert.strictEqual(box.st.race.got["2"], 1, "시간 끝 -> 파랑 쪽에 있으니 파랑 승");
    room.destroy();
  }
  // 4) 퀴즈: 틀리면 잠김, 먼저 맞힌 사람 승
  {
    const { room, box } = mk();
    await toKind(room, box, "quiz");
    const d = box.st.race.duel, wrong = (d.answer + 1) % 4;
    assert.strictEqual(d.opts.length, 4); assert(d.memo.length >= 1);
    room.duelKey("1", wrong); assert(d.lock["1"] > Date.now(), "틀리면 잠김");
    room.duelKey("1", d.answer); assert.strictEqual(d.winner, null, "잠긴 동안 무시");
    room.duelKey("2", ["ArrowLeft", "ArrowUp", "ArrowDown", "ArrowRight"][d.answer]);
    assert.strictEqual(d.winner, "2"); assert.strictEqual(box.st.race.got["2"], 1);
    room.destroy();
  }
  // 5) 조각을 다 모은 사람은 빠지고, 남은 사람 혼자 계속
  {
    const { room, box } = mk();
    const r = box.st.race, need = r.need;
    for (let k = 0; k < need; k++) {
      await toKind(room, box, "tug"); pull(room, "1", 12); await sleep(250);
    }
    assert.strictEqual(r.stage["1"], "ubongo", "빨강 조각 다 모음 -> 퍼즐 완성 단계");
    assert.deepStrictEqual(box.st.race.duel.players, ["2"], "다음 문제는 파랑 혼자");
    await toKind(room, box, "tug"); pull(room, "1", 12); assert.strictEqual(box.st.race.duel.winner, null, "빠진 사람 입력 무시");
    pull(room, "2", 12); assert.strictEqual(r.got["2"], 1);
    room.destroy();
  }
  console.log("test_duel OK");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
