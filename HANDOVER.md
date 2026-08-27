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
test_hosted.js     Playwright E2E. 두 플레이어를 띄워 로비→확보→우선택배→전반 5라운드→하프타임→
                   확보→우선택배→후반 5라운드→결과까지 전체 흐름을 검증.
test_nudge.js      엘리베이터 실시간 이동 + 현재 층 표시 검증 테스트.
screenshot*.js     화면 검수용 스크린샷 스크립트들.
render.yaml        Render Blueprint 설정.
```

> **2026-08-27 대규모 개편**: 냉장 택배 폐지 + 확정 층수 택배(6칸) 신설로 보드가 20칸→**21칸**,
> 점수가 추상 점수→**원(KRW) 단위 실금액**, 그리고 **우선 택배 지정 / 같은 층 5초 선택 / 전반·후반
> 2회 진행 / 후반 전용 택배도둑** 4개 메커닉이 새로 생겼다. 아래 3절 전체가 이 개편을 반영한
> 최신 규칙이다 — 예전 버전(신선·냉동 택배, 20칸, 추상 점수)을 참고하는 코드/문서가 남아 있다면
> 이 문서가 우선한다.

### 2.1 퍼즐 이미지 파이프라인 (조용히 틀리기 쉬운 곳 — 반드시 읽을 것)

이미지는 **2단계**를 거친다:

```
원본 PNG (저장소 밖)  ──build_images.py──▶  /tmp/compressed/*.jpg  ──build_client.py──▶  public/index.html
   장당 ~835KB                                    장당 ~70KB              base64 인라인, 전체 1.9MB
   1920x1081                                      1280x720 q78
```

- **원본 PNG는 이 저장소에 없다.** `/home/claude/project/quiz_board/ref/`.
  이미지를 바꿀 일이 없으면 신경 쓸 필요 없다 — 배포에 필요한 것은 이미 `public/index.html`에 들어 있다.
- 원본 파일명이 깨져 보인다(`#Ub300#Uc9c0 1_10.png`). 예전에 `unzip`이 한글 파일명을 잘못 디코딩한 흔적인데,
  `build_client.py`는 **정렬 순서만** 보므로 기능상 무해하다. 굳이 고치지 말 것 —
  이름을 바꾸면 정렬 순서가 달라져 어느 칸에 어느 이미지가 배정되는지가 바뀐다.

> **⚠️ 21칸인데 원본은 아직 20장뿐이다 (2026-08-27 개편 이후 미해결 상태).** 보드가 20칸→21칸으로
> 늘었지만(확정 층수 택배가 6칸), `quiz_board/ref/`에는 옛 20장이 그대로 있다. `build_client.py`는
> 이 경우 **마지막 이미지를 재사용해서 21번째 칸을 임시로 채우고 경고를 출력**한다 (빌드/배포는
> 막지 않음 — 두 칸이 같은 퍼즐 이미지를 보여주는 정도의 흠결). **사용자가 전반용/후반용 이미지
> 세트를 각각 21장씩 새로 준다고 했다** ("게임 우봉고 이미지는 내가 따로 더 줄테니, 전반과 후반을
> 각각 만들도록 해") — 아직 도착 전이다. 도착하면:
> 1. 지금은 전반/후반이 **같은 이미지 풀을 공유**한다 (`REF_DIR` 하나). 두 세트가 오면 `REF_DIR_1`/
>    `REF_DIR_2` 같은 분리 구조로 바꿔야 한다 — `build_client.py`/`build_images.py`를 반반 나눠 두 번
>    돌리거나, half별 CELLS를 따로 만드는 식. 아직 파일 전달 방식(폴더 구조, 21장씩 맞는지 등)을
>    모르므로 미리 만들어두지 않았다 — 실제로 올 때 그 형태에 맞춰 만들 것.
> 2. `IMAGE_FILES`가 `len(IMAGE_FILES) != TOTAL_CELLS`(21)면 `build_client.py`/`build_images.py`가
>    경고를 찍는다 — 21장이 정확히 갖춰지면 경고가 사라지는 것으로 확인 가능.

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
lobby → secure(3분) → priority → elevator(5라운드) → halftime → secure(3분) → priority → elevator(5라운드) → end
        └──────────────── 전반(half 1) ────────────────┘         └──────────────── 후반(half 2) ────────────────┘
```

**전체가 두 번(전반/후반) 연속으로 돈다** — 한 게임 세션 안에서 secure→priority→elevator 전체
사이클이 두 번 실행되고, **점수는 두 하프의 합산**이다 (`state.halfHistory`에 각 하프 스냅샷,
`state.scores`가 그 합산 — `game-room.js`의 `_finishHalf()`). 전반과 후반은 완전히 독립된
새 보드/새 송장으로 시작한다 (하프타임에 리셋).

**lobby** — 두 사람이 각각 "플레이어 1" / "플레이어 2" 좌석 선택.
이미 선점된 좌석은 못 고른다. 새로고침해도 좌석 유지(sessionStorage의 clientId로 서버가 식별).
**둘 다** 스페이스바를 누르면 시작.

**secure (택배 확보, 3분)** — 종류별 칸 수가 다른 **21칸 보드** (아래 3.3 표 참조). 칸을 누르면
퍼즐(우봉고) 이미지 오버레이가 뜨고, 실물 퍼즐을 푼 뒤 "완료"를 누르면 그 칸을 확보하고
**송장 1장**을 얻는다. 대부분은 **무작위 목적지**(층 + 호수, 예: `401호`)가 찍히지만, **확정 층수
택배**만은 예외로 **칸 자체가 곧 층을 확정**한다(아래 3.3). "포기"는 아무 일도 일어나지 않음(칸 그대로).

> **보드는 플레이어별로 완전히 독립이다.** 두 사람이 같은 칸 id를 각자 확보할 수 있고 서로 방해가 없다.
> (`state.boards["1"]`, `state.boards["2"]`가 각각 21칸 사본을 가진다.)

**priority (우선 택배 지정)** — secure가 끝나면 곧장 elevator로 안 가고 이 단계를 거친다. 각
플레이어가 자기 송장 중 **최대 1개**를 "우선 택배"로 찍을 수 있다(선택 사항, 안 찍어도 됨). 그
송장이 배송에 성공하면 점수가 **2배**(`PRIORITY_MULTIPLIER`)가 된다. 다른 게이트들과 동일하게
**둘 다 스페이스바**를 눌러야 다음(elevator)으로 넘어간다. `state.priority.picks[seat]`가 서버의
임시 선택값이고, 둘 다 준비되면 `state.players[seat].priorityInvoiceId`로 확정 복사된다
(`game-room.js`의 `setPriority`/`priorityReady`).

**elevator (5라운드)** — 아래 3.2에서 상세히.

**halftime (전반→후반 전환, 전반 끝에만 등장)** — 전반 5라운드가 끝나면 결과를 잠깐 보여주고,
둘 다 스페이스바를 누르면 보드/송장/우선택배 지정이 전부 리셋되고 후반의 secure 페이즈가 다시
시작된다 (`game-room.js`의 `halftimeReady`). **후반부터만 택배도둑 메커닉이 열린다** (아래 3.2).

**end (후반 끝)** — 두 플레이어의 **전반+후반 전체 송장 명세와 하프별 점수, 합산 총점**을 나란히
공개. 승패 배너는 합산 총점 기준.

### 3.2 엘리베이터 (핵심)

층 배열: `FLOORS = ["B1","1F","2F","3F","4F","5F"]` (인덱스 0~5). **시작은 인덱스 1 = 1F.**

한 라운드의 상태 머신 (2026-08-27, `choosing` 추가):

```
idle ─ 둘 다 스페이스 ─→ voting(5초) ─ 타이머 만료 ─┬─(같은 층 충돌 없음)─→ result ─ 둘 다 스페이스 ─→ 다음 라운드 / halftime·end
                                                    └─(충돌 있음)─→ choosing(5초) ─→ result
```

- `idle`: 라운드 1 시작 전 대기 게이트 (송장 훑어볼 시간). 후반이면 여기서도 택배도둑을 놓을 수 있다.
- `voting`: **5초.** 이 동안 이동이 일어난다. 후반이면 여기서도 택배도둑을 놓을 수 있다.
- `choosing`: **같은 층에 내 미배송 송장이 2개 이상**일 때만 등장 (없으면 곧장 result로 건너뜀).
  `SAME_FLOOR_CHOICE_MS`(5초) 동안 어느 걸 먼저 보낼지 고른다 — **안 고르면 서버가 무작위로
  정한다** (`game-room.js`의 `_finalizeChoice`). 충돌이 없는 쪽 플레이어에게는 그냥 대기 메시지만
  보인다 (자기 화면엔 아무 영향 없음).
- `result`: 이번 라운드 결과 + 내가 배송한 것(도난당했으면 그것도) 표시. 둘 다 스페이스를 눌러야 진행.

**이동 방식 (2026-08-27 변경, commit `527891b`):**

> **버튼(또는 ↑/↓ 키) 한 번 = 실제 층이 즉시 한 칸 이동.**
> 투표해서 모았다가 라운드 끝에 한 번 이동하는 방식이 **아니다.** 그 방식은 제거되었다.

- 두 플레이어가 **같은 엘리베이터 하나를 공유**한다. 누가 누르든 그 즉시 움직인다 (줄다리기 구조).
- 서버가 클릭마다 전체 상태를 브로드캐스트하므로 **상대가 누른 이동도 내 화면에 실시간으로 보인다.**
- 위/아래 끝(B1, 5F)에서는 clamp — 더 못 간다.
- **5초가 끝나는 순간 엘리베이터가 서 있는 층이 그 라운드의 배송 위치**가 된다.
- `state.elevator.votes[seat]`는 서버 상태에는 여전히 클릭 카운터로 남아 있지만(라운드 로그용),
  **클라이언트는 이제 이걸 화면에 전혀 그리지 않는다** (2026-08-27 추가 변경). 내 클릭 수든
  상대 클릭 수든 노출 안 함 — 왼쪽의 실제 공유 층 위치가 유일한 이동 피드백이다.
- 라운드 결과의 `dir`(상승/하강/동률)은 **라운드 시작 층 대비 최종 층**의 순증감일 뿐, 이동을 만들지 않는다.

**배송 규칙**: 라운드가 끝나면 그 층으로 가는 **미배송 송장 중 가장 먼저 확보한 것 1장만** 배송된다
(같은 층에 2개 이상이면 위 `choosing` 단계에서 고른 것이 대신 배송됨). 같은 층에 여러 장이 밀려
있어도 **한 번 방문에 한 장.** 나머지는 다음에 그 층에 다시 와야 한다.

**택배도둑 (후반 전용, 2026-08-27 신설)** — 후반(`state.half === 2`)의 `idle`/`voting` 중,
**1인당 라운드당 1회** 원하는 층에 도둑을 배치할 수 있다(`place-thief`). 배치 직후엔 아무 효과가
없고, **다음 라운드가 시작되는 순간** 실제로 작동한다 (`_startVotingRound`에서 `placedThisRound`
→ `active`로 승격). 작동 중인 도둑이 있는 층에 **상대방**(자기 자신 배치분은 자기 배송에 영향
없음)이 배송하면, 그 송장은 `stolen: true`로 표시되고 **무조건 마이너스 점수**(해당 종류의 실패
페널티, 아래 3.3)로 처리된다 — 원래 이 송장이 우선 택배였어도 2배 적용 안 됨. 배치 허용 횟수는
**매 라운드 리셋**된다(라운드당 1회, 누적 아님) — 사용자가 확인한 답변 그대로.

> **⚠️ 확인 필요 — 도난 페널티 금액은 임의 선택값이다.** 사용자 지시("무조건 확정 마이너스
> 점수")는 "얼마인지"까지는 정하지 않았다. 이 구현은 **가장 보수적인 해석**으로, 새 고정값을
> 만들지 않고 **그 송장 종류의 기존 실패(미배송) 페널티를 그대로 재사용**했다 — 즉 배송은 됐지만
> 도둑맞으면 "미배송과 똑같은 손해"로 취급. 사용자가 다른 금액(예: 항상 -5000원 고정, 또는
> 배송 성공 보상만큼 통째로 마이너스)을 의도했다면 `scoreInvoice()`(`game-room.js` +
> `build_client.py` 양쪽)의 `if (inv.stolen) return -t.penalty;` 한 줄만 고치면 된다.

### 3.3 보드 구성 + 점수 (2026-08-27: 추상 점수 → 원 단위 실금액, 20칸 → 21칸)

| 종류 | 칸 수 | 배송 성공 | 실패(미배송/도난) | 비고 |
|---|---|---|---|---|
| 일반택배 | 5 | **+2,500원** | **-1,000원** | 목적지 무작위 |
| 확정 층수 택배 | **6** | **+3,000원** | **-1,500원** | **칸 자체가 목적지 층을 확정** (B1~5F 각 1칸) |
| 깨지기 쉬운 택배 | 5 | **+5,000원** | **-2,500원** | 목적지 무작위 |
| 귀중품 | 5 | **+10,000원** | **-5,000원** | 목적지 무작위 |

**총 21칸** (`game-data.js`의 `TYPES[].count` 합계). "확정 층수 택배"만 무작위가 아니라, 6개 칸의
`num`(0~5)이 그대로 `FLOORS`의 인덱스가 된다 — 즉 이 종류는 어느 칸을 확보하느냐로 배송지가
미리 정해져 있다 (`game-room.js`의 `randomInvoice`, `t.fixedFloor` 분기). 보드 UI에서도 미확보
상태부터 그 칸에 뜰 층 이름을 미리 보여준다 (`build_client.py`의 `renderBoard`).

**우선 택배 2배**: `priorityInvoiceId`와 일치하는 송장이 배송 성공하면 `reward * PRIORITY_MULTIPLIER`
(현재 2배). 도난당한 경우엔 우선 택배여도 배수 적용 안 됨 — 위 택배도둑 항목 참조.

`pieces` 필드(우봉고 퍼즐 조각 개수 표시용, 예: "조각 3개")는 보드 칸 수(`count`)와 **무관한 별개
숫자**다 — 헷갈리지 말 것.

### 3.4 정보 공개 규칙 (깨뜨리기 쉬움 — 주의)

| 대상 | 엘리베이터 진행 중 | 종료 화면 |
|---|---|---|
| 상대 송장 목록 | **절대 표시 안 함** | **전체 공개** (전반+후반 각각) |
| 상대의 클릭 수 | **절대 표시 안 함** | (해당 없음) |
| 이번 라운드 배송 내역 | **내 것만** | **전체 공개** |
| 상대의 우선 택배 선택 | **절대 표시 안 함** (priority 단계에서도) | **전체 공개** (송장 표에 "· 우선" 표시) |
| 상대의 같은 층 선택(choosing) | **절대 표시 안 함** — 대기 메시지만 | (해당 없음) |
| 상대의 택배도둑 배치 위치 | **절대 표시 안 함** (도둑맞았을 때 "도난당함"만 알림, 누가/어디인지는 비공개) | (해당 없음) |
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
| `set-priority` | `invoiceId` (또는 `null`) | 우선 택배 지정/해제 (priority 단계에서만) |
| `priority-ready` | — | priority 단계 게이트 통과 |
| `choose-delivery` | `invoiceId` | 같은 층 충돌 시 먼저 보낼 송장 선택 (choosing 상태에서만) |
| `place-thief` | `floorIdx` | 택배도둑 배치 (후반, idle/voting 중, 라운드당 1회) |
| `halftime-ready` | — | 하프타임 게이트 통과 → 후반 secure 페이즈 시작 |

서버 → 클라이언트: `{type:"state", state}` (전체 상태) 또는 `{type:"error", code, seat}`.

### 4.3 점수 로직이 두 군데 있다 (의도된 중복)

`scoreInvoice(inv, priorityId)` / `resultLabel(inv)` / `totalScore(seat, state)`가 **`game-room.js`와
`build_client.py` 양쪽에** 있다.
- `game-room.js` 쪽이 **권위 있는 버전**.
- `build_client.py` 쪽은 **표시 전용 복제본**.
- **한쪽을 고치면 반드시 다른 쪽도 똑같이 고칠 것.** (2026-08-27: `stolen` 분기와 `priorityId` 매개변수가
  추가되면서 시그니처가 `scoreInvoice(inv)` → `scoreInvoice(inv, priorityId)`로 바뀌었다 — 두 파일 다 반영됨.)
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
2. **1클릭 = 1칸 즉시 이동 + 양쪽 브로드캐스트** 구조.
3. **정보 공개 규칙** (3.4절).
4. **서버 단일 진실 원칙** (4.1절) — 클라이언트에서 층을 예측/선반영하지 말 것.
5. **`SECURE_PHASE_MS = 3 * 60 * 1000`** 프로덕션 값.
6. **점수 로직 양쪽 동기화** (4.3절).
7. **확정 층수 택배의 결정론적 층 배정** (`t.fixedFloor` 분기) — 무작위로 되돌리지 말 것.
8. **택배도둑은 후반(half 2)에서만** — 전반에 열려 있으면 안 된다 (`state.half !== 2` 가드).
9. **전반/후반 점수는 하프타임에 리셋되지 않고 `halfHistory`에 누적** — 후반 보드/송장만 리셋되고,
   `state.scores`(최종 합산)는 두 하프의 `scores` 합이어야 한다.

---

## 7. 엘리베이터 화면의 구조

`.elev-layout`은 **2열 그리드**다: 왼쪽 220px = 층 표시 + 내 택배 목록, 오른쪽 = 조작/정보 패널.

```
.elev-layout (grid 220px 1fr)
├── .elev-left                     ← 왼쪽 열 전체 (세로 flex)
│   ├── .shaft                     ← 층 표시 껍데기
│   │   └── .shaft-track           ← flex column-reverse (B1이 시각적 맨 아래)
│   │       └── .floor-stop × 6    ← 층 한 줄. 현재 층에만 .current
│   │           └── .car           ← 현재 층에만 보이는 작은 발광 마커
│   └── .player-col.me             ← 내 택배 목록. 층 표시 바로 밑 (2026-08-27 이동)
│       └── .invoice-list          ← 상대 목록은 절대 렌더 안 함 (3.4절)
└── (오른쪽 카드)
    ├── .round-pill            "라운드 N / 5"
    ├── 현재 층 텍스트          ← 왼쪽 층 표시와 별개로 층 이름을 한 번 더 명시
    ├── .vote-buttons          ▲위로 / ▼아래로
    ├── .key-hint              "키보드 ↑/↓로도..." (클릭 카운트는 표시 안 함 — 아래 참고)
    ├── #round-clock           남은 시간
    ├── .round-result          라운드 결과 + .delivered-callout
    └── .ready-row             준비 칩
```

**현재 층 한 줄만 강조하는 단순한 표시다.** `.floor-stop.current`에 금색 배경 + 글자색 +
발광하는 `.car` 마커. 채워 올라가는 "게이지" 형태가 **아니다** — 한때 그런 버전이 있었지만
(아래쪽부터 현재 층까지 전체를 금색으로 채우는 방식) 사용자 피드백으로 되돌렸다: "진행도"처럼
읽혀서, 실시간으로 정확히 한 칸씩 움직이는 지금 방식과는 맞지 않는 은유였다. **다시 채움 방식으로
바꾸지 말 것** — 명시적으로 되돌린 결정이다.

`renderShaft(floorIdx)`는 매 상태 브로드캐스트마다 `FLOORS`를 순회하며 `i === floorIdx`인
칸에만 `.current`를 붙인다. 클라이언트 쪽 애니메이션이나 트랜지션 트릭이 없다 — `floorIdx`가
바뀌면 다음 렌더에서 그냥 그 줄이 켜진다. (DOM을 통째로 다시 그리는 구조라 CSS transition을
걸어도 어차피 재생되지 않는다 — 애초에 시도하지 않는 편이 낫다.)

> **클릭 카운트 UI 제거됨** (2026-08-27). 예전엔 오른쪽 패널에 `.vote-count-row`로 "내 클릭 수"를
> `▲N ▼N`으로 보여줬는데, 사용자 요청으로 완전히 뺐다. 서버 상태(`elevator.votes`)에는 여전히
> 클릭 카운터가 남아 있다(라운드 로그용, `game-room.js`는 안 건드림) — **화면에만 안 그린다.**

> **2026-08-27 추가**: 오른쪽 카드에 두 가지가 상태에 따라 더 붙는다.
> - `.choice-box` (같은 층 충돌 시, `el.state === "choosing"`일 때만) — `renderElevator` 안에서
>   voting/result 렌더보다 먼저 분기해서 처리하고 즉시 `return`한다.
> - `.thief-box` (후반의 idle/voting 상태에서만, `renderThiefBox(st, seat)`) — 전반에는 아예
>   렌더되지 않는다 (`st.half !== 2`면 빈 문자열 반환).

관련 코드 위치 (전부 `build_client.py`):
- CSS: `HEAD_HTML` 안, `.elev-layout` ~ `.elev-left .invoice .sticker` 부근, `.shaft` ~ `.floor-stop.current .car`,
  `.choice-box`/`.thief-box`/`.halftime-*` (2026-08-27 추가분)
- 렌더: `APP_JS_TEMPLATE` 안 `renderElevator` (왼쪽 열 조립 + choosing/thief 분기), `renderShaft(floorIdx)`,
  `renderThiefBox`, `renderPriority`, `renderHalftime`

> **주의 1**: `.shaft-track`이 `flex-direction: column-reverse`라 **DOM 순서(B1→5F)와 화면 순서(5F→B1)가 반대**다.
> `querySelectorAll(".floor-stop")[i]`는 화면 위치와 무관하게 `FLOORS[i]`에 대응한다. 테스트가 이 전제에 의존한다.
>
> **주의 2**: 클라이언트에서 층을 **미리 움직이지 말 것**. `floorIdx`는 서버 값을 그대로 그린다.
> 부드럽게 만들겠다고 낙관적 업데이트를 넣으면 상대 화면과 어긋난다 (4.1절).

`test_nudge.js`가 `.floor-stop.current`의 텍스트(어느 층인지)와 개수(항상 정확히 1개)를
검증하고, B1/5F clamp도 확인한다.

---

## 8. 참고: Render 무료 플랜 제약

- 15분 무요청 시 서버가 잠들고, 다음 접속 시 깨어나는 데 **약 1분**. 실제 운영 전에 링크를 한 번 열어 깨워둘 것.
- 깨어나면 진행 중이던 방/점수는 사라진다 (메모리 저장이므로 구조적 특성).
- 게임 중에는 소켓이 계속 열려 있어 잠들지 않는다.
