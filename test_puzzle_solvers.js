// 시험용 퍼즐 풀이기 (2026-10-08) -- test_minigames_extra.js 공용.
// iceSolve(rows): 빙판 배송 최단 키 문자열 / twinSolve(rows, mirror): 쌍둥이 배달 최단 키 문자열. 풀 수 없으면 null.
"use strict";
const DIR = [[0, -1, "U"], [0, 1, "D"], [-1, 0, "L"], [1, 0, "R"]];
function iceParse(rows) {
  const H = rows.length, W = Math.max(...rows.map((r) => r.length)), wall = [], P = []; let S = 0, G = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const ch = rows[y][x] || " ", i = y * W + x; wall[i] = ch === "#"; if (ch === "S") S = i; if (ch === "G") G = i; if (ch === "P") P.push(i); }
  return { W, H, wall, S, G, P };
}
function iceSolve(rows) {
  const { W, H, wall, S, G, P } = iceParse(rows), full = (1 << P.length) - 1, key = (p, m) => p * 8 + m;
  const seen = new Map([[key(S, 0), null]]), q = [[S, 0]];
  for (let h = 0; h < q.length; h++) {
    const [p, m] = q[h];
    if (p === G && m === full) { const out = []; let k = key(p, m); while (seen.get(k)) { const s = seen.get(k); out.unshift(s.d); k = s.k; } return out.join(""); }
    for (const [dx, dy, ch] of DIR) {
      let x = p % W, y = (p / W) | 0, mm = m, moved = false;
      for (;;) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H || wall[ny * W + nx]) break; x = nx; y = ny; moved = true; const pi = P.indexOf(y * W + x); if (pi >= 0) mm |= 1 << pi; }
      if (!moved) continue; const k = key(y * W + x, mm); if (seen.has(k)) continue; seen.set(k, { k: key(p, m), d: ch }); q.push([y * W + x, mm]);
    }
  }
  return null;
}
function twinParse(rows) {
  const H = rows.length, W = Math.max(...rows.map((r) => r.length)), wall = []; let a = 0, b = 0, A = 0, B = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const ch = rows[y][x] || " ", i = y * W + x; wall[i] = ch === "#"; if (ch === "a") a = i; if (ch === "b") b = i; if (ch === "A") A = i; if (ch === "B") B = i; }
  return { W, H, wall, a, b, A, B };
}
function twinSolve(rows, mirror) {
  const g = twinParse(rows), step = (p, dx, dy) => { const x = p % g.W + dx, y = ((p / g.W) | 0) + dy; return x < 0 || y < 0 || x >= g.W || y >= g.H || g.wall[y * g.W + x] ? p : y * g.W + x; };
  const key = (a, b) => a * 1000 + b, seen = new Map([[key(g.a, g.b), null]]), q = [[g.a, g.b]];
  for (let h = 0; h < q.length; h++) {
    const [a, b] = q[h];
    if (a === g.A && b === g.B) { const out = []; let k = key(a, b); while (seen.get(k)) { const s = seen.get(k); out.unshift(s.d); k = s.k; } return out.join(""); }
    for (const [dx, dy, ch] of DIR) { const na = step(a, dx, dy), nb = step(b, mirror ? -dx : dx, dy), k = key(na, nb); if (seen.has(k)) continue; seen.set(k, { k: key(a, b), d: ch }); q.push([na, nb]); }
  }
  return null;
}
module.exports = { iceSolve, twinSolve, iceParse, twinParse };
