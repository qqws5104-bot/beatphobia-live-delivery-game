// Shared game-economy constants + board layout. Required by both server.js (authoritative
// reducers) and build_client.py (embedded verbatim into the client bundle as JSON), so the
// two sides can never drift apart the way separately-maintained copies eventually do.
"use strict";

const TYPES = [
  { key: "normal", name: "일반택배", pieces: 2, reward: 2, penalty: 1,
    color: "#C9A576", ink: "#16233F" },
  { key: "fresh", name: "신선·냉동 택배", pieces: 3, reward: 3,
    penaltyEarly: 1, penaltyFinal: 1, color: "#6DBBFD", ink: "#16233F" },
  { key: "fragile", name: "깨지기 쉬운 택배", pieces: 4, reward: 5, penalty: 2,
    color: "#D9773F", ink: "#FFFFFF" },
  { key: "valuable", name: "귀중품", pieces: 3, reward: 4, penalty: 3,
    color: "#F0B84A", ink: "#16233F" },
];

const FLOORS = ["B1", "1F", "2F", "3F", "4F", "5F"];
// Single-digit room slot within a floor; the client combines this with the floor to display a
// realistic-looking room code like "401호" (4F, room 1) or "B03호" (B1, room 3) -- see roomCode()
// in build_client.py's APP_JS_TEMPLATE.
const ROOMS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

const CELLS = [];
TYPES.forEach((t, catIdx) => {
  for (let num = 0; num < 5; num++) {
    CELLS.push({ id: `${t.key}-${num + 1}`, catIdx, num });
  }
});

const START_FLOOR_IDX = 1; // 1F
const ELEVATOR_ROUNDS = 5;
const SECURE_PHASE_MS = 3 * 60 * 1000;
const VOTE_MS = 5000;

module.exports = { TYPES, FLOORS, ROOMS, CELLS, START_FLOOR_IDX, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS };
