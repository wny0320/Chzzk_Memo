# Changelog

이 프로젝트는 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따르며, [Semantic Versioning](https://semver.org/lang/ko/)을 지향합니다.

## [Unreleased]

(아직 배포되지 않은 변경)

## [0.1.2] - 2026-04-10

### Fixed

- **라이브 카테고리 오탐**: 카테고리 자동 기록에 채팅 닉네임·채팅 내용이 들어가던 문제.
  - *원인*: `getDefaultCategory()`가 문서 전역의 `a, span, div`를 훑은 뒤, 짧은 텍스트 중 키워드(게임·롤 등)가 맞는 첫 노드를 카테고리로 채택해 채팅 한 줄과 충돌.
  - *조치*: 전역 키워드 스캔 제거. 방송 정보 줄(`video_information_*` 등) 우선, `a[href*='/category/']` 위주. 채팅·댓글 패널 subtree는 후보에서 제외(`isLikelyChatOrCommentSubtree`).
- **라이브 카테고리 시각**: 방송 경과가 아니라 시청·재생 기준처럼 어긋나던 문제.
  - *원인*: 방송 경과 시각을 페이지 전역의 `video_information_count` span 중 첫 시계 문자열로만 판별해 오탐 가능. DOM 실패 시 `video.currentTime` 폴백은 라이브 HLS에서 시청자 기준에 가깝게 동작할 수 있음.
  - *조치*: `video_information_row` / `data` / `status` 안으로 스코프 한정. `스트리밍`·`streaming`·`방송 중` 등 라벨이 있는 span의 시각을 우선 파싱한 뒤, 같은 영역 내 일반 시계 문자열로 재시도.

GitHub에서 버전 태그(예: `v0.1.2`)를 만들면 [Compare](https://github.com/wny0320/Chzzk_Memo/compare) 화면으로 릴리스 간 diff를 볼 수 있습니다.
