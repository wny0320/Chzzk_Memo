# CHZZK Live Memo Marker

CHZZK 라이브/VOD 시청 중 메모와 카테고리를 기록하고, VOD 타임라인 마커로 다시 이동할 수 있게 도와주는 Chrome Extension입니다.

> 이 프로젝트는 **오픈소스**이며, **CHZZK(치지직) 공식 제품이 아닌 비공식 확장 프로그램**입니다.
>
> 이 저장소는 **바이브 코딩(Vibe Coding)** 방식으로 빠르게 실험·개선하며 개발한 프로젝트입니다.
>
> 개발 과정에서 **Cursor AI를 적극 활용한 AI-assisted 바이브 코딩 프로젝트**임을 명시합니다.

## 주요 기능

- 라이브/다시보기 시점에 맞춰 메모 저장
- 라이브 카테고리 자동 기록 및 변경 감지
- VOD 진행바 타임라인 마커 표시
- 마커 클러스터 목록에서 원하는 시점으로 즉시 이동
- 댓글의 타임라인(`HH:MM:SS`, `H:MM:SS`, `MM:SS`, `M:SS`)을 세션으로 가져오기
- 팝업에서 스트리머/세션 단위 기록 조회, 수정, 삭제
- TXT보내기/가져오기 및 클립보드 복사
- 메모 단축키 커스터마이징

## 권한

- `storage`: 메모/세션/설정 로컬 저장
- `downloads`: TXT보내기 저장
- `host_permissions`: `https://chzzk.naver.com/*`

## 개인정보 및 데이터 처리

- 본 확장은 사용자 기록 데이터를 `chrome.storage.local`에 저장합니다.
- 별도의 외부 서버로 전송하지 않습니다.

## 설치(개발자 모드)

1. Chrome에서 `chrome://extensions` 열기
2. 우측 상단 **개발자 모드** 활성화
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. 이 저장소를 클론했다면 **`Chzzk_Memo` 폴더(저장소 루트)** 를 선택합니다.

## 수정 이력 (버그 수정)

### 라이브 카테고리·타임라인 기록 (`content.js`)

| 증상 | 원인 | 조치 |
|------|------|------|
| **카테고리에 채팅 닉네임·채팅 내용이 저장됨** | `getDefaultCategory()`가 문서 전역의 `a, span, div`를 훑은 뒤, 짧은 텍스트 중 키워드(게임·롤 등)가 맞는 **첫 노드**를 카테고리로 채택해 채팅 한 줄과 충돌함 | 전역 키워드 스캔 제거. 방송 정보 줄(`video_information_*` 등) 우선, `a[href*='/category/']` 위주. 채팅·댓글 패널 subtree는 후보에서 제외(`isLikelyChatOrCommentSubtree`) |
| **카테고리 시각이 방송 경과가 아니라 시청·재생 기준처럼 어긋남** | 방송 경과 시각을 페이지 전역의 `video_information_count` span 중 **첫 번째 시계 문자열**로만 판별해 오탐 가능. DOM 실패 시 `video.currentTime` 폴백은 라이브 HLS에서 시청자 기준에 가깝게 동작할 수 있음 | `video_information_row` / `data` / `status` 안으로 스코프 한정. **`스트리밍`·`streaming`·`방송 중` 등 라벨**이 있는 span의 시각을 우선 파싱한 뒤, 같은 영역 내 일반 시계 문자열로 재시도 |

## 배포 전 체크

- `manifest.json`의 `version` 증가
- 불필요한 개발용 파일 제외
- CHZZK 비공식 고지 유지

## 라이선스

이 프로젝트는 [MIT License](./LICENSE)로 배포됩니다.
