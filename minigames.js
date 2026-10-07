/* minigames.js -- 택배 확보 미니게임 4종 (박스 포장 / 이상 확인 / 송장 붙이기 / 지도 배달)
 *
 * 바닐라 JS, 의존성 없음. 게임 본체(build_client.py)에 그대로 인라인하거나, 단독 시험장 페이지에서
 * 똑같이 쓸 수 있게 만들었다.
 *
 *   var ctl = MiniGames.start(hostElement, {
 *     kind: "pack" | "inspect" | "sticker" | "map",
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
  // 2026-10-07 난이도 업: 레벨 2(전반) 6 -> 8, 레벨 3(후반) 8 -> 10. (레벨 1은 시험장 전용)
  var PACK_LEN = [4, 8, 10]; // 방향키 개수 (+ 마지막 스페이스)
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
  // 이상 확인 (택배 검수) -- 벨트로 들어오는 택배의 "앞면 · 옆면 · 송장"을 서로 맞춰 보고,
  //   셋이 모두 같은 종류를 가리키면 그 종류 칸으로 보내고, 하나라도 다르면 폐기한다.
  //   ← 일반   ↓ 깨지기   → 귀중품   SPACE 정보가 안 맞는 택배 폐기
  // 2026-10-07 재설계 (사용자 피드백: "분류 + 이상품 SPACE는 반응속도 게임이다. 앞면+옆면+송장 정보를 주고 두 정보가
  //   일치하지 않을 때만 폐기하게 해서 판단이 들어가게"). 세 정보는 서로 다른 방식으로 표현된다:
  //     앞면 = 띠 모양/색 (일반=베이지 띠, 깨지기=빨간 줄무늬 띠, 귀중품=금색 리본)
  //     옆면 = 취급 그림 (일반=위 화살표 박스, 깨지기=유리잔, 귀중품=보석)
  //     송장 = 내용물 글자 (예: 옷/책 = 일반, 유리컵/도자기 = 깨지기, 시계/노트북 = 귀중품)
  //   그래서 눈으로 "반응"하는 게 아니라 세 가지를 읽고 같은 종류인지 판단해야 한다. 이상한 택배는 셋 중 하나만 다른 종류를 가리킨다.
  //   (스크래치 같은 겉 흠집은 판단과 무관한 장식이다 -- "흠집 = 폐기"로 찍지 못하게 하는 미끼.)
  // 분류 3종은 게임의 실제 카테고리(일반/깨지기/귀중품)와 같은 색을 쓴다.
  // 내부 kind 키는 그대로 "inspect" (game-data.js의 TYPES.mini와 시험장이 이 이름을 쓴다).
  // ======================================================================
  //   n 택배 수, bad 정보가 안 맞는 택배 수, hard 송장 내용물을 덜 뻔한 단어로(0 쉬움/1 어려움), decoy 멀쩡한 택배에 스크래치 넣을 확률
  var INSPECT_CFG = [
    { n: 6,  bad: 2, hard: 0, decoy: 0 },
    { n: 9,  bad: 3, hard: 0, decoy: 0.4 },
    { n: 11, bad: 4, hard: 1, decoy: 0.5 },
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

  // 택배 하나를 그린다: 앞면(띠) + 옆면(그림) + 송장(내용물). item = { front, side, slip(단어), bad }.
  function pkgSvg(item, cfg) {
    var F = CLASSES[item.front], tapeX = 14 + rand(34);
    var s = '<svg viewBox="0 0 190 100" aria-hidden="true">'
      + '<ellipse cx="95" cy="92" rx="88" ry="5" fill="rgba(43,29,18,.18)"/>'
      // 앞면
      + '<rect x="6" y="24" width="70" height="62" rx="3" fill="' + F.color + '" stroke="#6b4e26" stroke-width="1.8"/>'
      + '<rect x="6" y="24" width="70" height="12" rx="3" fill="' + F.light + '" stroke="#6b4e26" stroke-width="1.8"/>';
    if (item.front === 0) {
      s += '<rect x="' + tapeX + '" y="24" width="14" height="34" fill="#ead8b0" opacity=".95"/>';
    } else if (item.front === 1) {
      s += '<rect x="' + tapeX + '" y="24" width="14" height="34" fill="#d6452f"/>'
        + '<path d="M' + tapeX + ' 33l14-6M' + tapeX + ' 42l14-6M' + tapeX + ' 51l14-6" stroke="#fff" stroke-width="2.4"/>';
    } else {
      s += '<rect x="35" y="24" width="12" height="62" fill="#b8841f"/><rect x="6" y="50" width="70" height="10" fill="#b8841f"/>'
        + '<circle cx="41" cy="55" r="7" fill="#e0a82e" stroke="#8a5f12" stroke-width="1.4"/>';
    }
    // 옆면: 같은 박스의 옆, 취급 그림
    s += '<polygon points="76,24 104,16 104,78 76,86" fill="#d9b982" stroke="#6b4e26" stroke-width="1.8" stroke-linejoin="round"/>'
      + '<g transform="translate(90 51) scale(0.95)">' + sideIcon(item.side) + '</g>';
    // 송장: 종이 라벨, 내용물 글자
    s += '<rect x="112" y="22" width="72" height="62" rx="2.5" fill="#fffefa" stroke="#9a8460" stroke-width="1.4"/>'
      + '<rect x="112" y="22" width="72" height="11" rx="2.5" fill="#E8681C"/>'
      + '<text x="148" y="30.5" text-anchor="middle" font-size="8" font-weight="800" fill="#fff8ef" letter-spacing="2">송장</text>'
      + '<text x="118" y="46" font-size="6.5" font-weight="700" fill="#8a7256">내용물</text>'
      + '<text x="148" y="64" text-anchor="middle" font-size="' + (item.slip.length > 3 ? 14 : 17) + '" font-weight="800" fill="#2b1d12">' + item.slip + '</text>'
      + '<rect x="118" y="73" width="60" height="5" fill="#2b1d12" opacity=".8"/>';
    if (!item.bad && cfg.decoy && Math.random() < cfg.decoy) {
      // 정보가 맞는 택배에도 가벼운 스크래치 -- "흠집이 보이면 폐기"로 찍지 못하게 한다
      var sy = 44 + rand(30), sx = 12 + rand(40);
      s += '<path d="M' + sx + ' ' + sy + 'h' + (8 + rand(10)) + '" stroke="rgba(60,33,10,.4)" stroke-width="1.2" stroke-linecap="round" fill="none"/>';
    }
    return s + "</svg>";
  }

  function makeInspectItems(cfg) {
    var badAt = {};
    shuffle(Array.apply(null, { length: cfg.n }).map(function (_, i) { return i; })).slice(0, cfg.bad).forEach(function (i) { badAt[i] = true; });
    var items = [];
    for (var i = 0; i < cfg.n; i++) {
      var cls = rand(3), parts = [cls, cls, cls], bad = !!badAt[i];
      if (bad) { var odd = rand(3), other = (cls + 1 + rand(2)) % 3; parts[odd] = other; }
      var pool = SLIP_WORDS[parts[2]], words = cfg.hard && Math.random() < 0.6 ? pool[1] : pool[0];
      items.push({ cls: cls, bad: bad, front: parts[0], side: parts[1], slip: words[rand(words.length)] });
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
      + '<button type="button" class="mg-bin mg-discard" data-a="space" aria-label="정보가 안 맞는 택배 폐기"><span class="mg-bin-k">SPACE</span><span class="mg-bin-n">앞면·옆면·송장이 하나라도 다르면 폐기</span></button>';

    var queue = body.querySelector(".mg-queue");
    var doneEl = body.querySelector(".mg-found");
    var note = body.querySelector(".mg-freeze-note");
    var els = items.map(function (it, i) {
      var d = el("div", "mg-pkg", pkgSvg(it, cfg));
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
      note.textContent = items[idx].bad && a !== "space" ? "앞면·옆면·송장이 안 맞는 택배예요 — 폐기!" : (a === "space" ? "세 정보가 모두 같은 종류예요" : "다른 칸이에요 — 세 정보를 다시 보세요");
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
    return { hint: function () { return "택배의 앞면(띠) · 옆면(그림) · 송장(내용물)이 모두 같은 종류를 가리키면 그 칸으로 보내세요 (← 일반 · ↓ 깨지기 · → 귀중품). 하나라도 다르면 SPACE로 폐기! 흠집은 상관없어요. 틀리면 잠깐 멈춰요."; } };
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
    for (var attempt = 0; attempt < 900; attempt++) {
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

  var GAMES = { pack: packGame, inspect: inspectGame, sticker: stickerGame, map: mapGame };

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
