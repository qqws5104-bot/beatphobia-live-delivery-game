#!/usr/bin/env python3
"""game-data.js의 TYPES[].mini를 한 번에 바꾼다 (2026-10-08).

  python3 set_mini.py digital   # 최종 배치 v2(2026-10-08, 커밋되는 기본 상태): 일반 ice(빙판 배송) / 깨지기 map(지도 배달) / 귀중품 soko(창고 정리) / 확정 층수 route(배달 경로). miniLevel은 건드리지 않는다
  python3 set_mini.py ubongo    # 네 종류 모두 실물 우봉고 (mini: null) -- 퍼즐 이미지 + 완료 버튼(이미지 원본 폴더 필요, HANDOVER 9.8)

바꾼 뒤에는 `python3 build_client.py`로 클라이언트를 다시 빌드하고 서버도 재시작해야 한다.
regress.sh는 두 모드를 모두 돌린 뒤 `digital`(기본)로 되돌려 둔다.
"""
import re, sys

DIGITAL = {"normal": "ice", "fragile": "map", "valuable": "soko", "fixed-floor": "route"}
mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode not in ("ubongo", "digital"):
    sys.exit(__doc__)
path = __file__.rsplit("/", 1)[0] + "/game-data.js" if "/" in __file__ else "game-data.js"
src = open(path, encoding="utf-8").read()
for key, game in DIGITAL.items():
    want = "null" if mode == "ubongo" else '"%s"' % game
    pat = re.compile(r'(\{ key: "%s",.*?mini: )(null|"[a-z]+")' % re.escape(key), re.S)
    src, n = pat.subn(lambda m: m.group(1) + want, src, count=1)
    assert n == 1, key
open(path, "w", encoding="utf-8").write(src)
print("TYPES.mini ->", mode)
