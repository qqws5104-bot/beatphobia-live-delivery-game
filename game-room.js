// Authoritative, server-side game room. One instance per room code. All mutations happen here,
// in Node's single-threaded event loop, so there is no version/conflict machinery to speak of --
// two near-simultaneous actions are simply processed one after the other, in order. That whole
// class of problem (and the fragile client-side retry/tally-persistence code it required) only
// existed because the old design had no real server; it's gone here by construction.
"use strict";

const {
  TYPES, FLOORS, ROOMS, CELLS, START_FLOOR_IDX, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS,
  PRIORITY_MULTIPLIER, SAME_FLOOR_CHOICE_MS, HALVES,
} = require("./game-data");

// Secure phase is per-player now: each seat has its own independent copy of the 21-cell board,
// so there is no cross-player contention (both players can secure "the same" cell id -- they're
// really securing their own separate copy of it). cellById therefore needs to know which seat's
// board to look in.
function cellById(state, seat, id) { return state.boards[seat].find((c) => c.id === id) || null; }
function cellMeta(id) { return CELLS.find((c) => c.id === id) || null; }

// fixedFloor 종류(확정 층수 택배)는 칸의 num(0..5)이 그대로 FLOORS 인덱스가 된다 -- 무작위가 아니라
// 어느 칸을 확보했는지에 따라 배송지가 결정되어 있다. 그 외 종류는 기존처럼 무작위 층.
function randomInvoice(seat, catIdx, num, acquiredSeq) {
  const t = TYPES[catIdx];
  const floorIdx = t.fixedFloor ? num : Math.floor(Math.random() * FLOORS.length);
  const room = ROOMS[Math.floor(Math.random() * ROOMS.length)];
  return {
    id: "inv-" + seat + "-" + acquiredSeq,
    catIdx, floorIdx, room, acquiredSeq,
    deliveredRound: null,
    stolen: false, // 택배도둑에게 뺏긴 경우 true (후반 전용, 확정 마이너스 점수)
  };
}

// stolen: 배송은 됐지만 택배도둑이 가로챈 경우 -- 무조건 실패(penalty) 취급, 우선 배수도 적용 안 됨.
// priorityId가 주어지고 이 송장이 그 우선 택배라면, 정상 배송 시 보상이 PRIORITY_MULTIPLIER배가 된다.
function scoreInvoice(inv, priorityId) {
  const t = TYPES[inv.catIdx];
  if (inv.stolen) return -t.penalty;
  if (inv.deliveredRound === null) return -t.penalty;
  const base = t.reward;
  return (priorityId && inv.id === priorityId) ? base * PRIORITY_MULTIPLIER : base;
}
function resultLabel(inv) {
  if (inv.stolen) return "도난";
  return inv.deliveredRound === null ? "미배송" : "성공";
}
function totalScore(seat, state) {
  const priorityId = state.players[seat].priorityInvoiceId;
  return state.players[seat].invoices.reduce((sum, inv) => sum + scoreInvoice(inv, priorityId), 0);
}

function freshBoard() {
  return CELLS.map((c) => ({ id: c.id, catIdx: c.catIdx, num: c.num, taken: false, acquiredSeq: null }));
}
function freshPlayers() {
  return { "1": { invoices: [], priorityInvoiceId: null }, "2": { invoices: [], priorityInvoiceId: null } };
}
function freshElevator() {
  return {
    // state: "idle" | "voting" | "choosing" | "result" | "done"
    // "choosing": 이번 라운드에 같은 층에 배송 대기 중인 내 택배가 2개 이상인 플레이어가 있을 때,
    // 그 플레이어(들)에게 5초간 어느 걸 먼저 보낼지 고르게 하는 중간 단계 (없으면 곧장 result로).
    // "result"는 5초 이동/선택이 끝난 뒤 두 플레이어 모두 스페이스바를 눌러야(readyNext) 다음
    // 라운드(또는 마지막 라운드라면 하프 종료)로 넘어가는 대기 단계.
    round: 1, floorIdx: START_FLOOR_IDX, state: "idle", votingEndsAt: null,
    // votes: per-seat click counters, kept purely for the round log -- they no longer decide
    // anything and are never shown to players. Real movement is immediate, see vote().
    votes: { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } },
    roundStartFloorIdx: START_FLOOR_IDX,
    readyNext: { "1": false, "2": false },
    pendingChoice: null, // { conflicts: {seat: [invoiceId,...]}, chosen: {seat: invoiceId|null}, endsAt }
    // thieves: 후반(half===2) 전용. placedThisRound는 "이번 라운드에 배치를 썼는가"(1인당 라운드당 1회),
    // active는 "바로 다음 라운드에 실제로 작동 중인 도둑 목록" -- 배치한 그 라운드에는 아직 작동하지
    //않고, 라운드가 넘어갈 때 activate된다 ("다음 라운드에 그 층에 배송하면 뺏어간다").
    thieves: { placedThisRound: { "1": null, "2": null }, active: [] },
    log: [],
  };
}

function initialState() {
  return {
    phase: "lobby", // lobby -> secure -> priority -> elevator -> halftime -> secure -> priority -> elevator -> end
    ready: { "1": false, "2": false },
    seatOwners: { "1": null, "2": null },
    secureEndsAt: null,
    boards: { "1": freshBoard(), "2": freshBoard() },
    acquireCounter: { "1": 0, "2": 0 },
    players: freshPlayers(),
    priority: { picks: { "1": null, "2": null }, readyNext: { "1": false, "2": false } },
    elevator: freshElevator(),
    half: 1,
    halftimeReady: { "1": false, "2": false },
    halfHistory: [], // [{half, players, scores}, ...] -- snapshot taken at the end of each half
    scores: null, // grand total across both halves, set once phase becomes "end"
  };
}

class GameRoom {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange; // called with (state) whenever state mutates -- caller broadcasts it
    this.state = initialState();
    this.timer = null;
    this.lastActivityAt = Date.now();
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  touch() { this.lastActivityAt = Date.now(); }

  emit() { this.onChange(this.state); }

  // ---- seat / lobby ----
  pickSeat(seat, clientId) {
    this.touch();
    const owners = this.state.seatOwners;
    if (owners[seat] && owners[seat] !== clientId) return { ok: false, code: "seat_taken" };
    // freeing any other seat this same client previously held (e.g. picked wrong seat, retried)
    ["1", "2"].forEach((s) => { if (owners[s] === clientId && s !== seat) owners[s] = null; });
    owners[seat] = clientId;
    this.emit();
    return { ok: true };
  }

  setReady(seat) {
    if (this.state.phase !== "lobby") return;
    this.touch();
    this.state.ready[seat] = true;
    if (this.state.ready["1"] && this.state.ready["2"]) this._startGame();
    else this.emit();
  }

  _startGame() {
    this.state.phase = "secure";
    this.state.secureEndsAt = Date.now() + SECURE_PHASE_MS;
    this._scheduleAt(this.state.secureEndsAt, () => this._endSecurePhase());
    this.emit();
  }

  // ---- secure phase ----
  // Each seat has its own independent board (see freshBoard/state.boards), so there is no
  // cross-player race here anymore -- player 1 securing "fragile-1" has zero effect on whether
  // player 2 can also secure their own "fragile-1". Giving up (the client just closes the puzzle
  // overlay without sending this message) never reaches here, so a given-up cell never gets
  // touched -- it stays exactly as untaken as it was before the attempt.
  secureCell(seat, cellId) {
    if (this.state.phase !== "secure") return;
    const cell = cellById(this.state, seat, cellId);
    if (!cell || cell.taken) return; // already taken by this same seat (or unknown id) -- silent no-op
    this.touch();
    cell.taken = true;
    this.state.acquireCounter[seat] += 1;
    cell.acquiredSeq = this.state.acquireCounter[seat];
    const meta = cellMeta(cellId);
    this.state.players[seat].invoices.push(randomInvoice(seat, meta.catIdx, meta.num, cell.acquiredSeq));
    this.emit();
  }

  _endSecurePhase() {
    if (this.state.phase !== "secure") return;
    this.state.phase = "priority";
    this.state.priority = { picks: { "1": null, "2": null }, readyNext: { "1": false, "2": false } };
    this.emit();
  }

  // ---- priority phase: before the elevator starts, each player privately marks (at most) one of
  // their own secured invoices as their "우선 택배" -- if it's actually delivered later, it scores
  // PRIORITY_MULTIPLIER x its normal reward instead of the normal amount. Picking is optional and
  // changeable until both players press space (priorityReady); this mirrors the lobby/idle "both
  // press space to continue" gate used everywhere else in this game. ----
  setPriority(seat, invoiceId) {
    if (this.state.phase !== "priority") return;
    if (invoiceId !== null) {
      const owns = this.state.players[seat].invoices.some((inv) => inv.id === invoiceId);
      if (!owns) return;
    }
    this.touch();
    this.state.priority.picks[seat] = invoiceId;
    this.emit();
  }

  priorityReady(seat) {
    if (this.state.phase !== "priority") return;
    this.touch();
    this.state.priority.readyNext[seat] = true;
    if (!(this.state.priority.readyNext["1"] && this.state.priority.readyNext["2"])) { this.emit(); return; }
    ["1", "2"].forEach((s) => { this.state.players[s].priorityInvoiceId = this.state.priority.picks[s]; });
    this.state.phase = "elevator";
    this.state.elevator = freshElevator();
    this.emit();
  }

  // ---- elevator phase ----
  _startVotingRound() {
    const el = this.state.elevator;
    el.state = "voting";
    el.votes = { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } };
    el.roundStartFloorIdx = el.floorIdx;
    el.readyNext = { "1": false, "2": false };
    el.pendingChoice = null;
    // activate whatever thief was placed LAST round (not this one -- "다음 라운드부터" 작동),
    // then clear this round's placement slots so each player gets a fresh chance to place one.
    el.thieves.active = ["1", "2"]
      .filter((s) => el.thieves.placedThisRound[s] !== null)
      .map((s) => ({ seat: s, floorIdx: el.thieves.placedThisRound[s] }));
    el.thieves.placedThisRound = { "1": null, "2": null };
    el.votingEndsAt = Date.now() + VOTE_MS;
    this._scheduleAt(el.votingEndsAt, () => this._resolveRound());
    this.emit();
  }

  // Each accepted click moves the REAL elevator by exactly one floor, right now -- not a vote that
  // gets tallied and resolved later. Both players share control of the same car during the round's
  // 5-second window, so whichever of them clicks, the car visibly steps immediately for everyone
  // (the broadcast below reaches both clients). Wherever it happens to be sitting when the round's
  // timer fires is what _resolveRound() uses for that round's delivery. votes[seat] is still
  // incremented as a simple per-player click counter for the round log only -- never shown.
  vote(seat, dir) {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "voting") return;
    if (dir !== "up" && dir !== "down") return;
    this.touch();
    const el = this.state.elevator;
    el.votes[seat][dir] += 1;
    if (dir === "up") el.floorIdx = Math.min(FLOORS.length - 1, el.floorIdx + 1);
    else el.floorIdx = Math.max(0, el.floorIdx - 1);
    this.emit(); // real-time: broadcast every single click immediately so both players see the
    // actual car move, not just their own
  }

  // 후반(half===2)에서만 유효. 1인당 라운드당 1회 -- 이번 라운드에 이미 배치했다면 무시.
  // 배치 직후엔 아무 효과 없고, 다음 라운드가 시작될 때(_startVotingRound) active로 넘어가 작동한다.
  placeThief(seat, floorIdx) {
    if (this.state.half !== 2) return;
    if (this.state.phase !== "elevator") return;
    const el = this.state.elevator;
    if (el.state !== "voting" && el.state !== "idle") return;
    if (el.thieves.placedThisRound[seat] !== null) return;
    if (typeof floorIdx !== "number" || floorIdx < 0 || floorIdx >= FLOORS.length) return;
    this.touch();
    el.thieves.placedThisRound[seat] = floorIdx;
    this.emit();
  }

  // Returns the list of delivered/stolen items for the round-result callout. Only ONE package per
  // player is delivered per floor visit -- normally the earliest-acquired (lowest acquiredSeq)
  // undelivered invoice bound for this floor, UNLESS that player explicitly chose a different one
  // during a "choosing" conflict window (forcedChoice[seat]). If an active thief (placed by the
  // OTHER seat last round) targets this floor, the delivery still "arrives" but scores as stolen
  // (guaranteed negative) instead of a normal success.
  _applyDeliveries(round, forcedChoice) {
    const el = this.state.elevator;
    const floorIdx = el.floorIdx;
    const delivered = [];
    ["1", "2"].forEach((seat) => {
      const invs = this.state.players[seat].invoices
        .filter((v) => v.deliveredRound === null && v.floorIdx === floorIdx)
        .sort((a, b) => a.acquiredSeq - b.acquiredSeq);
      if (!invs.length) return;
      let v = invs[0];
      const forcedId = forcedChoice && forcedChoice[seat];
      if (forcedId) {
        const chosen = invs.find((x) => x.id === forcedId);
        if (chosen) v = chosen;
      }
      const thief = el.thieves.active.find((t) => t.floorIdx === floorIdx && t.seat !== seat);
      v.deliveredRound = round;
      if (thief) v.stolen = true;
      delivered.push({
        seat, catIdx: v.catIdx, floorIdx: v.floorIdx, room: v.room, invoiceId: v.id,
        stolen: !!thief,
      });
    });
    return delivered;
  }

  _computeHalfScores() {
    return { "1": totalScore("1", this.state), "2": totalScore("2", this.state) };
  }

  _finishRound(round, forcedChoice) {
    const el = this.state.elevator;
    const v1 = el.votes["1"], v2 = el.votes["2"];
    const totalUp = v1.up + v2.up, totalDown = v1.down + v2.down;
    const dir = el.floorIdx > el.roundStartFloorIdx ? "up" : (el.floorIdx < el.roundStartFloorIdx ? "down" : "tie");
    const delivered = this._applyDeliveries(round, forcedChoice);
    el.log.push({ round, up: totalUp, down: totalDown, dir, floorIdx: el.floorIdx, delivered });
    el.pendingChoice = null;
    // Pause here regardless of whether this was the final round -- both players press space to
    // continue (mirrors the lobby's ready-up gate), so there's always time to read the result
    // and see what was just delivered before moving on.
    el.state = "result";
    el.readyNext = { "1": false, "2": false };
    this.emit();
  }

  // The floor has already moved live, click by click, over the course of the round (see vote()) --
  // this locks in wherever it ended up. Before delivering, check whether either player has 2+
  // undelivered invoices bound for that exact floor -- if so, give them SAME_FLOOR_CHOICE_MS to
  // pick which one goes first (random if they don't answer in time) instead of always defaulting
  // to earliest-acquired. If nobody has a conflict, deliveries resolve immediately as before.
  _resolveRound() {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "voting") return;
    const el = this.state.elevator;
    const floorIdx = el.floorIdx;
    const conflicts = {};
    ["1", "2"].forEach((seat) => {
      const candidates = this.state.players[seat].invoices
        .filter((v) => v.deliveredRound === null && v.floorIdx === floorIdx)
        .map((v) => v.id);
      if (candidates.length >= 2) conflicts[seat] = candidates;
    });
    if (Object.keys(conflicts).length === 0) {
      this._finishRound(el.round, null);
      return;
    }
    this.touch();
    el.state = "choosing";
    el.pendingChoice = {
      conflicts,
      chosen: { "1": null, "2": null },
      endsAt: Date.now() + SAME_FLOOR_CHOICE_MS,
    };
    this._scheduleAt(el.pendingChoice.endsAt, () => this._finalizeChoice());
    this.emit();
  }

  chooseDelivery(seat, invoiceId) {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "choosing") return;
    const pc = this.state.elevator.pendingChoice;
    if (!pc || !pc.conflicts[seat] || !pc.conflicts[seat].includes(invoiceId)) return;
    if (pc.chosen[seat]) return; // already chose
    this.touch();
    pc.chosen[seat] = invoiceId;
    const stillWaiting = Object.keys(pc.conflicts).some((s) => !pc.chosen[s]);
    if (!stillWaiting) { this._finalizeChoice(); return; }
    this.emit();
  }

  _finalizeChoice() {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "choosing") return;
    const el = this.state.elevator;
    const pc = el.pendingChoice;
    const forcedChoice = {};
    Object.keys(pc.conflicts).forEach((seat) => {
      forcedChoice[seat] = pc.chosen[seat]
        || pc.conflicts[seat][Math.floor(Math.random() * pc.conflicts[seat].length)];
    });
    this._finishRound(el.round, forcedChoice);
  }

  // Used both for the pre-round-1 gate ("idle") and the between-round gate ("result") -- in
  // either case, once both players have pressed space, either round 1 begins (from "idle") or
  // the next round begins / the half ends (from "result").
  setElevatorReady(seat) {
    if (this.state.phase !== "elevator") return;
    const el = this.state.elevator;
    if (el.state !== "idle" && el.state !== "result") return;
    this.touch();
    el.readyNext[seat] = true;
    if (!(el.readyNext["1"] && el.readyNext["2"])) { this.emit(); return; }
    if (el.state === "idle") {
      this._startVotingRound(); // begins round 1; also emits
      return;
    }
    if (el.round >= ELEVATOR_ROUNDS) {
      el.state = "done";
      this._finishHalf();
    } else {
      el.round += 1;
      this._startVotingRound(); // also emits
    }
  }

  // Ends the current half: snapshots this half's per-player invoices + score into halfHistory.
  // After half 1, moves to a "halftime" transition screen (both press space to start half 2 --
  // fresh boards/invoices, thief mechanic unlocked). After half 2, sums both halves' scores into
  // the grand total and moves to "end".
  _finishHalf() {
    const scores = this._computeHalfScores();
    this.state.halfHistory.push({
      half: this.state.half,
      players: JSON.parse(JSON.stringify(this.state.players)),
      scores,
    });
    if (this.state.half < HALVES) {
      this.state.half += 1;
      this.state.phase = "halftime";
      this.state.halftimeReady = { "1": false, "2": false };
      this.emit();
    } else {
      this.state.scores = {
        "1": this.state.halfHistory.reduce((sum, h) => sum + h.scores["1"], 0),
        "2": this.state.halfHistory.reduce((sum, h) => sum + h.scores["2"], 0),
      };
      this.state.phase = "end";
      this.emit();
    }
  }

  halftimeReady(seat) {
    if (this.state.phase !== "halftime") return;
    this.touch();
    this.state.halftimeReady[seat] = true;
    if (!(this.state.halftimeReady["1"] && this.state.halftimeReady["2"])) { this.emit(); return; }
    this.state.boards = { "1": freshBoard(), "2": freshBoard() };
    this.state.acquireCounter = { "1": 0, "2": 0 };
    this.state.players = freshPlayers();
    this._startGame(); // phase="secure" again, fresh secure timer; also emits
  }

  // ---- disconnect bookkeeping: free a seat if its owning client has no other open sockets ----
  releaseSeatIfOrphaned(seat, clientId, stillConnectedClientIds) {
    if (this.state.seatOwners[seat] === clientId && !stillConnectedClientIds.has(clientId)) {
      this.state.seatOwners[seat] = null;
      this.emit();
    }
  }

  _scheduleAt(ts, fn) {
    if (this.timer) clearTimeout(this.timer);
    const ms = Math.max(0, ts - Date.now());
    this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
  }
}

module.exports = { GameRoom, initialState, scoreInvoice, resultLabel, totalScore };
