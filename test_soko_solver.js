// 창고 정리(소코반) 풀이기 -- test_minigames.js / test_minigames_live.js 공용 (2026-10-08).
// 판 형식: 문자열 행 배열 ('#' 벽, ' ' 바닥, '.' 하역 칸, '$' 박스, '@' 플레이어, '*' 박스+칸, '+' 플레이어+칸).
// skSolve(P, 시작 플레이어, 시작 박스들, [멈춤 조건]) -> 최단 키 문자열("UDLR"), 풀 수 없으면 null.
"use strict";
function skParse(rows) {
  const H = rows.length, W = Math.max(...rows.map((r) => r.length)), wall = [], tgt = [], boxes = []; let player = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ch = rows[y][x] || "#", i = y * W + x;
    wall[i] = ch === "#"; tgt[i] = ch === "." || ch === "*" || ch === "+";
    if (ch === "$" || ch === "*") boxes.push(i);
    if (ch === "@" || ch === "+") player = i;
  }
  return { W, H, wall, tgt, boxes, player };
}
function skSolve(P, fromP, fromBoxes, stopFn) { // 최단 풀이(또는 stopFn이 참이 되는 최단 상태)의 키 문자열
  const { W, H, wall, tgt } = P, D = [[0, -1, "U"], [0, 1, "D"], [-1, 0, "L"], [1, 0, "R"]];
  const goal = stopFn || ((bx) => bx.every((b) => tgt[b]));
  const key = (p, bx) => p + ":" + bx.slice().sort((a, b) => a - b).join(",");
  const q = [{ p: fromP, bx: fromBoxes.slice(), path: "" }], seen = new Set([key(fromP, fromBoxes)]);
  if (goal(fromBoxes)) return "";
  for (let h = 0; h < q.length; h++) {
    const s = q[h];
    for (const [dx, dy, ch] of D) {
      const nx = (s.p % W) + dx, ny = ((s.p / W) | 0) + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx; if (wall[ni]) continue;
      const bi = s.bx.indexOf(ni); let nb = s.bx;
      if (bi >= 0) { const mi = (ny + dy) * W + nx + dx; if (wall[mi] || s.bx.indexOf(mi) >= 0) continue; nb = s.bx.slice(); nb[bi] = mi; }
      const k = key(ni, nb); if (seen.has(k)) continue; seen.add(k);
      const ns = { p: ni, bx: nb, path: s.path + ch }; if (goal(nb)) return ns.path; q.push(ns);
    }
  }
  return null;
}

module.exports = { skParse, skSolve };
