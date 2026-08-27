"""
퍼즐 이미지 압축 단계 — build_client.py가 읽는 /tmp/compressed/*.jpg 를 생성한다.

**왜 별도 단계인가**: build_client.py는 원본 PNG가 아니라 압축된 JPG를 base64로 인라인한다.
원본은 장당 ~835KB(1920x1081 PNG)라 20장이면 16MB가 넘어 단일 HTML로는 감당이 안 된다.
압축본은 장당 ~70KB라 전체 1.9MB로 떨어진다.

**주의 — 이 단계를 건너뛰면 조용히 옛 이미지가 배포된다.**
원본 PNG만 교체하고 build_client.py를 돌리면, 빌드는 성공하지만 /tmp/compressed 에 남아 있는
예전 JPG가 그대로 들어간다. 이미지를 바꿨다면 **반드시 이 스크립트를 먼저 실행할 것.**

    python3 build_images.py && python3 build_client.py

**압축 설정은 임의로 바꾸지 말 것.** 아래 값은 기존 압축본과 바이트 단위로 일치하도록
역산해낸 것이다 (검증: 변경되지 않은 원본을 재압축했을 때 기존 JPG와 md5가 정확히 일치).
값을 바꾸면 20장 전체가 재생성되어 public/index.html의 diff가 통째로 뒤집힌다.

**원본 PNG는 이 저장소에 없다.** REF_DIR(아래)에 있으며, 저장소 밖이다. 이미지를 바꿀 일이
없다면 신경 쓸 필요 없다 — 배포에 필요한 것은 이미 public/index.html 안에 들어 있다.
"""

import os
import re
import sys

from PIL import Image

REF_DIR = "/home/claude/project/quiz_board/ref"   # 원본 PNG (저장소 밖)
COMPRESSED_DIR = "/tmp/compressed"                # build_client.py가 읽는 위치
GAME_DATA_JS = os.path.join(os.path.dirname(__file__), "game-data.js")

# 기존 압축본에서 역산한 값 — 변경 금지 (모듈 docstring 참조)
TARGET_SIZE = (1280, 720)
JPEG_QUALITY = 78
RESAMPLE = Image.LANCZOS


def main():
    if not os.path.isdir(REF_DIR):
        sys.exit(
            f"원본 PNG 디렉터리를 찾을 수 없습니다: {REF_DIR}\n"
            "이미지 원본은 이 저장소에 포함되어 있지 않습니다. "
            "이미지를 교체할 것이 아니라면 이 스크립트는 실행할 필요가 없습니다 "
            "(배포용 이미지는 이미 public/index.html에 들어 있습니다)."
        )

    os.makedirs(COMPRESSED_DIR, exist_ok=True)

    names = sorted(
        f for f in os.listdir(REF_DIR)
        if f.lower().endswith(".png") and f != "contact_sheet.png"
    )
    # 보드 칸 수는 game-data.js의 TYPES[].count 합계로 정해진다 (2026-08-27 개편 이후 21칸,
    # 종류별로 다름 -- 더 이상 고정 20장이 아니다). 여기서는 딱 맞아야만 진행하는 게 아니라
    # 경고만 하고 계속 진행한다 -- 부족분은 build_client.py가 마지막 이미지를 재사용해 채운다
    # (전반/후반용 새 이미지 세트가 아직 안 왔을 때도 빌드 자체는 막지 않기 위함).
    src = open(GAME_DATA_JS, encoding="utf-8").read()
    counts = [int(n) for n in re.findall(r"count:\s*(\d+)", src)]
    total_cells = sum(counts) if counts else 20
    if len(names) != total_cells:
        print(f"WARNING: 원본 PNG가 {len(names)}장인데 보드 칸은 {total_cells}개입니다 ({REF_DIR}). "
              "그래도 있는 만큼 압축을 진행합니다 -- build_client.py가 부족분을 임시로 채웁니다.")

    changed = 0
    for name in names:
        src = os.path.join(REF_DIR, name)
        dst = os.path.join(COMPRESSED_DIR, name.replace(".png", ".jpg"))
        before = os.path.getsize(dst) if os.path.exists(dst) else None
        (Image.open(src)
             .convert("RGB")
             .resize(TARGET_SIZE, RESAMPLE)
             .save(dst, "JPEG", quality=JPEG_QUALITY, optimize=True))
        after = os.path.getsize(dst)
        if before != after:
            changed += 1
            print(f"  {name} -> {after} bytes" + (f" (이전 {before})" if before else " (신규)"))

    print(f"압축본 {len(names)}장 생성 완료 ({COMPRESSED_DIR}), 크기가 바뀐 파일 {changed}장")
    print("다음: python3 build_client.py")


if __name__ == "__main__":
    main()
