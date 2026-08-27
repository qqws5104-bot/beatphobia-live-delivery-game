# 프로젝트 인수인계 문서 — 택배 배송 게임 (라이브)

> 이 문서는 이 프로젝트를 처음 보는 작업자(Claude Code 포함)가 아무 사전 맥락 없이
> 바로 작업에 들어갈 수 있도록 쓴 것이다.
> **작업 시작 전 이 문서를 끝까지 읽을 것.** 특히 6절("절대 건드리면 안 되는 것")과
> 2.1절(퍼즐 이미지 파이프라인 — 실패해도 에러가 안 나는 곳).

---

## 1. 이게 뭔가

비트포비아(BeatPhobia) 콘텐츠 제작팀의 **2인 실시간 동시진행 택배 배송 게임**.
오프라인 방탈출/체험형 콘텐츠에 쓰는 디지털 파트로, 두 사람이 각자 브라우저를 열고
같은 방 코드로 들어와서 동시에 플레이한다. 로그인 없음, 링크만 있으면 입장.

- **저장소**: `github.com/qqws5104-bot/beatphobia-live-delivery-game` (public, `main` 브랜치)
- **배포**: Render.com Blueprint. **`main`에 push하면 자동 배포됨.**
- **라이브 URL**: `https://beatphobia-live-delivery-game.onrender.com`
- **작업 디렉터리**: 저장소 루트 (= 예전 경로 `live_game_hosted/`)

### 기술 스택 (의도적으로 최소)

- Node.js `http` + `ws` (WebSocket). **프레임워크 없음. 빌드 없음. DB 없음.**
- 게임 상태는 **서버 메모리에만** 존재. 방이 비면 30분 뒤 GC로 사라진다. 이건 버그가 아니라 설계다.
- 클라이언트는 **단일 파일** `public/index.html` (약 1.9MB). Python 스크립트가 생성한다.
- 의존성은 `ws` 하나뿐.

---

## 2. 파일 구조와 역할

```
game-data.js       공유 상수(경제/보드/타이머). 서버와 빌드 스크립트가 같이 읽는 단일 소스.
game-room.js       방 하나의 권위 있는 상태 + 모든 리듀서. 게임 규칙의 실체가 전부 여기 있다.
server.js          HTTP + WebSocket. 방 코드 발급, 정적 서빙, 소켓 메시지 → GameRoom 메서드 호출.
build_images.py    퍼즐 이미지 압축 단계. 원본 PNG → /tmp/compressed/*.jpg. 아래 2.1절 참조.
build_client.py    public/index.html을 생성하는 빌드 스크립트. CSS와 클라이언트 JS가 전부 여기 문자열로 들어있다.
public/index.html  빌드 결과물. **커밋에 포함되어 그대로 배포된다.** 직접 수정 금지 (다음 빌드에 덮어써짐).
test_hosted.js     Playwright E2E. 두 플레이어를 띄워 로비→확보→엘리베이터 5라운드→결과까지 전부 검증.
test_nudge.js      엘리베이터 실시간 이동 + 게이지 채움 검증 테스트.
screenshot*.js     화면 검수용 스크린샷 스크립트들.
render.yaml        Render Blueprint 설정.
```

### 2.1 퍼즐 이미지 파이프라인 (조용히 틀리기 쉬운 곳 — 반드시 읽을 것)

이미지는 **2단계**를 거친다:

```
원본 PNG (저장소 밖)  ──build_images.py──▶  /tmp/compressed/*.jpg  ──build_client.py──▶  public/index.html
   장당 ~835KB                                    장당 ~70KB              base64 인라인, 전체 1.9MB
   1920x1081                                      1280x720 q78
```

- **원본 PNG는 이 저장소에 없다.** `/home/claude/project/quiz_board/ref/` (20장 + contact_sheet).
  이미지를 바꿀 일이 없으면 신경 쓸 필요 없다 — 배포에 필요한 것은 이미 `public/index.html`에 들어 있다.
- 원본 파일명이 깨져 보인다(`#Ub300#Uc9c0 1_10.png`). 예전에 `unzip`이 한글 파일명을 잘못 디코딩한 흔적인데,
  `build_client.py`는 **정렬 순서와 개수(20장)만** 보므로 기능상 무해하다. 굳이 고치지 말 것 —
  이름을 바꾸면 정렬 순서가 달라져 스와치 개수 매핑이 어긋난다.

> **⚠️ 함정**: 원본 PNG만 교체하고 `build_client.py`를 돌리면 **빌드는 성공하지만 옛 이미지가 그대로 배포된다.**
> `/tmp/compressed`에 남아 있는 예전 JPG를 읽기 때문이다. 에러가 나지 않아서 알아채기 어렵다.
> **이미지를 바꿨다면 반드시 `python3 build_images.py`를 먼저 실행할 것.**
> (실제로 이 함정 때문에 한 번 옛 이미지가 배포된 적이 있다.)

> **⚠️ `/tmp/compressed`는 휘발성이다.** 컨테이너/머신이 바뀌면 사라지고, 그 상태에서
> `build_client.py`는 `FileNotFoundError`로 죽는다. 그때 `build_images.py`를 돌리면 복구된다
> (단 원본 PNG에 접근할 수 있어야 한다).

압축 설정(1280x720 LANCZOS, JPEG q78, optimize)은 **바꾸지 말 것.** 기존 압축본과 바이트 단위로
일치하도록 역산한 값이라, 바꾸면 20장 전부 재생성되어 `public/index.html` diff가 통째로 뒤집힌다.

이미지 교체 절차:

```bash
# 1. 원본 PNG를 ref 디렉터리에 덮어쓴다 (파일명 유지!)
# 2. 압축본 재생성  ← 빠뜨리기 쉬움
python3 build_images.py
# 3. 클라이언트 재빌드
python3 build_client.py
# 4. 검증: 원본 20장이 전부 빌드에 들어갔는지 확인 (5.4절)
```

### `build_client.py` 내부 구조 (중요)

이 파일 하나가 클라이언트 전체다. 크게 세 덩어리:

| 위치 (대략) | 이름 | 내용 |
|---|---|---|
| ~107행 | `HEAD_HTML` | `<!doctype>`부터 `<style>...</style>`까지. **CSS가 전부 여기 있다.** |
| ~311행 | `APP_JS_TEMPLATE` | 클라이언트 JS 전체 (raw 문자열). 렌더 함수, WS 클라이언트, 이벤트 핸들러. |
| 하단 | 조립부 | `@@TYPES_JSON@@` 등 플레이스홀더를 `game-data.js`에서 읽은 값으로 치환 후 파일 출력. |

`game-data.js`는 **정규식으로 파싱**한다 (Node 실행 없이 순수 Python 유지 목적).
그래서 `game-data.js`의 상수 리터럴 **형식**을 바꾸면 (예: 배열을 함수 호출로) 빌드가 깨진다.

퍼즐 이미지 20장은 base64로 인라인된다 — `public/index.html`이 1.9MB인 이유.

---

## 3. 게임 규칙 (구현된 그대로)

### 3.1 진행 흐름

```
lobby  →  secure(3분)  →  elevator(5라운드)  →  end
```

**lobby** — 두 사람이 각각 "플레이어 1" / "플레이어 2" 좌석 선택.
이미 선점된 좌석은 못 고른다. 새로고침해도 좌석 유지(sessionStorage의 clientId로 서버가 식별).
**둘 다** 스페이스바를 누르면 시작.

**secure (택배 확보, 3분)** — 4종 × 5개 = **20칸 보드**. 칸을 누르면 퍼즐(우봉고) 이미지 오버레이가
뜨고, 실물 퍼즐을 푼 뒤 "완료"를 누르면 그 칸을 확보하고 **송장 1장**을 얻는다.
송장에는 **무작위 목적지**(층 + 호수, 예: `401호`)가 찍힌다. "포기"는 아무 일도 일어나지 않음(칸 그대로).

> **보드는 플레이어별로 완전히 독립이다.** 두 사람이 같은 칸 id를 각자 확보할 수 있고 서로 방해가 없다.
> (`state.boards["1"]`, `state.boards["2"]`가 각각 20칸 사본을 가진다.)

**elevator (5라운드)** — 아래 3.2에서 상세히.

**end** — 두 플레이어의 **전체 송장 명세와 총점**을 나란히 공개. 승패 배너.

### 3.2 엘리베이터 (핵심 — 최근에 크게 바뀐 부분)

층 배열: `FLOORS = ["B1","1F","2F","3F","4F","5F"]` (인덱스 0~5). **시작은 인덱스 1 = 1F.**

한 라운드의 상태 머신:

```
idle   ─ 둘 다 스페이스 ─→  voting(5초)  ─ 타이머 만료 ─→  result  ─ 둘 다 스페이스 ─→  다음 라운드 / end
```

- `idle`: 라운드 1 시작 전 대기 게이트 (송장 훑어볼 시간).
- `voting`: **5초.** 이 동안 이동이 일어난다.
- `result`: 이번 라운드 결과 + 내가 배송한 것 표시. 둘 다 스페이스를 눌러야 진행.

**이동 방식 (2026-08-27 변경, commit `527891b`):**

> **버튼(또는 ↑/↓ 키) 한 번 = 실제 층이 즉시 한 칸 이동.**
> 투표해서 모았다가 라운드 끝에 한 번 이동하는 방식이 **아니다.** 그 방식은 제거되었다.

- 두 플레이어가 **같은 엘리베이터 하나를 공유**한다. 누가 누르든 그 즉시 움직인다 (줄다리기 구조).
- 서버가 클릭마다 전체 상태를 브로드캐스트하므로 **상대가 누른 이동도 내 화면에 실시간으로 보인다.**
- 위/아래 끝(B1, 5F)에서는 clamp — 더 못 간다.
- **5초가 끝나는 순간 엘리베이터가 서 있는 층이 그 라운드의 배송 위치**가 된다.
- `state.elevator.votes[seat]`는 서버 상태에는 여전히 클릭 카운터로 남아 있지만(라운드 로그용),
  **클라이언트는 이제 이걸 화면에 전혀 그리지 않는다** (2026-08-27 추가 변경). 내 클릭 수든
  상대 클릭 수든 노출 안 함 — 게이지(실제 공유 층 위치)가 유일한 이동 피드백이다.
- 라운드 결과의 `dir`(상승/하강/동률)은 **라운드 시작 층 대비 최종 층**의 순증감일 뿐, 이동을 만들지 않는다.

**배송 규칙**: 라운드가 끝나면 그 층으로 가는 **미배송 송장 중 가장 먼저 확보한 것 1장만** 배송된다.
같은 층에 여러 장이 밀려 있어도 **한 번 방문에 한 장.** 나머지는 다음에 그 층에 다시 와야 한다.

### 3.3 점수

| 종류 | 조각 | 배송 성공 | 미배송 |
|---|---|---|---|
| 일반택배 | 2 | **+2** | **-1** |
| 신선·냉동 택배 | 3 | 3라운드 이내 **+3** / 4~5라운드 **+2** | **-2** |
| 깨지기 쉬운 택배 | 4 | **+5** | **-2** |
| 귀중품 | 3 | **+4** | **-3** |

신선·냉동만 라운드 의존적이다:
- `deliveredRound <= 3` → `reward`(3)
- `deliveredRound` 4~5 → `reward - penaltyEarly` = 3 - 1 = **2**
- 미배송 → `-(penaltyEarly + penaltyFinal)` = **-2**

### 3.4 정보 공개 규칙 (깨뜨리기 쉬움 — 주의)

| 대상 | 엘리베이터 진행 중 | 종료 화면 |
|---|---|---|
| 상대 송장 목록 | **절대 표시 안 함** | **전체 공개** |
| 상대의 클릭 수 | **절대 표시 안 함** | (해당 없음) |
| 이번 라운드 배송 내역 | **내 것만** | **전체 공개** |
| 엘리베이터 현재 층 | **양쪽 다 봄** (공유 자원이므로 당연) | (해당 없음) |

`test_hosted.js`가 이 규칙들을 전부 검증한다. 렌더 함수를 고칠 때 이걸 깨면 테스트가 잡아낸다.

---

## 4. 아키텍처 원칙

### 4.1 서버가 유일한 진실

모든 액션은 **fire-and-forget 메시지**다. 클라이언트는 아무것도 예측하지 않는다.
서버가 상태를 바꾸고 → 전체 상태를 브로드캐스트 → 클라이언트는 그냥 다시 그린다.

```js
// 클라이언트 측 전부
ws.onmessage = 상태 받으면 → state = 그것 → render()
```

클라이언트 리듀서 없음, 낙관적 업데이트 없음, 충돌 해결 없음, 재시도 큐 없음.
Node가 싱글스레드라 두 사람의 동시 클릭도 그냥 순서대로 처리된다 — 경합 처리 코드가 아예 필요 없다.

> **이 원칙을 깨지 말 것.** 예전 버전에 있던 클라이언트측 상태 누적/재시도 로직은
> 버그의 원인이었고 전부 제거됐다. "부드럽게 보이려고" 클라이언트에서 층을 미리 움직이는
> 식의 코드를 추가하면 상대와 어긋난다.

### 4.2 WebSocket 메시지

클라이언트 → 서버 (전부 `{type, clientId, seat, ...}`):

| type | 추가 필드 | 동작 |
|---|---|---|
| `hello` | — | 연결 등록 |
| `pick-seat` | `seat` | 좌석 선점 (실패 시 `{type:"error", code:"seat_taken"}` 회신) |
| `set-ready` | — | 로비 준비 |
| `elevator-ready` | — | `idle`/`result` 게이트 통과 |
| `secure-cell` | `cellId` | 칸 확보 |
| `vote` | `dir: "up"\|"down"` | **엘리베이터 1칸 즉시 이동** |

서버 → 클라이언트: `{type:"state", state}` (전체 상태) 또는 `{type:"error", code, seat}`.

### 4.3 점수 로직이 두 군데 있다 (의도된 중복)

`scoreInvoice` / `resultLabel` / `totalScore`가 **`game-room.js`와 `build_client.py` 양쪽에** 있다.
- `game-room.js` 쪽이 **권위 있는 버전**.
- `build_client.py` 쪽은 **표시 전용 복제본**.
- **한쪽을 고치면 반드시 다른 쪽도 똑같이 고칠 것.**
- `test_hosted.js`가 `require("./game-room.js")`로 진짜 함수를 불러와 화면 표시값과 대조한다 — 어긋나면 테스트 실패.

---

## 5. 개발 워크플로

### 5.1 실행

```bash
npm install
node server.js          # 포트 3000
# 브라우저에서 http://localhost:3000/ → 자동으로 ?room=XXXX 로 리다이렉트
```

### 5.2 언제 재빌드가 필요한가

| 고친 파일 | 필요한 조치 |
|---|---|
| `build_client.py` (CSS/JS) | `python3 build_client.py` → 서버 재시작 |
| `game-data.js` (상수) | `python3 build_client.py` → 서버 재시작 (**양쪽이 읽으므로 둘 다 영향**) |
| **퍼즐 이미지 원본 PNG** | **`python3 build_images.py` → `python3 build_client.py`** → 서버 재시작 (2.1절 함정 주의) |
| `game-room.js`, `server.js` | 서버 재시작만 |

> `public/index.html`을 **직접 편집하지 말 것.** 다음 빌드에 통째로 덮어써진다.

### 5.3 테스트

```bash
node server.js &        # 먼저 서버가 떠 있어야 함
node test_hosted.js     # 전체 E2E (5라운드 전부 플레이)
node test_nudge.js      # 엘리베이터 실시간 이동
```

**secure 페이즈가 3분이라 그냥 돌리면 테스트가 타임아웃된다.** 테스트 전에 임시로 줄인다:

```bash
# 1) 임시 단축
python3 - <<'EOF'
s = open('game-data.js').read()
s2 = s.replace('SECURE_PHASE_MS = 3 * 60 * 1000;', 'SECURE_PHASE_MS = 6 * 1000;')
assert s2 != s          # 치환 실패를 조용히 넘기지 않기 위해 필수
open('game-data.js','w').write(s2)
EOF
python3 build_client.py && 서버 재시작

# 2) 테스트 실행

# 3) 반드시 원복 (커밋 전 필수!)
python3 - <<'EOF'
s = open('game-data.js').read()
s2 = s.replace('SECURE_PHASE_MS = 6 * 1000;', 'SECURE_PHASE_MS = 3 * 60 * 1000;')
assert s2 != s
open('game-data.js','w').write(s2)
EOF
python3 build_client.py && 서버 재시작
```

> **원복을 잊고 커밋하면 라이브 게임의 확보 시간이 6초가 된다.** 커밋 직전에
> `grep SECURE_PHASE_MS game-data.js`로 `3 * 60 * 1000`인지 반드시 확인할 것.

Playwright 클릭이 가끔 산발적으로 실패한다(환경 특성). 같은 스크립트를 한 번 더 돌리면 통과한다 —
코드 버그로 오해하지 말 것. 단, **연속 2회 이상 깨끗하게 통과하는 것을 기준**으로 삼는다.

### 5.4 이미지가 실제로 빌드에 들어갔는지 검증

이미지 교체는 실패해도 에러가 안 나므로(2.1절), 바꿨다면 이걸로 확인할 것:

```bash
python3 - <<'EOF'
import re, base64, hashlib, os, io
from PIL import Image
html = open('public/index.html', encoding='utf-8').read()
embedded = set(hashlib.md5(base64.b64decode(b)).hexdigest()
               for b in re.findall(r'data:image/jpeg;base64,([A-Za-z0-9+/=]+)', html))
REF = '/home/claude/project/quiz_board/ref'
names = sorted(f for f in os.listdir(REF) if f.lower().endswith('.png') and f != 'contact_sheet.png')
stale = []
for n in names:
    buf = io.BytesIO()
    Image.open(os.path.join(REF, n)).convert('RGB').resize((1280, 720), Image.LANCZOS) \
         .save(buf, 'JPEG', quality=78, optimize=True)
    if hashlib.md5(buf.getvalue()).hexdigest() not in embedded:
        stale.append(n)
print('전부 반영됨:', not stale, '| 누락:', stale or '없음')
EOF
```

### 5.5 커밋 / 배포

```bash
git add <바뀐 소스> public/index.html    # 빌드 결과물도 반드시 함께 커밋
git commit -m "..."
git push origin main                      # → Render가 자동 배포
```

`public/index.html`을 빼먹고 커밋하면 **소스는 바뀌었는데 배포된 화면은 그대로**인 상태가 된다.
지금까지 가장 흔했던 실수다.

---

## 6. 절대 건드리면 안 되는 것

작업 지시서에 명시적으로 "바꿔라"라고 적혀 있지 않은 한:

1. **`game-room.js`의 게임 규칙** — 이동/배송/점수/라운드 전이. 전부 테스트로 고정되어 있다.
2. **1클릭 = 1칸 즉시 이동 + 양쪽 브로드캐스트** 구조. 최근에 이걸로 바꾸느라 한 번 갈아엎었다.
3. **정보 공개 규칙** (3.4절).
4. **서버 단일 진실 원칙** (4.1절) — 클라이언트에서 층을 예측/선반영하지 말 것.
5. **`SECURE_PHASE_MS = 3 * 60 * 1000`** 프로덕션 값.
6. **점수 로직 양쪽 동기화** (4.3절).

---

## 7. 엘리베이터 화면의 구조 — 게이지 바

`.elev-layout`은 **2열 그리드**다: 왼쪽 220px = 게이지 바 + 내 택배 목록, 오른쪽 = 조작/정보 패널.

```
.elev-layout (grid 220px 1fr)
├── .elev-left                     ← 왼쪽 열 전체 (세로 flex)
│   ├── .shaft                     ← 게이지 바 껍데기
│   │   └── .gauge                 ← 게이지 본체 (position:relative, overflow:hidden)
│   │       ├── .gauge-fill        ← 아래에서 차오르는 금색 채움. height = (floorIdx+1)/6
│   │       │   └── ::after        ← 채움 윗면의 밝은 "수면" 선
│   │       └── .gauge-rows        ← flex column-reverse (B1이 시각적 맨 아래)
│   │           └── .floor-stop×6  ← 눈금 한 칸. i<=floorIdx면 .filled, i===floorIdx면 .current
│   │               └── .car       ← 현재 층에만 보이는 작은 마커
│   └── .player-col.me             ← 내 택배 목록. 게이지 바로 밑 (2026-08-27 이동)
│       └── .invoice-list          ← 상대 목록은 절대 렌더 안 함 (3.4절)
└── (오른쪽 카드)
    ├── .round-pill            "라운드 N / 5"
    ├── 현재 층 텍스트          ← 게이지와 별개로 층 이름을 한 번 더 명시
    ├── .vote-buttons          ▲위로 / ▼아래로
    ├── .key-hint              "키보드 ↑/↓로도..." (클릭 카운트는 표시 안 함 — 아래 참고)
    ├── #round-clock           남은 시간
    ├── .round-result          라운드 결과 + .delivered-callout
    └── .ready-row             준비 칩
```

> **클릭 카운트 UI 제거됨** (2026-08-27). 예전엔 오른쪽 패널에 `.vote-count-row`로 "내 클릭 수"를
> `▲N ▼N`으로 보여줬는데, 사용자 요청으로 완전히 뺐다. 서버 상태(`elevator.votes`)에는 여전히
> 클릭 카운터가 남아 있다(라운드 로그용, `game-room.js`는 안 건드림) — **화면에만 안 그린다.**

관련 코드 위치 (전부 `build_client.py`):
- CSS: `HEAD_HTML` 안, `.elev-layout` ~ `.elev-left .invoice .sticker` 부근, `.shaft` ~ `@media (max-width:820px) { .gauge ... }`
- 렌더: `APP_JS_TEMPLATE` 안 `renderElevator` (왼쪽 열 조립), `renderShaft(floorIdx)` / `settleShaft()` / `shaftFillPct(i)`

### 동작 원리 (고칠 때 반드시 이해할 것)

**채움 높이 = `(floorIdx + 1) / 6`.** 즉 B1(인덱스 0)은 1/6, 5F(인덱스 5)는 6/6.
항상 눈금 경계에 정확히 걸리므로 "지금 몇 층인지"가 모호해지지 않는다
(배송 주소가 `401호`처럼 층에 묶여 있어 이게 중요하다).

**애니메이션이 성립하는 방식이 조금 특이하다.** `render()`는 브로드캐스트마다 DOM을 통째로
갈아엎는다. 그래서 채움 요소를 최종 높이로 만들어버리면 그냥 그 높이로 "나타날" 뿐 움직이지 않는다.
그래서:

1. `renderShaft`는 채움을 **직전 층 높이**(`prevShaftFloorIdx`)로 그리고, 진짜 목표를 `data-target`에 넣는다.
2. `render()` 끝에서 `settleShaft()`가 **`requestAnimationFrame` 2번 중첩** 후 실제 높이를 넣는다.
   → 브라우저가 "직전 높이"를 한 번 그린 뒤 바뀌므로 transition이 실제로 재생된다.
   (rAF 1번만 쓰면 브라우저가 둘을 같은 초기 레이아웃으로 합쳐버려 transition이 생략된다.)

연타해도 막히지 않는다 — 새 클릭은 그냥 다음 렌더를 부르고, 그 렌더는 언제나 "직전 논리적 위치"에서
시작해 새 위치로 이어간다.

> **주의 1**: `.gauge-rows`가 `flex-direction: column-reverse`라 **DOM 순서(B1→5F)와 화면 순서(5F→B1)가 반대**다.
> `querySelectorAll(".floor-stop")[i]`는 화면 위치와 무관하게 `FLOORS[i]`에 대응한다. 테스트가 이 전제에 의존한다.
>
> **주의 2**: 채움 위에 올라간 눈금(`.filled`)은 금색 배경 위라서 **어두운 잉크**를 쓴다.
> 색만 바꾸면 채움 아래 칸의 글씨가 안 보이게 되니 `.filled` / `.current` 규칙을 함께 볼 것.
>
> **주의 3**: 클라이언트에서 층을 **미리 움직이지 말 것**. `floorIdx`는 서버 값을 그대로 그린다.
> 부드럽게 만들겠다고 낙관적 업데이트를 넣으면 상대 화면과 어긋난다 (4.1절).

`test_nudge.js`가 게이지 채움 비율까지 검증한다 (`.gauge-fill` 높이 ÷ `.gauge` 높이가
`(floorIdx+1)/6`인지, B1에서 clamp되는지 포함).

---

## 8. 참고: Render 무료 플랜 제약

- 15분 무요청 시 서버가 잠들고, 다음 접속 시 깨어나는 데 **약 1분**. 실제 운영 전에 링크를 한 번 열어 깨워둘 것.
- 깨어나면 진행 중이던 방/점수는 사라진다 (메모리 저장이므로 구조적 특성).
- 게임 중에는 소켓이 계속 열려 있어 잠들지 않는다.
