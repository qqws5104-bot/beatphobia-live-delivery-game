/* minigames.js -- 택배 확보 미니게임 4종 (박스 포장 / 이상 확인 / 송장 붙이기 / 지도 배달)
 *
 * 바닐라 JS, 의존성 없음. 게임 본체(build_client.py)에 그대로 인라인하거나, 단독 시험장 페이지에서
 * 똑같이 쓸 수 있게 만들었다.
 *
 *   var ctl = MiniGames.start(hostElement, {
 *     kind: "pack" | "inspect" | "sticker" | "map" | "soko" | "ice" | "route" | "twin" | "pipe" | "hanoi",
 *     level: 1 | 2 | 3,              // 쉬움 / 보통 / 어려움
 *     label: "B08호",                // 송장 붙이기에서 송장에 찍을 목적지 (없으면 임의 생성)
 *     onDone:   function (res) {},   // res = { ok:true, kind, level, ms, mistakes }
 *     onCancel: function () {},      // "포기" 버튼
 *   });
 *   ctl.destroy();                   // 키 입력 리스너/타이머 정리 (오버레이를 닫을 때 반드시 호출)
 *
 * 한 칸의 시간제한은 따로 없다 -- 전체 확보 시간(3분)이 곧 시계다. 실패 상태도 없고, 다 풀어야 끝난다.
 */
(function (root) {
  "use strict";

  var KINDS = {
    pack:    { name: "박스 포장" },
    inspect: { name: "이상 확인" },
    sticker: { name: "송장 붙이기" },
    map:     { name: "지도 배달" },
    soko:    { name: "창고 정리" },
    ice:     { name: "빙판 배송" },
    route:   { name: "배달 경로" },
    twin:    { name: "쌍둥이 배달" },
    pipe:    { name: "컨베이어 잇기" },
    hanoi:   { name: "택배 쌓기" },
  };
  var LEVEL_NAME = ["쉬움", "보통", "어려움"];

  // 박스 포장에서 방향키를 잘못 눌렀을 때의 규칙 (2026-10-06 결정: 영상처럼 "reset" -- 처음부터 다시).
  //   reset  : 입력한 순서 전체를 처음부터 다시
  //   freeze : 0.5초 멈췄다가 있던 자리부터 이어서
  //   ignore : 틀린 키는 무시(실수로만 기록)
  var config = { mistakeRule: "reset" };

  function rand(n) { return Math.floor(Math.random() * n); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = rand(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function restartAnim(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // 리플로우를 강제해야 같은 클래스를 다시 붙여도 애니메이션이 재시작된다
    node.classList.add(cls);
  }
  function fmtSec(ms) { return (ms / 1000).toFixed(1) + "초"; }

  // ======================================================================
  // 박스 포장 -- 상자 칸에 물건(조각)들을 돌리고 옮겨서 빈틈없이 채워 넣기 (우봉고식 퍼즐)
  //   ← ↑ ↓ → 조각 이동   SPACE 회전   ENTER 놓기   BACKSPACE 되돌리기   TAB 다른 조각 고르기
  // 2026-10-07 재설계 (사용자 피드백: "방향키 6키 -> 15키 -> 30키는 손가락 노동이다. 우봉고에서 가져올 건 해결 과정 --
  //   내가 판단하고, 직접 조작하고, 실수하면 다시 생각하는 것"). 예전엔 화면에 뜬 방향키 순서를 따라 누르는 게임이었다.
  // 퍼즐은 항상 풀리게 만든다: 칸을 조각들로 무작위 분할(`makePackPlan`)한 뒤 조각을 돌려서 보여 준다. 정답 배치는 하나가 아니어도 된다 --
  // 빈틈없이 채우기만 하면 끝. 놓은 조각은 되돌릴 수 있어서 "여기 놓으면 나머지가 안 들어가네" -> 되돌리고 다시 생각하는 시행착오가 핵심.
  // 겹치게 놓으려 하면 실수 +1 (움직이는 건 자유, ENTER로 확정할 때만 판정). 조각 수/칸 크기가 난이도.
  // ======================================================================
  var PACK_CFG = [
    { cols: 3, rows: 3, sizes: [3, 3, 3] },          // 쉬움 (시험장 전용)
    { cols: 4, rows: 4, sizes: [4, 4, 4, 4] },       // 보통 (전반): 4칸짜리 4조각
    { cols: 5, rows: 4, sizes: [3, 4, 4, 4, 5] },    // 어려움 (후반): 3~5칸짜리 5조각
  ];
  var PACK_COLORS = ["#E8681C", "#2F8F52", "#3E7CB1", "#B5527F", "#C99A00", "#7B5EA7"];
  var PACK_LOCK_MS = 600;   // 겹치는 자리에 놓으려다 틀린 뒤 멈춤 (ENTER 연타로 때려 맞추기 방지)

  function normCells(cells) {
    var mx = 1e9, my = 1e9;
    cells.forEach(function (p) { if (p[0] < mx) mx = p[0]; if (p[1] < my) my = p[1]; });
    return cells.map(function (p) { return [p[0] - mx, p[1] - my]; });
  }
  function rotCells(cells, n) { // 시계 방향 90도 n번 (화면 y는 아래로 증가)
    var out = cells.map(function (p) { return [p[0], p[1]]; });
    for (var r = 0; r < ((n % 4) + 4) % 4; r++) out = out.map(function (p) { return [-p[1], p[0]]; });
    return normCells(out);
  }
  function cellsKey(cells) { return cells.map(function (p) { return p[0] + "." + p[1]; }).sort().join("|"); }
  function canonShape(cells) { // 회전해서 같아지는 모양은 같은 키
    var best = null;
    for (var r = 0; r < 4; r++) { var k = cellsKey(rotCells(cells, r)); if (best === null || k < best) best = k; }
    return best;
  }
  function boxDims(cells) {
    var w = 0, h = 0;
    cells.forEach(function (p) { if (p[0] + 1 > w) w = p[0] + 1; if (p[1] + 1 > h) h = p[1] + 1; });
    return { w: w, h: h };
  }

  // cols x rows 칸을 sizes 크기의 연결된 조각들로 쪼갠다 (무작위로 자라게 한 뒤, 막히면 다시). 모양이 서로 다른 조각들을 선호한다.
  function makePackPlan(cfg) {
    var W = cfg.cols, H = cfg.rows, N = W * H, K = cfg.sizes.length, fallback = null;
    for (var attempt = 0; attempt < 800; attempt++) {
      var owner = [], cells = [], remain = cfg.sizes.slice(), ok = true, i;
      for (i = 0; i < N; i++) owner.push(-1);
      var seeds = shuffle(owner.map(function (_, ix) { return ix; })).slice(0, K);
      for (i = 0; i < K; i++) { owner[seeds[i]] = i; cells.push([[seeds[i] % W, Math.floor(seeds[i] / W)]]); remain[i]--; }
      for (;;) {
        var open = [];
        for (i = 0; i < K; i++) if (remain[i] > 0) open.push(i);
        if (!open.length) break;
        var pi = open[rand(open.length)], fr = [];
        cells[pi].forEach(function (p) {
          [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
            var x = p[0] + d[0], y = p[1] + d[1];
            if (x >= 0 && y >= 0 && x < W && y < H && owner[y * W + x] === -1) fr.push([x, y]);
          });
        });
        if (!fr.length) { ok = false; break; }
        var pick = fr[rand(fr.length)];
        owner[pick[1] * W + pick[0]] = pi; cells[pi].push(pick); remain[pi]--;
      }
      if (!ok) continue;
      var pieces = cells.map(function (cs) {
        var mx = 1e9, my = 1e9;
        cs.forEach(function (p) { if (p[0] < mx) mx = p[0]; if (p[1] < my) my = p[1]; });
        return { cells: normCells(cs), sx: mx, sy: my };
      });
      var seen = {}, distinct = true;
      pieces.forEach(function (pc) { var k = canonShape(pc.cells); if (seen[k]) distinct = false; seen[k] = 1; });
      // 1x4 막대(I)가 둘 이상이거나 한 줄짜리 조각이 너무 많으면 심심해서 거른다
      var lines = pieces.filter(function (pc) { var d = boxDims(pc.cells); return d.w === 1 || d.h === 1; }).length;
      if (lines > 1) distinct = false;
      if (distinct || attempt > 500) return pieces;
      if (!fallback) fallback = pieces;
    }
    return fallback;
  }

  function packGame(body, c) {
    var cfg = PACK_CFG[c.level - 1], W = cfg.cols, H = cfg.rows;
    var solved = makePackPlan(cfg);
    // 트레이 순서는 섞고, 각 조각은 무작위로 돌려서 시작한다 (정답 모양 그대로 보이면 안 된다)
    var order = shuffle(solved.map(function (_, i) { return i; }));
    var pieces = order.map(function (si, ti) {
      var sp = solved[si], r0 = rand(4);
      return { base: sp.cells, rot: r0, r0: r0, sx: sp.sx, sy: sp.sy, placed: false, x: 0, y: 0, color: PACK_COLORS[ti % PACK_COLORS.length] };
    });
    if (c.testHooks) body.setAttribute("data-plan", JSON.stringify({ cols: W, rows: H, pieces: pieces.map(function (p) { return { presses: (4 - p.r0) % 4, x: p.sx, y: p.sy }; }) }));

    var cellsHtml = "";
    for (var i = 0; i < W * H; i++) cellsHtml += '<div class="pk-cell"></div>';
    body.innerHTML =
      '<div class="pk-wrap"><div class="pk-box" style="--cols:' + W + ';--rows:' + H + '">' + cellsHtml + '</div>'
      + '<div class="pk-tray"></div></div>'
      + '<p class="mg-freeze-note"></p>'
      + '<div class="pk-pad">'
      + '<button type="button" class="mg-key" data-pk="up" aria-label="위">↑</button>'
      + '<button type="button" class="mg-key" data-pk="left" aria-label="왼쪽">←</button>'
      + '<button type="button" class="mg-key" data-pk="down" aria-label="아래">↓</button>'
      + '<button type="button" class="mg-key" data-pk="right" aria-label="오른쪽">→</button>'
      + '<button type="button" class="mg-key pk-act" data-pk="rotate">회전<small>SPACE</small></button>'
      + '<button type="button" class="mg-key pk-act" data-pk="place">놓기<small>ENTER</small></button>'
      + '<button type="button" class="mg-key pk-act" data-pk="undo">되돌리기<small>⌫</small></button>'
      + '<button type="button" class="mg-key pk-act" data-pk="next">조각 바꾸기<small>TAB</small></button>'
      + "</div>";
    var boxCells = Array.prototype.slice.call(body.querySelectorAll(".pk-cell"));
    var tray = body.querySelector(".pk-tray");
    var note = body.querySelector(".mg-freeze-note");
    var boxEl = body.querySelector(".pk-box");
    var cur = 0, px = 0, py = 0, locked = false, stack = [];

    function shape(p) { return rotCells(p.base, p.rot); }
    function clampPos() {
      var d = boxDims(shape(pieces[cur]));
      px = clamp(px, 0, W - d.w); py = clamp(py, 0, H - d.h);
    }
    function occupancy() {
      var occ = [], i;
      for (i = 0; i < W * H; i++) occ.push(-1);
      pieces.forEach(function (p, pi) {
        if (!p.placed) return;
        shape(p).forEach(function (q) { occ[(p.y + q[1]) * W + (p.x + q[0])] = pi; });
      });
      return occ;
    }
    function ghostCells() { return shape(pieces[cur]).map(function (q) { return [px + q[0], py + q[1]]; }); }
    function overlaps() {
      var occ = occupancy();
      return ghostCells().some(function (q) { return occ[q[1] * W + q[0]] >= 0; });
    }
    function unplaced() { return pieces.filter(function (p) { return !p.placed; }).length; }

    function paint() {
      var occ = occupancy(), ghost = {}, bad = overlaps();
      if (!c.isFinished() && !pieces[cur].placed) ghostCells().forEach(function (q) { ghost[q[1] * W + q[0]] = 1; });
      boxCells.forEach(function (el, i) {
        var o = occ[i];
        el.className = "pk-cell" + (o >= 0 ? " is-fill" : "") + (ghost[i] ? (bad ? " is-bad" : " is-ghost") : "");
        if (o >= 0) el.style.setProperty("--pc", pieces[o].color);
        else if (ghost[i]) el.style.setProperty("--pc", pieces[cur].color);
        else el.style.removeProperty("--pc");
      });
      tray.innerHTML = pieces.map(function (p, pi) {
        var sh = shape(p), d = boxDims(sh), m = {};
        sh.forEach(function (q) { m[q[1] * d.w + q[0]] = 1; });
        var g = "";
        for (var yy = 0; yy < d.h; yy++) for (var xx = 0; xx < d.w; xx++) g += '<i class="pk-mini' + (m[yy * d.w + xx] ? " on" : "") + '"></i>';
        return '<button type="button" class="pk-piece' + (p.placed ? " is-placed" : "") + (pi === cur && !p.placed ? " is-active" : "") + '" data-pi="' + pi + '" style="--pc:' + p.color + '" aria-label="조각 ' + (pi + 1) + '">'
          + '<span class="pk-mg" style="--cols:' + d.w + '">' + g + "</span></button>";
      }).join("");
      note.textContent = note.dataset.keep === "1" ? note.textContent : "";
      if (c.testHooks) body.setAttribute("data-pk", [cur, px, py, pieces[cur].rot, stack.length].join(","));
    }
    function say(msg, ms) {
      note.textContent = msg; note.dataset.keep = "1";
      c.later(function () { note.dataset.keep = ""; note.textContent = ""; }, ms || 900);
    }
    function select(i) {
      cur = i;
      var p = pieces[cur];
      if (!p.placed) { var d = boxDims(shape(p)); px = clamp(px, 0, W - d.w); py = clamp(py, 0, H - d.h); }
    }
    function nextFree(from) {
      for (var k = 1; k <= pieces.length; k++) { var j = (from + k) % pieces.length; if (!pieces[j].placed) return j; }
      return from;
    }

    function act(a) {
      if (c.isFinished() || locked) return;
      if (a === "left" || a === "right" || a === "up" || a === "down") {
        if (pieces[cur].placed) return;
        px += a === "left" ? -1 : a === "right" ? 1 : 0; py += a === "up" ? -1 : a === "down" ? 1 : 0;
        clampPos();
      } else if (a === "rotate") {
        if (pieces[cur].placed) return;
        pieces[cur].rot = (pieces[cur].rot + 1) % 4; clampPos();
      } else if (a === "next") {
        select(nextFree(cur));
      } else if (a === "undo") {
        if (!stack.length) return;
        var li = stack.pop(), lp = pieces[li];
        lp.placed = false; cur = li; px = lp.x; py = lp.y; clampPos();
      } else if (a === "place") {
        if (pieces[cur].placed) return;
        if (overlaps()) {
          c.addMistake();
          locked = true;
          restartAnim(boxEl, "is-shake");
          say("겹쳐서 놓을 수 없어요 — 자리나 방향을 바꿔 보세요", PACK_LOCK_MS);
          c.later(function () { locked = false; paint(); }, PACK_LOCK_MS);
          paint();
          return;
        }
        var p = pieces[cur]; p.placed = true; p.x = px; p.y = py; stack.push(cur);
        if (stack.length === pieces.length) {
          paint();
          say("상자가 가득 찼어요!", 1500);
          c.later(c.finish, 420);
          return;
        }
        select(nextFree(cur));
      }
      paint();
    }

    function onKey(e) {
      if (e.repeat && e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (c.isFinished()) return;
      var a = null;
      if (e.key === "ArrowLeft") a = "left";
      else if (e.key === "ArrowRight") a = "right";
      else if (e.key === "ArrowUp") a = "up";
      else if (e.key === "ArrowDown") a = "down";
      else if (e.code === "Space" || e.key === " ") a = "rotate";
      else if (e.key === "Enter") a = "place";
      else if (e.key === "Backspace" || e.key === "z" || e.key === "Z") a = "undo";
      else if (e.key === "Tab") a = "next";
      if (!a) return;
      e.preventDefault();
      e.stopPropagation(); // 게임 본체의 전역 스페이스바/방향키 핸들러가 이 키를 따로 처리하지 않게 막는다
      act(a);
    }
    document.addEventListener("keydown", onKey, true);
    c.onCleanup(function () { document.removeEventListener("keydown", onKey, true); });
    Array.prototype.forEach.call(body.querySelectorAll(".mg-key[data-pk]"), function (b) {
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); act(b.getAttribute("data-pk")); });
    });
    tray.addEventListener("pointerdown", function (e) { // 트레이의 조각을 누르면 그 조각을 고른다
      var t = e.target.closest ? e.target.closest(".pk-piece") : null;
      if (!t || c.isFinished() || locked) return;
      var pi = parseInt(t.getAttribute("data-pi"), 10);
      if (pieces[pi].placed) return;
      e.preventDefault(); select(pi); paint();
    });
    paint();
    return {
      hint: function () {
        return "조각들을 상자 칸에 빈틈없이 채우세요. 방향키(←↑↓→)로 조각을 옮기고, 스페이스로 돌리고, 엔터로 놓아요. 안 맞으면 백스페이스로 되돌리고, 탭으로 다른 조각을 고를 수 있어요. 겹치게 놓으면 실수!";
      },
    };
  }

  // ======================================================================
  // 이상 확인 (택배 검수) -- 벨트로 들어오는 택배의 "앞면 · 옆면 · 송장"을 서로 맞춰 보고,
  //   셋이 모두 같은 종류를 가리키면 그 종류 칸으로 보내고, 하나라도 다르면 폐기한다.
  //   ← 일반   ↓ 깨지기   → 귀중품   SPACE 정보가 안 맞는 택배 폐기
  // 2026-10-07 재설계 (사용자 피드백: "분류 + 이상품 SPACE는 반응속도 게임이다. 두 정보가 일치하지 않을 때만 폐기하게 해서
  //   판단이 들어가게") + 같은 날 "정보가 너무 많아 오히려 복잡하다" -> 단서를 두 개로 줄였다:
  //     옆면 = 취급 그림 (일반=위 화살표 박스, 깨지기=유리잔, 귀중품=보석)
  //     송장 = 내용물 글자 (예: 옷/책 = 일반, 유리컵/도자기 = 깨지기, 시계/노트북 = 귀중품)
  //   둘이 같은 종류면 그 칸으로, 서로 다르면 SPACE 폐기. 앞면 띠/흠집 같은 추가 정보는 없다(맨 상자).
  // 분류 3종은 게임의 실제 카테고리(일반/깨지기/귀중품)와 같은 색을 쓴다.
  // 내부 kind 키는 그대로 "inspect" (game-data.js의 TYPES.mini와 시험장이 이 이름을 쓴다).
  // ======================================================================
  //   n 택배 수, bad 그림과 글자가 안 맞는 택배 수, hard 송장 내용물을 덜 뻔한 단어로(0 쉬움/1 어려움)
  var INSPECT_CFG = [
    { n: 6,  bad: 2, hard: 0 },
    { n: 9,  bad: 3, hard: 0 },
    { n: 11, bad: 4, hard: 1 },
  ];
  var CLASSES = [
    { key: "left",  name: "일반",   tag: "일반",   color: "#C9A576", light: "#ddc08f", keyGlyph: "←", hint: "옷 · 책 · 생활용품" },
    { key: "down",  name: "깨지기", tag: "깨짐주의", color: "#C7E29A", light: "#dcefb8", keyGlyph: "↓", hint: "유리 · 도자기 · 화분" },
    { key: "right", name: "귀중품", tag: "귀중품", color: "#F0B84A", light: "#f7d37e", keyGlyph: "→", hint: "시계 · 보석 · 전자기기" },
  ];
  var ACT_CLASS = { left: 0, down: 1, right: 2 };
  // 송장 내용물 단어. 쉬운 단어 + (hard일 때) 덜 뻔한 단어도 섞는다. 종류 사이에 겹치는 단어는 없다.
  var SLIP_WORDS = [
    [["옷", "책", "수건", "양말", "담요"], ["이불", "운동화", "프라이팬", "필통", "베개"]],
    [["유리컵", "화분", "도자기", "거울", "접시"], ["전구", "와인", "찻잔", "유리병", "꽃병"]],
    [["시계", "반지", "목걸이", "현금"], ["노트북", "금팔찌", "명품백", "상품권", "카메라"]],
  ];

  // 옆면의 취급 그림 (가운데 좌표 0,0 기준 -- 호출하는 쪽이 translate)
  function sideIcon(clsIdx) {
    if (clsIdx === 0) { // 위 화살표가 있는 박스
      return '<rect x="-9" y="-3" width="18" height="14" rx="1.5" fill="none" stroke="#3a2812" stroke-width="1.8"/>'
        + '<path d="M0 -14v13M-5 -9l5-5 5 5" fill="none" stroke="#3a2812" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    if (clsIdx === 1) { // 유리잔
      return '<path d="M-9 -13h18l-2 11a7 7 0 0 1-14 0Z" fill="rgba(255,255,255,.55)" stroke="#3a2812" stroke-width="1.8" stroke-linejoin="round"/>'
        + '<path d="M0 3v10M-6 13h12" stroke="#3a2812" stroke-width="1.8" stroke-linecap="round"/>';
    }
    return '<path d="M-10 -6l5-7h10l5 7-10 14Z" fill="#7fd0e8" stroke="#3a2812" stroke-width="1.6" stroke-linejoin="round"/>'
      + '<path d="M-10 -6h20M-3 -6l3 14 3-14" fill="none" stroke="#3a2812" stroke-width="1.1"/>'; // 보석
  }

  // 택배 하나를 그린다: 옆면(그림) + 송장(내용물). 앞면은 모두 같은 맨 상자(정보 없음). item = { side, slip(단어), bad }.
  function pkgSvg(item) {
    var s = '<svg viewBox="0 0 190 100" aria-hidden="true">'
      + '<ellipse cx="95" cy="92" rx="88" ry="5" fill="rgba(43,29,18,.18)"/>'
      + '<rect x="6" y="24" width="70" height="62" rx="3" fill="#cfae7a" stroke="#6b4e26" stroke-width="1.8"/>'
      + '<rect x="6" y="24" width="70" height="12" rx="3" fill="#ddc08f" stroke="#6b4e26" stroke-width="1.8"/>'
      + '<rect x="34" y="24" width="14" height="34" fill="#ead8b0" opacity=".95"/>';
    // 옆면: 취급 그림
    s += '<polygon points="76,24 104,16 104,78 76,86" fill="#d9b982" stroke="#6b4e26" stroke-width="1.8" stroke-linejoin="round"/>'
      + '<g transform="translate(90 51) scale(0.95)">' + sideIcon(item.side) + '</g>';
    // 송장: 종이 라벨, 내용물 글자
    s += '<rect x="112" y="22" width="72" height="62" rx="2.5" fill="#fffefa" stroke="#9a8460" stroke-width="1.4"/>'
      + '<rect x="112" y="22" width="72" height="11" rx="2.5" fill="#E8681C"/>'
      + '<text x="148" y="30.5" text-anchor="middle" font-size="8" font-weight="800" fill="#fff8ef" letter-spacing="2">송장</text>'
      + '<text x="148" y="62" text-anchor="middle" font-size="' + (item.slip.length > 3 ? 14 : 17) + '" font-weight="800" fill="#2b1d12">' + item.slip + '</text>';
    return s + "</svg>";
  }

  function makeInspectItems(cfg) {
    var badAt = {};
    shuffle(Array.apply(null, { length: cfg.n }).map(function (_, i) { return i; })).slice(0, cfg.bad).forEach(function (i) { badAt[i] = true; });
    var items = [];
    for (var i = 0; i < cfg.n; i++) {
      var cls = rand(3), bad = !!badAt[i], sideCls = cls, slipCls = cls;
      if (bad) { var other = (cls + 1 + rand(2)) % 3; if (Math.random() < 0.5) sideCls = other; else slipCls = other; }
      var pool = SLIP_WORDS[slipCls], words = cfg.hard && Math.random() < 0.6 ? pool[1] : pool[0];
      items.push({ cls: cls, bad: bad, side: sideCls, slip: words[rand(words.length)] });
    }
    return items;
  }

  var INSPECT_LOCK_MS = 900; // 틀린 키 뒤 멈춤 -- 아무 키나 연타해서 뚫는 걸 막고, 다시 확인할 시간을 준다

  function inspectGame(body, c) {
    var cfg = INSPECT_CFG[c.level - 1];
    var items = makeInspectItems(cfg);
    var expected = items.map(function (it) { return it.bad ? "space" : CLASSES[it.cls].key; });
    if (c.testHooks) body.setAttribute("data-seq", expected.join(","));

    var binsHtml = CLASSES.map(function (k, ci) {
      return '<button type="button" class="mg-bin" data-a="' + k.key + '" style="--bin:' + k.color + '" aria-label="' + k.name + '">'
        + '<span class="mg-bin-k">' + k.keyGlyph + '</span><span class="mg-bin-n">' + k.name + '</span>'
        + '<svg class="mg-bin-ico" viewBox="-14 -16 28 32" aria-hidden="true">' + sideIcon(ci) + '</svg>'
        + '<span class="mg-bin-s">' + k.hint + '</span></button>';
    }).join("");
    body.innerHTML = '<div class="mg-belt"><div class="mg-gate" aria-hidden="true"><span>검수대</span></div><div class="mg-queue"></div></div>'
      + '<p class="mg-progress">처리 <em class="mg-found">0</em> / ' + cfg.n + '개</p>'
      + '<p class="mg-freeze-note"></p>'
      + '<div class="mg-bins">' + binsHtml + '</div>'
      + '<button type="button" class="mg-bin mg-discard" data-a="space" aria-label="정보가 안 맞는 택배 폐기"><span class="mg-bin-k">SPACE</span><span class="mg-bin-n">그림과 글자가 다르면 폐기</span></button>';

    var queue = body.querySelector(".mg-queue");
    var doneEl = body.querySelector(".mg-found");
    var note = body.querySelector(".mg-freeze-note");
    var els = items.map(function (it, i) {
      var d = el("div", "mg-pkg", pkgSvg(it));
      d.style.setProperty("--i", i);
      queue.appendChild(d);
      return d;
    });
    var idx = 0, locked = false;
    function setFront() {
      queue.style.setProperty("--shift", idx);
      els.forEach(function (d, i) { d.classList.toggle("is-front", i === idx); });
    }

    function act(a) {
      if (locked || c.isFinished() || idx >= cfg.n) return;
      var btn = body.querySelector('.mg-bin[data-a="' + a + '"]');
      if (a === expected[idx]) {
        var d = els[idx];
        d.classList.add(items[idx].bad ? "is-zap" : "is-sent");
        if (btn) restartAnim(btn, "is-ok");
        idx++;
        doneEl.textContent = idx;
        setFront();
        if (idx === cfg.n) c.later(c.finish, 380);
        return;
      }
      // 오입력: 실수 +1, 앞 택배는 그대로 남고 잠깐 멈춘다
      c.addMistake();
      locked = true;
      restartAnim(els[idx], "mg-shake");
      if (btn) restartAnim(btn, "is-wrong");
      note.textContent = items[idx].bad && a !== "space" ? "그림과 글자가 달라요 — 폐기!" : (a === "space" ? "그림과 글자가 같은 종류예요" : "다른 칸이에요 — 그림과 글자를 다시 보세요");
      c.later(function () { locked = false; note.textContent = ""; }, INSPECT_LOCK_MS);
    }

    function onKey(e) {
      if (e.repeat || c.isFinished()) return;
      var a = null;
      if (e.key === "ArrowLeft") a = "left";
      else if (e.key === "ArrowDown") a = "down";
      else if (e.key === "ArrowRight") a = "right";
      else if (e.code === "Space" || e.key === " ") a = "space";
      else if (e.key === "ArrowUp") { e.preventDefault(); return; } // 쓰지 않는 키지만 화면이 스크롤되지 않게
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      act(a);
    }
    document.addEventListener("keydown", onKey, true);
    c.onCleanup(function () { document.removeEventListener("keydown", onKey, true); });
    Array.prototype.forEach.call(body.querySelectorAll(".mg-bin"), function (b) {
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); act(b.getAttribute("data-a")); });
    });
    setFront();
    return { hint: function () { return "옆면 그림과 송장 글자가 같은 종류면 그 칸으로(← 일반 · ↓ 깨지기 · → 귀중품), 서로 다르면 SPACE로 폐기. 틀리면 잠깐 멈춰요."; } };
  }

  // ======================================================================
  // 송장 붙이기 -- 송장의 정보(배송코드 + 취급 + 층)와 "일부만 적힌" 박스들을 맞춰 보고, 딱 하나로 특정되는 박스에 붙이기
  // ======================================================================
  // (2026-10-06 개편) 코드를 읽고 같은 박스를 찾는 게임이었다.
  // (2026-10-07 재설계, 사용자 피드백: "코드 확인 -> 같은 코드 박스 찾기 -> 붙이기는 너무 명확하다. 박스에 코드가 온전히 안 적혀 있고
  //  일부 정보만 있어서, 여러 정보를 조합해야 하나로 특정되게") 송장은 B-17 / 깨짐 / 4F 처럼 세 정보를 갖고,
  // 박스에는 코드의 한 글자가 가려져 있고(B-□7), 취급과 층은 있거나 없다(? 표시). 박스 하나의 보이는 정보가 전부 송장과 맞아야만
  // "맞는 박스"고, 그런 박스는 항상 정확히 하나다 -- 코드만 맞는 박스(B-□7인데 취급이 다름)가 일부러 섞여 있어서
  // "B-17이니까 이거?" -> "아니네, 취급이 달라" -> "그럼 이거다" 처럼 조합해서 추리해야 한다. (틀리면 실수 + 멈춤)
  var STK_BOXES  = [4, 7, 8];   // 레벨별 박스 수
  var STK_LABELS = [2, 4, 5];   // 레벨별 송장 장수 (붙일 박스 수)
  var STK_HIDE   = [0.25, 0.5, 0.62]; // 박스에서 취급/층 정보를 가릴 확률 (높을수록 코드와 조합해야 한다)
  var STK_FLOOR_FIELD = ["1F", "2F", "3F", "4F", "5F"];
  var STK_LETTERS = ["A", "B", "C", "D", "E"];
  var STK_LOCK_MS = 900;        // 틀린 박스에 붙인 뒤 멈춤 -- 다시 추리할 시간 (이상 확인과 같은 값)
  var LW = 22, LH = 22.5;       // 송장 크기 (스테이지 대비 %, 스테이지 520:320)
  var TRAY_X = (100 - LW) / 2, TRAY_Y = 75.5;

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // 송장 코드 "B-17": 글자 1 + 숫자 2. 마스크 위치 0 = 글자, 1 = 십의 자리, 2 = 일의 자리.
  function codeChars(b) { return [b.letter, String(b.num).charAt(0), String(b.num).charAt(1)]; }
  // box(가려진 정보 포함)가 inv와 "보이는 부분이 전부 일치"하는가. codeOnly면 취급/층은 무시.
  function stkCompat(box, inv, codeOnly) {
    var bc = codeChars(box), ic = codeChars(inv);
    for (var i = 0; i < 3; i++) if (i !== box.mask && bc[i] !== ic[i]) return false;
    if (codeOnly) return true;
    if (!box.hideG && box.grade !== inv.grade) return false;
    if (!box.hideF && box.floor !== inv.floor) return false;
    return true;
  }

  // 박스 n개(정답 k개 포함)와 송장 순서를 만든다. 모든 정답 송장이 정확히 한 박스와만 맞고, 코드만 맞는 박스가 따로 있도록 시도한다.
  function makeStickerPlan(level, n, k) {
    var hide = STK_HIDE[level - 1];
    var best = null;
    for (var attempt = 0; attempt < 4000; attempt++) {
      // 모든 박스가 비슷해 보이도록 숫자는 작은 집합(3개)에서만, 글자도 2개에서만 뽑는다
      var digits = shuffle(["1", "2", "3", "7", "8", "9"]).slice(0, 3), letters = shuffle(STK_LETTERS).slice(0, 2);
      var used = {}, boxes = [], guard = 0;
      while (boxes.length < n && guard++ < 300) {
        var b = { letter: letters[rand(2)], num: parseInt(digits[rand(3)] + digits[rand(3)], 10),
          grade: rand(3), floor: STK_FLOOR_FIELD[rand(5)] };
        var key = b.letter + b.num + "/" + b.grade + "/" + b.floor;
        if (used[key]) continue;
        used[key] = 1;
        b.mask = rand(3); b.hideG = Math.random() < hide; b.hideF = Math.random() < hide;
        boxes.push(b);
      }
      if (boxes.length < n) continue;
      var order = shuffle(boxes.map(function (_, i) { return i; })), targets = order.slice(0, k);
      var ok = true, nearCode = 0;
      for (var ti = 0; ti < targets.length && ok; ti++) {
        var inv = boxes[targets[ti]], match = 0, near = 0;
        boxes.forEach(function (bx, bi) {
          if (stkCompat(bx, inv, false)) match++;
          else if (bi !== targets[ti] && stkCompat(bx, inv, true)) near++;
        });
        if (match !== 1) ok = false;
        if (near >= 1) nearCode++;
      }
      if (!ok) continue;
      // 레벨 2 이상은 정답 송장 대부분에 "코드만 맞는 함정 박스"가 있어야 한다 (조합해야 풀리게)
      var need = level === 1 ? 0 : (level === 2 ? Math.ceil(k * 0.6) : k);
      var plan = { boxes: boxes, seq: shuffle(targets), near: nearCode };
      if (nearCode >= need) return plan;
      if (!best || nearCode > best.near) best = plan;
    }
    if (best) return best;
    throw new Error("sticker plan failed");
  }

  var GRADE_NAME = ["일반", "깨짐", "귀중"];
  function codeHtml(b, masked) {
    var ch = codeChars(b), out = "";
    for (var i = 0; i < 3; i++) {
      if (i === 1) out += "-";
      out += (masked && i === b.mask) ? '<u class="bx-hole"></u>' : ch[i];
    }
    return out;
  }

  function stickerGame(body, c) {
    var n = STK_BOXES[c.level - 1], k = STK_LABELS[c.level - 1];
    var plan = makeStickerPlan(c.level, n, k);

    var boxHtml = plan.boxes.map(function (b, bi) {
      var g = b.hideG ? '<span class="bx-chip is-hid">?</span>' : '<span class="bx-chip g' + b.grade + '">' + GRADE_NAME[b.grade] + '</span>';
      var f = b.hideF ? '<span class="bx-chip is-hid">?</span>' : '<span class="bx-chip fl">' + b.floor + '</span>';
      return '<div class="mg-bx" data-i="' + bi + '"><div class="bx-top"></div><div class="bx-front">'
        + '<div class="bx-addr"><i>받는 곳</i><b>' + codeHtml(b, true) + '</b></div>'
        + '<div class="bx-meta">' + g + f + '</div><div class="bx-slot"></div></div>'
        + '<div class="bx-tape"></div><span class="bx-ok" aria-hidden="true">✓</span></div>';
    }).join("");
    body.innerHTML = '<div class="mg-stage" data-total="' + k + '"><div class="mg-bxs">' + boxHtml + '</div>'
      + '<div class="mg-tray"><span class="mg-tray-note"></span></div></div>'
      + '<div class="mg-pad">'
      + '<button type="button" class="mg-key" data-k="up" aria-label="위">↑</button>'
      + '<button type="button" class="mg-key" data-k="left" aria-label="왼쪽">←</button>'
      + '<button type="button" class="mg-key" data-k="down" aria-label="아래">↓</button>'
      + '<button type="button" class="mg-key" data-k="right" aria-label="오른쪽">→</button>'
      + '<button type="button" class="mg-key" data-k="space" aria-label="스페이스">SPACE · 붙이기</button>'
      + "</div>";
    var stage = body.querySelector(".mg-stage");
    // 좁은 화면(폰): 박스 안 글자가 읽히도록 무대를 세로로 늘리고 박스를 한 줄 3개로 키운다. 송장도 가로로 넓힌다.
    var narrow = stage.clientWidth > 0 && stage.clientWidth < 460;
    var lw = LW, lh = LH, ty = TRAY_Y;
    if (narrow) { stage.classList.add("is-narrow"); lw = 38; lh = 19.5; ty = 76.5; }
    if (n > 6) { stage.style.setProperty("--bw", narrow ? "29cqw" : "21cqw"); stage.style.setProperty("--ggap", narrow ? "2.6cqw 2.4cqw" : "2.2cqw 2.2cqw"); } // 7개 이상: 한 줄 4개(넓은 화면) / 3개(폰)
    if (c.testHooks) body.setAttribute("data-plan", JSON.stringify({ seq: plan.seq, near: plan.near }));
    var boxes = Array.prototype.slice.call(body.querySelectorAll(".mg-bx"));
    var note = body.querySelector(".mg-tray-note");
    var placed = 0, current = null;
    var cursor = 0, keyLocked = false; // 지금 고른 박스(boxes 인덱스)


    // ---- 조작은 키보드 전용 (2026-10-07: 마우스 끌어다 놓기 제거): ←→ 박스 고르기, ↑↓ 윗줄/아랫줄 박스로, 스페이스 = 지금 송장을 고른 박스에 붙이기.
    // 화면 아래 방향키/스페이스 버튼은 다른 미니게임과 같은 터치용 패드(폰) -- 누르면 같은 동작이다. ----
    function paintCursor() { boxes.forEach(function (x, i) { x.classList.toggle("is-cursor", i === cursor && !x.classList.contains("is-done")); }); }
    function nextOpen(from, step) { // from에서 step(+1/-1) 방향으로 아직 안 붙인 박스 (한 바퀴 돎)
      for (var i = 1; i <= boxes.length; i++) {
        var j = (from + step * i + boxes.length * 2) % boxes.length;
        if (!boxes[j].classList.contains("is-done")) return j;
      }
      return from;
    }
    function moveRow(dir) { // dir -1 = 위, +1 = 아래: 다른 줄의 안 붙인 박스 중 가로 위치가 가장 가까운 것
      var me = boxes[cursor].getBoundingClientRect(), mx = me.left + me.width / 2, my = me.top + me.height / 2;
      var best = -1, bestD = 1e9;
      boxes.forEach(function (x, i) {
        if (i === cursor || x.classList.contains("is-done")) return;
        var r = x.getBoundingClientRect(), cy = r.top + r.height / 2;
        if (dir < 0 ? cy >= my - me.height / 2 : cy <= my + me.height / 2) return; // 다른 줄이 아니면 건너뜀
        var d = Math.abs(r.left + r.width / 2 - mx) + Math.abs(cy - my) * 0.01;
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best >= 0) cursor = best;
    }
    function keyAttach() {
      if (!current || keyLocked) return;
      var b = boxes[cursor];
      if (!b || b.classList.contains("is-done")) return;
      if (boxes.indexOf(b) === plan.seq[placed]) { var lb = current; stick(lb, b); return; }
      c.addMistake();
      restartAnim(b, "is-wrong");
      keyLocked = true; // 틀린 뒤 잠깐 멈춤 -- 방향키+스페이스를 번갈아 눌러 박스를 하나씩 찍어 보는 걸 막는다
      c.later(function () { keyLocked = false; }, STK_LOCK_MS);
    }
    function press(k) {
      if (c.isFinished()) return;
      if (k === "left") cursor = nextOpen(cursor, -1);
      else if (k === "right") cursor = nextOpen(cursor, 1);
      else if (k === "up") moveRow(-1);
      else if (k === "down") moveRow(1);
      else if (k === "space") keyAttach();
      paintCursor();
    }
    function onKey(e) {
      if (c.isFinished() || e.repeat) return;
      var k = null;
      if (e.key === "ArrowLeft") k = "left";
      else if (e.key === "ArrowRight") k = "right";
      else if (e.key === "ArrowUp") k = "up";
      else if (e.key === "ArrowDown") k = "down";
      else if (e.code === "Space" || e.key === " ") k = "space";
      if (!k) return;
      e.preventDefault();
      e.stopPropagation(); // 게임 본체의 전역 스페이스바 핸들러가 이 키를 따로 처리하지 않게 막는다
      press(k);
    }
    document.addEventListener("keydown", onKey, true);
    c.onCleanup(function () { document.removeEventListener("keydown", onKey, true); });
    Array.prototype.forEach.call(body.querySelectorAll(".mg-key"), function (b) {
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); press(b.getAttribute("data-k")); });
    });

    // 송장은 트레이에 한 장씩 나온다(끌 수 없음 -- 붙이는 건 스페이스뿐).
    function spawnLabel() {
      var inv = plan.boxes[plan.seq[placed]];
      note.textContent = "남은 송장 " + (k - placed) + "장";
      var lb = el("div", "mg-label",
        '<div class="lb-bar"><span>송장</span></div><div class="lb-main"><b class="lb-room">' + codeHtml(inv, false) + '</b>'
        + '<div class="lb-meta"><span class="bx-chip g' + inv.grade + '">' + GRADE_NAME[inv.grade] + '</span><span class="bx-chip fl">' + inv.floor + '</span></div></div><div class="lb-code"></div>');
      if (c.testHooks) lb.setAttribute("data-want", String(plan.seq[placed]));
      lb.style.width = lw + "%"; lb.style.height = lh + "%";
      lb.style.left = ((100 - lw) / 2) + "%"; lb.style.top = ty + "%";
      lb.setAttribute("data-label", "1");
      stage.appendChild(lb);
      current = lb;
    }

    // 송장이 박스 앞면의 송장 자리로 줄어들며 붙는다
    function stick(lb, b) {
      var sr = stage.getBoundingClientRect(), slot = b.querySelector(".bx-slot").getBoundingClientRect();
      var lw = lb.offsetWidth, lh = lb.offsetHeight;
      var kk = Math.min(slot.width / lw, slot.height / lh);
      var x = slot.left - sr.left + (slot.width - lw * kk) / 2, y = slot.top - sr.top + (slot.height - lh * kk) / 2;
      lb.classList.add("is-stuck");
      lb.style.left = (x / sr.width * 100) + "%"; lb.style.top = (y / sr.height * 100) + "%";
      lb.style.transform = "scale(" + kk + ")";
      lb.setAttribute("data-stuck", "1");
      b.classList.add("is-done");
      placed++;
      current = null;
      if (placed < k) cursor = nextOpen(cursor, 1); // 붙인 박스에서 다음 안 붙인 박스로 커서를 옮겨 둔다
      paintCursor();
      if (placed === k) { note.textContent = "모두 붙였어요"; c.later(c.finish, 320); }
      else { c.later(spawnLabel, 300); }
    }

    spawnLabel();
    paintCursor();
    return { hint: function () { return "송장(배송코드 · 취급 · 층)과 보이는 정보가 전부 맞는 박스는 딱 하나예요 (" + k + "장). 박스에는 코드 한 글자가 가려져 있고, 취급/층은 없을 수도 있어요 -- 조합해서 찾으세요. 방향키(←→↑↓)로 박스를 고르고 스페이스로 붙여요. 틀린 박스에 붙이면 실수!"; } };
  }


  // ======================================================================
  // 지도 배달 (2026-10-07: 귀중품의 우봉고를 대체)
  //   1) 송장 단계: 지도는 가려져 있고, "송장만 붙은 택배" 여러 개(예: 103호, 201호 ...)가 순서대로 팝업으로 떴다가 사라진다.
  //   2) 지도 단계: 택배가 사라지고 지도가 뜬다 -- 집마다 호실 번호가 적혀 있어서, 외운 호실의 집을 지도에서 찾아
  //      방향키로 이동해 도착하면 스페이스로 배달한다. 외운 순서대로.
  //   3) 게임 시작 20초 뒤부터(MAP_REPLAY_AFTER_MS) "송장 다시 보기"가 열린다: 택배 팝업을 다시 보여 준다(그동안 지도는 가려지고 이동 불가).
  //      공짜지만 그만큼 시간이 가므로 사실상의 비용은 시간이다. 그 전에는 못 본다 -- 처음에 제대로 외워야 한다.
  //   (이력: 1차는 목표 집이 지도 위에서 번호와 함께 켜졌다. 2차는 호실 번호 목록만 먼저 띄웠다. 사용자가 "송장만 붙은 택배 4개가
  //    팝업으로 보였다 사라지고, 이후 지도가 표시되고, 20초 뒤부터는 다시 호수를 확인"으로 정정해서 지금 형태가 됐다.)
  //   입력은 박스 포장과 같은 방향키 4개 + 스페이스(화면 버튼도 같다).
  //   난이도 레버는 전부 MAP_CFG 한 군데:
  //     targets  외울 택배(호실) 수     flashMs  택배 팝업이 떠 있는 시간(ms)
  //     cols/rows 지도 크기            houses   집 개수 (목표 + 미끼)
  //     similar  목표와 비슷한 번호(같은 층 / 같은 호)를 가진 미끼 집 수 -- 잘못 외우거나 대충 보면 틀리는 함정
  //     blocks   지나갈 수 없는 칸(공사장) 수 -- 돌아가야 해서 길을 직접 짜야 한다
  //   레벨 1은 시험장 전용, 게임에서는 전반 2 / 후반 3 (game-data.js의 TYPES.valuable.miniLevel).
  //   틀린 배달(엉뚱한 집/도로/이미 배달한 집/순서 틀림)은 실수 +1 이고 0.8초 멈춘다 -- 진행은 유지.
  // ======================================================================
  // targets = 외워야 할 송장(택배) 수: 전반(레벨 2) 3개, 후반(레벨 3) 4개 (2026-10-07 사용자 요청). 레벨 1은 시험장 전용.
  var MAP_CFG = [
    { cols: 5, rows: 4, houses: 8,  targets: 2, flashMs: 4500, similar: 0, blocks: 0 },
    // 2026-10-07 난이도 업: 외울 개수(3/4)와 송장 다시 보기 20초는 사용자 지정값이라 그대로 두고, 팝업 시간을 줄이고 미끼/공사장을 늘렸다.
    { cols: 6, rows: 4, houses: 11, targets: 3, flashMs: 3000, similar: 4, blocks: 2 },
    { cols: 7, rows: 5, houses: 14, targets: 4, flashMs: 2500, similar: 6, blocks: 6 },
  ];
  var MAP_REPLAY_AFTER_MS = 20000; // 게임 시작 후 이 시간이 지나야 "송장 다시 보기"가 열린다
  var MAP_POP_STAGGER_MS = 150;    // 택배 팝업이 하나씩 뜨는 간격(순서 단서)
  var MAP_LOCK_MS = 800;   // 틀린 배달 뒤 멈춤
  var MAP_STEP_MS = 70;    // 방향키를 꾹 누를 때 한 칸씩 가는 최소 간격
  var MAP_VEC = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  var HOUSE_SVG = '<svg class="mg-hsvg" viewBox="0 0 40 40" aria-hidden="true"><path d="M5 19 20 6l15 13Z" class="mg-roof"/><rect x="9" y="19" width="22" height="15" class="mg-wall"/><rect x="17" y="25" width="6" height="9" class="mg-door"/></svg>';
  var VAN_SVG = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="4" y="11" width="21" height="17" rx="2" class="mg-van-box"/><path d="M25 16h7l4 5v7H25Z" class="mg-van-cab"/><circle cx="12" cy="30" r="3.4" class="mg-van-wh"/><circle cx="30" cy="30" r="3.4" class="mg-van-wh"/></svg>';

  function mapKey(x, y) { return x + "," + y; }
  // 호실 번호: 층(1~5) + 0 + 호(1~9) = 101 ~ 509. 목표는 무작위, 미끼 중 similar개는 목표와 같은 층 또는 같은 호(번갈아)를 가진다.
  function assignRoomLabels(houses, targets, similar) {
    var used = {};
    function code(f, r) { return String(f * 100 + r); }
    function takeRandom() {
      for (;;) { var cd = code(1 + rand(5), 1 + rand(9)); if (!used[cd]) { used[cd] = 1; return cd; } }
    }
    targets.forEach(function (t) { t.label = takeRandom(); });
    var tset = {}; targets.forEach(function (t) { tset[mapKey(t.x, t.y)] = 1; });
    var decoys = shuffle(houses.filter(function (h) { return !tset[mapKey(h.x, h.y)]; }));
    var n = Math.min(similar, decoys.length, targets.length);
    for (var i = 0; i < decoys.length; i++) {
      var cand = [];
      if (i < n) {
        var f = parseInt(targets[i].label.charAt(0), 10), r = parseInt(targets[i].label.charAt(2), 10);
        for (var a = 1; a <= 5; a++) for (var b = 1; b <= 9; b++) {
          var same = i % 2 === 0 ? (a === f && b !== r) : (b === r && a !== f); // 짝수: 같은 층 다른 호 / 홀수: 같은 호 다른 층
          if (same && !used[code(a, b)]) cand.push(code(a, b));
        }
      }
      if (cand.length) { var pick = cand[rand(cand.length)]; used[pick] = 1; decoys[i].label = pick; }
      else decoys[i].label = takeRandom();
    }
  }
  function makeMapPlan(cfg, noBlocks) {
    var W = cfg.cols, H = cfg.rows, nb = noBlocks ? 0 : cfg.blocks;
    var depot = { x: Math.floor(W / 2), y: H - 1 };
    for (var tries = 0; tries < 300; tries++) {
      var all = [];
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) if (!(x === depot.x && y === depot.y)) all.push({ x: x, y: y });
      var sh = shuffle(all);
      var blocked = sh.slice(0, nb), houses = sh.slice(nb, nb + cfg.houses);
      var blockSet = {}; blocked.forEach(function (b) { blockSet[mapKey(b.x, b.y)] = 1; });
      var seen = {}; seen[mapKey(depot.x, depot.y)] = 1;
      var q = [depot];
      while (q.length) {
        var p = q.shift();
        for (var d in MAP_VEC) {
          var nx = p.x + MAP_VEC[d][0], ny = p.y + MAP_VEC[d][1], nk = mapKey(nx, ny);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || blockSet[nk] || seen[nk]) continue;
          seen[nk] = 1; q.push({ x: nx, y: ny });
        }
      }
      var ok = houses.every(function (h) { return seen[mapKey(h.x, h.y)]; });
      if (!ok) continue; // 공사장 때문에 갈 수 없는 집이 생겼으면 다시 뽑는다
      var targets = shuffle(houses).slice(0, cfg.targets);
      assignRoomLabels(houses, targets, cfg.similar);
      return { W: W, H: H, depot: depot, blocked: blocked, houses: houses, targets: targets };
    }
    return noBlocks ? null : makeMapPlan(cfg, true); // (사실상 도달 불가) 공사장 없이라도 만든다
  }

  function mapGame(body, c) {
    var cfg = MAP_CFG[c.level - 1];
    var plan = makeMapPlan(cfg);
    var W = plan.W, H = plan.H, N = plan.targets.length;
    var houseAt = {}, blockAt = {};
    plan.houses.forEach(function (h) { houseAt[mapKey(h.x, h.y)] = h; });
    plan.blocked.forEach(function (b) { blockAt[mapKey(b.x, b.y)] = 1; });
    if (c.testHooks) {
      body.setAttribute("data-grid", W + "," + H);
      body.setAttribute("data-depot", mapKey(plan.depot.x, plan.depot.y));
      body.setAttribute("data-blocked", plan.blocked.map(function (b) { return mapKey(b.x, b.y); }).join(";"));
      body.setAttribute("data-targets", plan.targets.map(function (t) { return mapKey(t.x, t.y); }).join(";"));
    }

    var tiles = "";
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var k = mapKey(x, y), h = houseAt[k], isDepot = x === plan.depot.x && y === plan.depot.y;
      tiles += '<div class="mg-tile' + (h ? " is-house" : "") + (blockAt[k] ? " is-block" : "") + (isDepot ? " is-depot" : "") + '" data-x="' + x + '" data-y="' + y + '">'
        + (h ? HOUSE_SVG + '<b class="mg-lab">' + h.label + '</b><span class="mg-chk">✓</span>'
          : blockAt[k] ? '<span class="mg-fence"></span>' : isDepot ? '<span class="mg-dep">센터</span>' : "")
        + "</div>";
    }
    var dots = ""; for (var di = 0; di < N; di++) dots += '<span class="mg-dot"></span>';
    body.innerHTML =
      '<div class="mg-map-top"><div class="mg-flashbar"><i></i></div><p class="mg-phase"></p></div>'
      + '<div class="mg-map is-covered" style="--cols:' + W + ';--rows:' + H + '">' + tiles
      + '<div class="mg-courier" style="--cx:' + plan.depot.x + ';--cy:' + plan.depot.y + '">' + VAN_SVG + '</div>'
      + '<div class="mg-cover"><div class="mg-parcels"></div><span class="mg-cover-note">지도는 택배를 확인한 뒤에 나와요</span></div></div>'
      + '<div class="mg-map-foot"><div class="mg-dots">' + dots + '</div><button type="button" class="mg-replay" tabindex="-1" disabled>송장 다시 보기</button></div>'
      + '<p class="mg-freeze-note"></p>'
      + '<div class="mg-pad">'
      + '<button type="button" class="mg-key" data-k="up" aria-label="위">↑</button>'
      + '<button type="button" class="mg-key" data-k="left" aria-label="왼쪽">←</button>'
      + '<button type="button" class="mg-key" data-k="down" aria-label="아래">↓</button>'
      + '<button type="button" class="mg-key" data-k="right" aria-label="오른쪽">→</button>'
      + '<button type="button" class="mg-key" data-k="space" aria-label="스페이스">SPACE · 배달</button>'
      + "</div>";

    var map = body.querySelector(".mg-map"), courier = body.querySelector(".mg-courier");
    var parcelsEl = body.querySelector(".mg-parcels"), phaseEl = body.querySelector(".mg-phase"), barEl = body.querySelector(".mg-flashbar > i");
    var note = body.querySelector(".mg-freeze-note"), replay = body.querySelector(".mg-replay");
    var dotEls = Array.prototype.slice.call(body.querySelectorAll(".mg-dot"));
    function tileAt(x, y) { return map.querySelector('.mg-tile[data-x="' + x + '"][data-y="' + y + '"]'); }

    var pos = { x: plan.depot.x, y: plan.depot.y }, idx = 0, phase = "invoice", locked = false, lastStep = 0;
    var startedAt = performance.now(), replayAfter = typeof c.opts.replayAfterMs === "number" ? c.opts.replayAfterMs : MAP_REPLAY_AFTER_MS;

    function paintDots() {
      dotEls.forEach(function (d, i) { d.classList.toggle("is-done", i < idx); d.classList.toggle("is-current", i === idx && phase === "play"); });
    }
    // 송장 단계: 지도를 가리고 그 위에 "송장만 붙은 택배"를 순서대로 팝업으로 띄운다(이미 배달한 호실은 흐리게 + 체크로 같이 보여 줘서
    // 번호 순서가 그대로 유지된다). 처음 한 번 + "다시 보기" 때.
    function showInvoice() {
      phase = "invoice";
      map.classList.add("is-covered");
      var html = "";
      for (var i = 0; i < N; i++) {
        html += '<div class="mg-parcel' + (i < idx ? " is-done" : "") + '" style="--d:' + (i * MAP_POP_STAGGER_MS) + 'ms">'
          + '<i class="pn">' + (i + 1) + '</i><span class="pbox"><b class="pl">' + plan.targets[i].label + '호</b></span><span class="pk">✓</span></div>';
      }
      parcelsEl.innerHTML = html; // 새로 그려야 팝업 애니메이션이 처음부터 다시 돈다
      phaseEl.textContent = "택배 송장을 외우세요! 이 순서대로 배달해요";
      barEl.style.transition = "none"; barEl.style.width = "100%";
      void barEl.offsetWidth;
      barEl.style.transition = "width " + cfg.flashMs + "ms linear"; barEl.style.width = "0%";
      replay.disabled = true;
      paintDots();
      c.later(showMap, cfg.flashMs);
    }
    // 지도 단계: 택배가 사라지고 지도가 뜬다.
    function showMap() {
      phase = "play";
      map.classList.remove("is-covered");
      phaseEl.textContent = "지도가 나왔어요! 호실을 찾아 순서대로 배달하세요";
      paintDots();
      updateReplay();
    }
    // "송장 다시 보기": 게임 시작 후 replayAfter(20초)가 지나야 열린다. 그 전에는 남은 시간을 버튼에 표시.
    function updateReplay() {
      var left = replayAfter - (performance.now() - startedAt);
      if (left <= 0) { replay.textContent = "송장 다시 보기"; replay.disabled = phase !== "play"; return; }
      replay.disabled = true;
      replay.textContent = "송장 다시 보기 (" + Math.ceil(left / 1000) + "초 뒤)";
      c.later(updateReplay, Math.min(500, left));
    }
    function place() { courier.style.setProperty("--cx", pos.x); courier.style.setProperty("--cy", pos.y); }

    function move(k) {
      var now = performance.now();
      if (now - lastStep < MAP_STEP_MS) return;
      lastStep = now;
      var nx = pos.x + MAP_VEC[k][0], ny = pos.y + MAP_VEC[k][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || blockAt[mapKey(nx, ny)]) { restartAnim(courier, "is-bump"); return; } // 벽/공사장: 실수 아님
      pos.x = nx; pos.y = ny; place();
    }
    function deliver() {
      var tile = tileAt(pos.x, pos.y), want = plan.targets[idx];
      if (want && pos.x === want.x && pos.y === want.y) {
        tile.classList.add("is-delivered");
        restartAnim(tile, "is-pop");
        idx++;
        paintDots();
        if (idx === N) c.later(c.finish, 450);
        return;
      }
      c.addMistake();
      locked = true;
      restartAnim(tile, "is-wrong");
      note.textContent = tile.classList.contains("is-house") ? "그 호실이 아니에요!" : "배달할 집이 아니에요";
      c.later(function () { locked = false; note.textContent = ""; }, MAP_LOCK_MS);
    }
    function press(k) {
      if (locked || phase !== "play" || c.isFinished()) return;
      if (k === "space") deliver(); else move(k);
    }
    function onKey(e) {
      if (c.isFinished()) return;
      var k = null;
      if (e.key === "ArrowUp") k = "up";
      else if (e.key === "ArrowDown") k = "down";
      else if (e.key === "ArrowLeft") k = "left";
      else if (e.key === "ArrowRight") k = "right";
      else if (e.code === "Space" || e.key === " ") k = "space";
      if (!k) return;
      e.preventDefault();
      e.stopPropagation(); // 게임 본체의 전역 스페이스바/방향키 핸들러가 이 키를 따로 처리하지 않게 막는다
      if (e.repeat && k === "space") return; // 방향키는 꾹 누르면 계속 이동, 스페이스는 한 번에 한 번만
      press(k);
    }
    document.addEventListener("keydown", onKey, true);
    c.onCleanup(function () { document.removeEventListener("keydown", onKey, true); });
    Array.prototype.forEach.call(body.querySelectorAll(".mg-key"), function (b) {
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); press(b.getAttribute("data-k")); });
    });
    replay.addEventListener("mousedown", function (e) { e.preventDefault(); }); // 포커스를 안 가져가게(스페이스가 버튼을 또 누르면 안 된다)
    replay.addEventListener("click", function () {
      if (phase !== "play" || locked || c.isFinished() || performance.now() - startedAt < replayAfter) return;
      showInvoice(); // 공짜 -- 대신 보는 동안 지도가 가려져 시간이 간다
    });

    showInvoice();
    updateReplay();
    return {
      hint: function () {
        return "먼저 송장만 붙은 택배가 순서대로 잠깐 떠요 -- 호실 번호와 순서를 외우세요. 그다음 지도가 나오면 그 호실의 집을 찾아 방향키로 이동하고, 도착하면 스페이스로 배달해요. "
          + "비슷한 번호의 집이 섞여 있어요. 엉뚱한 집에서 배달하면 실수예요. 시작 " + Math.round(replayAfter / 1000) + "초 뒤부터는 송장을 다시 볼 수 있어요.";
      },
    };
  }

  // ======================================================================
  // 창고 정리 (소코반) -- 방향키로 걸으며 택배 박스를 밀어 노란 하역 칸에 모두 넣기
  //   ← ↑ ↓ → 이동(박스는 밀기만 가능, 당기기 없음)   Z / BACKSPACE 되돌리기(무료)   R 처음부터
  //   2026-10-08: 실물 우봉고 복귀 뒤 "우봉고가 아닌 형태로 우봉고처럼 생각이 필요한 미니게임" 후보로 추가한 시험용 게임.
  //   (사용자: 키보드로 진행하는 게 좋다.) 한 번 잘못 밀면 다시 생각해야 하는 시행착오 + 박스가 하나씩 제자리에 들어가는 완성 장면이 목적.
  //   판은 gen 스크립트(역방향 당기기로 섞은 뒤 BFS 풀이기로 최적 이동 수를 검증)로 미리 만들어 SOKO_POOL에 넣었다 -- 전부 풀 수 있다.
  //   판 형식: '#' 벽, ' ' 바닥, '.' 하역 칸, '$' 박스, '@' 플레이어, '+' 하역 칸 위 플레이어.
  //   막다른 길(박스가 풀 수 없는 위치에 끼임)을 만들면 실수 +1이 기록되고 안내가 뜬다 -- 되돌리기는 무료.
  // ======================================================================
  var SOKO_POOL = /*SOKO_POOL*/[
    // 레벨 1 (8판)
    [["######","#  ###","#  $@#","#   .#","######"],
     ["######","# #  #","#@$  #","#.   #","######"],
     ["######","#   .#","#  $@#","#  ###","######"],
     ["######","#.   #","#@$  #","###  #","######"],
     ["######","###  #","#@$  #","#.   #","######"],
     ["######","#.   #","#@$  #","# #  #","######"],
     ["######","#  # #","#  $@#","#   .#","######"],
     ["######","#   .#","#  $@#","#  # #","######"]],
    // 레벨 2 (16판)
    [["#######","####  #","#@$   #","#   $ #","#..   #","#######"],
     ["#######","# .   #","# # # #","# $ $@#","# #.  #","#######"],
     ["#######","#   #.#","#   #.#","##$  $#","# @   #","#######"],
     ["#######","#   #.#","#  $@ #","#  #$ #","# .#  #","#######"],
     ["#######","#     #","# .#$ #","#   $@#","#  .# #","#######"],
     ["#######","#  .  #","#   $@#","### $##","#.    #","#######"],
     ["#######","##.@ ##","#  $$ #","#.  # #","#     #","#######"],
     ["#######","#  #  #","# $#. #","#@$   #","#.#   #","#######"],
     ["#######","#.#   #","#  #  #","#  $$ #","#. #@ #","#######"],
     ["#######","#.  # #","# $#  #","#@$   #","#   #.#","#######"],
     ["#######","#.  # #","##.   #","#@$ $ #","# #   #","#######"],
     ["#######","# ##@ #","#  $$ #","# .   #","# . # #","#######"],
     ["#######","#  @. #","#  $$ #","# #.# #","#     #","#######"],
     ["#######","#..   #","### $ #","#   $@#","#   # #","#######"],
     ["#######","##  . #","# @$  #","# $#  #","## .  #","#######"],
     ["#######","#  .  #","#   $@#","# $## #","#  . ##","#######"]],
    // 레벨 3 (16판)
    [["########","#   $@.#","# # $###","# # $  #","#    ..#","########"],
     ["########","#   #  #","##  #$ #","#  . $@#","# $ .#.#","########"],
     ["########","#  #   #","#+$ .  #","#.#$$  #","#    # #","########"],
     ["########","#    #.#","# $ $#.#","##  .$@#","#   #  #","########"],
     ["########","##    .#","# $##  #","#@$  $ #","#.#   .#","########"],
     ["########","#   . ##","# # #$ #","# $ $+ #","#    #.#","########"],
     ["########","#.  .  #","# $ #$ #","###@$  #","#.   # #","########"],
     ["########","##     #","# $  $@#","# $ # .#","#   #..#","########"],
     ["########","#     ##","# # #$ #","# $  $@#","# .. #.#","########"],
     ["########","#  #   #","#  #$$.#","#    $@#","#  .##.#","########"],
     ["########","#    # #","# $$## #","#    $@#","# . .. #","########"],
     ["########","# ##   #","#@$   .#","# $$#. #","#   # .#","########"],
     ["########","#. . # #","#    $@#","# #$#$ #","#  .  ##","########"],
     ["########","# . .###","# $. $@#","# #  $ #","# #    #","########"],
     ["########","#    . #","#@$  $ #","### #$ #","#  .# .#","########"],
     ["########","#     .#","# $#$ ##","##   $@#","#.. #  #","########"]]
  ]/*END_SOKO_POOL*/;
  var SOKO_STEP_MS = 85;  // 방향키를 꾹 누를 때 한 칸씩 가는 최소 간격
  var SOKO_DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function sokoParse(rows) {
    var H = rows.length, W = 0, y, x, i;
    rows.forEach(function (r) { W = Math.max(W, r.length); });
    var wall = [], tgt = [], boxes = [], player = 0;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var ch = rows[y].charAt(x) || "#"; i = y * W + x;
      wall[i] = ch === "#"; tgt[i] = ch === "." || ch === "*" || ch === "+";
      if (ch === "$" || ch === "*") boxes.push(i);
      if (ch === "@" || ch === "+") player = i;
    }
    return { W: W, H: H, wall: wall, tgt: tgt, boxes: boxes, player: player };
  }
  // 풀 수 없게 된 박스: 하역 칸이 아닌 구석, 또는 양 끝이 벽으로 막힌 벽 줄(그 줄에 하역 칸이 없음)
  function sokoDead(S, i) {
    if (S.tgt[i]) return false;
    var W = S.W, x = i % W, y = (i / W) | 0, k, side;
    var open = function (xx, yy) { return xx >= 0 && yy >= 0 && xx < W && yy < S.H && !S.wall[yy * W + xx]; };
    var wU = !open(x, y - 1), wD = !open(x, y + 1), wL = !open(x - 1, y), wR = !open(x + 1, y);
    if ((wU || wD) && (wL || wR)) return true;
    // 벽을 따라 늘어선 줄 검사 (옆으로만 밀 수 있다)
    for (side = 0; side < 4; side++) {
      var vertWall = side < 2 ? (side === 0 ? wU : wD) : (side === 2 ? wL : wR);
      if (!vertWall) continue;
      var horiz = side < 2, dx = horiz ? 1 : 0, dy = horiz ? 0 : 1, nx = side === 0 ? 0 : side === 1 ? 0 : side === 2 ? -1 : 1, ny = side === 0 ? -1 : side === 1 ? 1 : 0;
      var hasT = false, closed = true, dir;
      for (dir = -1; dir <= 1; dir += 2) {
        var cx = x, cy = y;
        for (;;) {
          if (S.tgt[cy * W + cx]) hasT = true;
          var ax = cx + dx * dir, ay = cy + dy * dir;
          if (!open(ax, ay)) break;                       // 줄 끝이 벽
          if (open(ax + nx, ay + ny)) { closed = false; break; } // 이 칸은 벽을 벗어나 있다 -> 빠져나갈 수 있음
          cx = ax; cy = ay;
        }
        if (!closed) break;
      }
      if (closed && !hasT) return true;
    }
    return false;
  }

  var SK_BOX_SVG = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="4" y="7" width="32" height="28" rx="2.5" class="sk-bx-body"/><rect x="4" y="7" width="32" height="8" rx="2.5" class="sk-bx-top"/><rect x="16" y="7" width="8" height="17" class="sk-bx-tape"/><path class="sk-bx-ok" d="M12 25l6 6 11-12"/></svg>';
  var SK_MAN_SVG = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="14" r="7.5" class="sk-m-face"/><path d="M11.5 12.5c0-6 4-8.5 8.5-8.5s8.5 2.5 8.5 8.5Z" class="sk-m-cap"/><rect x="19" y="10" width="14" height="3.4" rx="1.6" class="sk-m-brim"/><path d="M9 36c0-8 5-13 11-13s11 5 11 13Z" class="sk-m-body"/><circle cx="16.6" cy="15" r="1.1" class="sk-m-eye"/><circle cx="23.4" cy="15" r="1.1" class="sk-m-eye"/></svg>';

  function sokoGame(body, c) {
    var pool = SOKO_POOL[c.level - 1] && SOKO_POOL[c.level - 1].length ? SOKO_POOL[c.level - 1] : SOKO_POOL[1];
    var rows = pool[rand(pool.length)];
    var S = sokoParse(rows), W = S.W, H = S.H, N = W * H;
    var start = { p: S.player, boxes: S.boxes.slice() };
    var p = start.p, boxes = start.boxes.slice(), hist = [], lastStep = 0, stuck = false, moves = 0;
    if (c.testHooks) body.setAttribute("data-plan", JSON.stringify({ rows: rows }));

    var floorHtml = "", i;
    for (i = 0; i < N; i++) floorHtml += '<i class="sk-cell' + (S.wall[i] ? " is-wall" : S.tgt[i] ? " is-tgt" : "") + '"></i>';
    var boxHtml = boxes.map(function () { return '<span class="sk-box">' + SK_BOX_SVG + "</span>"; }).join("");
    body.innerHTML =
      '<div class="sk-wrap"><div class="sk-board" style="--cols:' + W + ';--rows:' + H + '">'
      + '<div class="sk-floor">' + floorHtml + "</div>" + boxHtml + '<span class="sk-man">' + SK_MAN_SVG + "</span></div></div>"
      + '<p class="sk-status"><span>박스 <b class="sk-in">0</b> / ' + boxes.length + '</span><span>움직임 <b class="sk-moves">0</b></span></p>'
      + '<p class="mg-freeze-note"></p>'
      + '<div class="pk-pad sk-pad">'
      + '<button type="button" class="mg-key" data-sk="up" aria-label="위">↑</button>'
      + '<button type="button" class="mg-key" data-sk="left" aria-label="왼쪽">←</button>'
      + '<button type="button" class="mg-key" data-sk="down" aria-label="아래">↓</button>'
      + '<button type="button" class="mg-key" data-sk="right" aria-label="오른쪽">→</button>'
      + '<button type="button" class="mg-key pk-act" data-sk="undo">되돌리기<small>Z · ⌫</small></button>'
      + '<button type="button" class="mg-key pk-act" data-sk="restart">처음부터<small>R</small></button>'
      + "</div>";
    var boxEls = Array.prototype.slice.call(body.querySelectorAll(".sk-box"));
    var manEl = body.querySelector(".sk-man"), inEl = body.querySelector(".sk-in"), movesEl = body.querySelector(".sk-moves");
    var note = body.querySelector(".mg-freeze-note"), boardEl = body.querySelector(".sk-board");

    function place(node, idx) { node.style.setProperty("--x", idx % W); node.style.setProperty("--y", (idx / W) | 0); }
    function onTarget() { return boxes.filter(function (b) { return S.tgt[b]; }).length; }
    function anyDead() { return boxes.some(function (b) { return sokoDead(S, b); }); }
    function paint() {
      place(manEl, p);
      boxEls.forEach(function (e, bi) { place(e, boxes[bi]); e.classList.toggle("is-in", !!S.tgt[boxes[bi]]); e.classList.toggle("is-dead", sokoDead(S, boxes[bi])); });
      inEl.textContent = onTarget(); movesEl.textContent = moves;
      if (!stuck) note.textContent = "";
      if (c.testHooks) body.setAttribute("data-sk", [p % W, (p / W) | 0, onTarget(), moves].join(","));
    }
    function act(a) {
      if (c.isFinished()) return;
      if (a === "undo") {
        if (!hist.length) return;
        var h = hist.pop(); p = h.p; boxes = h.boxes; moves = Math.max(0, moves - 1);
        stuck = anyDead(); note.textContent = stuck ? "박스가 막다른 곳에 끼어 있어요 — 더 되돌리세요 (Z)" : "";
        paint(); return;
      }
      if (a === "restart") {
        p = start.p; boxes = start.boxes.slice(); hist = []; moves = 0; stuck = false; note.textContent = ""; paint(); return;
      }
      var d = SOKO_DIRS[a]; if (!d) return;
      var x = p % W, y = (p / W) | 0, nx = x + d[0], ny = y + d[1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
      var ni = ny * W + nx; if (S.wall[ni]) { restartAnim(manEl, "is-bump"); return; }
      var bi = boxes.indexOf(ni), nb = boxes;
      if (bi >= 0) {
        var mx = nx + d[0], my = ny + d[1];
        if (mx < 0 || my < 0 || mx >= W || my >= H) { restartAnim(manEl, "is-bump"); return; }
        var mi = my * W + mx;
        if (S.wall[mi] || boxes.indexOf(mi) >= 0) { restartAnim(manEl, "is-bump"); return; }
        nb = boxes.slice(); nb[bi] = mi;
      }
      hist.push({ p: p, boxes: boxes.slice() });
      p = ni; boxes = nb; moves++;
      if (bi >= 0) {
        var dead = anyDead();
        if (dead && !stuck) {
          c.addMistake();
          note.textContent = "박스가 막다른 곳에 끼었어요 — Z로 되돌려 보세요";
          restartAnim(boardEl, "is-shake");
        }
        stuck = dead;
      }
      paint();
      if (onTarget() === boxes.length) {
        note.textContent = "창고 정리 끝!";
        c.later(c.finish, 420);
      }
    }

    function onKey(e) {
      if (c.isFinished()) return;
      var a = null;
      if (e.key === "ArrowLeft") a = "left";
      else if (e.key === "ArrowRight") a = "right";
      else if (e.key === "ArrowUp") a = "up";
      else if (e.key === "ArrowDown") a = "down";
      else if (e.key === "Backspace" || e.key === "z" || e.key === "Z") a = "undo";
      else if (e.key === "r" || e.key === "R") a = "restart";
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) {
        if (a === "restart") return;
        var now = performance.now(); if (now - lastStep < SOKO_STEP_MS) return; lastStep = now;
      } else lastStep = performance.now();
      act(a);
    }
    document.addEventListener("keydown", onKey, true);
    c.onCleanup(function () { document.removeEventListener("keydown", onKey, true); });
    Array.prototype.forEach.call(body.querySelectorAll(".mg-key[data-sk]"), function (b) {
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); act(b.getAttribute("data-sk")); });
    });
    paint();
    return {
      hint: function () {
        return "방향키(←↑↓→)로 걸으며 박스를 밀어 노란 하역 칸에 모두 넣으세요. 박스는 밀기만 되고 당길 수는 없어요! 구석에 끼면 Z(백스페이스)로 되돌리고, R로 처음부터 다시 해요.";
      },
    };
  }

  // ======================================================================
  // 2026-10-08 소코반 같은 류의 시험용 게임 4종 + 하노이 (사용자: "다 게임 테스트로만 만들어보자").
  // 전부 키보드 + 되돌리기(Z / Backspace, 무료) + 처음부터(R) + 터치용 화면 버튼. 시험장 전용 -- TYPES.mini에는 연결하지 않았다.
  //   ice   빙판 배송     방향키로 미끄러져 하역 칸에 정확히 멈추기 (택배는 지나가면 수거)
  //   route 배달 경로     방향키로 선을 그어 모든 길을 한 번씩만 지나기 (한붓그리기)
  //   twin  쌍둥이 배달   방향키 하나로 두 택배원이 동시에 움직여 각자의 하역 칸에 넣기
  //   pipe  컨베이어 잇기 커서로 타일을 골라 SPACE로 돌려 입구에서 출구까지 잇기
  //   hanoi 택배 쌓기     큰 상자 위에 작은 상자만 올려 가며 탑을 옆 칸으로 옮기기
  //   빙판/쌍둥이 판은 오프라인 생성기 + BFS로 풀이를 검증한 풀, 한붓그리기/컨베이어는 항상 풀리게 만드는 방식으로 실행 중 생성한다.
  // ======================================================================
  var ICE_POOL = /*ICE_POOL*/[
    // 레벨 1 (30판)
    [[" #    ", "      ", "# ## S", " # G  ", "    # "],
     [" # S  ", " #  ##", "#     ", "     G", " #    "],
     ["#     ", "     #", "    # ", " S#G #", "     #"],
     ["#  S##", "    G#", "      ", "  #   ", "      "],
     ["# #   ", " S    ", " #    ", "   G  ", "#  # #"],
     ["# # S ", "    # ", " # #  ", "   G  ", "  #   "],
     ["     #", "   # G", " #  # ", "      ", "  S  #"],
     ["    S ", " #    ", " G##  ", "  #  #", "  #   "],
     ["      ", "  #   ", " #  G#", "#S    ", " #    "],
     ["   S#G", "   ## ", "#  ## ", "      ", "      "],
     ["  S   ", "      ", "     #", " ##  G", "# #   "],
     ["   # #", "S     ", "    # ", "#G    ", "   #  "],
     ["  #   ", "  ##S ", "   G# ", "      ", " ##   "],
     ["S    #", "   # #", " #    ", "    # ", "  G # "],
     ["      ", "   ###", "G#    ", "#S    ", " #    "],
     [" #G   ", "      ", "   ## ", "  #   ", "#S   #"],
     ["  G   ", " S   #", "   # #", "# #   ", "  #   "],
     ["  S  #", "  ##G ", "      ", "#     ", "    # "],
     ["#  ## ", "     #", "#     ", "  G#S ", "      "],
     ["#   # ", "     #", "  #   ", "   #S ", " G #  "],
     ["   G #", " S    ", "#    #", "    ##", "      "],
     ["    ##", "      ", "    S ", "#     ", "   G #"],
     ["#S   #", "G     ", "#     ", "   ###", "      "],
     ["     #", "     S", " #   G", "  # # ", "   #  "],
     ["#     ", "G #   ", " #    ", "# #   ", "   #S "],
     ["#    #", "S     ", "   ## ", "#G    ", "   #  "],
     ["      ", " #   G", "#S   #", "      ", "#  #  "],
     ["S    #", "      ", " # #  ", "  #G #", "  #   "],
     ["S   G ", "      ", "  #   ", "#  #  ", "#  #  "],
     ["   #  ", " #  #S", "      ", " #G # ", "  #   "]],
    // 레벨 2 (30판)
    [["  #   G", " #     ", "P  # # ", "#S #  #", " # # # ", "  #    "],
     ["# S    ", "   G#  ", "  #P#  ", " ###   ", "#   #  ", "   #   "],
     ["P #G   ", "    #  ", "       ", "#     S", "#    ##", "       "],
     ["#  #   ", "#   P #", "       ", "   ##  ", "#      ", " G## S "],
     [" #     ", "#  ## #", "# #P   ", " #  G# ", "    S #", " #     "],
     ["  ## ##", " #G #  ", "  #    ", "      #", " #  P S", "     # "],
     ["  #   P", " #G # #", " # #   ", " #  S  ", "       ", " ##   #"],
     ["  #G   ", " S   ##", "#     #", "   ### ", "P##    ", "   #   "],
     ["#   #  ", " # P## ", " #     ", " # S   ", " G #   ", "  #    "],
     ["  S#   ", "G    # ", "#      ", "   #   ", "    #P ", "###   #"],
     ["   #   ", "       ", " #     ", "#  #  #", "  #G#S ", " P  ###"],
     ["P  #  #", "     S#", " ##   #", "#    G ", "     ##", "   #   "],
     [" #S  # ", "#     #", "#    G ", "#    # ", " P#  # ", "       "],
     ["#  #S#G", "#    # ", "#      ", "  #  # ", "    P  ", "#    # "],
     ["#  # # ", "    #  ", " #  G  ", " #   # ", " #     ", "# S# P "],
     ["  G   #", "   #  #", "     # ", "P    #S", "#      ", "##   ##"],
     ["P #G# #", " #     ", "  S #  ", "  #    ", "# # #  ", "      #"],
     ["   G   ", "   P#  ", " #    #", "    #  ", "# #  # ", " #  ##S"],
     ["     # ", " #   G ", "    #  ", " S  # #", "P    ##", " # #   "],
     ["#   #G ", "#  P   ", "     # ", "   S   ", " #    #", "    # #"],
     ["#   # P", "#   G  ", "  #    ", "##  S# ", "   #   ", "       "],
     ["  S#P  ", "  #    ", "     # ", "#     #", "# #G   ", "# # #  "],
     ["  # #  ", "       ", "###   #", " #     ", "     # ", "PG#   S"],
     ["   #   ", "# ##   ", " P     ", "#  ### ", "   #S  ", "  ##  G"],
     ["#   # P", "  ##   ", "     ##", " S    #", "     # ", "#G   # "],
     ["      #", "      #", "  G#   ", "##    #", "S  # P ", " # #  #"],
     ["     # ", "  #  # ", " # # ##", "#   P  ", "S#  #  ", "      G"],
     ["###    ", " # #   ", "    #  ", "   P ##", " ##   G", "#S     "],
     [" P#   #", "     # ", "# #G   ", "  ###  ", "   S # ", " #    #"],
     ["    G# ", " #  #  ", "      #", "##  #  ", "#PS    ", " ##    "]],
    // 레벨 3 (30판)
    [["   #  # ", "  P ## P", "#      #", "   #    ", " #    G ", " ## # ##", "#  S#   "],
     ["#      S", " #      ", "#  P#   ", "   P  G#", "  #  #  ", "#      #", "# #  ## "],
     ["##      ", "    #   ", "  #  #  ", " #G P#  ", "   #  # ", "P#  S  #", "##    # "],
     ["# ##    ", " # S    ", "     # P", "# #  ###", "      P#", " ## #  G", "   #    "],
     ["       #", "  ##  # ", "##   S G", "## ##  #", "   P #  ", "   #P # ", "#       "],
     ["   G #  ", "  #  #  ", "     #  ", "SP      ", " #  #   ", " ##   ##", "P#   ###"],
     [" #   #  ", " P     #", " ##    P", " S  # # ", " # # # G", "#    #  ", " # # # #"],
     [" ##  # #", "# #  P# ", "#  ##   ", "  #SP  #", "#    #  ", "  # #  G", "    #   "],
     ["#  # P# ", "  ##  # ", " S   ###", " #     G", " #  # # ", "        ", " #  P   "],
     ["    #  #", "  #    #", "   GP#  ", "   # ## ", "   ## ##", "P  #S## ", "      # "],
     ["#  #  # ", "P G ##  ", "  ## # S", "       #", "P   #   ", "    ## #", "  #     "],
     ["        ", "#  S   #", "G     # ", "  ### ##", " P #    ", " #   #  ", "# # P#  "],
     ["  #G # #", "   S#  P", "#       ", "     # P", "#  # #  ", "##  ##  ", "   ##   "],
     ["#   P   ", "P## #   ", "        ", "  #  #  ", "     #  ", "#  #   G", "S ## # #"],
     ["#       ", "    # P#", " ##     ", " ##    S", "G   ##  ", "P#     #", "   #    "],
     ["    S  #", "        ", " # P##  ", " ##     ", " G ##P  ", "#    # #", "#    ###"],
     ["#   ### ", "#  P  # ", "     S  ", "#  ##   ", " #    P#", "    #G  ", "  #     "],
     ["   # #G ", "     P  ", "    ### ", "S       ", "  #  ## ", " # ##  P", "    ##  "],
     [" #  #P  ", "P ## #  ", "#     # ", "    # # ", "#      G", "##  S## ", " #      "],
     ["  # #P# ", " #   P  ", "    # S#", "###  ###", " #     #", "  ##    ", "#G      "],
     ["#   # #G", " #   P  ", " #  #   ", "   P    ", " #S# # #", " #  #   ", " #     #"],
     ["  ##   #", "     # #", "# ### PG", "  #  ## ", "S#P     ", "    # # ", "  #   # "],
     ["P  # #  ", "   S  # ", "###     ", "     # #", "      # ", " P   ###", "  ##G   "],
     [" ### GSP", "#     # ", "#      #", "   #P#  ", "##      ", "      # ", "    ## #"],
     ["## P    ", "     ###", "  ##   #", "    #   ", "  #   PG", "   ##S# ", "     # #"],
     ["#G  # # ", "   ##  #", "    S # ", "    P   ", " # # ## ", "       #", "  ##  P "],
     [" #     #", "     #P#", "# P G # ", "  # ##  ", "#  #    ", "    #   ", " S #  # "],
     ["        ", "  #   # ", "#   #GS#", "#   P  #", "  P  #  ", " #  #   ", "##   ## "],
     ["  #  P  ", "##      ", " #S  #  ", "     #  ", "  #G    ", " #P   ##", " #   ###"],
     [" # P#   ", "#     # ", "   #### ", "     ###", "  ##    ", " # S    ", " PG##   "]]
  ]/*END_ICE_POOL*/;
  var TWIN_POOL = /*TWIN_POOL*/[
    // 레벨 1 (30판)
    [{rows:["     ", "    a", "# ## ", "#   b", " # AB"]},
     {rows:["a ## ", " B   ", " A   ", "# #  ", "  b  "]},
     {rows:["#A  #", "     ", " b#a ", " ##  ", " B   "]},
     {rows:["   b ", " A# a", "#   #", " #B# ", "     "]},
     {rows:["##b# ", "     ", "   a ", "BA  #", "    #"]},
     {rows:["     ", " #  #", "#  B ", "#  A ", "#  ab"]},
     {rows:[" #  a", "  A# ", "    #", "B  # ", " # b "]},
     {rows:["  #  ", "  A  ", "  Ba ", "###  ", "# b  "]},
     {rows:["     ", "  # b", "B  # ", "    a", "  A# "]},
     {rows:["  ## ", "a    ", " b  #", "  A# ", "    B"]},
     {rows:["#    ", "    b", "#a   ", " #  B", "  # A"]},
     {rows:["#    ", " b## ", "  a A", "    #", "  # B"]},
     {rows:["#B   ", "  A# ", "#    ", "#  a ", "  b# "]},
     {rows:["# b  ", "  #a ", "     ", "A#B  ", " #  #"]},
     {rows:["ab  #", "  ## ", "    #", "     ", "  AB#"]},
     {rows:[" ##  ", "###  ", "b    ", " BA  ", "    a"]},
     {rows:[" A## ", "  a #", " bB  ", "   ##", "     "]},
     {rows:["     ", "   # ", "#b aA", " #   ", "   #B"]},
     {rows:[" B   ", " #ab#", "#    ", "#    ", "#A   "]},
     {rows:["a ## ", "     ", "bA# B", "#  # ", "     "]},
     {rows:[" #  B", "b aA ", "  #  ", "#    ", "#   #"]},
     {rows:["#a B ", "   #b", "     ", "  A #", "  ## "]},
     {rows:[" #   ", "  a A", "b    ", "  #B#", " # # "]},
     {rows:["     ", "#    ", "B  # ", " ba#A", "  #  "]},
     {rows:["     ", " b   ", "#   #", "#aB  ", "A  # "]},
     {rows:["    a", "B# bA", "  #  ", " ##  ", "    #"]},
     {rows:["  #  ", "#a   ", "  # b", " B   ", " A  #"]},
     {rows:["    #", "#A #a", "  B  ", " b # ", "#    "]},
     {rows:["  #  ", " #  #", "   # ", "  AaB", " b#  "]},
     {rows:["#  B ", "ba## ", "   A ", "#   #", "     "]}],
    // 레벨 2 (30판)
    [{rows:["b B   ", "  # # ", "    a#", "A  ###", "  #   "]},
     {rows:["    A#", " a#  b", " ##  #", "  #   ", "  B  #"]},
     {rows:["B  # #", "a#    ", "      ", " #  b#", "A  ## "]},
     {rows:["  #   ", "B    A", "#  #  ", "   b# ", "  #  a"]},
     {rows:[" b   B", "A   # ", "    a ", " ###  ", "  # # "]},
     {rows:["  # # ", "A  # #", " #  # ", "   b  ", " B#a #"]},
     {rows:["#  A  ", " #    ", "###  b", "# #  #", "B    a"]},
     {rows:["#     ", "#    A", "# ##  ", "  b # ", " B #a "]},
     {rows:[" #   A", "      ", " ## B ", "   # #", "#a   b"]},
     {rows:["  #   ", " ##  #", "B Ab# ", "      ", "a # # "]},
     {rows:["#    #", "# ##  ", "  # # ", "B a b ", "  #A  "]},
     {rows:["# #  b", "#  #  ", "   #  ", " a #  ", "    BA"]},
     {rows:["  b # ", "  #  #", "a#    ", " BA   ", "  ### "]},
     {rows:[" #  b ", " A    ", "   # #", "  #a  ", "# B# #"]},
     {rows:[" a#B  ", "  ##  ", " A    ", "##b # ", "#  #  "]},
     {rows:["   a# ", "B##   ", "  # ##", "A    b", "  #  #"]},
     {rows:["  b   ", "  ##  ", "   # A", " B #  ", " #   a"]},
     {rows:["# # # ", "a b  #", " #B   ", "     #", "# # A "]},
     {rows:["  b   ", " #   #", "#  # a", " ##  #", " AB   "]},
     {rows:["#b   #", "##  # ", "     #", " A #a ", "#B    "]},
     {rows:["B #  a", "  ##b ", "# #   ", "#    #", "A     "]},
     {rows:["   B#b", " #  A ", "a     ", "     #", "## ## "]},
     {rows:["  #  b", "   A #", "  ##a#", "   #  ", "  B ##"]},
     {rows:["# #a #", "  A   ", "      ", " #   #", "b  B##"]},
     {rows:["  #   ", " # # #", "#  ##B", " #A   ", " b a  "]},
     {rows:[" #    ", "A     ", "  a#  ", " ##   ", " b#B# "]},
     {rows:["   ## ", "#A    ", "   #B ", "#  a# ", "  #b# "]},
     {rows:["# b a ", " #    ", " A#   ", "  #  #", "  B  #"]},
     {rows:[" b    ", "  #A a", "  # B#", "  ##  ", "   ## "]},
     {rows:[" #   B", "#  #A#", "  ##  ", "  b   ", "#a#   "]}],
    // 레벨 3 (30판)
    [{rows:["   # #", "     #", "#  b #", "#     ", "##   a", "  AB  "],mirror:true},
     {rows:["   #b ", "#     ", "#     ", "  # #A", "##    ", "B  a  "],mirror:true},
     {rows:["##  # ", "  A #a", "   ## ", "B # # ", " b    ", "#     "],mirror:true},
     {rows:["  #   ", " ##  A", "# #   ", "#     ", "Ba#   ", " # b  "],mirror:true},
     {rows:["#  #  ", " # #B ", "#b #  ", "  a   ", "  #   ", "  A## "],mirror:true},
     {rows:["  #  a", "#     ", "  b  #", " #   #", " A  # ", "##B   "],mirror:true},
     {rows:[" B## a", "      ", " ###  ", " # #  ", "   b#A", "      "],mirror:true},
     {rows:["     a", " b    ", "##  A ", "# # # ", "   #  ", "   #B "],mirror:true},
     {rows:["     #", "    b ", "#     ", "#a# A ", "   # #", "B#    "],mirror:true},
     {rows:["  #   ", "  #a# ", "  # # ", "  B   ", "      ", "# ##Ab"],mirror:true},
     {rows:["   #  ", "B#  A#", "  #   ", "##b   ", "  #a  ", " ##   "],mirror:true},
     {rows:[" ##   ", "##   b", " B #  ", "      ", "# #a  ", " A #  "],mirror:true},
     {rows:["    ##", " #    ", "   b  ", "  B #A", "   #  ", " a## #"],mirror:true},
     {rows:["#  B  ", "#a#   ", "     #", "# b  #", "# #A  ", "     #"],mirror:true},
     {rows:[" #   #", "  ##  ", "B  #A ", "#    b", " #    ", " #a   "],mirror:true},
     {rows:["  # # ", "   B# ", " ab   ", " #    ", "##    ", "#  #A "],mirror:true},
     {rows:["# #b  ", " #  # ", "#     ", "# # a ", "      ", "A B#  "],mirror:true},
     {rows:[" #A   ", "#  b #", " #    ", " #a   ", "     B", "# ## #"],mirror:true},
     {rows:[" #  ##", "  b   ", " A#   ", "# B   ", "   #  ", " #  a#"],mirror:true},
     {rows:[" # ## ", "  #   ", "  a# A", "  #   ", "#    b", "  # B "],mirror:true},
     {rows:["A     ", " Ba  #", "   # #", "# # b ", "     #", "#     "],mirror:true},
     {rows:["### b#", "      ", "      ", "##B  A", "##  # ", "a     "],mirror:true},
     {rows:["  ##  ", " #   #", "    a ", "  A# B", "# # b ", "      "],mirror:true},
     {rows:["# #  b", "   # #", "# A   ", "   a  ", "# # # ", "#   B "],mirror:true},
     {rows:["#A   #", "  ##  ", "  ##  ", "ba #  ", "B     ", "     #"],mirror:true},
     {rows:["a B## ", "      ", "#  #  ", "b  A# ", "      ", " ###  "],mirror:true},
     {rows:["#  # B", "###A  ", "   #  ", "#  #  ", "  a  #", "   b  "],mirror:true},
     {rows:["#    #", "#     ", "ab#B  ", "  # # ", "   #A ", "  #   "],mirror:true},
     {rows:[" #   #", " #   b", "    # ", "   # #", "##   A", "B   a#"],mirror:true},
     {rows:["  # # ", "   a# ", "##    ", " b  # ", "#A #B ", "    # "],mirror:true}]
  ]/*END_TWIN_POOL*/;
  var DIR_KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

  // 공통: 키보드/버튼 연결. onAct(a)는 a = up|down|left|right|undo|restart|space.
  function bindPad(body, c, attr, onAct, keyMap) {
    function onKey(e) {
      if (c.isFinished()) return;
      var a = DIR_KEYS[e.key] || null;
      if (!a) {
        if (e.key === "Backspace" || e.key === "z" || e.key === "Z") a = "undo";
        else if (e.key === "r" || e.key === "R") a = "restart";
        else if (e.code === "Space" || e.key === " ") a = "space";
        else if (e.key === "Enter") a = "enter";
        else if (keyMap && keyMap[e.key]) a = keyMap[e.key];
      }
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat && a !== "up" && a !== "down" && a !== "left" && a !== "right") return;
      onAct(a);
    }
    document.addEventListener("keydown", onKey, true);
    c.onCleanup(function () { document.removeEventListener("keydown", onKey, true); });
    Array.prototype.forEach.call(body.querySelectorAll(".mg-key[" + attr + "]"), function (b) {
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); onAct(b.getAttribute(attr)); });
    });
  }
  function arrowPad(attr, extra) {
    return '<button type="button" class="mg-key" ' + attr + '="up" aria-label="위">↑</button>'
      + '<button type="button" class="mg-key" ' + attr + '="left" aria-label="왼쪽">←</button>'
      + '<button type="button" class="mg-key" ' + attr + '="down" aria-label="아래">↓</button>'
      + '<button type="button" class="mg-key" ' + attr + '="right" aria-label="오른쪽">→</button>' + (extra || "");
  }
  function actBtn(attr, name, label, sub) { return '<button type="button" class="mg-key pk-act" ' + attr + '="' + name + '">' + label + (sub ? "<small>" + sub + "</small>" : "") + "</button>"; }
  function gridCells(S, cls) { var h = "", i; for (i = 0; i < S.W * S.H; i++) h += '<i class="sk-cell ' + cls(i) + '"></i>'; return h; }
  function placeAt(node, idx, W) { node.style.setProperty("--x", idx % W); node.style.setProperty("--y", (idx / W) | 0); }
  function slotAt(W, idx) { return [idx % W, (idx / W) | 0]; }

  // ---------- 빙판 배송 ----------
  function iceParse(rows) {
    var H = rows.length, W = 0, x, y;
    rows.forEach(function (r) { W = Math.max(W, r.length); });
    var wall = [], S = 0, G = 0, P = [];
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var ch = rows[y].charAt(x) || " ", i = y * W + x;
      wall[i] = ch === "#"; if (ch === "S") S = i; if (ch === "G") G = i; if (ch === "P") P.push(i);
    }
    return { W: W, H: H, wall: wall, S: S, G: G, P: P };
  }
  function iceSlide(S, from, d) { // d = [dx, dy]; 벽/바위/가장자리 직전까지. 지나간 칸 목록도 돌려준다
    var x = from % S.W, y = (from / S.W) | 0, path = [];
    for (;;) {
      var nx = x + d[0], ny = y + d[1];
      if (nx < 0 || ny < 0 || nx >= S.W || ny >= S.H || S.wall[ny * S.W + nx]) break;
      x = nx; y = ny; path.push(y * S.W + x);
    }
    return { to: y * S.W + x, path: path };
  }
  function iceGame(body, c) {
    var pool = ICE_POOL[c.level - 1] && ICE_POOL[c.level - 1].length ? ICE_POOL[c.level - 1] : ICE_POOL[1];
    var rows = pool[rand(pool.length)], S = iceParse(rows), W = S.W;
    var p = S.S, got = {}, hist = [], moves = 0, sliding = false;
    if (c.testHooks) body.setAttribute("data-plan", JSON.stringify({ rows: rows }));
    var floor = gridCells(S, function (i) { return S.wall[i] ? "is-rock" : i === S.G ? "is-tgt" : "is-ice"; });
    var items = S.P.map(function (i) { return '<span class="sk-box ic-item">' + SK_BOX_SVG + "</span>"; }).join("");
    body.innerHTML = '<div class="sk-wrap"><div class="sk-board" style="--cols:' + W + ';--rows:' + S.H + '"><div class="sk-floor">' + floor + "</div>"
      + items + '<span class="sk-man ic-man">' + SK_MAN_SVG + "</span></div></div>"
      + '<p class="sk-status"><span>택배 <b class="ic-got">0</b> / ' + S.P.length + "</span><span>미끄러짐 <b class=\"ic-moves\">0</b></span></p>"
      + '<p class="mg-freeze-note"></p><div class="pk-pad sk-pad">' + arrowPad("data-ic", actBtn("data-ic", "undo", "되돌리기", "Z · ⌫") + actBtn("data-ic", "restart", "처음부터", "R")) + "</div>";
    var man = body.querySelector(".ic-man"), itemEls = Array.prototype.slice.call(body.querySelectorAll(".ic-item"));
    var gotEl = body.querySelector(".ic-got"), movesEl = body.querySelector(".ic-moves"), note = body.querySelector(".mg-freeze-note"), boardEl = body.querySelector(".sk-board");
    function count() { return Object.keys(got).length; }
    function paint(dist) {
      man.style.transitionDuration = Math.max(90, (dist || 1) * 55) + "ms";
      placeAt(man, p, W);
      itemEls.forEach(function (e, k) { placeAt(e, S.P[k], W); e.classList.toggle("is-gone", !!got[S.P[k]]); });
      gotEl.textContent = count(); movesEl.textContent = moves;
      if (c.testHooks) body.setAttribute("data-ic", [p % W, (p / W) | 0, count(), moves].join(","));
    }
    function act(a) {
      if (c.isFinished()) return;
      if (a === "undo") { if (!hist.length) return; var h = hist.pop(); p = h.p; got = h.got; moves--; sliding = false; note.textContent = ""; paint(1); return; }
      if (a === "restart") { p = S.S; got = {}; hist = []; moves = 0; sliding = false; note.textContent = ""; paint(1); return; }
      var d = SOKO_DIRS[a]; if (!d || sliding) return;
      var r = iceSlide(S, p, d);
      if (r.to === p) { restartAnim(man, "is-bump"); return; }
      hist.push({ p: p, got: JSON.parse(JSON.stringify(got)) });
      r.path.forEach(function (i) { if (S.P.indexOf(i) >= 0) got[i] = 1; });
      var dist = r.path.length; p = r.to; moves++;
      sliding = true; c.later(function () { sliding = false; }, Math.max(90, dist * 55) - 10);
      paint(dist);
      if (p === S.G && count() === S.P.length) { note.textContent = "배송 완료!"; c.later(c.finish, Math.max(90, dist * 55) + 330); }
      else if (p === S.G) note.textContent = "하역 칸에 멈췄지만 택배를 아직 다 못 모았어요";
      else note.textContent = "";
    }
    bindPad(body, c, "data-ic", act);
    paint(1);
    return { hint: function () { return "방향키를 누르면 벽이나 바위에 부딪힐 때까지 쭉 미끄러져요. 노란 하역 칸에 정확히 멈추세요. 박스는 지나가기만 해도 실려요. Z로 되돌리고 R로 다시 시작해요."; } };
  }

  // ---------- 쌍둥이 배달 ----------
  function twinParse(rows) {
    var H = rows.length, W = 0, x, y;
    rows.forEach(function (r) { W = Math.max(W, r.length); });
    var wall = [], a = 0, b = 0, A = 0, B = 0;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var ch = rows[y].charAt(x) || " ", i = y * W + x;
      wall[i] = ch === "#"; if (ch === "a") a = i; if (ch === "b") b = i; if (ch === "A") A = i; if (ch === "B") B = i;
    }
    return { W: W, H: H, wall: wall, a: a, b: b, A: A, B: B };
  }
  function twinStep(S, p, dx, dy) {
    var x = p % S.W + dx, y = ((p / S.W) | 0) + dy;
    if (x < 0 || y < 0 || x >= S.W || y >= S.H || S.wall[y * S.W + x]) return p;
    return y * S.W + x;
  }
  function twinGame(body, c) {
    var pool = TWIN_POOL[c.level - 1] && TWIN_POOL[c.level - 1].length ? TWIN_POOL[c.level - 1] : TWIN_POOL[1];
    var plan = pool[rand(pool.length)], S = twinParse(plan.rows), W = S.W, mirror = !!plan.mirror;
    var a = S.a, b = S.b, hist = [], moves = 0;
    if (c.testHooks) body.setAttribute("data-plan", JSON.stringify({ rows: plan.rows, mirror: mirror }));
    var floor = gridCells(S, function (i) { return S.wall[i] ? "is-wall" : i === S.A ? "is-tgt tw-ga" : i === S.B ? "is-tgt tw-gb" : ""; });
    body.innerHTML = '<div class="sk-wrap"><div class="sk-board" style="--cols:' + W + ';--rows:' + S.H + '"><div class="sk-floor">' + floor + "</div>"
      + '<span class="sk-man tw-a">' + SK_MAN_SVG + '<b>A</b></span><span class="sk-man tw-b">' + SK_MAN_SVG + "<b>B</b></span></div></div>"
      + '<p class="sk-status"><span>움직임 <b class="tw-moves">0</b></span>' + (mirror ? "<span>B는 좌우가 반대로 움직여요</span>" : "") + "</p>"
      + '<p class="mg-freeze-note"></p><div class="pk-pad sk-pad">' + arrowPad("data-tw", actBtn("data-tw", "undo", "되돌리기", "Z · ⌫") + actBtn("data-tw", "restart", "처음부터", "R")) + "</div>";
    // 목표 칸에 글자 표시
    var cellEls = body.querySelectorAll(".sk-cell");
    cellEls[S.A].textContent = "A"; cellEls[S.B].textContent = "B";
    var ea = body.querySelector(".tw-a"), eb = body.querySelector(".tw-b"), movesEl = body.querySelector(".tw-moves"), note = body.querySelector(".mg-freeze-note");
    function paint() {
      placeAt(ea, a, W); placeAt(eb, b, W); movesEl.textContent = moves;
      ea.classList.toggle("is-home", a === S.A); eb.classList.toggle("is-home", b === S.B);
      if (c.testHooks) body.setAttribute("data-tw", [a % W, (a / W) | 0, b % W, (b / W) | 0, moves].join(","));
    }
    function act(x) {
      if (c.isFinished()) return;
      if (x === "undo") { if (!hist.length) return; var h = hist.pop(); a = h.a; b = h.b; moves--; note.textContent = ""; paint(); return; }
      if (x === "restart") { a = S.a; b = S.b; hist = []; moves = 0; note.textContent = ""; paint(); return; }
      var d = SOKO_DIRS[x]; if (!d) return;
      var na = twinStep(S, a, d[0], d[1]), nb = twinStep(S, b, mirror ? -d[0] : d[0], d[1]);
      if (na === a && nb === b) { restartAnim(ea, "is-bump"); restartAnim(eb, "is-bump"); return; }
      hist.push({ a: a, b: b }); a = na; b = nb; moves++; paint();
      if (a === S.A && b === S.B) { note.textContent = "둘 다 도착!"; c.later(c.finish, 420); }
      else note.textContent = "";
    }
    bindPad(body, c, "data-tw", act);
    paint();
    return { hint: function () { return "방향키 하나로 A와 B가 동시에 움직여요. 한쪽이 벽에 막혀도 다른 쪽은 움직여요! A는 A 칸에, B는 B 칸에 동시에 들어가면 끝나요." + (mirror ? " 이번 판은 B가 좌우만 반대로 움직여요." : "") + " Z로 되돌리고 R로 다시 시작해요."; } };
  }

  // ---------- 배달 경로 (한붓그리기) ----------
  var ROUTE_CFG = [
    { W: 4, H: 4, cut: 2 },
    { W: 5, H: 5, cut: 3 },
    { W: 6, H: 5, cut: 3 },
  ];
  // 직사각형 칸 전체를 한 번에 지나는 랜덤 한붓그리기 길(backbite 알고리즘)을 만든 뒤, 길의 앞뒤 몇 칸을 막아 구멍을 낸다.
  // 남은 칸을 전부 지나는 길이 항상 존재하고(= 항상 풀림), 길만 따라 걷는 외길이 아니라 갈림길이 많다.
  function makeRoutePlan(cfg) {
    var W = cfg.W, H = cfg.H, N = W * H, path = [], x, y, i;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) path.push(y * W + (y % 2 ? W - 1 - x : x)); // 뱀 모양에서 시작
    function nbrs(c) { var cx = c % W, cy = (c / W) | 0, o = []; if (cx > 0) o.push(c - 1); if (cx < W - 1) o.push(c + 1); if (cy > 0) o.push(c - W); if (cy < H - 1) o.push(c + W); return o; }
    for (i = 0; i < N * 30; i++) {
      var os = nbrs(path[0]).filter(function (n) { return n !== path[1]; });
      var n = os[rand(os.length)], j = path.indexOf(n);
      path = path.slice(0, j).reverse().concat(path.slice(j)); // path[0]과 n(=path[j])이 이웃이므로 앞부분을 뒤집어도 이어진다
      if (i % 2) path.reverse();
    }
    var front = rand(cfg.cut + 1), back = cfg.cut - front;
    var kept = path.slice(front, N - back), cells = [];
    for (i = 0; i < N; i++) cells.push("#");
    kept.forEach(function (q) { cells[q] = " "; });
    cells[kept[0]] = "S";
    var rows = []; for (y = 0; y < H; y++) rows.push(cells.slice(y * W, (y + 1) * W).join(""));
    var dirs = ""; for (i = 1; i < kept.length; i++) { var df = kept[i] - kept[i - 1]; dirs += df === 1 ? "R" : df === -1 ? "L" : df === W ? "D" : "U"; }
    return { rows: rows, solution: dirs };
  }
  function routeGame(body, c) {
    var plan = makeRoutePlan(ROUTE_CFG[c.level - 1]), W = plan.rows[0].length, H = plan.rows.length;
    var open = [], start = 0, i;
    for (i = 0; i < W * H; i++) { var ch = plan.rows[(i / W) | 0].charAt(i % W); if (ch !== "#") open.push(i); if (ch === "S") start = i; }
    var isOpen = {}; open.forEach(function (q) { isOpen[q] = 1; });
    var trail = [start], visited = {}; visited[start] = 1; var doomed = false;
    if (c.testHooks) body.setAttribute("data-plan", JSON.stringify({ rows: plan.rows, path: plan.solution }));
    var floor = ""; for (i = 0; i < W * H; i++) floor += '<i class="sk-cell ' + (isOpen[i] ? "is-road" : "is-wall") + '"></i>';
    body.innerHTML = '<div class="sk-wrap"><div class="sk-board rt-board" style="--cols:' + W + ';--rows:' + H + '"><div class="sk-floor">' + floor + '</div><svg class="rt-line" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none"><polyline points="" fill="none"/></svg><span class="sk-man rt-man">' + SK_MAN_SVG + "</span></div></div>"
      + '<p class="sk-status"><span>지나온 길 <b class="rt-n">1</b> / ' + open.length + '</span></p><p class="mg-freeze-note"></p>'
      + '<div class="pk-pad sk-pad">' + arrowPad("data-rt", actBtn("data-rt", "undo", "한 칸 되돌리기", "Z · ⌫") + actBtn("data-rt", "restart", "처음부터", "R")) + "</div>";
    var cellEls = body.querySelectorAll(".sk-cell"), man = body.querySelector(".rt-man"), line = body.querySelector(".rt-line polyline");
    var nEl = body.querySelector(".rt-n"), note = body.querySelector(".mg-freeze-note"), boardEl = body.querySelector(".sk-board");
    cellEls[start].classList.add("is-start");
    function reachableAll() { // 남은 칸을 전부 지나는 길이 아직 가능한가 (필요 조건 검사: 연결 + 막다른 칸은 최대 1개)
      var head = trail[trail.length - 1], seen = {}, q = [head], cnt = 0; seen[head] = 1;
      var around = function (cur) { var cx = cur % W, cy = (cur / W) | 0, o = [], dd = [[0, -1], [0, 1], [-1, 0], [1, 0]]; dd.forEach(function (d) { var nx = cx + d[0], ny = cy + d[1]; if (nx >= 0 && ny >= 0 && nx < W && ny < H) o.push(ny * W + nx); }); return o; };
      while (q.length) {
        var cur = q.pop();
        around(cur).forEach(function (ni) { if (!isOpen[ni] || visited[ni] || seen[ni]) return; seen[ni] = 1; cnt++; q.push(ni); });
      }
      var remain = open.length - trail.length;
      if (cnt !== remain) return false;
      var ends = 0;
      for (var u = 0; u < W * H; u++) {
        if (!isOpen[u] || visited[u]) continue;
        var deg = around(u).filter(function (ni) { return isOpen[ni] && (!visited[ni] || ni === head); }).length;
        if (deg === 0) return false;
        if (deg === 1) { ends++; if (ends > 1 && remain > 1) return false; }
      }
      return true;
    }
    function paint() {
      placeAt(man, trail[trail.length - 1], W);
      var inTrail = {}; trail.forEach(function (q) { inTrail[q] = 1; });
      for (var k = 0; k < W * H; k++) cellEls[k].classList.toggle("is-trail", !!inTrail[k]);
      line.setAttribute("points", trail.map(function (q) { return (q % W + 0.5) + "," + (((q / W) | 0) + 0.5); }).join(" "));
      nEl.textContent = trail.length;
      boardEl.classList.toggle("is-doomed", doomed);
      if (c.testHooks) body.setAttribute("data-rt", [trail[trail.length - 1] % W, (trail[trail.length - 1] / W) | 0, trail.length].join(","));
    }
    function act(a) {
      if (c.isFinished()) return;
      if (a === "undo") {
        if (trail.length < 2) return;
        var gone = trail.pop(); delete visited[gone];
        doomed = !reachableAll(); note.textContent = doomed ? "아직 막다른 길이에요 — 더 되돌려 보세요 (Z)" : ""; paint(); return;
      }
      if (a === "restart") { trail = [start]; visited = {}; visited[start] = 1; doomed = false; note.textContent = ""; paint(); return; }
      var d = SOKO_DIRS[a]; if (!d) return;
      var head = trail[trail.length - 1], nx = head % W + d[0], ny = ((head / W) | 0) + d[1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
      var ni = ny * W + nx;
      if (!isOpen[ni] || visited[ni]) { restartAnim(man, "is-bump"); return; }
      trail.push(ni); visited[ni] = 1;
      if (trail.length === open.length) { paint(); note.textContent = "모든 길을 지났어요!"; c.later(c.finish, 420); return; }
      var ok = reachableAll();
      if (!ok && !doomed) { c.addMistake(); note.textContent = "남은 길로 갈 수 없게 됐어요 — Z로 되돌려 보세요"; restartAnim(boardEl, "is-shake"); }
      else if (ok) note.textContent = "";
      doomed = !ok; paint();
    }
    bindPad(body, c, "data-rt", act);
    paint();
    return { hint: function () { return "창고(주황 칸)에서 출발해 방향키로 길을 따라가며 모든 길 칸을 한 번씩만 지나가세요. 한 번 지난 칸은 다시 못 가요. 막히면 Z로 한 칸씩 되돌리세요. 남은 길로 갈 수 없게 되면 알려줘요."; } };
  }

  // ---------- 컨베이어 잇기 (파이프) ----------
  var PIPE_CFG = [{ W: 4, H: 3 }, { W: 5, H: 4 }, { W: 6, H: 5 }];
  var PU = 1, PR = 2, PD = 4, PL = 8;
  function rotMask(m, n) { n = ((n % 4) + 4) % 4; while (n--) m = ((m << 1) | (m >> 3)) & 15; return m; }
  function makePipePlan(cfg) {
    var W = cfg.W, H = cfg.H;
    for (;;) {
      var r0 = rand(H), r1 = rand(H), path = [r0 * W], used = {}; used[r0 * W] = 1;
      var guard = 0, target = r1 * W + W - 1;
      // 입구(왼쪽 r0행) -> 출구(오른쪽 r1행): 자기 교차 없는 랜덤 길 (최대 시도 횟수 안에서)
      while (path[path.length - 1] !== target && guard++ < 400) {
        var cur = path[path.length - 1], cx = cur % W, cy = (cur / W) | 0, opts = [];
        [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(function (d) { var nx = cx + d[0], ny = cy + d[1]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && !used[ny * W + nx]) opts.push(ny * W + nx); });
        if (!opts.length) { used[path.pop()] = 2; if (!path.length) break; continue; }
        // 목표 쪽으로 약간 치우치게 고르되, 돌아가는 길도 섞는다
        var nxt = opts[rand(opts.length)]; used[nxt] = 1; path.push(nxt);
      }
      if (path[path.length - 1] !== target || path.length < W + 1) continue;
      var tiles = [], i;
      for (i = 0; i < W * H; i++) { var kinds = [5, 3, 3, 7]; tiles.push({ mask: kinds[rand(4)], goal: -1 }); }
      path.forEach(function (q, k) {
        var inD = k === 0 ? PL : (q - path[k - 1] === 1 ? PL : q - path[k - 1] === -1 ? PR : q - path[k - 1] === W ? PU : PD);
        var outD = k === path.length - 1 ? PR : (path[k + 1] - q === 1 ? PR : path[k + 1] - q === -1 ? PL : path[k + 1] - q === W ? PD : PU);
        var need = inD | outD, base = (need === 5 || need === 10) ? 5 : 3, n;
        tiles[q].mask = base; tiles[q].goal = -1;
        for (n = 0; n < 4; n++) if (rotMask(base, n) === need) tiles[q].goal = n;
      });
      // 시작 회전은 전부 무작위 (정답 회전이 우연히 이어져 있으면 다시 섞는다)
      for (var tries = 0; tries < 30; tries++) {
        tiles.forEach(function (t) { t.rot = rand(4); });
        if (!pipeFlow(W, H, r0, r1, tiles).ok) return { W: W, H: H, r0: r0, r1: r1, tiles: tiles, path: path };
      }
    }
  }
  function pipeFlow(W, H, r0, r1, tiles) { // 입구에서 막힘 없이 이어지는 칸 집합 + 출구 도달 여부
    var seen = {}, q = [], ok = false;
    var m0 = rotMask(tiles[r0 * W].mask, tiles[r0 * W].rot);
    if (m0 & PL) { seen[r0 * W] = 1; q.push(r0 * W); }
    while (q.length) {
      var cur = q.pop(), cx = cur % W, cy = (cur / W) | 0, m = rotMask(tiles[cur].mask, tiles[cur].rot);
      if (cur === r1 * W + W - 1 && (m & PR)) ok = true;
      [[PU, 0, -1, PD], [PR, 1, 0, PL], [PD, 0, 1, PU], [PL, -1, 0, PR]].forEach(function (d) {
        if (!(m & d[0])) return;
        var nx = cx + d[1], ny = cy + d[2]; if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
        var ni = ny * W + nx; if (seen[ni]) return;
        if (rotMask(tiles[ni].mask, tiles[ni].rot) & d[3]) { seen[ni] = 1; q.push(ni); }
      });
    }
    return { ok: ok, flow: seen };
  }
  function pipeSvg(mask) { // 칸 안에 열린 쪽으로 관을 그린다
    var s = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="6" class="pp-hub"/>';
    if (mask & PU) s += '<rect x="14" y="0" width="12" height="22" class="pp-arm"/>';
    if (mask & PR) s += '<rect x="18" y="14" width="22" height="12" class="pp-arm"/>';
    if (mask & PD) s += '<rect x="14" y="18" width="12" height="22" class="pp-arm"/>';
    if (mask & PL) s += '<rect x="0" y="14" width="22" height="12" class="pp-arm"/>';
    return s + "</svg>";
  }
  function pipeGame(body, c) {
    var plan = makePipePlan(PIPE_CFG[c.level - 1]), W = plan.W, H = plan.H, tiles = plan.tiles, cx = 0, cy = plan.r0, hist = [];
    if (c.testHooks) body.setAttribute("data-plan", JSON.stringify({ W: W, H: H, src: plan.r0, snk: plan.r1, presses: tiles.map(function (t) { return t.goal < 0 ? 0 : ((t.goal - t.rot) % 4 + 4) % 4; }) }));
    var cellsHtml = tiles.map(function () { return '<button type="button" class="pp-tile" tabindex="-1"></button>'; }).join("");
    body.innerHTML = '<div class="pp-wrap"><div class="pp-in" style="--r:' + plan.r0 + ';--rows:' + H + '">입구 ▶</div><div class="pp-board" style="--cols:' + W + ';--rows:' + H + '">' + cellsHtml + '</div><div class="pp-out" style="--r:' + plan.r1 + ';--rows:' + H + '">▶ 출구</div></div>'
      + '<p class="mg-freeze-note"></p><div class="pk-pad sk-pad">' + arrowPad("data-pp", actBtn("data-pp", "space", "돌리기", "SPACE") + actBtn("data-pp", "undo", "되돌리기", "Z · ⌫")) + "</div>";
    var tileEls = Array.prototype.slice.call(body.querySelectorAll(".pp-tile")), note = body.querySelector(".mg-freeze-note");
    function paint() {
      var f = pipeFlow(W, H, plan.r0, plan.r1, tiles);
      tileEls.forEach(function (e, i) {
        e.innerHTML = pipeSvg(rotMask(tiles[i].mask, tiles[i].rot));
        e.classList.toggle("is-flow", !!f.flow[i]); e.classList.toggle("is-cursor", i === cy * W + cx);
      });
      if (c.testHooks) body.setAttribute("data-pp", [cx, cy, Object.keys(f.flow).length, hist.length].join(","));
      return f;
    }
    function act(a) {
      if (c.isFinished()) return;
      if (a === "left") cx = clamp(cx - 1, 0, W - 1); else if (a === "right") cx = clamp(cx + 1, 0, W - 1);
      else if (a === "up") cy = clamp(cy - 1, 0, H - 1); else if (a === "down") cy = clamp(cy + 1, 0, H - 1);
      else if (a === "space" || a === "enter") {
        var i = cy * W + cx; tiles[i].rot = (tiles[i].rot + 1) % 4; hist.push(i);
        var f = paint(); if (f.ok) { note.textContent = "컨베이어가 이어졌어요!"; c.later(c.finish, 450); }
        return;
      } else if (a === "undo") { if (!hist.length) return; var j = hist.pop(); tiles[j].rot = (tiles[j].rot + 3) % 4; cx = j % W; cy = (j / W) | 0; }
      else return;
      paint();
    }
    bindPad(body, c, "data-pp", act);
    Array.prototype.forEach.call(tileEls, function (e, i) { e.addEventListener("pointerdown", function (ev) { ev.preventDefault(); cx = i % W; cy = (i / W) | 0; act("space"); }); });
    paint();
    return { hint: function () { return "방향키로 타일을 고르고 스페이스로 돌려서, 왼쪽 입구에서 오른쪽 출구까지 컨베이어를 이으세요. 이어진 칸은 파랗게 켜져요. Z로 되돌려요. (타일을 눌러도 돌아가요)"; } };
  }

  // ---------- 택배 쌓기 (하노이) ----------
  var HANOI_N = [3, 4, 5];
  function hanoiGame(body, c) {
    var n = HANOI_N[c.level - 1], pegs = [[], [], []], cur = 0, held = null, from = -1, hist = [], moves = 0, i;
    for (i = n; i >= 1; i--) pegs[0].push(i);
    function optimal() { var out = []; (function mv(k, a, b, via) { if (!k) return; mv(k - 1, a, via, b); out.push([a, b]); mv(k - 1, via, b, a); })(n, 0, 2, 1); return out; }
    if (c.testHooks) body.setAttribute("data-plan", JSON.stringify({ n: n, solution: optimal() }));
    body.innerHTML = '<div class="hn-board">' + [0, 1, 2].map(function (p) { return '<div class="hn-peg" data-peg="' + p + '"><div class="hn-pole"></div><div class="hn-stack"></div></div>'; }).join("") + '</div>'
      + '<div class="hn-hand"></div><p class="sk-status"><span>움직임 <b class="hn-moves">0</b></span></p><p class="mg-freeze-note"></p>'
      + '<div class="pk-pad sk-pad">' + '<button type="button" class="mg-key" data-hn="left" aria-label="왼쪽">←</button><button type="button" class="mg-key" data-hn="right" aria-label="오른쪽">→</button>'
      + actBtn("data-hn", "space", "집기 / 놓기", "SPACE") + actBtn("data-hn", "undo", "되돌리기", "Z · ⌫") + "</div>";
    var pegEls = Array.prototype.slice.call(body.querySelectorAll(".hn-peg")), handEl = body.querySelector(".hn-hand"), movesEl = body.querySelector(".hn-moves"), note = body.querySelector(".mg-freeze-note");
    function boxHtml(sz) { return '<div class="hn-box" style="--w:' + (28 + sz * 14) + '%;--k:' + sz + '"><i></i></div>'; }
    function paint() {
      pegEls.forEach(function (e, p) {
        e.classList.toggle("is-cursor", p === cur);
        e.querySelector(".hn-stack").innerHTML = pegs[p].map(boxHtml).join("");
      });
      handEl.innerHTML = held ? '<div class="hn-held" style="--p:' + cur + '">' + boxHtml(held) + "</div>" : "";
      movesEl.textContent = moves;
      if (c.testHooks) body.setAttribute("data-hn", [cur, held || 0, moves].join(","));
    }
    function act(a) {
      if (c.isFinished()) return;
      if (a === "left") cur = clamp(cur - 1, 0, 2);
      else if (a === "right") cur = clamp(cur + 1, 0, 2);
      else if (a === "1" || a === "2" || a === "3") cur = parseInt(a, 10) - 1;
      else if (a === "up") { /* 집기 */ if (!held && pegs[cur].length) { held = pegs[cur].pop(); from = cur; } }
      else if (a === "down") { if (held) a = "space"; }
      if (a === "space" || a === "enter") {
        if (!held) { if (pegs[cur].length) { held = pegs[cur].pop(); from = cur; } }
        else {
          var top = pegs[cur].length ? pegs[cur][pegs[cur].length - 1] : 99;
          if (held > top) { c.addMistake(); note.textContent = "큰 상자를 작은 상자 위에 놓을 수 없어요"; restartAnim(pegEls[cur], "is-shake"); c.later(function () { note.textContent = ""; }, 1100); return paint(); }
          pegs[cur].push(held); held = null; note.textContent = "";
          if (cur !== from) { hist.push([from, cur]); moves++; }
          from = -1;
          if (pegs[2].length === n) { paint(); note.textContent = "탑을 다 옮겼어요!"; c.later(c.finish, 420); return; }
        }
      } else if (a === "undo") {
        if (held) { pegs[from].push(held); held = null; from = -1; }
        else if (hist.length) { var m = hist.pop(); pegs[m[0]].push(pegs[m[1]].pop()); moves--; }
        note.textContent = "";
      } else if (a === "restart") {
        pegs = [[], [], []]; for (var k = n; k >= 1; k--) pegs[0].push(k); held = null; from = -1; hist = []; moves = 0; cur = 0; note.textContent = "";
      }
      paint();
    }
    bindPad(body, c, "data-hn", act, { "1": "1", "2": "2", "3": "3" });
    paint();
    return { hint: function () { return "맨 왼쪽 탑을 맨 오른쪽 칸으로 옮기세요. ←→로 칸을 고르고 스페이스로 맨 위 상자를 집고, 다른 칸에서 스페이스로 놓아요. 큰 상자를 작은 상자 위에 놓으면 실수! (1·2·3 키로 칸 바로 선택, Z 되돌리기, R 처음부터)"; } };
  }

  var GAMES = { pack: packGame, inspect: inspectGame, sticker: stickerGame, map: mapGame, soko: sokoGame, ice: iceGame, route: routeGame, twin: twinGame, pipe: pipeGame, hanoi: hanoiGame };

  // ======================================================================
  // 공통 진행: 헤더(제목/시간/실수/포기), 타이머, 완료 배너, 정리
  // ======================================================================
  function start(host, opts) {
    opts = opts || {};
    var kind = GAMES[opts.kind] ? opts.kind : "pack";
    var level = clamp(parseInt(opts.level, 10) || 1, 1, 3);

    var rootEl = el("div", "mg-root mg-kind-" + kind);
    rootEl.innerHTML =
      '<header class="mg-head"><div class="mg-title"><span class="mg-name">' + KINDS[kind].name + '</span>'
      + '<span class="mg-level">난이도 ' + LEVEL_NAME[level - 1] + '</span></div>'
      + '<div class="mg-stats"><span class="mg-time">0.0초</span><span class="mg-miss">실수 0</span></div>'
      + '<button type="button" class="mg-giveup">포기</button></header>'
      + '<div class="mg-body"></div><p class="mg-hint"></p>'
      + '<div class="mg-done"><b>완료!</b></div>';
    host.innerHTML = "";
    host.appendChild(rootEl);
    var body = rootEl.querySelector(".mg-body");
    var doneEl = rootEl.querySelector(".mg-done");
    var timeEl = rootEl.querySelector(".mg-time");
    var missEl = rootEl.querySelector(".mg-miss");

    var t0 = performance.now(), mistakes = 0, finished = false, destroyed = false;
    var timers = [], cleanups = [];
    var tick = setInterval(function () { if (!finished) timeEl.textContent = fmtSec(performance.now() - t0); }, 100);

    var ctx = {
      level: level, label: opts.label, testHooks: !!opts.testHooks, opts: opts,
      isFinished: function () { return finished || destroyed; },
      later: function (fn, ms) {
        var id = setTimeout(function () { if (!destroyed) fn(); }, ms);
        timers.push(id);
        return id;
      },
      onCleanup: function (fn) { cleanups.push(fn); },
      addMistake: function () {
        mistakes++;
        missEl.textContent = "실수 " + mistakes;
        missEl.classList.add("has-miss");
      },
      finish: function () {
        if (finished || destroyed) return;
        finished = true;
        var ms = Math.round(performance.now() - t0);
        timeEl.textContent = fmtSec(ms);
        doneEl.querySelector("b").textContent = "완료! " + fmtSec(ms);
        doneEl.classList.add("is-on");
        ctx.later(function () {
          if (opts.onDone) opts.onDone({ ok: true, kind: kind, level: level, ms: ms, mistakes: mistakes });
        }, 700);
      },
    };

    var game = GAMES[kind](body, ctx);
    rootEl.querySelector(".mg-hint").textContent = game.hint();
    rootEl.querySelector(".mg-giveup").addEventListener("click", function () {
      if (finished || destroyed) return;
      if (opts.onCancel) opts.onCancel();
    });

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(tick);
      timers.forEach(clearTimeout);
      cleanups.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
      if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    }
    return { destroy: destroy, root: rootEl };
  }

  root.MiniGames = {
    start: start,
    KINDS: KINDS,
    LEVEL_NAME: LEVEL_NAME,
    MAP_REPLAY_AFTER_MS: MAP_REPLAY_AFTER_MS,
    setMistakeRule: function (rule) { if (rule === "reset" || rule === "freeze" || rule === "ignore") config.mistakeRule = rule; },
    getMistakeRule: function () { return config.mistakeRule; },
  };
})(typeof window !== "undefined" ? window : this);
