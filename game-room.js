// Authoritative, server-side game room. One instance per room code. All mutations happen here,
// in Node's single-threaded event loop, so there is no version/conflict machinery to speak of --
// two near-simultaneous actions are simply processed one after the other, in order. That whole
// class of problem (and the fragile client-side retry/tally-persistence code it required) only
// existed because the old design had no real server; it's gone here by construction.
"use strict";

const { TYPES, FLOORS, ROOMS, CELLS, START_FLOOR_IDX, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS } = require("./game-data");

// Secure phase is per-player now: each seat has its own independent copy of the 20-cell board,
// so there is no cross-player contention (both players can secure "the same" cell id -- they're
// really securing their own separate copy of it). cellById therefore needs to know which seat's
// board to look in.
function cellById(state, seat, id) { return state.boards[seat].find((c) => c.id === id) || null; }
function cellMeta(id) { return CELLS.find((c) => c.id === id) || null; }

function randomInvoice(seat, catIdx, acquiredSeq) {
  const floorIdx = Math.floor(Math.random() * FLOORS.length);
  const room = ROOMS[Math.floor(Math.random() * ROOMS.length)];
  return { id: "inv-" + seat + "-" + acquiredSeq, catIdx, floorIdx, room, acquiredSeq, deliveredRound: null };
}

function scoreInvoice(inv) {
  const t = TYPES[inv.catIdx];
  if (t.key === "fresh") {
    if (inv.deliveredRound === null) return -(t.penaltyEarly + t.penaltyFinal);
    if (inv.deliveredRound <= 2) return t.reward;
    return t.reward - t.penaltyEarly;
  }
  return inv.deliveredRound === null ? -t.penalty : t.reward;
}
function resultLabel(inv) {
  const t = TYPES[inv.catIdx];
  if (t.key === "fresh") {
    if (inv.deliveredRound === null) return "미배송 (최종)";
    if (inv.deliveredRound <= 2) return "성공";
    return "지연성공";
  }
  return inv.deliveredRound === null ? "미배송" : "성공";
}
function totalScore(seat, state) {
  return state.players[seat].invoices.reduce((sum, inv) => sum + scoreInvoice(inv), 0);
}

function freshBoard() {
  return CELLS.map((c) => ({ id: c.id, catIdx: c.catIdx, num: c.num, taken: false, acquiredSeq: null }));
}

function initialState() {
  return {
    phase: "lobby",
    ready: { "1": false, "2": false },
    seatOwners: { "1": null, "2": null },
    secureEndsAt: null,
    boards: { "1": freshBoard(), "2": freshBoard() },
    acquireCounter: { "1": 0, "2": 0 },
    players: { "1": { invoices: [] }, "2": { invoices: [] } },
    elevator: {
      // state: "idle" | "voting" | "result" | "done"
      // "result" is a pause after the 5s tally where both players must press space (readyNext)
      // before the next round (or the end screen, for the final round) begins.
      round: 1, floorIdx: START_FLOOR_IDX, state: "idle", votingEndsAt: null,
      votes: { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } },
      readyNext: { "1": false, "2": false },
      log: [],
    },
    scores: null,
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
  // cross-player race here anymore -- player 1 securing "fresh-1" has zero effect on whether
  // player 2 can also secure their own "fresh-1". Giving up (the client just closes the puzzle
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
    this.state.players[seat].invoices.push(randomInvoice(seat, meta.catIdx, cell.acquiredSeq));
    this.emit();
  }

  _endSecurePhase() {
    if (this.state.phase !== "secure") return;
    this.state.phase = "elevator";
    // don't auto-start round 1 -- wait at "idle" until both players press space, same as the
    // between-round gate. Gives everyone a moment to look over their invoices first.
    this.state.elevator.readyNext = { "1": false, "2": false };
    this.emit();
  }

  // ---- elevator phase ----
  _startVotingRound() {
    this.state.elevator.state = "voting";
    this.state.elevator.votes = { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } };
    this.state.elevator.readyNext = { "1": false, "2": false };
    this.state.elevator.votingEndsAt = Date.now() + VOTE_MS;
    this._scheduleAt(this.state.elevator.votingEndsAt, () => this._resolveRound());
    this.emit();
  }

  vote(seat, dir) {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "voting") return;
    if (dir !== "up" && dir !== "down") return;
    this.touch();
    this.state.elevator.votes[seat][dir] += 1;
    this.emit(); // real-time: broadcast every single click immediately (server-side; the client
    // chooses whether to render the opponent's live count -- see build_client.py)
  }

  // Returns the list of {seat, catIdx, floorIdx, room} for invoices delivered just now, so the
  // "result" pause screen can show exactly what arrived this round (e.g. "401호 신선·냉동 택배").
  // Only ONE package per player is delivered per floor visit -- the earliest-acquired (lowest
  // acquiredSeq) undelivered invoice bound for this floor -- even if several are waiting here.
  // Any others bound for the same floor stay pending until the elevator returns to it again.
  _applyDeliveries(round) {
    const floorIdx = this.state.elevator.floorIdx;
    const delivered = [];
    ["1", "2"].forEach((seat) => {
      const invs = this.state.players[seat].invoices
        .filter((v) => v.deliveredRound === null && v.floorIdx === floorIdx)
        .sort((a, b) => a.acquiredSeq - b.acquiredSeq);
      if (invs.length) {
        const v = invs[0];
        v.deliveredRound = round;
        delivered.push({ seat, catIdx: v.catIdx, floorIdx: v.floorIdx, room: v.room });
      }
    });
    return delivered;
  }

  _computeScores() {
    this.state.scores = { "1": totalScore("1", this.state), "2": totalScore("2", this.state) };
  }

  _resolveRound() {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "voting") return;
    const el = this.state.elevator;
    const v1 = el.votes["1"], v2 = el.votes["2"];
    const totalUp = v1.up + v2.up, totalDown = v1.down + v2.down;
    const dir = totalUp > totalDown ? "up" : (totalDown > totalUp ? "down" : "tie");
    if (dir === "up") el.floorIdx = Math.min(FLOORS.length - 1, el.floorIdx + 1);
    if (dir === "down") el.floorIdx = Math.max(0, el.floorIdx - 1);
    const delivered = this._applyDeliveries(el.round);
    el.log.push({ round: el.round, up: totalUp, down: totalDown, dir, floorIdx: el.floorIdx, delivered });
    // Pause here regardless of whether this was the final round -- both players press space to
    // continue (mirrors the lobby's ready-up gate), so there's always time to read the result
    // and see what was just delivered before moving on.
    el.state = "result";
    el.readyNext = { "1": false, "2": false };
    this.emit();
  }

  // Used both for the pre-round-1 gate ("idle") and the between-round gate ("result") -- in
  // either case, once both players have pressed space, either round 1 begins (from "idle") or
  // the next round begins / the game ends (from "result").
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
      this.state.phase = "end";
      this._computeScores();
      this.emit();
    } else {
      el.round += 1;
      this._startVotingRound(); // also emits
    }
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
