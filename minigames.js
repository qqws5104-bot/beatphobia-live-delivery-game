/* minigames.js -- 택배 확보 미니게임 3종 (박스 포장 / 이상 확인 / 송장 붙이기)
 *
 * 바닐라 JS, 의존성 없음. 게임 본체(build_client.py)에 그대로 인라인하거나, 단독 시험장 페이지에서
 * 똑같이 쓸 수 있게 만들었다.
 *
 *   var ctl = MiniGames.start(hostElement, {
 *     kind: "pack" | "inspect" | "sticker",
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
  // 박스 포장 -- 화면에 뜬 방향키 순서대로 누르고, 마지막은 스페이스바(테이프)
  // ======================================================================
  var PACK_LEN = [4, 6, 8]; // 방향키 개수 (+ 마지막 스페이스)
  var DIRS = ["up", "down", "left", "right"];
  var GLYPH = { up: "↑", down: "↓", left: "←", right: "→" };

  function packGame(body, c) {
    var len = PACK_LEN[c.level - 1];
    var seq = [];
    while (seq.length < len) {
      var d = DIRS[rand(4)], n = seq.length;
      if (n >= 2 && seq[n - 1] === d && seq[n - 2] === d) continue; // 같은 키 3연속은 지루하니 제외
      seq.push(d);
    }
    body.setAttribute("data-seq", seq.join(","));

    var chipsHtml = seq.map(function (d) { return '<span class="mg-chip" data-k="' + d + '">' + GLYPH[d] + "</span>"; }).join("")
      + '<span class="mg-chip is-space" data-k="space">SPACE</span>';
    body.innerHTML =
      '<div class="mg-pack-stage"><div class="mg-box">'
      + '<div class="mg-box-inner"></div>'
      + '<div class="mg-flap mg-flap-up" data-flap="up"></div><div class="mg-flap mg-flap-down" data-flap="down"></div>'
      + '<div class="mg-flap mg-flap-left" data-flap="left"></div><div class="mg-flap mg-flap-right" data-flap="right"></div>'
      + '<div class="mg-tape">TAPE</div></div></div>'
      + '<p class="mg-freeze-note"></p>'
      + '<div class="mg-seq">' + chipsHtml + "</div>"
      + '<div class="mg-pad">'
      + '<button type="button" class="mg-key" data-k="up" aria-label="위">↑</button>'
      + '<button type="button" class="mg-key" data-k="left" aria-label="왼쪽">←</button>'
      + '<button type="button" class="mg-key" data-k="down" aria-label="아래">↓</button>'
      + '<button type="button" class="mg-key" data-k="right" aria-label="오른쪽">→</button>'
      + '<button type="button" class="mg-key" data-k="space" aria-label="스페이스">SPACE · 테이프</button>'
      + "</div>";

    var box = body.querySelector(".mg-box");
    var tape = body.querySelector(".mg-tape");
    var note = body.querySelector(".mg-freeze-note");
    var chips = Array.prototype.slice.call(body.querySelectorAll(".mg-chip"));
    var flaps = {};
    Array.prototype.forEach.call(body.querySelectorAll(".mg-flap"), function (f) { flaps[f.getAttribute("data-flap")] = f; });
    var idx = 0, locked = false;

    function paint() {
      chips.forEach(function (ch, i) {
        ch.classList.toggle("is-done", i < idx);
        ch.classList.toggle("is-current", i === idx);
        ch.classList.remove("is-bad");
      });
    }
    function reopenAll() {
      Object.keys(flaps).forEach(function (k) { flaps[k].classList.remove("is-closed"); });
      tape.classList.remove("is-on");
    }

    function press(k) {
      if (locked || c.isFinished()) return;
      var want = idx < len ? seq[idx] : "space";
      if (k === want) {
        if (idx < len) {
          flaps[k].classList.add("is-closed");
          restartAnim(flaps[k], "is-pop");
        } else {
          // 테이프를 붙이는 순간 아직 열려 있던 덮개도 같이 닫혀야 "봉해진 상자"로 보인다
          Object.keys(flaps).forEach(function (k) { flaps[k].classList.add("is-closed"); });
          tape.classList.add("is-on");
        }
        idx++;
        paint();
        if (idx === len + 1) c.later(c.finish, 280);
        return;
      }
      // ---- 오입력 ----
      c.addMistake();
      restartAnim(box, "is-shake");
      var cur = chips[idx]; if (cur) { cur.classList.add("is-bad"); }
      var rule = config.mistakeRule;
      if (rule === "reset") {
        idx = 0;
        reopenAll();
        note.textContent = "틀렸어요 — 처음부터!";
        c.later(function () { note.textContent = ""; }, 900);
        c.later(paint, 160);
      } else if (rule === "freeze") {
        locked = true;
        note.textContent = "잠깐 멈춤 (0.5초)";
        c.later(function () { locked = false; note.textContent = ""; paint(); }, 500);
      } else { // ignore
        c.later(paint, 160);
      }
    }

    function onKey(e) {
      if (e.repeat || c.isFinished()) return;
      var k = null;
      if (e.key === "ArrowUp") k = "up";
      else if (e.key === "ArrowDown") k = "down";
      else if (e.key === "ArrowLeft") k = "left";
      else if (e.key === "ArrowRight") k = "right";
      else if (e.code === "Space" || e.key === " ") k = "space";
      if (!k) return;
      e.preventDefault();
      e.stopPropagation(); // 게임 본체의 전역 스페이스바/방향키 핸들러가 이 키를 따로 처리하지 않게 막는다
      press(k);
    }
    document.addEventListener("keydown", onKey, true);
    c.onCleanup(function () { document.removeEventListener("keydown", onKey, true); });

    Array.prototype.forEach.call(body.querySelectorAll(".mg-key"), function (b) {
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); press(b.getAttribute("data-k")); });
    });
    paint();
    return {
      hint: function () {
        var r = config.mistakeRule;
        return "화면에 뜬 순서대로 방향키를 누르고, 마지막은 스페이스바로 테이프를 붙이세요. "
          + (r === "reset" ? "한 번 틀리면 처음부터 다시 해야 해요." : r === "freeze" ? "틀리면 0.5초 멈춰요." : "틀린 키는 무시돼요.");
      },
    };
  }

  // ======================================================================
  // 이상 확인 (택배 검수) -- 벨트로 들어오는 택배를 종류에 맞는 칸으로 보내고, 이상한 건 폐기
  //   ← 일반   ↓ 깨지기   → 귀중품   SPACE 이상 폐기(찌그러지거나 갈라진 택배)
  // 2026-10-06: 처음엔 "여러 상자 중 불량 찾기" 격자였는데, 사용자가 레퍼런스(빵공장 아르바이트 영상)를
  // 주면서 "각자 맞는 분류로 누르고 이상한 택배는 지우는 느낌"으로 바꾸라고 해서 벨트 방식으로 다시 만들었다.
  // 분류 3종은 게임의 실제 카테고리(일반/깨지기/귀중품)와 같은 색을 쓴다.
  // 내부 kind 키는 그대로 "inspect" (game-data.js의 TYPES.mini와 시험장이 이 이름을 쓴다).
  // ======================================================================
  var INSPECT_CFG = [
    { n: 6,  bad: 1, crack: 3.4, dent: 0.42, decoy: 0 },
    { n: 8,  bad: 2, crack: 2.4, dent: 0.30, decoy: 0.3 },
    { n: 10, bad: 3, crack: 1.7, dent: 0.20, decoy: 0.4 },
  ];
  var CLASSES = [
    { key: "left",  name: "일반",   tag: "일반",   color: "#C9A576", light: "#ddc08f", keyGlyph: "←" },
    { key: "down",  name: "깨지기", tag: "깨짐주의", color: "#C7E29A", light: "#dcefb8", keyGlyph: "↓" },
    { key: "right", name: "귀중품", tag: "귀중품", color: "#F0B84A", light: "#f7d37e", keyGlyph: "→" },
  ];
  var ACT_CLASS = { left: 0, down: 1, right: 2 };

  // 택배 하나를 그린다: 종류별 색/테이프(일반=베이지, 깨지기=빨강 줄무늬, 귀중품=금색 리본) + 이름표.
  // 이상 택배는 같은 종류 그림 위에 균열과 찌그러진 모서리를 얹는다(난이도가 오를수록 균열이 얇아진다).
  function pkgSvg(clsIdx, isBad, cfg) {
    var C = CLASSES[clsIdx];
    var tapeX = 22 + rand(40);
    var s = '<svg viewBox="0 0 100 100" aria-hidden="true">'
      + '<ellipse cx="50" cy="90" rx="36" ry="5" fill="rgba(43,29,18,.2)"/>'
      + '<rect x="12" y="26" width="76" height="60" rx="3" fill="' + C.color + '" stroke="#6b4e26" stroke-width="1.8"/>'
      + '<rect x="12" y="26" width="76" height="13" rx="3" fill="' + C.light + '" stroke="#6b4e26" stroke-width="1.8"/>';
    if (clsIdx === 0) {
      s += '<rect x="' + tapeX + '" y="26" width="13" height="30" fill="#ead8b0" opacity=".95"/>';
    } else if (clsIdx === 1) {
      s += '<rect x="' + tapeX + '" y="26" width="13" height="30" fill="#d6452f"/>'
        + '<path d="M' + tapeX + ' 34l13-6M' + tapeX + ' 42l13-6M' + tapeX + ' 50l13-6" stroke="#fff" stroke-width="2.4"/>';
    } else {
      s += '<rect x="45" y="26" width="10" height="60" fill="#b8841f"/><rect x="12" y="52" width="76" height="9" fill="#b8841f"/>'
        + '<circle cx="50" cy="56" r="6.5" fill="#e0a82e" stroke="#8a5f12" stroke-width="1.4"/>';
    }
    s += '<rect x="22" y="68" width="56" height="15" rx="2.5" fill="#fffcf4" stroke="#6b4e26" stroke-width="1.2"/>'
      + '<text x="50" y="79.5" text-anchor="middle" font-size="11" font-weight="800" fill="#2b1d12">' + C.tag + '</text>';
    if (isBad) {
      var cx = 24 + rand(50), corner = rand(4);
      s += '<path d="M' + cx + ' 26 l5 10 l-8 9 l7 10 l-5 8" stroke="#3b210a" stroke-width="' + cfg.crack + '" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
      var dent = ["12,26 34,26 12,48", "88,26 66,26 88,48", "12,86 34,86 12,64", "88,86 66,86 88,64"][corner];
      s += '<polygon points="' + dent + '" fill="rgba(60,25,10,' + cfg.dent + ')"/>';
    } else if (cfg.decoy && Math.random() < cfg.decoy) {
      // 멀쩡한 택배에도 가벼운 스크래치를 넣어서 "선이 보이면 폐기"로 찍지 못하게 한다
      var sy = 46 + rand(16), sx = 18 + rand(46);
      s += '<path d="M' + sx + ' ' + sy + 'h' + (7 + rand(8)) + '" stroke="rgba(60,33,10,.36)" stroke-width="1.1" stroke-linecap="round" fill="none"/>';
    }
    return s + "</svg>";
  }

  var INSPECT_LOCK_MS = 450; // 틀린 키 뒤 잠깐 멈춤 -- 아무 키나 연타해서 4분의 1 확률로 뚫는 걸 막는다

  function inspectGame(body, c) {
    var cfg = INSPECT_CFG[c.level - 1];
    var badAt = {};
    shuffle(Array.apply(null, { length: cfg.n }).map(function (_, i) { return i; })).slice(0, cfg.bad).forEach(function (i) { badAt[i] = true; });
    var items = [];
    for (var i = 0; i < cfg.n; i++) items.push({ cls: rand(3), bad: !!badAt[i] });
    var expected = items.map(function (it) { return it.bad ? "space" : CLASSES[it.cls].key; });
    if (c.testHooks) body.setAttribute("data-seq", expected.join(","));

    var binsHtml = CLASSES.map(function (k) {
      return '<button type="button" class="mg-bin" data-a="' + k.key + '" style="--bin:' + k.color + '" aria-label="' + k.name + '">'
        + '<span class="mg-bin-k">' + k.keyGlyph + '</span><span class="mg-bin-n">' + k.name + '</span></button>';
    }).join("");
    body.innerHTML = '<div class="mg-belt"><div class="mg-gate" aria-hidden="true"><span>검수대</span></div><div class="mg-queue"></div></div>'
      + '<p class="mg-progress">처리 <em class="mg-found">0</em> / ' + cfg.n + '개</p>'
      + '<p class="mg-freeze-note"></p>'
      + '<div class="mg-bins">' + binsHtml + '</div>'
      + '<button type="button" class="mg-bin mg-discard" data-a="space" aria-label="이상 폐기"><span class="mg-bin-k">SPACE</span><span class="mg-bin-n">이상한 택배 폐기</span></button>';

    var queue = body.querySelector(".mg-queue");
    var doneEl = body.querySelector(".mg-found");
    var note = body.querySelector(".mg-freeze-note");
    var els = items.map(function (it, i) {
      var d = el("div", "mg-pkg", pkgSvg(it.cls, it.bad, cfg));
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
      note.textContent = items[idx].bad && a !== "space" ? "이상한 택배예요 — 폐기!" : (a === "space" ? "멀쩡한 택배예요" : "다른 칸이에요");
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
    return { hint: function () { return "검수대에 온 택배를 종류에 맞는 칸으로 보내세요 (← 일반 · ↓ 깨지기 · → 귀중품). 찌그러지거나 갈라진 택배는 스페이스로 폐기! 틀리면 잠깐 멈춰요."; } };
  }

  // ======================================================================
  // 송장 붙이기 -- 송장에 적힌 배송코드와 같은 코드가 적힌 박스를 찾아 붙이기
  // ======================================================================
  // (2026-10-06 개편) 예전엔 점선 칸에 송장을 끌어다 놓는 단순 조준이라 너무 쉬웠다. 지금은 "읽고 찾는" 게임:
  // 박스 여러 개가 작업대에 놓여 있고, 송장은 한 장씩 나온다. 송장의 배송코드(예: 1F-07)와 같은 코드가 적힌
  // 박스에만 붙는다. 틀린 박스에 놓으면 실수 +1, 송장은 트레이로 돌아간다. 조준 자체는 관대하다(송장의
  // 중심이 박스 위에 있으면 그 박스로 판정) -- 어려움은 손기술이 아니라 코드를 읽고 비교하는 데서 온다.
  // 배송코드는 이 미니게임 안에서만 쓰는 값이다: 실제 송장 호수는 확보 순간 서버가 정하므로 여기서 호수를
  // 흉내 내지 않는다(그래서 "1F-07" 같은 호수와 다른 모양의 코드). 코드의 층 부분만 그 칸의 층과 맞춘다.
  var STK_BOXES  = [4, 5, 6];   // 레벨별 박스 수
  var STK_LABELS = [2, 3, 4];   // 레벨별 송장 장수 (붙일 박스 수)
  var STK_FLOORS = ["B1", "1F", "2F", "3F", "4F", "5F"];
  var LW = 19, LH = 20.5;       // 송장 크기 (스테이지 대비 %, 스테이지 520:320)
  var TRAY_X = (100 - LW) / 2, TRAY_Y = 76;

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // 레벨별로 박스에 적을 배송코드 목록과, 송장이 나올 박스 순서를 만든다.
  //   L1: 틀린 박스는 층이 다른 코드(눈에 띄게 다름)
  //   L2: 같은 층 코드가 섞이고, 층만 다르고 번호가 같은 함정(2F-07 vs 1F-07)이 하나
  //   L3: 전부 같은 층, 번호가 한 글자만 다르거나(07/17) 자리만 바뀐(07/70) 함정
  function makeStickerPlan(level, floor, n, k) {
    for (var attempt = 0; attempt < 50; attempt++) {
      var used = {}, nums = [], codes = [];
      function code(f, nn) { return f + "-" + pad2(nn); }
      function add(f, nn) { var cd = code(f, nn); if (used[cd] || nn < 1 || nn > 99) return false; used[cd] = 1; codes.push({ code: cd, f: f, nn: nn }); return true; }
      var others = STK_FLOORS.filter(function (x) { return x !== floor; });
      var targets = [];
      while (targets.length < k) {
        var nn = 1 + rand(99);
        if (add(floor, nn)) targets.push(nn);
      }
      var guard = 0;
      while (codes.length < n && guard++ < 200) {
        var t = targets[rand(k)], tens = Math.floor(t / 10), ones = t % 10;
        var d = codes.length - k; // 몇 번째 틀린 박스인가
        if (level === 1) {
          add(others[rand(others.length)], 1 + rand(99));
        } else if (level === 2) {
          if (d === 0) add(others[rand(others.length)], t);                       // 층만 다른 함정
          else if (d === 1) add(floor, 1 + rand(99));                              // 같은 층 다른 번호
          else add(others[rand(others.length)], 1 + rand(99));
        } else {
          var kind = d % 3;
          if (kind === 0) add(floor, tens * 10 + ((ones + 1 + rand(8)) % 10));    // 일의 자리만 다름
          else if (kind === 1) add(floor, ((tens + 1 + rand(8)) % 10) * 10 + ones); // 십의 자리만 다름
          else if (tens !== ones) add(floor, ones * 10 + tens);                    // 자리 바꿈(07 -> 70)
          else add(others[rand(others.length)], t);
        }
      }
      if (codes.length < n) continue;
      // 목표 코드는 앞 k개. 위치는 섞는다.
      var order = shuffle(codes.map(function (_, i) { return i; }));
      var boxes = order.map(function (i) { return codes[i].code; });
      var seq = shuffle(codes.slice(0, k).map(function (x) { return x.code; }));
      return { boxes: boxes, seq: seq };
    }
    throw new Error("sticker plan failed");
  }

  function stickerGame(body, c) {
    var n = STK_BOXES[c.level - 1], k = STK_LABELS[c.level - 1];
    var floor = STK_FLOORS.indexOf(c.label) >= 0 ? c.label : STK_FLOORS[rand(STK_FLOORS.length)];
    var plan = makeStickerPlan(c.level, floor, n, k);

    var boxHtml = plan.boxes.map(function (cd) {
      return '<div class="mg-bx"><div class="bx-top"></div><div class="bx-front">'
        + '<div class="bx-addr"><i>받는 곳</i><b>' + cd + '</b></div><div class="bx-slot"></div></div>'
        + '<div class="bx-tape"></div><span class="bx-ok" aria-hidden="true">✓</span></div>';
    }).join("");
    body.innerHTML = '<div class="mg-stage" data-total="' + k + '"><div class="mg-bxs">' + boxHtml + '</div>'
      + '<div class="mg-tray"><span class="mg-tray-note"></span></div></div>';
    var stage = body.querySelector(".mg-stage");
    var boxes = Array.prototype.slice.call(body.querySelectorAll(".mg-bx"));
    var note = body.querySelector(".mg-tray-note");
    var placed = 0, current = null, dragging = false, grabDX = 0, grabDY = 0;

    function boxCode(b) { return b.querySelector(".bx-addr b").textContent; }
    // 송장 중심이 놓인 박스(이미 붙인 박스는 제외). 없으면 null.
    function boxUnder(lb) {
      var r = lb.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].classList.contains("is-done")) continue;
        var b = boxes[i].getBoundingClientRect();
        if (cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom) return boxes[i];
      }
      return null;
    }
    function setHover(b) { boxes.forEach(function (x) { x.classList.toggle("is-hover", x === b); }); }

    function spawnLabel() {
      var code = plan.seq[placed];
      note.textContent = "남은 송장 " + (k - placed) + "장";
      var lb = el("div", "mg-label",
        '<div class="lb-bar"><span>송장</span></div><div class="lb-main"><i>배송코드</i><b class="lb-room">' + code + '</b></div><div class="lb-code"></div>');
      lb.style.width = LW + "%"; lb.style.height = LH + "%";
      lb.style.left = TRAY_X + "%"; lb.style.top = TRAY_Y + "%";
      lb.setAttribute("data-label", "1");
      stage.appendChild(lb);
      current = lb;
      lb.addEventListener("pointerdown", function (e) {
        if (c.isFinished() || lb !== current) return;
        e.preventDefault();
        lb.setPointerCapture(e.pointerId);
        var lr = lb.getBoundingClientRect();
        grabDX = e.clientX - lr.left; grabDY = e.clientY - lr.top;
        dragging = true;
        lb.classList.remove("is-return");
        lb.classList.add("is-drag");
      });
      lb.addEventListener("pointermove", function (e) {
        if (!dragging || lb !== current) return;
        var r = stage.getBoundingClientRect();
        lb.style.left = clamp((e.clientX - grabDX - r.left) / r.width * 100, -4, 104 - LW) + "%";
        lb.style.top = clamp((e.clientY - grabDY - r.top) / r.height * 100, -4, 104 - LH) + "%";
        setHover(boxUnder(lb));
      });
      function drop() {
        if (!dragging || lb !== current) return;
        dragging = false;
        lb.classList.remove("is-drag");
        var b = boxUnder(lb);
        setHover(null);
        if (b && boxCode(b) === code) { stick(lb, b); return; }
        if (b) { c.addMistake(); restartAnim(b, "is-wrong"); } // 틀린 박스에 붙이려 함. 빈 곳에 놓은 건 실수 아님
        lb.classList.add("is-return");
        lb.style.left = TRAY_X + "%"; lb.style.top = TRAY_Y + "%";
      }
      lb.addEventListener("pointerup", drop);
      lb.addEventListener("pointercancel", drop);
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
      if (placed === k) { note.textContent = "모두 붙였어요"; c.later(c.finish, 320); }
      else { c.later(spawnLabel, 300); }
    }

    spawnLabel();
    return { hint: function () { return "송장의 배송코드와 같은 코드가 적힌 박스에 송장을 붙이세요 (" + k + "장). 코드를 잘 읽어요 -- 비슷한 코드가 섞여 있어요. 틀린 박스에 붙이면 실수!"; } };
  }

  var GAMES = { pack: packGame, inspect: inspectGame, sticker: stickerGame };

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
      level: level, label: opts.label, testHooks: !!opts.testHooks,
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
    setMistakeRule: function (rule) { if (rule === "reset" || rule === "freeze" || rule === "ignore") config.mistakeRule = rule; },
    getMistakeRule: function () { return config.mistakeRule; },
  };
})(typeof window !== "undefined" ? window : this);
