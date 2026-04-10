# Changelog

이 프로젝트는 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따르며, [Semantic Versioning](https://semver.org/lang/ko/)을 지향합니다.

## [Unreleased]

(아직 배포되지 않은 변경)

## [0.1.2] - 2026-04-10

### 사용자 안내 (제한)

- **라이브 카테고리 자동 기록**은 **일반(기본) 레이아웃**에서만 기대할 수 있습니다. **전체 화면**·**넓은 화면 보기(시어터)** 에서는 치지직 DOM에 카테고리 후보가 잘 붙지 않아 자동 감지·자동 기록이 동작하지 않을 수 있습니다. 방송 **경과 시각** 등은 같은 탭 안 **페이지 DOM·화면에 노출된 텍스트**만 사용합니다(치지직 API 호출 없음).

### Added

- `tabs` 권한: 팝업에서 **현재 활성 탭 URL**로 치지직 VOD 여부를 판별하고, 선택한 세션과 **타임라인 연결**에 사용합니다.
- 팝업 **플레이어 도구 표시** 설정: 메모·타임라인 연결(🔗)을 치지직 플레이어에 보일지 저장(`chzzkPlayerToolsVisibility`). **연결(🔗)은 VOD에서만** 표시합니다.
- 팝업에서 현재 탭이 치지직 `/video/…`일 때, 선택 세션으로 타임라인 연결(`tabs` 우선, 실패 시 `chzzkActivePageContext` 폴백).
- **TXT Import** 세션에 VOD 연결 시: 스트리머·세션 제목 반영 및 저장소 갱신 전 **확인 대화상자**(원본 TXT는 자동 변경 없음).
- 팝업 **라이브 카테고리 자동 감지 ON/OFF** (`chzzkCategoryAutoDetect`, 기본 ON). 끄면 주기 감시·진입 시 자동 기록이 멈추고, 다시 켜면 라이브 탭에서 즉시 재개합니다.

### Changed

- **README**·**개인정보처리방침**: `https://chzzk.naver.com/*` 범위만 사용, **치지직 API·별도 원격 수집 없음**, `tabs`·플레이어 버튼·카테고리 자동 감지 설정 반영.
- 팝업·연결 패널 **스타일** 보강(`popup.css`, `styles.css`).
- VOD 타임라인 마커·팝업 목록에서 카테고리 자동 기록 항목을 **「카테고리」/「카테고리 변경」** 과 이름으로 구분해 표시.

### Fixed

- **라이브 카테고리 오탐**: 카테고리 자동 기록에 채팅 닉네임·채팅 내용이 들어가던 문제.
  - *원인*: `getDefaultCategory()`가 문서 전역의 `a, span, div`를 훑은 뒤, 짧은 텍스트 중 키워드(게임·롤 등)가 맞는 첫 노드를 카테고리로 채택해 채팅 한 줄과 충돌.
  - *조치*: 전역 키워드 스캔 제거. 방송 정보 줄(`video_information_*` 등) 우선, `a[href*='/category/']` 위주. 채팅·댓글 패널 subtree는 후보에서 제외(`isLikelyChatOrCommentSubtree`).
- **라이브 카테고리 시각**: 방송 경과가 아니라 시청·재생 기준처럼 어긋나던 문제.
  - *원인*: 방송 경과 시각을 페이지 전역의 `video_information_count` span 중 첫 시계 문자열로만 판별해 오탐 가능. DOM 실패 시 `video.currentTime` 폴백은 라이브 HLS에서 시청자 기준에 가깝게 동작할 수 있음.
  - *조치*: `video_information_row` / `data` / `status` 안으로 스코프 한정. `스트리밍`·`streaming`·`방송 중` 등 라벨이 있는 span의 시각을 우선 파싱한 뒤, 같은 영역 내 일반 시계 문자열로 재시도.
- **라이브 경과 시각**: 넓은 화면·전체 화면용 **`live_information_player_*`** 등 DOM을 추가로 활용하고, `스트리밍 중` 등 **라벨이 붙은 시계 텍스트**를 우선합니다. 인라인 JSON `openDate`·짧은 `MutationObserver` 프로브·앵커 캐시 재검증을 보강했습니다.
- 인라인 스크립트 등에서 읽은 **`"YYYY-MM-DD HH:mm:ss"` 형식 `openDate`** 파싱 보정.
- **라이브 카테고리·게임 링크**: 위 오탐 방지 조치에 더해 `live_information_player_*` 영역, 인라인 스크립트의 `liveCategoryValue`·`categoryValue` 등 JSON 패턴, `chzzk.naver.com/category/`·`/category/` 셀렉터를 보강했습니다.
- **플레이어 UI**: 타임라인 연결 버튼을 항상 DOM에 두고 **VOD에서만** 표시해 마운트 시점 오인을 줄였습니다.
- **팝업**: 푸터 토글 레이아웃, 확장 팝업에서 높이가 무너지지 않도록 **`vh` 의존 제거**, VOD 연결 패널 상시 표시·비활성 처리, 확인 모달 버튼 문구 정리.
- **`#__NEXT_DATA__` 전용 파싱 분기** 제거, 인라인 스크립트 등 기존 경로로 통합.

GitHub에서 버전 태그(예: `v0.1.2`)를 만들면 [Compare](https://github.com/wny0320/Chzzk_Memo/compare) 화면으로 릴리스 간 diff를 볼 수 있습니다.
