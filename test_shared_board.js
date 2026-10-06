// 2026-10-06: "종류별 6개는 두 사람 합쳐서 6개" -- 공유 보드의 선착순/소진 규칙을 GameRoom을 직접 구동해서 검증한다.
// (브라우저 쪽 표시/미니게임 닫힘은 test_minigames_live.js가 실제 두 브라우저로 확인한다.)
"use strict";
const assert = require("assert");
const { GameRoom } = require("./game-room.js");
const { TYPES } = require("./game-data.js");
function log(...a) { console.log("[test-shared-board]", ...a); }

function newRoom() {
  const room = new GameRoom("T", () => {});
  room.pickCourier("cookbang", "A"); room.pickCourier("cheonil", "B");
  room.setReady("1"); room.setReady("2"); // -> secure
  assert.strictEqual(room.state.phase, "secure");
  return room;
}
const left = (room, key) => room.state.board.filter((c) => c.catIdx === TYPES.findIndex((t) => t.key === key) && !c.taken).length;
const inv = (room, seat) => room.state.players[seat].invoices;

// 1) 처음엔 종류별 6개, 합계 24
{
  const r = newRoom();
  for (const t of TYPES) assert.strictEqual(left(r, t.key), 6, `${t.key} starts with 6`);
  assert.strictEqual(r.state.board.length, 24);
  log("종류별 6개 / 총 24칸");
}

// 2) 한 사람이 확보할 때마다 줄어든다 -- 두 사람 합쳐서 6개
{
  const r = newRoom();
  r.secureCell("1", "normal-1"); r.secureCell("1", "normal-2"); r.secureCell("1", "normal-3");
  r.secureCell("2", "normal-4"); r.secureCell("2", "normal-5");
  assert.strictEqual(left(r, "normal"), 1, "3 + 2 taken -> 1 left");
  assert.strictEqual(inv(r, "1").length, 3); assert.strictEqual(inv(r, "2").length, 2);
  r.secureCell("2", "normal-6");
  assert.strictEqual(left(r, "normal"), 0);
  assert.strictEqual(inv(r, "2").length, 3);
  // 소진 후에는 누가 보내도 무시 (6개 초과 불가)
  r.secureCell("1", "normal-6"); r.secureCell("1", "normal-1");
  assert.strictEqual(inv(r, "1").length, 3, "exhausted category grants nothing");
  assert.strictEqual(inv(r, "1").length + inv(r, "2").length, 6, "total invoices of a category never exceeds 6");
  log("한 명 3 + 한 명 3 = 6 -> 소진, 이후 요청은 무시");
}

// 3) 같은 칸을 둘 다 열었다가 먼저 끝낸 쪽이 가져가고, 늦은 쪽은 같은 종류의 다른 빈 칸을 받는다 (남은 개수가 있을 때)
{
  const r = newRoom();
  r.secureCell("1", "fragile-1");
  r.secureCell("2", "fragile-1"); // 이미 p1이 가져간 칸 -> p2에게는 대체 칸
  assert.strictEqual(inv(r, "1").length, 1); assert.strictEqual(inv(r, "2").length, 1);
  const mine = r.state.board.filter((c) => c.takenBy === "2")[0];
  assert(mine && mine.id !== "fragile-1" && mine.catIdx === 1, "p2 got a different fragile cell");
  assert.strictEqual(left(r, "fragile"), 4);
  log("같은 칸을 늦게 끝낸 사람은 같은 종류의 빈 칸을 대신 받음");
}

// 4) 마지막 1개를 두 사람이 동시에 끝내면 먼저 온 한 명만
{
  const r = newRoom();
  for (let i = 1; i <= 5; i++) r.secureCell("1", "valuable-" + i);
  r.secureCell("2", "valuable-1"); // 마지막 한 칸은 valuable-6이 대신 배정
  r.secureCell("1", "valuable-6");
  assert.strictEqual(left(r, "valuable"), 0);
  assert.strictEqual(inv(r, "1").length, 5); assert.strictEqual(inv(r, "2").length, 1, "late finisher gets nothing");
  log("마지막 1개: 먼저 끝낸 한 명만 가져감");
}

// 5) 확정 층수 택배: 칸=층이라 대체 불가, 먼저 확보한 사람이 그 층을 가진다
{
  const r = newRoom();
  r.secureCell("1", "fixed-floor-3");
  r.secureCell("2", "fixed-floor-3");
  assert.strictEqual(inv(r, "1").length, 1); assert.strictEqual(inv(r, "2").length, 0, "taken floor is not substituted");
  assert.strictEqual(inv(r, "1")[0].floorIdx, 2, "fixed-floor-3 -> FLOORS[2] (2F)");
  r.secureCell("2", "fixed-floor-4");
  assert.strictEqual(inv(r, "2")[0].floorIdx, 3);
  assert.strictEqual(left(r, "fixed-floor"), 4);
  log("확정 층수: 선점자 우선, 이미 가져간 층은 대체 없이 무시");
}

// 6) 같은 사람이 같은 칸 완료 메시지를 두 번 보내도 두 개가 되지 않는다
{
  const r = newRoom();
  r.secureCell("1", "normal-1"); r.secureCell("1", "normal-1");
  assert.strictEqual(inv(r, "1").length, 1, "duplicate message from the owner is a no-op");
  assert.strictEqual(left(r, "normal"), 5);
  log("중복 메시지 무시");
}

// 7) secure 단계가 아니면 무시, 하프가 바뀌면 다시 6개
{
  const r = newRoom();
  r.secureCell("1", "normal-1");
  r._endSecurePhase();
  r.secureCell("1", "normal-2");
  assert.strictEqual(inv(r, "1").length, 1, "no securing after the secure phase");
  r._finishHalf(); r.halftimeReady("1"); r.halftimeReady("2");
  assert.strictEqual(r.state.phase, "secure");
  for (const t of TYPES) assert.strictEqual(left(r, t.key), 6, `${t.key} is back to 6 in 후반`);
  assert.strictEqual(r.state.board.every((c) => c.takenBy === null), true);
  log("secure 단계 밖에서는 무시, 후반에는 종류별 6개로 다시 시작");
}

console.log("[test-shared-board] ALL CHECKS PASSED");
process.exit(0); // GameRoom의 타이머가 남아 있어 프로세스가 안 끝나므로 명시적으로 종료
