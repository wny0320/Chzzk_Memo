# Chrome Web Store 제출 가이드 (현재 버전)

현재 제출 대상 버전: `0.1.1`

## 1) 업로드 파일

- 업로드 ZIP: `D:\Kirinuki\vod_highlight\chzzk_memo_store_v0.1.1.zip`

ZIP 루트에 아래 파일이 직접 보여야 합니다.

- `manifest.json`
- `content.js`
- `styles.css`
- `popup.html`
- `popup.js`
- `popup.css`
- `icons/icon16.png`
- `icons/icon48.png`
- `icons/icon128.png`

## 2) 스토어 설명에 넣을 권장 문구

- 비공식 고지: `본 확장 프로그램은 CHZZK(치지직) 비공식 확장 프로그램입니다.`
- 핵심 기능: `라이브/VOD 메모·카테고리 기록, VOD 타임라인 마커 이동, TXT 가져오기/내보내기`

## 3) 권한 사유 예시

- `storage`: 메모, 세션, 단축키 설정을 사용자 브라우저에 저장
- `downloads`: 사용자가 직접 요청한 TXT 내보내기 저장
- `https://chzzk.naver.com/*`: 치지직 페이지에서만 동작

## 4) 개인정보처리방침

- 정책 문서: `PRIVACY_POLICY.md`
- 공개 URL로 게시 후 Chrome Web Store 폼의 개인정보처리방침 URL에 입력

## 5) 제출 전 체크

- `manifest.json` 버전 확인 (`0.1.1`)
- 아이콘 3종 로드 확인
- 팝업 링크 동작 확인 (GitHub / Issues)
- 라이브 기록 시간이 방송 경과시간 기준으로 저장되는지 확인
