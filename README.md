# CHZZK Live Memo Marker

CHZZK 라이브/VOD 시청 중 메모와 카테고리를 기록하고, VOD 타임라인 마커로 다시 이동할 수 있게 도와주는 Chrome Extension입니다.

> 이 프로젝트는 **오픈소스**이며, **CHZZK(치지직) 공식 제품이 아닌 비공식 확장 프로그램**입니다.

## 주요 기능

- 라이브/다시보기 시점에 맞춰 메모 저장
- 라이브 카테고리 자동 기록 및 변경 감지
- VOD 진행바 타임라인 마커 표시
- 마커 클러스터 목록에서 원하는 시점으로 즉시 이동
- 댓글의 타임라인(`HH:MM:SS`, `H:MM:SS`, `MM:SS`, `M:SS`)을 세션으로 가져오기
- 팝업에서 스트리머/세션 단위 기록 조회, 수정, 삭제
- TXT 내보내기/가져오기 및 클립보드 복사
- 메모 단축키 커스터마이징

## 권한

- `storage`: 메모/세션/설정 로컬 저장
- `downloads`: TXT 내보내기 저장
- `host_permissions`: `https://chzzk.naver.com/*`

## 개인정보 및 데이터 처리

- 본 확장은 사용자 기록 데이터를 `chrome.storage.local`에 저장합니다.
- 별도의 외부 서버로 전송하지 않습니다.

## 설치(개발자 모드)

1. Chrome에서 `chrome://extensions` 열기
2. 우측 상단 **개발자 모드** 활성화
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. 이 폴더(`chrome_extension`) 선택

## 배포 전 체크

- `manifest.json`의 `version` 증가
- 불필요한 개발용 파일 제외
- CHZZK 비공식 고지 유지

## 라이선스

이 프로젝트는 [MIT License](./LICENSE)로 배포됩니다.
