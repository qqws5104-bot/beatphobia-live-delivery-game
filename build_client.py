"""
택배 배송 게임 — 자체 호스팅(WebSocket 서버) 버전의 클라이언트(public/index.html) 생성 스크립트.

Claude Artifact의 publish/reload 구조를 걷어내고, 실제 Node WebSocket 서버(server.js +
game-room.js)가 상태를 소유한다. 클라이언트는 이제 순수 렌더러 + WS 클라이언트일 뿐이라
예전 버전에 있던 것들이 통째로 사라졌다: 클라이언트측 리듀서, sessionStorage 기반 pending
액션 재시도, publish 충돌/재시도 로직, 라운드별 투표 집계를 로컬에 모아뒀다 라운드 끝에
한 번만 제출하던 방식(그리고 그 방식 때문에 있었던 "제출 직전 리로드로 집계가 날아가는"
버그의 원인 자체)까지 전부. 서버가 모든 액션을 순서대로 처리하는 단일 소유자이므로
클릭 하나하나를 즉시 브로드캐스트해도 안전하고, 오히려 그게 더 단순하다.

TYPES/CELLS/FLOORS/ROOMS 경제 상수는 game-data.js(서버가 require하는 것과 동일 파일)에서
읽어와 클라이언트 JSON에 그대로 반영한다 — 서버와 클라이언트가 다른 소스에서 각자
유지되며 몰래 어긋나는 일을 원천적으로 막기 위함.
"""

import os
import re
import base64
import json

REF_DIR = "/home/claude/project/quiz_board/ref"
COMPRESSED_DIR = "/tmp/compressed"
GAME_DATA_JS = os.path.join(os.path.dirname(__file__), "game-data.js")
OUT_HTML = os.path.join(os.path.dirname(__file__), "public", "index.html")


def load_shared_constants():
    """game-data.js를 파싱해서 TYPES/FLOORS/ROOMS/ELEVATOR_ROUNDS/SECURE_PHASE_MS/VOTE_MS를
    그대로 재사용한다 (정규식으로 각 상수 리터럴을 추출 -- Node를 별도로 실행하지 않고
    빌드 스크립트를 순수 Python으로 유지하기 위함). 값이 하나라도 어긋나면 즉시 실패하도록
    각 상수를 못 찾으면 에러를 낸다."""
    src = open(GAME_DATA_JS, encoding="utf-8").read()

    def grab(name):
        m = re.search(r"const %s = (\[[\s\S]*?\]|\d+(?:\s*\*\s*\d+)*);" % re.escape(name), src)
        if not m:
            raise RuntimeError(f"could not find {name} in game-data.js")
        return m.group(1)

    types_js = grab("TYPES")
    floors_js = grab("FLOORS")
    rooms_js = grab("ROOMS")
    elevator_rounds = eval(grab("ELEVATOR_ROUNDS"))
    secure_phase_ms = eval(grab("SECURE_PHASE_MS"))
    vote_ms = eval(grab("VOTE_MS"))

    # TYPES uses plain (unquoted) JS object keys -- not valid JSON as-is. Quote bare
    # identifier keys before parsing (FLOORS/ROOMS are already flat string arrays, so this
    # is a no-op for them; applying it unconditionally keeps this function generic).
    def js_object_to_json(js):
        js = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)', r'\1"\2"\3', js)
        # strip trailing commas before a closing ] or } (valid in JS, not in JSON)
        js = re.sub(r',(\s*[\]}])', r'\1', js)
        return js

    types = json.loads(js_object_to_json(types_js))
    floors = json.loads(js_object_to_json(floors_js))
    rooms = json.loads(js_object_to_json(rooms_js))
    return types, floors, rooms, elevator_rounds, secure_phase_ms, vote_ms


TYPES, FLOORS, ROOMS, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS = load_shared_constants()

# 스와치 개수 매핑 -- quiz_board/build_site.py, build_live_game.py와 동일 이미지 세트, 동일 로직
IMAGE_FILES = sorted(
    f for f in os.listdir(REF_DIR)
    if f.lower().endswith(".png") and f != "contact_sheet.png"
)
assert len(IMAGE_FILES) == 20
SWATCH2_IDX = [0, 1, 5, 6, 7]
SWATCH3_IDX = [2, 3, 4, 8, 9, 10, 11, 12, 13, 14]
SWATCH4_IDX = [15, 16, 17, 18, 19]
SWATCH3_SPLIT = 5

GRID = [
    [IMAGE_FILES[i] for i in SWATCH2_IDX],
    [IMAGE_FILES[i] for i in SWATCH3_IDX[:SWATCH3_SPLIT]],
    [IMAGE_FILES[i] for i in SWATCH4_IDX],
    [IMAGE_FILES[i] for i in SWATCH3_IDX[SWATCH3_SPLIT:]],
]


def data_uri_for(png_name):
    jpg_name = png_name.replace(".png", ".jpg")
    path = os.path.join(COMPRESSED_DIR, jpg_name)
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


CELLS = []
for cat_idx, t in enumerate(TYPES):
    for num_idx in range(5):
        CELLS.append({
            "id": f"{t['key']}-{num_idx + 1}",
            "catIdx": cat_idx,
            "num": num_idx,
            "src": data_uri_for(GRID[cat_idx][num_idx]),
        })

TYPES_JSON = json.dumps(TYPES, ensure_ascii=False)
CELLS_JSON = json.dumps(CELLS, ensure_ascii=False)
FLOORS_JSON = json.dumps(FLOORS, ensure_ascii=False)
ROOMS_JSON = json.dumps(ROOMS, ensure_ascii=False)

HEAD_HTML = """<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>택배 배송 게임 — 라이브</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #101a2c; --bg-deep: #0a1220; --panel: #1b2a45; --panel-line: rgba(255,255,255,0.09);
    --ink: #f5f4f0; --muted: #93a0be; --gold: #f0b84a; --gold-ink: #16233f;
    --sky: #6dbbfd; --danger: #d9483a; --ok: #3fae6a; --visited: #3a4256;
    --font-display: 'Oswald','Noto Sans KR',sans-serif; --font-body: 'Noto Sans KR',system-ui,-apple-system,sans-serif;
  }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; background:var(--bg); color:var(--ink); font-family:var(--font-body); min-height:100%; }
  body { min-height:100vh; }
  #app { min-height:100vh; display:flex; flex-direction:column; }
  button { font-family:inherit; cursor:pointer; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:1rem;
    padding:0.9rem clamp(1rem,3vw,2.2rem); border-bottom:1px solid var(--panel-line);
    background:linear-gradient(180deg,var(--bg-deep),rgba(10,18,32,0.4)); flex-wrap:wrap; }
  .topbar .brand { display:flex; flex-direction:column; gap:0.3rem; }
  .topbar .eyebrow { font-family:var(--font-display); font-size:0.7rem; letter-spacing:0.2em; text-transform:uppercase; color:var(--gold); font-weight:600; }
  .topbar h1 { margin:0; font-size:clamp(1.1rem,2vw,1.5rem); font-weight:700; }
  .topbar .right { display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap; }
  .seat-badge { display:inline-flex; align-items:center; gap:0.4rem; padding:0.3rem 0.7rem; border-radius:999px;
    border:1px solid rgba(240,184,74,0.4); background:rgba(240,184,74,0.1); color:var(--gold);
    font-family:var(--font-display); font-size:0.82rem; font-weight:600; }
  .room-chip { display:inline-flex; align-items:center; gap:0.35rem; padding:0.3rem 0.7rem; border-radius:999px;
    border:1px solid rgba(109,187,253,0.4); background:rgba(109,187,253,0.1); color:var(--sky);
    font-family:var(--font-display); font-size:0.82rem; font-weight:600; letter-spacing:0.05em; }
  .conn-banner { position:fixed; top:0; left:0; right:0; z-index:90; text-align:center; padding:0.5rem;
    background:var(--danger); color:#fff; font-family:var(--font-display); font-size:0.85rem; font-weight:600; }
  main.stage { flex:1; padding:clamp(1rem,3vw,2.2rem); display:flex; flex-direction:column; gap:1.2rem; }
  main.stage.stage--secure { padding-left:calc(128px + 1.1rem + 1.6rem); }
  @media (max-width:900px) { main.stage.stage--secure { padding-left:clamp(1rem,3vw,2.2rem); } }
  .card { background:var(--panel); border:1px solid var(--panel-line); border-radius:14px; padding:1.2rem 1.4rem; }
  .btn { border:none; border-radius:10px; padding:0.7rem 1.3rem; font-weight:700; font-size:0.95rem;
    font-family:var(--font-display); letter-spacing:0.01em; transition:transform .12s ease, filter .12s ease; }
  .btn:active { transform:scale(0.96); }
  .btn.primary { background:var(--gold); color:var(--gold-ink); }
  .btn.primary:hover { filter:brightness(1.08); }
  .btn.ghost { background:transparent; color:var(--ink); border:1px solid var(--panel-line); }
  .btn.danger { background:var(--danger); color:#fff; }
  .btn.ok { background:var(--ok); color:#fff; }
  .btn:disabled { opacity:0.4; cursor:not-allowed; transform:none; }
  .btn.big { padding:1.4rem; font-size:1.4rem; border-radius:16px; width:100%; }

  .center-screen { flex:1; display:flex; align-items:center; justify-content:center; }
  .seat-pick { text-align:center; max-width:420px; }
  .seat-pick h2 { font-family:var(--font-display); font-size:1.6rem; margin:0 0 0.4rem; }
  .seat-pick p { color:var(--muted); font-size:0.9rem; margin:0 0 1.4rem; }
  .seat-options { display:flex; gap:0.8rem; justify-content:center; }
  .seat-options .btn { flex:1; padding:1.6rem 1rem; font-size:1.15rem; }
  .seat-options .btn.taken { position:relative; }
  .seat-options .btn .taken-note { display:block; font-size:0.7rem; font-weight:500; margin-top:0.3rem; opacity:0.8; }
  .room-share { margin-top:1.2rem; padding-top:1.2rem; border-top:1px solid var(--panel-line); color:var(--muted); font-size:0.85rem; }
  .room-share strong { color:var(--sky); font-family:var(--font-display); letter-spacing:0.08em; }

  .lobby-box { text-align:center; max-width:520px; }
  .lobby-box h2 { font-family:var(--font-display); font-size:1.8rem; margin:0 0 0.6rem; }
  .lobby-box p { color:var(--muted); font-size:0.95rem; line-height:1.6; }

  .timer-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
  .timer-label { font-family:var(--font-display); font-size:0.85rem; color:var(--muted); letter-spacing:0.05em; }
  .timer-num { font-family:var(--font-display); font-size:1.9rem; font-weight:700; font-variant-numeric:tabular-nums; color:var(--gold); }
  .timer-bar { height:8px; border-radius:999px; background:rgba(255,255,255,0.08); overflow:hidden; margin-top:0.5rem; }
  .timer-bar > i { display:block; height:100%; background:var(--gold); transition:width 0.3s linear; }

  .side-timer { position:fixed; left:1.1rem; top:6.5rem; width:128px; z-index:30; text-align:center;
    background:var(--panel); border:1px solid var(--panel-line); border-radius:14px; padding:0.9rem 0.8rem;
    box-shadow:0 14px 34px rgba(0,0,0,0.4); }
  .side-timer .timer-label { display:block; line-height:1.3; margin-bottom:0.4rem; }
  .side-timer .timer-num { display:block; font-size:1.65rem; }
  .side-timer .timer-bar { margin-top:0.6rem; }
  @media (max-width:900px) { .side-timer { position:static; width:auto; margin:0 0 1rem; display:flex;
    align-items:center; gap:0.9rem; text-align:left; } .side-timer .timer-bar { flex:1; margin-top:0; } }

  .ready-row { display:flex; gap:0.7rem; justify-content:center; margin-top:1.2rem; flex-wrap:wrap; }
  .ready-chip { font-family:var(--font-display); font-size:0.85rem; font-weight:600; padding:0.5rem 0.9rem;
    border-radius:999px; border:1px solid var(--panel-line); color:var(--muted); }
  .ready-chip.is-ready { color:var(--ok); border-color:rgba(63,174,106,0.5); background:rgba(63,174,106,0.1); }
  .space-hint { margin:1.4rem auto 0; width:min(220px,80%); padding:0.9rem; text-align:center; border-radius:10px;
    border:1px solid var(--panel-line); background:rgba(255,255,255,0.03); font-family:var(--font-display);
    letter-spacing:0.08em; color:var(--muted); }
  .key-hint { margin-top:0.6rem; color:var(--muted); font-size:0.78rem; }

  .board-grid { display:grid; grid-template-columns:minmax(120px,150px) repeat(5,1fr); gap:0.5rem; }
  .board-head, .board-label { display:flex; align-items:center; padding:0.5rem 0.7rem; border-radius:8px;
    font-family:var(--font-display); font-weight:600; font-size:0.85rem; }
  .board-head { background:transparent; color:var(--muted); justify-content:center; }
  .board-label { font-weight:700; }
  .cell { position:relative; aspect-ratio:1/0.72; border-radius:10px; border:none; display:flex; align-items:center; justify-content:center;
    font-family:var(--font-display); font-weight:700; font-size:1.3rem; color:#fff; overflow:hidden; }
  .cell .cell-num { position:relative; z-index:2; text-shadow:0 1px 3px rgba(0,0,0,0.5); }
  .cell::before { content:""; position:absolute; inset:0; background:rgba(0,0,0,0.08); }
  .cell.taken { background:var(--visited) !important; color:#7c8296; cursor:default; }
  .cell.taken .owner-tag { position:absolute; bottom:4px; right:6px; font-size:0.62rem; background:rgba(0,0,0,0.4);
    padding:0.1rem 0.4rem; border-radius:999px; z-index:2; }
  .cell:not(.taken):hover { filter:brightness(1.12); }

  .overlay { position:fixed; inset:0; background:rgba(6,10,18,0.92); display:flex; align-items:center; justify-content:center;
    z-index:50; padding:1.2rem; }
  .overlay.hidden { display:none; }
  .puzzle-frame { max-width:960px; width:100%; }
  .puzzle-frame img { width:100%; border-radius:12px; display:block; box-shadow:0 20px 60px rgba(0,0,0,0.5); }
  .puzzle-actions { display:flex; gap:0.8rem; margin-top:1rem; }
  .puzzle-actions .btn { flex:1; }

  .elev-layout { display:grid; grid-template-columns:220px 1fr; gap:1.2rem; align-items:start; }
  @media (max-width:820px) { .elev-layout { grid-template-columns:1fr; } }
  .shaft { background:var(--bg-deep); border-radius:14px; border:1px solid var(--panel-line); padding:1rem 0.8rem; }
  .shaft-track { display:flex; flex-direction:column-reverse; gap:0.4rem; }
  .floor-stop { display:flex; align-items:center; gap:0.5rem; padding:0.5rem 0.6rem; border-radius:8px; font-family:var(--font-display); font-weight:600; color:var(--muted); }
  .floor-stop.current { background:rgba(240,184,74,0.14); color:var(--gold); }
  .floor-stop .car { width:10px; height:10px; border-radius:3px; background:transparent; }
  .floor-stop.current .car { background:var(--gold); box-shadow:0 0 10px var(--gold); }
  .round-pill { display:inline-flex; align-items:center; gap:0.4rem; padding:0.3rem 0.8rem; border-radius:999px;
    background:rgba(109,187,253,0.14); color:var(--sky); font-family:var(--font-display); font-weight:600; font-size:0.85rem; }
  .vote-buttons { display:flex; flex-direction:column; gap:0.7rem; margin-top:1rem; }
  .vote-count-row { display:flex; justify-content:space-between; align-items:center; margin-top:0.6rem; font-family:var(--font-display); gap:1rem; }
  .vote-count-col { text-align:center; flex:1; }
  .vote-count-col .who { display:block; font-size:0.72rem; color:var(--muted); letter-spacing:0.04em; margin-bottom:0.2rem; }
  .vote-count-col .nums { font-size:1.5rem; font-weight:700; font-variant-numeric:tabular-nums; }
  .vote-count-col .nums .up { color:var(--ok); }
  .vote-count-col .nums .down { color:var(--danger); margin-left:0.5rem; }
  .round-result { background:rgba(63,174,106,0.1); border:1px solid rgba(63,174,106,0.3); border-radius:10px; padding:0.9rem 1rem; margin-top:0.8rem; }

  .invoice-list { display:flex; flex-direction:column; gap:0.5rem; margin-top:0.7rem; }
  .invoice { display:flex; align-items:center; gap:0.7rem; padding:0.55rem 0.7rem; border-radius:9px; background:rgba(255,255,255,0.04); border:1px solid var(--panel-line); }
  .invoice.delivered { opacity:0.65; }
  .invoice .swatch { width:10px; height:34px; border-radius:4px; flex-shrink:0; }
  .invoice .meta { flex:1; }
  .invoice .meta .t { font-weight:700; font-size:0.88rem; }
  .invoice .meta .d { font-size:0.78rem; color:var(--muted); }
  .invoice .sticker { font-family:var(--font-display); font-size:0.72rem; font-weight:700; padding:0.2rem 0.5rem; border-radius:999px;
    background:var(--ok); color:#fff; white-space:nowrap; }
  .invoice .sticker.pending { background:transparent; color:var(--muted); border:1px dashed var(--panel-line); }

  .split-two { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
  @media (max-width:720px) { .split-two { grid-template-columns:1fr; } }
  .player-col h3 { font-family:var(--font-display); font-size:0.95rem; margin:0 0 0.3rem; color:var(--muted); }
  .player-col.me h3 { color:var(--gold); }

  .score-table { width:100%; border-collapse:collapse; margin-top:0.6rem; }
  .score-table th, .score-table td { text-align:left; padding:0.45rem 0.5rem; border-bottom:1px solid var(--panel-line); font-size:0.85rem; }
  .score-table th { color:var(--muted); font-weight:600; font-family:var(--font-display); }
  .winner-banner { text-align:center; padding:1.4rem; font-family:var(--font-display); font-size:1.6rem; font-weight:700; color:var(--gold); }
  .toast { position:fixed; left:50%; bottom:1.4rem; transform:translateX(-50%); background:var(--panel); border:1px solid var(--panel-line);
    padding:0.6rem 1.1rem; border-radius:999px; font-size:0.85rem; z-index:80; box-shadow:0 10px 30px rgba(0,0,0,0.4); }
</style>
</head><body>
<div id="app"></div>
"""

APP_JS_TEMPLATE = r"""
(function () {
  "use strict";

  var TYPES = @@TYPES_JSON@@;
  var CELLS = @@CELLS_JSON@@;
  var FLOORS = @@FLOORS_JSON@@;
  var ROOMS = @@ROOMS_JSON@@;
  var ELEVATOR_ROUNDS = @@ELEVATOR_ROUNDS@@;
  var SECURE_PHASE_MS = @@SECURE_PHASE_MS@@;

  var ROOM = (new URLSearchParams(window.location.search).get("room") || "").trim().toUpperCase();

  // ---------- identity: per-tab, survives a refresh (sessionStorage), but a second tab on the
  // same device gets its own id -- so two tabs can hold the two different seats without one
  // stealing the other's seat on reconnect. ----------
  function getClientId() {
    try {
      var id = sessionStorage.getItem("bp-client-id");
      if (!id) { id = "c-" + Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem("bp-client-id", id); }
      return id;
    } catch (e) { return "c-" + Math.random().toString(36).slice(2); }
  }
  var CLIENT_ID = getClientId();
  function mySeat() { try { return sessionStorage.getItem("bp-seat"); } catch (e) { return null; } }
  function setMySeat(s) { try { sessionStorage.setItem("bp-seat", s); } catch (e) {} }

  var state = null; // populated by the first "state" message from the server
  var local = { openCellId: null, toast: null };
  var wsConnected = false;

  function cellById(st, id) { for (var i = 0; i < st.board.length; i++) if (st.board[i].id === id) return st.board[i]; return null; }
  function cellMeta(id) { for (var i = 0; i < CELLS.length; i++) if (CELLS[i].id === id) return CELLS[i]; return null; }

  // ---------- scoring (pure display functions -- server owns deliveredRound/floorIdx, this
  // just formats them; no risk of drifting from the server since it's a pure fn of server data) ----------
  function scoreInvoice(inv) {
    var t = TYPES[inv.catIdx];
    if (t.key === "fresh") {
      if (inv.deliveredRound === null) return -(t.penaltyEarly + t.penaltyFinal);
      if (inv.deliveredRound <= 2) return t.reward;
      return t.reward - t.penaltyEarly;
    }
    if (inv.deliveredRound === null) return -t.penalty;
    return t.reward;
  }
  function resultLabel(inv) {
    var t = TYPES[inv.catIdx];
    if (t.key === "fresh") {
      if (inv.deliveredRound === null) return "미배송 (최종)";
      if (inv.deliveredRound <= 2) return "성공";
      return "지연성공";
    }
    return inv.deliveredRound === null ? "미배송" : "성공";
  }
  function totalScore(seat, st) {
    return st.players[seat].invoices.reduce(function (sum, inv) { return sum + scoreInvoice(inv); }, 0);
  }

  // ---------- websocket sync: the server is the single source of truth. every action is just a
  // fire-and-forget message; the resulting full state comes back (to everyone in the room) as
  // a broadcast, and render() runs off of that. no client-side reducers, no conflict handling,
  // no pending-action retry queue -- none of that machinery is needed once a real server owns
  // the state and processes messages one at a time. ----------
  var ws = null;
  function wsUrl() {
    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + window.location.host + "/ws?room=" + encodeURIComponent(ROOM);
  }
  function connectWS() {
    if (!ROOM) return;
    try { ws = new WebSocket(wsUrl()); } catch (e) { setTimeout(connectWS, 1500); return; }
    ws.onopen = function () {
      wsConnected = true;
      renderConnBanner();
      var seat = mySeat();
      ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID, seat: seat }));
      if (seat) ws.send(JSON.stringify({ type: "pick-seat", clientId: CLIENT_ID, seat: seat })); // reclaim after reconnect
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg) return;
      if (msg.type === "state") { state = msg.state; render(); }
      else if (msg.type === "error") { handleWsError(msg); }
    };
    ws.onclose = function () { wsConnected = false; renderConnBanner(); setTimeout(connectWS, 1200); };
    ws.onerror = function () {};
  }
  function send(action) {
    action.clientId = CLIENT_ID;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(action));
  }
  function handleWsError(msg) {
    if (msg.code === "seat_taken") {
      try { sessionStorage.removeItem("bp-seat"); } catch (e) {}
      showToast("플레이어 " + msg.seat + "는 이미 다른 사람이 선택했어요. 다른 좌석을 골라주세요.");
      render();
    }
  }
  function renderConnBanner() {
    var el = document.getElementById("conn-banner");
    if (wsConnected) { if (el) el.remove(); return; }
    if (el) return;
    var d = document.createElement("div");
    d.id = "conn-banner"; d.className = "conn-banner"; d.textContent = "서버와 연결이 끊겼어요 — 재연결 시도 중...";
    document.body.appendChild(d);
  }

  // ---------- rendering ----------
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function fmtClock(ms) {
    if (ms < 0) ms = 0;
    var s = Math.ceil(ms / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function renderSeatPicker() {
    var taken1 = state && state.seatOwners["1"] && state.seatOwners["1"] !== CLIENT_ID;
    var taken2 = state && state.seatOwners["2"] && state.seatOwners["2"] !== CLIENT_ID;
    function seatBtn(n, taken) {
      return '<button class="btn primary' + (taken ? ' taken' : '') + '" data-action="pick-seat" data-seat="' + n + '"' + (taken ? ' disabled' : '') + '>'
        + '플레이어 ' + n + (taken ? '<span class="taken-note">이미 선택됨</span>' : '') + '</button>';
    }
    return '<div class="center-screen"><div class="seat-pick">'
      + '<h2>어느 플레이어인가요?</h2>'
      + '<p>이 기기에서 조작할 좌석을 한 번만 선택하세요. 다른 사람과 겹치지 않게 서로 다른 좌석을 골라주세요.</p>'
      + '<div class="seat-options">' + seatBtn("1", taken1) + seatBtn("2", taken2) + '</div>'
      + '<div class="room-share">이 방 코드: <strong>' + esc(ROOM) + '</strong><br>상대방에게는 지금 이 페이지의 링크를 그대로 보내주면 같은 방으로 들어와요.</div>'
      + '</div></div>';
  }

  function renderTopbar(st, seat) {
    var phaseLabel = { lobby: "대기 중", secure: "택배 확보", elevator: "엘리베이터", end: "결과" }[st.phase] || "";
    return '<div class="topbar"><div class="brand"><span class="eyebrow">BeatPhobia · Live</span><h1>택배 배송 게임 — ' + phaseLabel + '</h1></div>'
      + '<div class="right"><span class="room-chip">방 ' + esc(ROOM) + '</span>'
      + '<span class="seat-badge">' + (seat ? ("내 좌석 · 플레이어 " + seat) : "좌석 미선택") + '</span></div></div>';
  }

  function renderLobby(st, seat) {
    var otherSeat = seat === "1" ? "2" : (seat === "2" ? "1" : null);
    var mine = seat ? !!st.ready[seat] : false;
    var other = otherSeat ? !!st.ready[otherSeat] : false;
    return '<main class="stage"><div class="center-screen"><div class="lobby-box card">'
      + '<h2>택배 배송 게임</h2>'
      + '<p>두 사람 모두 이 페이지를 열고 좌석을 선택한 뒤, 각자 자기 키보드의 <strong>스페이스바</strong>를 누르면 준비 완료예요.<br>'
      + '둘 다 준비되면 자동으로 시작하고, 3분 동안 택배 확보 미니게임을 진행한 뒤 자동으로 엘리베이터 라운드(총 ' + ELEVATOR_ROUNDS + '라운드)로 넘어가요.</p>'
      + '<div class="ready-row">'
      + '<span class="ready-chip' + (mine ? ' is-ready' : '') + '">나 · 플레이어 ' + (seat || "-") + (mine ? ' · 준비 완료' : ' · 스페이스바 대기') + '</span>'
      + '<span class="ready-chip' + (other ? ' is-ready' : '') + '">플레이어 ' + (otherSeat || "-") + (other ? ' · 준비 완료' : ' · 대기 중') + '</span>'
      + '</div>'
      + '<div class="space-hint">Space</div>'
      + '</div></div></main>';
  }

  function renderBoard(st, seat) {
    var msLeft = st.secureEndsAt ? (st.secureEndsAt - Date.now()) : SECURE_PHASE_MS;
    var pct = Math.max(0, Math.min(100, (msLeft / SECURE_PHASE_MS) * 100));
    var html = '<main class="stage stage--secure">';
    html += '<div class="side-timer" id="side-timer">'
      + '<span class="timer-label">택배 확보<br>남은 시간</span>'
      + '<span class="timer-num">' + fmtClock(msLeft) + '</span>'
      + '<div class="timer-bar"><i style="width:' + pct + '%"></i></div></div>';

    html += '<div class="card"><div class="board-grid">';
    html += '<div class="board-head"></div>';
    for (var n = 1; n <= 5; n++) html += '<div class="board-head">' + n + '</div>';
    TYPES.forEach(function (t, catIdx) {
      html += '<div class="board-label" style="background:' + t.color + ';color:' + t.ink + ';">' + esc(t.name) + '</div>';
      for (var num = 0; num < 5; num++) {
        var cell = st.board[catIdx * 5 + num];
        var taken = !!cell.ownerSeat;
        html += '<button class="cell' + (taken ? ' taken' : '') + '" style="' + (taken ? '' : ('background:' + t.color + ';')) + '"'
          + (taken ? '' : (' data-action="open-cell" data-cell="' + cell.id + '"'))
          + '><span class="cell-num">' + (num + 1) + '</span>'
          + (taken ? ('<span class="owner-tag">P' + cell.ownerSeat + '</span>') : '')
          + '</button>';
      }
    });
    html += '</div></div>';
    html += '</main>';
    return html;
  }

  function renderPuzzleOverlay(st) {
    var cellId = local.openCellId;
    if (!cellId) return '<div class="overlay hidden" id="puzzle-overlay"></div>';
    var meta = cellMeta(cellId);
    var t = TYPES[meta.catIdx];
    return '<div class="overlay" id="puzzle-overlay">'
      + '<div class="puzzle-frame">'
      + '<div style="margin-bottom:0.6rem;color:var(--muted);font-family:var(--font-display);font-size:0.85rem;">' + esc(t.name) + ' · 조각 ' + t.pieces + '개</div>'
      + '<img src="' + meta.src + '" alt="우봉고 문제">'
      + '<div class="puzzle-actions">'
      + '<button class="btn danger" data-action="give-up">포기</button>'
      + '<button class="btn ok" data-action="complete-cell" data-cell="' + cellId + '">완료</button>'
      + '</div></div></div>';
  }

  function renderShaft(floorIdx) {
    var html = '<div class="shaft"><div class="shaft-track">';
    FLOORS.forEach(function (f, i) {
      html += '<div class="floor-stop' + (i === floorIdx ? ' current' : '') + '"><span class="car"></span>' + f + '</div>';
    });
    html += '</div></div>';
    return html;
  }

  function renderInvoiceList(st, seat) {
    var invs = st.players[seat].invoices.slice().sort(function (a, b) { return a.acquiredSeq - b.acquiredSeq; });
    if (!invs.length) return '<div style="color:var(--muted);font-size:0.85rem;">아직 확보한 택배가 없어요</div>';
    return '<div class="invoice-list">' + invs.map(function (inv) {
      var t = TYPES[inv.catIdx];
      var delivered = inv.deliveredRound !== null;
      return '<div class="invoice' + (delivered ? ' delivered' : '') + '">'
        + '<span class="swatch" style="background:' + t.color + '"></span>'
        + '<div class="meta"><div class="t">' + esc(t.name) + '</div><div class="d">' + FLOORS[inv.floorIdx] + ' ' + inv.room + '호</div></div>'
        + '<span class="sticker' + (delivered ? '' : ' pending') + '">' + (delivered ? ('완료 · R' + inv.deliveredRound) : '대기') + '</span>'
        + '</div>';
    }).join("") + '</div>';
  }

  function renderElevator(st, seat) {
    var html = '<main class="stage"><div class="elev-layout">';
    html += renderShaft(st.elevator.floorIdx);

    html += '<div>';
    html += '<div class="card">';
    html += '<span class="round-pill">라운드 ' + st.elevator.round + ' / ' + ELEVATOR_ROUNDS + '</span>';
    html += '<div style="margin-top:0.6rem;font-family:var(--font-display);font-size:1.1rem;">현재 층: <strong style="color:var(--gold)">' + FLOORS[st.elevator.floorIdx] + '</strong></div>';

    var otherSeat = seat === "1" ? "2" : "1";
    var mine = st.elevator.votes[seat] || { up: 0, down: 0 };
    var other = st.elevator.votes[otherSeat] || { up: 0, down: 0 };

    html += '<div class="vote-buttons">';
    html += '<button class="btn big primary" data-action="vote-up">▲ 위로</button>';
    html += '<button class="btn big ghost" data-action="vote-down">▼ 아래로</button>';
    html += '</div>';
    html += '<div class="vote-count-row">'
      + '<div class="vote-count-col"><span class="who">나 (플레이어 ' + seat + ')</span><span class="nums"><span class="up">▲' + mine.up + '</span><span class="down">▼' + mine.down + '</span></span></div>'
      + '<div class="vote-count-col"><span class="who">상대 (플레이어 ' + otherSeat + ')</span><span class="nums"><span class="up">▲' + other.up + '</span><span class="down">▼' + other.down + '</span></span></div>'
      + '</div>';
    html += '<div class="key-hint">실시간으로 서로의 클릭 수가 보여요 · 키보드 ↑ / ↓ 화살표로도 누를 수 있어요</div>';
    html += '<div style="margin-top:0.5rem;color:var(--muted);font-size:0.85rem;" id="round-clock">남은 시간 계산 중...</div>';

    if (st.elevator.log.length) {
      var last = st.elevator.log[st.elevator.log.length - 1];
      html += '<div class="round-result">라운드 ' + last.round + ' 결과 — 위 ' + last.up + ' · 아래 ' + last.down
        + ' → ' + (last.dir === "tie" ? "동률, 유지" : (last.dir === "up" ? "상승" : "하강"))
        + ' (현재 ' + FLOORS[last.floorIdx] + ')</div>';
    }
    html += '</div>';

    html += '<div class="split-two" style="margin-top:1rem;">';
    ["1", "2"].forEach(function (s) {
      html += '<div class="player-col' + (s === seat ? ' me' : '') + '"><h3>플레이어 ' + s + (s === seat ? ' (나)' : '') + '</h3>' + renderInvoiceList(st, s) + '</div>';
    });
    html += '</div>';

    html += '</div></div></main>';
    return html;
  }

  function renderEnd(st, seat) {
    var s1 = totalScore("1", st), s2 = totalScore("2", st);
    var winner = s1 === s2 ? "무승부" : (s1 > s2 ? "플레이어 1 승리" : "플레이어 2 승리");
    var html = '<main class="stage">';
    html += '<div class="winner-banner">' + winner + '</div>';
    html += '<div class="split-two">';
    ["1", "2"].forEach(function (s) {
      var invs = st.players[s].invoices.slice().sort(function (a, b) { return a.acquiredSeq - b.acquiredSeq; });
      html += '<div class="card"><h3 style="font-family:var(--font-display);margin-top:0;">플레이어 ' + s + ' — 총점 ' + totalScore(s, st) + '</h3>';
      html += '<table class="score-table"><thead><tr><th>종류</th><th>목적지</th><th>결과</th><th>점수</th></tr></thead><tbody>';
      invs.forEach(function (inv) {
        var t = TYPES[inv.catIdx];
        var pts = scoreInvoice(inv);
        html += '<tr><td>' + esc(t.name) + '</td><td>' + FLOORS[inv.floorIdx] + ' ' + inv.room + '호</td><td>' + resultLabel(inv) + '</td><td>' + (pts > 0 ? "+" : "") + pts + '</td></tr>';
      });
      if (!invs.length) html += '<tr><td colspan="4" style="color:var(--muted)">확보한 택배 없음</td></tr>';
      html += '</tbody></table></div>';
    });
    html += '</div></main>';
    return html;
  }

  function renderLoading() {
    return '<main class="stage"><div class="center-screen"><div class="lobby-box card"><h2>연결 중...</h2>'
      + '<p>서버에 접속하고 있어요. 잠시만 기다려 주세요.</p></div></div></main>';
  }

  function renderBody() {
    if (!ROOM) return '<main class="stage"><div class="center-screen"><div class="lobby-box card"><h2>잘못된 링크예요</h2><p>방 코드가 없어요. 처음 받은 링크로 다시 들어와 주세요.</p></div></div></main>';
    if (!state) return renderTopbarShell() + renderLoading();
    var seat = mySeat();
    var body = renderTopbar(state, seat);
    if (!seat) { body += renderSeatPicker(); return body; }
    if (state.phase === "lobby") body += renderLobby(state, seat);
    else if (state.phase === "secure") body += renderBoard(state, seat) + renderPuzzleOverlay(state);
    else if (state.phase === "elevator") body += renderElevator(state, seat);
    else if (state.phase === "end") body += renderEnd(state, seat);
    return body;
  }
  function renderTopbarShell() {
    return '<div class="topbar"><div class="brand"><span class="eyebrow">BeatPhobia · Live</span><h1>택배 배송 게임</h1></div>'
      + '<div class="right"><span class="room-chip">방 ' + esc(ROOM) + '</span></div></div>';
  }

  function showToast(msg) {
    var el = document.getElementById("toast");
    if (el) el.remove();
    if (!msg) return;
    var d = document.createElement("div");
    d.id = "toast"; d.className = "toast"; d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2600);
  }

  function render() {
    document.getElementById("app").innerHTML = renderBody();
  }

  // ---------- event handling ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-action]");
    if (!t) return;
    var action = t.getAttribute("data-action");

    if (action === "pick-seat") {
      var seat = t.getAttribute("data-seat");
      setMySeat(seat);
      send({ type: "pick-seat", seat: seat });
      render();
      return;
    }
    if (action === "open-cell") { local.openCellId = t.getAttribute("data-cell"); render(); return; }
    if (action === "give-up") { local.openCellId = null; render(); return; }
    if (action === "complete-cell") {
      var cid = t.getAttribute("data-cell");
      local.openCellId = null;
      send({ type: "secure-cell", seat: mySeat(), cellId: cid });
      render();
      return;
    }
    if (action === "vote-up" || action === "vote-down") {
      send({ type: "vote", seat: mySeat(), dir: action === "vote-up" ? "up" : "down" });
      return;
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
      var seat = mySeat();
      if (seat && state && state.phase === "lobby" && !e.repeat && !state.ready[seat]) {
        e.preventDefault();
        send({ type: "set-ready", seat: seat });
      }
      return;
    }
    if (e.code === "ArrowUp" || e.code === "ArrowDown") {
      var seat2 = mySeat();
      if (seat2 && state && state.phase === "elevator" && state.elevator.state === "voting") {
        e.preventDefault();
        send({ type: "vote", seat: seat2, dir: e.code === "ArrowUp" ? "up" : "down" });
      }
    }
  });

  // ---------- local countdown display only: the server owns the actual round/phase transitions
  // via its own timers, so there is nothing for the client to "submit" or auto-advance here ----------
  setInterval(function () {
    if (!state) return;
    if (state.phase === "secure" && state.secureEndsAt) {
      var msLeft = state.secureEndsAt - Date.now();
      var barI = document.querySelector(".timer-bar > i");
      var numEl = document.querySelector(".timer-num");
      if (numEl) numEl.textContent = fmtClock(msLeft);
      if (barI) barI.style.width = Math.max(0, Math.min(100, (msLeft / SECURE_PHASE_MS) * 100)) + "%";
    } else if (state.phase === "elevator" && state.elevator.state === "voting" && state.elevator.votingEndsAt) {
      var left = state.elevator.votingEndsAt - Date.now();
      var clockEl = document.getElementById("round-clock");
      if (clockEl) clockEl.textContent = "남은 시간 " + fmtClock(Math.max(0, left));
    }
  }, 200);

  render();
  connectWS();
})();
"""

APP_JS = (APP_JS_TEMPLATE
          .replace("@@TYPES_JSON@@", TYPES_JSON)
          .replace("@@CELLS_JSON@@", CELLS_JSON)
          .replace("@@FLOORS_JSON@@", FLOORS_JSON)
          .replace("@@ROOMS_JSON@@", ROOMS_JSON)
          .replace("@@ELEVATOR_ROUNDS@@", str(ELEVATOR_ROUNDS))
          .replace("@@SECURE_PHASE_MS@@", str(SECURE_PHASE_MS)))

full_html = (
    HEAD_HTML
    + '<script>' + APP_JS + "</script>\n"
    + "</body></html>\n"
)

os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)
with open(OUT_HTML, "w", encoding="utf-8") as f:
    f.write(full_html)

size_kb = len(full_html.encode("utf-8")) / 1024
print(f"saved {OUT_HTML} - {size_kb:.1f} KB")
