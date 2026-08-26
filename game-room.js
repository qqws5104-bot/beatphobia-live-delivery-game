// Authoritative, server-side game room. One instance per room code. All mutations happen here,
// in Node's single-threaded event loop, so there is no version/conflict machinery to speak of --
// two near-simultaneous actions are simply processed one after the other, in order. That whole
// class of problem (and the fragile client-side retry/tally-persistence code it required) only
// existed because the old design had no real server; it's gone here by construction.
"use strict";

const { TYPES, FLOORS, ROOMS, CELLS, START_FLOOR_IDX, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS } = require("./game-data");

function cellById(state, id) { return state.board.find((c) => c.id === id) || null; }
function cellMeta(id) { return CELLS.find((c) => c.id === id) || null; }

function randomInvoice(catIdx, acquiredSeq) {
  const floorIdx = Math.floor(Math.random() * FLOORS.length);
  const room = ROOMS[Math.floor(Math.random() * ROOMS.length)];
  return { id: "inv-" + acquiredSeq, catIdx, floorIdx, room, acquiredSeq, deliveredRound: null };
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

function initialState() {
  return {
    phase: "lobby",
    ready: { "1": false, "2": false },
    seatOwners: { "1": null, "2": null },
    secureEndsAt: null,
    board: CELLS.map((c) => ({ id: c.id, catIdx: c.catIdx, num: c.num, ownerSeat: null, acquiredSeq: null })),
    acquireCounter: 0,
    players: { "1": { invoices: [] }, "2": { invoices: [] } },
    elevator: {
      round: 1, floorIdx: START_FLOOR_IDX, state: "idle", votingEndsAt: null,
      votes: { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } }, log: [],
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
  secureCell(seat, cellId) {
    if (this.state.phase !== "secure") return;
    const cell = cellById(this.state, cellId);
    if (!cell || cell.ownerSeat) return; // already taken (or unknown id) -- silent no-op, client re-renders from next state anyway
    this.touch();
    cell.ownerSeat = seat;
    this.state.acquireCounter += 1;
    cell.acquiredSeq = this.state.acquireCounter;
    const meta = cellMeta(cellId);
    this.state.players[seat].invoices.push(randomInvoice(meta.catIdx, this.state.acquireCounter));
    this.emit();
  }

  _endSecurePhase() {
    if (this.state.phase !== "secure") return;
    this.state.phase = "elevator";
    this._startVotingRound();
  }

  // ---- elevator phase ----
  _startVotingRound() {
    this.state.elevator.state = "voting";
    this.state.elevator.votes = { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } };
    this.state.elevator.votingEndsAt = Date.now() + VOTE_MS;
    this._scheduleAt(this.state.elevator.votingEndsAt, () => this._resolveRound());
    this.emit();
  }

  vote(seat, dir) {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "voting") return;
    if (dir !== "up" && dir !== "down") return;
    this.touch();
    this.state.elevator.votes[seat][dir] += 1;
    this.emit(); // real-time: broadcast every single click immediately, both players see live tallies
  }

  _applyDeliveries(round) {
    const floorIdx = this.state.elevator.floorIdx;
    ["1", "2"].forEach((seat) => {
      const invs = this.state.players[seat].invoices
        .filter((v) => v.deliveredRound === null && v.floorIdx === floorIdx)
        .sort((a, b) => a.acquiredSeq - b.acquiredSeq);
      invs.forEach((v) => { v.deliveredRound = round; });
    });
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
    el.log.push({ round: el.round, up: totalUp, down: totalDown, dir, floorIdx: el.floorIdx });
    this._applyDeliveries(el.round);
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
