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

## 변경 이력

- 버그 수정·버전별 패치 요약은 **[CHANGELOG.md](./CHANGELOG.md)** 에 둡니다.
- GitHub에서 태그 단위로 보고 싶다면 **[Releases](https://github.com/wny0320/Chzzk_Memo/releases)** 를 사용합니다. 새 버전을 낼 때는 `CHANGELOG.md` 내용을 Release 본문에 맞춰 붙이면 됩니다.

## 개발자 참고 (로컬)

배포·스토어 제출 전에 직접 확인할 항목은 공개 README 대신 로컬 파일로 둡니다.

1. 저장소 루트의 **[RELEASE_CHECKLIST.local.md.example](./RELEASE_CHECKLIST.local.md.example)** 를 같은 폴더에 **`RELEASE_CHECKLIST.local.md`** 로 복사합니다.
2. 복사한 `RELEASE_CHECKLIST.local.md`에서 체크·메모를 갱신합니다. 이 파일은 **`.gitignore`** 로 Git에 포함되지 않습니다.

## 라이선스

이 프로젝트는 [MIT License](./LICENSE)로 배포됩니다.
