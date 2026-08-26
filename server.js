"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { GameRoom } = require("./game-room");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");

// ---- room registry ----
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I -- avoids read-aloud ambiguity
function makeRoomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
  return s;
}

const rooms = new Map(); // code -> { room: GameRoom, sockets: Set<{ws, clientId, seat}> }

function getOrCreateRoom(code) {
  let entry = rooms.get(code);
  if (!entry) {
    const room = new GameRoom(code, (state) => broadcast(code, state));
    entry = { room, sockets: new Set() };
    rooms.set(code, entry);
  }
  return entry;
}

function broadcast(code, state) {
  const entry = rooms.get(code);
  if (!entry) return;
  const payload = JSON.stringify({ type: "state", state });
  for (const conn of entry.sockets) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(payload);
  }
}

// periodic sweep: drop rooms that have had zero open sockets for a while, so a long-lived
// (non-free-tier) deployment doesn't accumulate abandoned game state forever
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of rooms) {
    if (entry.sockets.size === 0 && now - entry.room.lastActivityAt > 30 * 60 * 1000) {
      entry.room.destroy();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

// ---- http server: redirect bare "/" to a fresh room, serve the client for "/?room=CODE" ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url.pathname !== "/") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const room = url.searchParams.get("room");
  if (!room) {
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode(); // astronomically unlikely, but keep it honest
    res.writeHead(302, { location: "/?room=" + code });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(INDEX_HTML);
});

// ---- websocket layer ----
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  const code = (url.searchParams.get("room") || "").toUpperCase();
  if (!code) { ws.close(4000, "missing room"); return; }
  const entry = getOrCreateRoom(code);
  const conn = { ws, clientId: null, seat: null };
  entry.sockets.add(conn);

  ws.send(JSON.stringify({ type: "state", state: entry.room.state }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    const { type, clientId, seat } = msg;
    if (typeof clientId === "string" && clientId) conn.clientId = clientId;
    if (seat === "1" || seat === "2") conn.seat = seat;

    switch (type) {
      case "hello":
        // nothing further to do -- state was already sent on connect; this just registers
        // clientId/seat on the connection object (above) for disconnect bookkeeping
        break;
      case "pick-seat": {
        if (!conn.clientId || (seat !== "1" && seat !== "2")) return;
        const res = entry.room.pickSeat(seat, conn.clientId);
        if (!res.ok) ws.send(JSON.stringify({ type: "error", code: res.code, seat }));
        break;
      }
      case "set-ready":
        if (!conn.seat) return;
        entry.room.setReady(conn.seat);
        break;
      case "secure-cell":
        if (!conn.seat || typeof msg.cellId !== "string") return;
        entry.room.secureCell(conn.seat, msg.cellId);
        break;
      case "vote":
        if (!conn.seat || (msg.dir !== "up" && msg.dir !== "down")) return;
        entry.room.vote(conn.seat, msg.dir);
        break;
      default:
        break;
    }
  });

  ws.on("close", () => {
    entry.sockets.delete(conn);
    if (conn.seat && conn.clientId) {
      const stillConnected = new Set(Array.from(entry.sockets).map((c) => c.clientId).filter(Boolean));
      entry.room.releaseSeatIfOrphaned(conn.seat, conn.clientId, stillConnected);
    }
  });
});

server.listen(PORT, () => {
  console.log("live_game server listening on port " + PORT);
});
