const STORAGE_KEY = "chzzkMemoSessions";
const VOD_BINDING_KEY = "chzzkVodBindings";
/** 팝업이 현재 탭의 VOD/라이브와 동일한 세션을 고르기 위한 힌트 (storage) */
const ACTIVE_PAGE_CONTEXT_KEY = "chzzkActivePageContext";
const CATEGORY_STATE_KEY = "chzzkCategoryState";
const LIVE_START_CACHE_KEY = "chzzkLiveStartCache";
const MEMO_HOTKEY_KEY = "chzzkMemoHotkey";

/** 치지직 플레이어 기본 조작과 겹치는 키 — 단축키로 지정 불가 (Cheese-PIP 도킹 대상 `.pzp-pc` 영역과 동일하게 플레이어·하단바에서만 단축키 처리). */
const CHZZK_MEMO_RESERVED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "KeyK",
  "Space",
  "KeyM",
  "KeyT",
  "KeyF",
  "KeyJ"
]);

const DEFAULT_MEMO_HOTKEY = {
  altKey: true,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  code: "KeyN"
};

/**
 * 기본 임계값(라이브/폴백 경로).
 * VOD는 아래 show/hide 분리 임계값(히스테리시스)을 사용.
 */
const PZP_CHROME_SHOW_MIN_COMPOUND = 0.42;
/** VOD: OFF→ON — early·seek 중 하나라도 이 이상이면 표시(OR). 0.08이면 로그상 ~191ms(0.077)에서 한 프레임 밀릴 수 있어 0.06 */
const PZP_VOD_SHOW_MIN_COMPOUND = 0.06;
/** VOD: ON 상태 유지(ON→OFF)는 seek 기준으로 좀 더 보수적으로 내려가 깜빡임 방지 */
const PZP_VOD_HIDE_MIN_COMPOUND = 0.35;
/** 기본 클러스터 간격(초). 실제값은 duration 기반으로 가변 확장됨. */
const VOD_MARKER_CLUSTER_GAP_SEC = 22;
/**
 * 진행 바에서 두 마커 중심이 이 픽셀 이내로 보이면 한 클러스터로 병합.
 * 긴 VOD에서는 같은 픽셀에 가깝게 쌓이는 초 범위가 커지므로, 아래 병합 로직에서 초 단위 상한을 둠.
 */
const VOD_MARKER_MERGE_MAX_CENTER_PX = 52;
/** 픽셀→초 환산 후에도 이 초를 넘기면 병합하지 않음 (장시간 VOD에서 무관한 메모까지 묶이는 것 방지) */
const VOD_MARKER_MERGE_CENTER_SEC_CAP = 280;

let memoHotkeyConfig = { ...DEFAULT_MEMO_HOTKEY };

let pageInfo = getPageInfo();
let lastHref = location.href;
let uiMounted = false;
let markerRafId = null;
let markerRenderTimer = null;
let controlsHideTimer = null;
let lastMouseX = 0;
let lastMouseY = 0;
let toolsRelocateTimer = null;
let extensionContextDead = false;
let playerUiVisibilityCleanup = null;
/** `localStorage.setItem("cmmDebugPzp","1")` 일 때만 `syncOverlayVisibility`에서 [CMM PZP] 로그 출력 */
let cmmDebugPzpLastShow = null;
let cmmDebugPzpLastCompound = null;
/** `getVideo()`로 마지막으로 UI를 붙인 `<video>` — PIP·VOD 전환 시 참조가 바뀌면 재마운트 */
let lastBoundVideoEl = null;
/** 같은 video 노드라도 blob/src가 바뀌면(치지직 미니·내부 플레이어) UI를 다시 붙임 */
let lastBoundVideoSrcKey = "";
/** VOD 마커 클러스터 팝오버 (document 이벤트 정리용) */
let clusterPopoverCleanup = null;
let clusterPopoverAnchor = null;
/** 마커·클러스터 목록 위에 포인터가 있으면 마커 레이어를 PZP 숨김과 무관하게 유지 */
let cmmPointerOverMarkerUi = false;
/** 마커 호버 중 PZP에 합성 이동 이벤트를 보내 하단바 타이머를 깨우기 위한 스로틀 */
let lastCmmPzpNudgeMs = 0;
/** VOD 댓글 타임라인 → 세션 가져오기 버튼 (MutationObserver) */
let commentImportObserver = null;
let commentImportDebounceTimer = null;
/** 팝업 동기화용 — 동일 컨텍스트면 storage 쓰기 생략 */
let lastPublishedPageContextJson = "";
/** 세션 배열 read-modify-write 경쟁 방지 (연속 메모·병합·upsert 충돌로 분리/유실 방지) */
let sessionStorageChain = Promise.resolve();

function runSessionStorageLocked(fn) {
  const next = sessionStorageChain.then(() => fn());
  sessionStorageChain = next.catch(() => {});
  return next;
}

function mergeSessionEntryLists(a, b) {
  const dedup = new Map();
  for (const e of [...(a || []), ...(b || [])]) {
    const k = e.id ? `id:${e.id}` : `legacy:${e.sec}:${e.type}:${(e.text || "").slice(0, 120)}`;
    if (!dedup.has(k)) dedup.set(k, e);
  }
  return Array.from(dedup.values()).sort((a, b) => {
    if (a.sec !== b.sec) return a.sec - b.sec;
    return String(a.type).localeCompare(String(b.type));
  });
}

/** 동일 sessionId가 배열에 중복 저장된 경우(경쟁 조건) 항목만 합침 */
function dedupeSessionsBySessionId(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const id = s.sessionId;
    const cur = map.get(id);
    if (!cur) {
      map.set(id, { ...s, entries: [...(s.entries || [])] });
      continue;
    }
    const mergedEntries = mergeSessionEntryLists(cur.entries, s.entries);
    const c0 = cur.createdAt;
    const c1 = s.createdAt;
    const createdAt =
      Number.isFinite(c0) && Number.isFinite(c1)
        ? Math.min(c0, c1)
        : Number.isFinite(c0)
          ? c0
          : c1;
    map.set(id, {
      ...cur,
      ...s,
      entries: mergedEntries,
      updatedAt: Math.max(cur.updatedAt || 0, s.updatedAt || 0),
      ...(Number.isFinite(createdAt) ? { createdAt } : {})
    });
  }
  return Array.from(map.values());
}

function isExtensionContextValid() {
  if (extensionContextDead) return false;
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch {
    extensionContextDead = true;
    return false;
  }
}

function tearDownAfterInvalidExtensionContext() {
  extensionContextDead = true;
  try {
    chrome.storage.onChanged.removeListener(onMemoHotkeyStorageChanged);
    chrome.storage.onChanged.removeListener(onSessionsStorageChanged);
  } catch (_) {
    /* ignore */
  }
  closeClusterPopover({ releaseMarkerHoverHold: true });
  stopCommentImportFeature();
  stopVodMarkerLoop();
  clearToolsRelocateTimer();
  clearPlayerUiVisibilityListeners();
  clearMarkerUiPointerListeners();
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
}

function isExtensionInvalidatedError(err) {
  const msg = err?.message || String(err || "");
  return /extension context invalidated|context invalidated/i.test(msg);
}

function handleExtensionAsyncError(err) {
  if (isExtensionInvalidatedError(err)) tearDownAfterInvalidExtensionContext();
}

function safeRenderVodMarkers() {
  void renderVodMarkers().catch(handleExtensionAsyncError);
}

void boot().catch(handleExtensionAsyncError);

function isInsideCmmMarkerUi(el) {
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest("#cmm-marker-layer") || el.closest("#cmm-marker-cluster-pop"));
}

function onDocumentPointerOutForMarkerUi(ev) {
  if (pageInfo.mode !== "vod") return;
  if (!isInsideCmmMarkerUi(ev.target)) return;
  const to = ev.relatedTarget;
  if (isInsideCmmMarkerUi(to)) return;
  cmmPointerOverMarkerUi = false;
  lastCmmPzpNudgeMs = 0;
  syncOverlayVisibility();
}

function onDocumentPointerOverForMarkerUi(ev) {
  if (pageInfo.mode !== "vod") return;
  if (!isInsideCmmMarkerUi(ev.target)) return;
  lastMouseX = ev.clientX;
  lastMouseY = ev.clientY;
  if (!cmmPointerOverMarkerUi) {
    cmmPointerOverMarkerUi = true;
    lastCmmPzpNudgeMs = 0;
    syncOverlayVisibility();
  }
}

function onDocumentPointerMoveForMarkerUi(ev) {
  if (pageInfo.mode !== "vod" || !cmmPointerOverMarkerUi) return;
  if (!isInsideCmmMarkerUi(ev.target)) return;
  lastMouseX = ev.clientX;
  lastMouseY = ev.clientY;
}

/**
 * 치지직 PZP는 신뢰된 포인터 이벤트만 쓸 수 있어 완벽히 맞출 수는 없음.
 * 마커(확장 오버레이) 위에만 있을 때 하단바 타이머가 멈추지 않는 경우가 있어,
 * 플레이어 쪽으로 합성 mouse/pointer move를 스로틀해 크롬을 다시 올리도록 시도.
 */
function nudgePzpChromeWhileHoveringMarkers() {
  if (pageInfo.mode !== "vod" || !cmmPointerOverMarkerUi) return;
  const tools = document.getElementById("cmm-player-tools");
  if (!tools?.classList.contains("cmm-in-controls")) return;

  const now = performance.now();
  if (now - lastCmmPzpNudgeMs < 90) return;
  lastCmmPzpNudgeMs = now;

  const x = lastMouseX;
  const y = lastMouseY;
  const root = findPzpPlayerScope();
  const video = getVideo();
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y
  };

  const dispatchMouse = (el) => {
    if (!el) return;
    try {
      el.dispatchEvent(new MouseEvent("mousemove", base));
    } catch (_) {
      /* ignore */
    }
  };

  try {
    const top = document.elementFromPoint(x, y);
    if (top && typeof top.closest === "function" && top.closest(".pzp-pc")) {
      dispatchMouse(top);
    }
  } catch (_) {
    /* ignore */
  }
  dispatchMouse(root);
  dispatchMouse(video);

  if (typeof PointerEvent === "undefined") return;
  const ptr = {
    ...base,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    buttons: 0
  };
  const dispatchPtr = (el) => {
    if (!el) return;
    try {
      el.dispatchEvent(new PointerEvent("pointermove", ptr));
    } catch (_) {
      /* ignore */
    }
  };
  dispatchPtr(root);
  dispatchPtr(video);
}

function installMarkerUiPointerListeners() {
  document.addEventListener("pointerout", onDocumentPointerOutForMarkerUi, true);
  document.addEventListener("pointerover", onDocumentPointerOverForMarkerUi, true);
  document.addEventListener("pointermove", onDocumentPointerMoveForMarkerUi, true);
}

function clearMarkerUiPointerListeners() {
  document.removeEventListener("pointerout", onDocumentPointerOutForMarkerUi, true);
  document.removeEventListener("pointerover", onDocumentPointerOverForMarkerUi, true);
  document.removeEventListener("pointermove", onDocumentPointerMoveForMarkerUi, true);
}

const CMM_COMMENT_ROW_SELECTORS = [
  "[class*='comment_list'] li",
  "[class*='CommentList'] li",
  "[class*='comment-list'] li",
  "[class*='video_comment'] li",
  "[class*='VideoComment'] li",
  "section[class*='comment'] ul li",
  "main [class*='comment'] li",
  "[class*='comment_list'] > div",
  "[class*='CommentList'] > div",
  "[class*='comment_item']",
  "[class*='CommentItem']",
  "[class*='video_comment'] [class*='item']",
  "article[class*='comment']",
  "main [class*='Comment'] [class*='item']"
];

const CMM_REPLY_SUBTREE_SELECTORS = [
  "[class*='reply_list']",
  "[class*='ReplyList']",
  "[class*='comment_reply']",
  "[class*='CommentReply']",
  "[class*='replies']",
  "[class*='ReplyItem']",
  "[class*='reply_item']",
  "[class*='nested_comment']",
  "[class*='NestedComment']",
  "[data-testid*='reply']"
].join(", ");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMainCommentTextElement(root) {
  if (!root) return null;
  return (
    root.querySelector(":scope > .comment_item_content__QxOPL .comment_item_text__c6NLq") ||
    root.querySelector(".comment_item_content__QxOPL .comment_item_text__c6NLq") ||
    root.querySelector("[class*='comment_item_text__']") ||
    null
  );
}

function isCommentExpandMoreButton(el) {
  if (!el) return false;
  const raw = (el.textContent || "").trim().replace(/\s+/g, " ");
  const compact = raw.replace(/\s/g, "");
  if (!(raw === "더보기" || compact.endsWith("더보기") || /^\.{2,}더보기/.test(compact))) return false;
  /* 우측 메뉴 버튼(... 아이콘 + blind 더보기)과 구분 */
  if (el.querySelector("svg")) return false;
  return true;
}

function isCommentOverflowMenuButton(el) {
  if (!el) return false;
  const className = String(el.className || "");
  const raw = (el.textContent || "").trim().replace(/\s+/g, " ");
  const hasSvg = Boolean(el.querySelector("svg"));
  const hasBlindMore = Boolean(
    el.querySelector(".blind") && /더보기|more/i.test((el.querySelector(".blind")?.textContent || "").trim())
  );
  if (/comment_item_button_more__/i.test(className) && (hasSvg || hasBlindMore)) return true;
  if (raw === "..." || raw === "⋯" || raw === "⋮" || raw === "︙") return true;
  const ar = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.toLowerCase();
  if (/메뉴|more|menu|ellipsis|신고|차단|options|option/i.test(ar) && !isCommentExpandMoreButton(el)) {
    return true;
  }
  return false;
}

/** 답글 스레드 안의 노드면 true (본편 댓글만 처리) */
function isInsideReplyThread(el) {
  const li = el.closest("li");
  if (!li) return false;
  return Boolean(li.parentElement?.closest("li"));
}

/**
 * 메모로 버튼·텍스트 추출 기준 루트. 답글 li 안이면 null.
 * li 레이아웃이면 최상위 본댓 li.
 */
function getStableCommentRowRoot(el) {
  if (!el) return null;
  if (isInsideReplyThread(el)) return null;
  const li = el.closest("li");
  if (li) return li;
  return el;
}

/** 본문만: 답글·대댓 subtree 제거 후 텍스트 */
function getCommentMainBodyText(root) {
  if (!root) return "";
  const textEl = getMainCommentTextElement(root);
  if (!textEl) return "";
  const clone = textEl.cloneNode(true);
  clone.querySelectorAll(".cmm-comment-import-btn").forEach((b) => b.remove());
  try {
    clone.querySelectorAll(CMM_REPLY_SUBTREE_SELECTORS).forEach((n) => n.remove());
  } catch (_) {
    /* invalid selector in old browsers */
  }
  clone.querySelectorAll("button, [role='button'], a").forEach((b) => {
    const t = (b.textContent || "").trim().replace(/\s+/g, " ");
    if (t === "답글 쓰기" || t === "답글달기" || /^답글\s*달기$/.test(t)) {
      b.remove();
    }
  });
  return (clone.textContent || "").replace(/\s+/g, " ").trim();
}

/** 접힌 본문도 잡기 위해 innerText 우선(답글 subtree 제외) */
function getCommentTimelineProbeText(root) {
  if (!root) return "";
  const textEl = getMainCommentTextElement(root);
  if (!textEl) return "";
  const clone = textEl.cloneNode(true);
  clone.querySelectorAll(".cmm-comment-import-btn").forEach((b) => b.remove());
  try {
    clone.querySelectorAll(CMM_REPLY_SUBTREE_SELECTORS).forEach((n) => n.remove());
  } catch (_) {
    /* ignore */
  }
  return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
}

function isCommentControlInReplyBranch(root, el) {
  const anchor = el.closest(
    "[class*='reply_list'], [class*='ReplyList'], [class*='CommentReply'], [class*='comment_reply']"
  );
  return !!(anchor && root.contains(anchor));
}

/** 본문 접기 `더보기`를 끝까지 클릭해 펼침 (답글 영역 버튼은 제외) */
async function expandCommentMainContent(root) {
  if (!root) return;
  const textEl = getMainCommentTextElement(root);
  if (!textEl) return;
  const maxPasses = 12;
  for (let pass = 0; pass < maxPasses; pass++) {
    const candidates = textEl.querySelectorAll("button, [role='button'], a, span[role='button']");
    let clicked = false;
    for (const b of candidates) {
      if (!textEl.contains(b) || b.classList.contains("cmm-comment-import-btn")) continue;
      if (isCommentControlInReplyBranch(textEl, b)) continue;
      const raw = (b.textContent || "").trim().replace(/\s+/g, " ");
      if (isCommentOverflowMenuButton(b)) continue;
      const ar = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""}`.toLowerCase();
      if (
        /신고|차단|삭제|댓글\s*메뉴|comment\s*menu|ellipsis|more\s*options/i.test(ar) &&
        !/펼치기|expand|내용.{0,6}더|show\s*more/i.test(ar)
      ) {
        continue;
      }
      if (/^메뉴|^more$/i.test(raw)) continue;
      const isExpand = isCommentExpandMoreButton(b) || /펼치기|내용.{0,6}더|show\s*more|expand/i.test(ar);
      if (!isExpand) continue;
      try {
        b.click();
        clicked = true;
        await delay(400);
        break;
      } catch (_) {
        /* ignore */
      }
    }
    if (!clicked) break;
  }
}

/**
 * 문자열 안의 모든 시각 토큰(겹침 없이 왼쪽→오른쪽).
 * `H:MM:SS` / `HH:MM:SS` / `M:SS` / `MM:SS` (두 칸은 분:초, 초≤59).
 */
function scanTimelinesInString(raw) {
  const str = String(raw || "").replace(/\u00a0/g, " ");
  const out = [];
  let i = 0;
  while (i < str.length) {
    const slice = str.slice(i);
    const hms = slice.match(/^(\d{1,2}):(\d{2}):(\d{2})(?!\d)/);
    if (hms) {
      const hh = Number(hms[1]);
      const mm = Number(hms[2]);
      const ss = Number(hms[3]);
      if (
        Number.isFinite(hh) &&
        Number.isFinite(mm) &&
        Number.isFinite(ss) &&
        mm <= 59 &&
        ss <= 59 &&
        hh <= 99
      ) {
        out.push({ index: i, len: hms[0].length, sec: hh * 3600 + mm * 60 + ss });
        i += hms[0].length;
        continue;
      }
    }
    const two = slice.match(/^(\d{1,5}):(\d{2})(?!\d)/);
    if (two) {
      const minutes = Number(two[1]);
      const ss = Number(two[2]);
      const rest = slice.slice(two[0].length);
      if (
        Number.isFinite(minutes) &&
        Number.isFinite(ss) &&
        ss <= 59 &&
        minutes >= 0 &&
        minutes <= 99999 &&
        !/^:\d{2}/.test(rest)
      ) {
        out.push({ index: i, len: two[0].length, sec: minutes * 60 + ss });
        i += two[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** 치지직 댓글/탐라 덤프에서 시각 오른쪽 구간만 메모 본문으로 정리 */
function sanitizeTimelineMemoChunk(raw) {
  let t = String(raw || "").replace(/\u00a0/g, " ");
  const cutCandidates = [
    t.indexOf("답글 쓰기"),
    t.indexOf("답글"),
    t.indexOf("버프")
  ].filter((x) => x >= 0);
  const cutIdx = cutCandidates.length ? Math.min(...cutCandidates) : -1;
  if (cutIdx !== -1) t = t.slice(0, cutIdx);
  const moreIdx = t.indexOf("더보기");
  if (moreIdx !== -1) {
    t = t.slice(moreIdx + "더보기".length);
  }
  t = t.split(/답글\s*\d+버프\d+/)[0];
  t = t.replace(/\[[^\]]*\]/g, " ");
  t = t.replace(/\d+\s*시간\s*전/g, " ");
  t = t.replace(/\d+\s*분\s*전/g, " ");
  t = t.replace(/답글\s*쓰기/g, " ");
  t = t.replace(/답글\s*\d+/g, " ");
  t = t.replace(/버프\d+/g, " ");
  t = t.replace(/\.{2,}/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function filterOutermostRowElements(nodes) {
  const arr = nodes.filter(Boolean);
  const set = new Set(arr);
  return arr.filter((el) => {
    let p = el.parentElement;
    while (p) {
      if (set.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });
}

function isLikelyCommentRow(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.closest("#cmm-editor-panel, #cmm-bind-panel, #cmm-player-tools, #cmm-marker-layer")) {
    return false;
  }
  if (el.closest("nav, header, footer, [role='navigation']")) return false;
  const root = getStableCommentRowRoot(el);
  if (!root) return false;
  const t = getCommentTimelineProbeText(root);
  if (t.length < 3 || t.length > 50000) return false;
  if (scanTimelinesInString(t).length === 0) return false;
  if (root.querySelector(".cmm-comment-import-btn")) return false;
  if (root.dataset.cmmCommentHooked === "1") return false;
  if (!findCommentRowOverflowMenuButton(root)) return false;
  return true;
}

function isCommentRowElement(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === "LI") return true;
  if (tag === "ARTICLE") return true;
  if (tag === "DIV" && el.className && String(el.className).length > 0) return true;
  return false;
}

function gatherVodCommentRowElements() {
  const roots = new Set();
  const tryNode = (node) => {
    if (!isCommentRowElement(node) || !isLikelyCommentRow(node)) return;
    const root = getStableCommentRowRoot(node);
    if (root) roots.add(root);
  };
  for (const sel of CMM_COMMENT_ROW_SELECTORS) {
    try {
      document.querySelectorAll(sel).forEach((node) => tryNode(node));
    } catch (_) {
      /* invalid selector */
    }
  }
  if (roots.size === 0) {
    const main = document.querySelector("main");
    if (main) {
      let n = 0;
      main
        .querySelectorAll("li, article, div[class*='comment'], div[class*='Comment']")
        .forEach((el) => {
          if (n >= 400) return;
          tryNode(el);
          n += 1;
        });
    }
  }
  return filterOutermostRowElements(Array.from(roots));
}

/**
 * 본문 펼치기용 `더보기`가 아니라, 우측 `⋯` / 오버플로 메뉴 버튼만 (그 왼쪽에 메모로 삽입).
 */
function findCommentRowOverflowMenuButton(row) {
  if (!row) return null;
  const header = row.querySelector(":scope > .comment_item_header__kLcEu .comment_item_more__ceoL8");
  if (header) {
    const headerButtons = Array.from(header.querySelectorAll("button, [role='button'], a"));
    for (const b of headerButtons) {
      if (isCommentOverflowMenuButton(b)) return b;
    }
  }
  const all = Array.from(
    row.querySelectorAll("button, [role='button'], a[href='#'], a[role='button']")
  ).filter((b) => !b.classList?.contains?.("cmm-comment-import-btn"));

  for (const b of all) {
    if (isCommentOverflowMenuButton(b)) return b;
  }
  for (const b of all) {
    const raw = (b.textContent || "").trim().replace(/\s+/g, " ");
    if (isCommentExpandMoreButton(b)) continue;
    const ar = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""}`.toLowerCase();
    if (/펼치기|expand|show\s*more|내용.{0,8}더/i.test(ar)) continue;
    if (/메뉴|more|menu|ellipsis|신고|차단|options|option/i.test(ar)) return b;
  }
  const byClass = row.querySelector(
    "button[class*='comment_item_button_more__'], [class*='MoreButton'], [class*='more_button'], [class*='BtnMore'], [class*='MenuButton'], [class*='menu_btn']"
  );
  if (
    byClass &&
    (byClass.tagName === "BUTTON" || byClass.getAttribute("role") === "button" || byClass.tagName === "A")
  ) {
    if (isCommentOverflowMenuButton(byClass)) return byClass;
  }
  const tool = row.querySelector(
    "[class*='header'], [class*='Header'], [class*='toolbar'], [class*='Toolbar'], [class*='action'], [class*='Action'], [class*='top'], [class*='Top']"
  );
  if (tool) {
    const bs = Array.from(tool.querySelectorAll("button, [role='button']")).filter(
      (b) =>
        !b.classList.contains("cmm-comment-import-btn") &&
        (b.textContent || "").trim() !== "더보기" &&
        !(b.textContent || "").trim().endsWith("더보기")
    );
    if (bs.length) return bs[bs.length - 1];
  }
  return null;
}

function attachCommentImportButton(row) {
  const root = getStableCommentRowRoot(row) || row;
  if (!root || isInsideReplyThread(root)) return;
  if (root.querySelector(".cmm-comment-import-btn")) return;
  if (root.dataset.cmmCommentHooked === "1") return;
  const menuBtn = findCommentRowOverflowMenuButton(root);
  if (!menuBtn?.parentNode) return;
  const sourceText = getCommentTimelineProbeText(root);
  if (scanTimelinesInString(sourceText).length === 0) return;

  root.dataset.cmmCommentHooked = "1";
  root.dataset.cmmCommentSource = sourceText;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cmm-comment-import-btn";
  btn.textContent = "타임라인 가져오기";
  btn.title = "이 댓글의 타임라인을 현재 VOD 세션에 추가";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void importCommentRowToVodSession(root).catch(handleExtensionAsyncError);
  });

  menuBtn.parentNode.insertBefore(btn, menuBtn);
}

function scanAndAttachCommentImportButtons() {
  if (!pageInfo.isChzzk || pageInfo.mode !== "vod" || !pageInfo.vodId) return;
  if (!isExtensionContextValid()) return;
  for (const row of gatherVodCommentRowElements()) {
    attachCommentImportButton(row);
  }
}

function scheduleCommentImportScan() {
  if (commentImportDebounceTimer) clearTimeout(commentImportDebounceTimer);
  commentImportDebounceTimer = setTimeout(() => {
    commentImportDebounceTimer = null;
    scanAndAttachCommentImportButtons();
  }, 450);
}

function stopCommentImportFeature() {
  if (commentImportObserver) {
    commentImportObserver.disconnect();
    commentImportObserver = null;
  }
  if (commentImportDebounceTimer) {
    clearTimeout(commentImportDebounceTimer);
    commentImportDebounceTimer = null;
  }
  document.querySelectorAll(".cmm-comment-import-btn").forEach((b) => b.remove());
  document.querySelectorAll("[data-cmm-comment-hooked]").forEach((el) => {
    delete el.dataset.cmmCommentHooked;
    delete el.dataset.cmmCommentSource;
  });
}

function startCommentImportFeature() {
  stopCommentImportFeature();
  if (!pageInfo.isChzzk || pageInfo.mode !== "vod" || !pageInfo.vodId) return;
  scanAndAttachCommentImportButtons();
  const root = document.querySelector("main") || document.body;
  try {
    commentImportObserver = new MutationObserver(() => scheduleCommentImportScan());
    commentImportObserver.observe(root, { childList: true, subtree: true });
  } catch (_) {
    /* ignore */
  }
}

async function importCommentRowToVodSession(row) {
  if (!pageInfo.isChzzk || pageInfo.mode !== "vod") return;
  const root = getStableCommentRowRoot(row) || row;
  if (!root) return;
  await expandCommentMainContent(root);
  await delay(280);
  const source = getCommentMainBodyText(root);
  const matches = scanTimelinesInString(source);
  if (matches.length === 0) {
    toast("타임라인(H:MM:SS 또는 M:SS 등)을 찾을 수 없습니다.");
    return;
  }
  const session = await getConsolidatedVodSession();
  if (!session) {
    toast("세션을 불러올 수 없습니다.");
    return;
  }
  let added = 0;
  let skippedDup = 0;
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].len;
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
    const memo = sanitizeTimelineMemoChunk(source.slice(start, end));
    if (!memo) continue;
    const ok = await appendEntry(session, "memo", memo, matches[i].sec);
    if (ok) added += 1;
    else skippedDup += 1;
  }
  if (added === 0) {
    if (skippedDup > 0) {
      toast("이미 등록된 메모만 있어 추가하지 않았습니다.");
    } else {
      toast("추출된 메모 본문이 없습니다.");
    }
    return;
  }
  toast(added > 1 ? `메모 ${added}건 추가됨` : "메모에 추가됨");
  lastPublishedPageContextJson = "";
  await publishActivePageContext();
  safeRenderVodMarkers();
}

async function boot() {
  if (!pageInfo.isChzzk) return;
  installHistoryHooks();
  installNavigationApiHook();
  window.addEventListener("popstate", () => void onLocationChange().catch(handleExtensionAsyncError));
  await loadMemoHotkeyConfig();
  if (isExtensionContextValid()) {
    try {
      chrome.storage.onChanged.addListener(onMemoHotkeyStorageChanged);
      chrome.storage.onChanged.addListener(onSessionsStorageChanged);
    } catch (_) {
      /* ignore */
    }
  }
  await waitForVideo();
  mountPlayerTools();
  ensureEditorPanel();
  ensureBindPanel();
  ensureVodBlocker();

  if (pageInfo.mode === "live") {
    await ensureLiveCategoryOnJoin();
  }
  if (pageInfo.mode === "vod") {
    await tryAutoBindVod();
    startVodMarkerLoop();
    startCommentImportFeature();
  }

  await publishActivePageContext();

  document.addEventListener("mousemove", recordGlobalPointer, true);
  document.addEventListener("keydown", onGlobalKeydown, true);
  installMarkerUiPointerListeners();

  document.addEventListener(
    "enterpictureinpicture",
    () => {
      closeClusterPopover({ releaseMarkerHoverHold: true });
      lastBoundVideoEl = null;
      lastBoundVideoSrcKey = "";
      requestAnimationFrame(() => {
        reconcileExtensionPlayerUi();
        requestAnimationFrame(() => {
          reconcileExtensionPlayerUi();
          syncOverlayVisibility();
        });
      });
    },
    true
  );
  document.addEventListener(
    "leavepictureinpicture",
    () => {
      closeClusterPopover({ releaseMarkerHoverHold: true });
      lastBoundVideoEl = null;
      lastBoundVideoSrcKey = "";
      requestAnimationFrame(() => {
        reconcileExtensionPlayerUi();
        requestAnimationFrame(() => {
          reconcileExtensionPlayerUi();
          syncOverlayVisibility();
        });
      });
    },
    true
  );
}

function installHistoryHooks() {
  const fire = () => setTimeout(() => void onLocationChange().catch(handleExtensionAsyncError), 0);
  const wrap = (fn) =>
    function () {
      const ret = fn.apply(this, arguments);
      fire();
      return ret;
    };
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
}

/**
 * 치지직 등 최신 SPA는 History API만으로 잡히지 않는 전환이 있음 (Navigation API).
 * `intercept()`는 사용하지 않음 — 사이트 라우팅을 가로채지 않고 URL 반영 후 `onLocationChange`만 호출.
 */
function installNavigationApiHook() {
  try {
    const nav = globalThis.navigation;
    if (!nav || typeof nav.addEventListener !== "function") return;
    nav.addEventListener("navigate", (ev) => {
      try {
        /* 전체 문서 이동은 곧 언로드되므로 생략 (sameDocument 미정의인 구현은 기존처럼 처리) */
        if (ev?.destination && ev.destination.sameDocument === false) return;
        const dest = ev.destination.url;
        if (!dest) return;
        let host = "";
        try {
          host = new URL(dest).hostname;
        } catch {
          return;
        }
        if (!/chzzk\.naver\.com$/i.test(host)) return;
        setTimeout(() => void onLocationChange().catch(handleExtensionAsyncError), 0);
      } catch (e) {
        handleExtensionAsyncError(e);
      }
    });
  } catch (_) {
    /* Navigation API 미지원 브라우저 */
  }
}

async function onLocationChange() {
  const href = location.href;
  const fresh = getPageInfo();
  if (
    href === lastHref &&
    fresh.vodId === pageInfo.vodId &&
    fresh.liveId === pageInfo.liveId &&
    fresh.mode === pageInfo.mode
  ) {
    return;
  }
  lastHref = href;
  pageInfo = fresh;
  if (!pageInfo.isChzzk) return;

  document.getElementById("cmm-editor-panel")?.classList.remove("show");
  document.getElementById("cmm-bind-panel")?.classList.remove("show");
  setVodBlocker(false);

  stopCommentImportFeature();
  stopVodMarkerLoop();
  clearToolsRelocateTimer();
  clearPlayerUiVisibilityListeners();
  clearMarkerLayer();
  uiMounted = false;
  lastBoundVideoEl = null;
  lastBoundVideoSrcKey = "";
  cmmPointerOverMarkerUi = false;
  document.getElementById("cmm-player-tools")?.remove();

  await waitForVideo();
  mountPlayerTools();
  if (pageInfo.mode === "live") {
    await ensureLiveCategoryOnJoin();
  }
  if (pageInfo.mode === "vod") {
    await tryAutoBindVod();
    startVodMarkerLoop();
    startCommentImportFeature();
  }
  syncOverlayVisibility();
  await publishActivePageContext();
}

/** 히스토리 훅이 빠진 네비게이션 대비: VOD 마커 루프에서 주기적으로 호출 */
async function syncPageInfoIfDrifted() {
  if (!pageInfo.isChzzk) return;
  await onLocationChange();
}

async function tryAutoBindVod() {
  if (pageInfo.mode !== "vod" || !pageInfo.vodId) return;
  const bindings = await getStorage(VOD_BINDING_KEY, {});
  if (!bindings[pageInfo.vodId]) return;
  const sessions = await getSessions();
  const session = sessions.find((s) => s.sessionId === bindings[pageInfo.vodId]);
  if (!session) return;
  const toastKey = `cmm_auto_vod_toast_${pageInfo.vodId}`;
  try {
    if (!sessionStorage.getItem(toastKey)) {
      sessionStorage.setItem(toastKey, "1");
      toast("이 VOD는 저장된 세션과 자동 연결되었습니다.");
    }
  } catch (_) {
    toast("이 VOD는 저장된 세션과 자동 연결되었습니다.");
  }
}

function ensureVodBlocker() {
  if (document.getElementById("cmm-vod-blocker")) return;
  const el = document.createElement("div");
  el.id = "cmm-vod-blocker";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  el.addEventListener("click", (e) => e.stopPropagation());
}

function setVodBlocker(on) {
  const el = document.getElementById("cmm-vod-blocker");
  if (!el) return;
  el.classList.toggle("show", Boolean(on));
}

function getPageInfo() {
  const url = new URL(window.location.href);
  const path = url.pathname;
  const liveMatch = path.match(/^\/live\/([^/?#]+)/);
  const vodMatch = path.match(/^\/video\/([^/?#]+)/);

  return {
    isChzzk: /chzzk\.naver\.com$/.test(url.hostname),
    mode: liveMatch ? "live" : vodMatch ? "vod" : "other",
    liveId: liveMatch?.[1] || null,
    vodId: vodMatch?.[1] || null
  };
}

function waitForVideo(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (getVideo()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

function isChzzkMemoCodeReserved(code) {
  return CHZZK_MEMO_RESERVED_CODES.has(code);
}

function normalizeMemoHotkey(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MEMO_HOTKEY };
  let code =
    typeof raw.code === "string" && /^Key[A-Z]$|^Digit[0-9]$/.test(raw.code)
      ? raw.code
      : DEFAULT_MEMO_HOTKEY.code;
  if (isChzzkMemoCodeReserved(code)) code = DEFAULT_MEMO_HOTKEY.code;
  return {
    altKey: Boolean(raw.altKey),
    ctrlKey: Boolean(raw.ctrlKey),
    shiftKey: Boolean(raw.shiftKey),
    metaKey: Boolean(raw.metaKey),
    code
  };
}

function recordGlobalPointer(e) {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}

function shouldIgnoreMemoHotkeyDueToFocus() {
  const ae = document.activeElement;
  if (!ae || ae === document.body || ae === document.documentElement) return false;
  if (ae.closest("#cmm-editor-panel") || ae.closest("#cmm-bind-panel")) return true;
  const tag = ae.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (ae.isContentEditable) return true;
  return false;
}

function formatHotkeyForTip(cfg) {
  const parts = [];
  if (cfg.metaKey) parts.push("Win");
  if (cfg.ctrlKey) parts.push("Ctrl");
  if (cfg.altKey) parts.push("Alt");
  if (cfg.shiftKey) parts.push("Shift");
  let k = cfg.code || "KeyN";
  if (k.startsWith("Key")) k = k.slice(3);
  else if (k.startsWith("Digit")) k = k.slice(5);
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join("+");
}

function matchesMemoHotkey(e, cfg) {
  return (
    e.code === cfg.code &&
    !!e.altKey === !!cfg.altKey &&
    !!e.ctrlKey === !!cfg.ctrlKey &&
    !!e.shiftKey === !!cfg.shiftKey &&
    !!e.metaKey === !!cfg.metaKey
  );
}

async function loadMemoHotkeyConfig() {
  if (!isExtensionContextValid()) return;
  try {
    const stored = await getStorage(MEMO_HOTKEY_KEY, null);
    memoHotkeyConfig = normalizeMemoHotkey(stored);
  } catch (e) {
    handleExtensionAsyncError(e);
    memoHotkeyConfig = { ...DEFAULT_MEMO_HOTKEY };
  }
}

function onMemoHotkeyStorageChanged(changes, area) {
  if (area !== "local" || !changes[MEMO_HOTKEY_KEY]) return;
  memoHotkeyConfig = normalizeMemoHotkey(changes[MEMO_HOTKEY_KEY].newValue);
  applyMemoButtonLabels();
}

/** 팝업 등에서 세션·항목을 수정하면 storage 이벤트로 VOD 마커를 즉시 다시 그림 */
function onSessionsStorageChanged(changes, area) {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  if (pageInfo.mode !== "vod") return;
  safeRenderVodMarkers();
}

function applyMemoButtonLabels() {
  const btn = document.getElementById("cmm-open-memo");
  if (!btn || !memoHotkeyConfig) return;
  const hk = formatHotkeyForTip(memoHotkeyConfig);
  const tip = btn.querySelector(".cmm-pzp-tooltip-memo");
  if (tip) tip.textContent = `메모 (${hk})`;
  btn.setAttribute("aria-label", `메모 추가 (${hk})`);
}

function onGlobalKeydown(e) {
  if (!memoHotkeyConfig || !matchesMemoHotkey(e, memoHotkeyConfig)) return;
  if (shouldIgnoreMemoHotkeyDueToFocus()) return;
  if (document.visibilityState !== "visible") return;
  e.preventDefault();
  openMemoEditor().catch(() => {});
}

function findPzpBottomButtonsRightWithin(root) {
  if (!root || !root.querySelector) return null;
  return (
    root.querySelector(".pzp-pc__bottom-buttons-right") ||
    root.querySelector("[class*='pzp-pc__bottom-buttons-right']") ||
    null
  );
}

/**
 * 현재 비디오가 속한 플레이어의 하단 오른쪽 버튼 영역만 사용.
 * `forVideo`를 넘기면 그때의 `getVideo()`와 동일한 루트를 쓴다 (문서 첫 `.pzp`와 섞이면 reconcile가 매 프레임 remount).
 */
function findPzpBottomButtonsRight(forVideo) {
  const video = forVideo ?? getVideo();
  const root = getPlayerUiRootForVideo(video);
  const scoped = findPzpBottomButtonsRightWithin(root);
  if (scoped) return scoped;
  return (
    document.querySelector(".pzp-pc__bottom-buttons-right") ||
    document.querySelector("[class*='pzp-pc__bottom-buttons-right']") ||
    null
  );
}

function findPzpPlayerScope() {
  const video = getVideo();
  return (
    video?.closest(".pzp-pc") ||
    video?.closest("[class*='webplayer']") ||
    document.querySelector(".pzp-pc") ||
    null
  );
}

function findPzpBottomChromeAnchor() {
  const right = findPzpBottomButtonsRight(getVideo());
  if (!right) return null;
  const scope = findPzpPlayerScope() || document;
  const slider =
    scope.querySelector("[role='slider']") || scope.querySelector("input[type='range']");
  if (!slider) return right.parentElement;

  let el = right.parentElement;
  for (let i = 0; i < 12 && el; i++) {
    if (el.contains(slider) && el.contains(right)) {
      const h = el.getBoundingClientRect().height;
      if (h >= 32 && h <= 360) return el;
    }
    el = el.parentElement;
  }
  return right.parentElement;
}

function insertMemoToolsIntoPzpTarget(target, wrap) {
  if (!target || !wrap) return;
  wrap.classList.add("cmm-in-controls");
  if (target.firstChild) {
    target.insertBefore(wrap, target.firstChild);
  } else {
    target.appendChild(wrap);
  }
}

/** Effective visibility: multiply ancestor opacities (getComputedStyle does not compound for children). */
function isElementVisuallyOpaqueInTree(el) {
  if (!el || el.nodeType !== 1) return true;
  let compound = 1;
  let node = el;
  while (node && node.nodeType === 1) {
    const st = window.getComputedStyle(node);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const o = parseFloat(st.opacity);
    if (!Number.isFinite(o)) return false;
    compound *= o;
    if (compound < 0.02) return false;
    node = node.parentElement;
  }
  return compound >= PZP_CHROME_SHOW_MIN_COMPOUND;
}

function isNativePzpBottomControlsVisible() {
  const right = findPzpBottomButtonsRight(getVideo());
  if (!right) return true;
  const nativeBtn = right.querySelector(
    ".pzp-button, .pzp-pc-ui-button, button[class*='pzp-']"
  );
  let sample = null;
  if (nativeBtn && !nativeBtn.closest("#cmm-player-tools")) {
    sample = nativeBtn;
  } else {
    for (const child of right.children) {
      if (child.id === "cmm-player-tools") continue;
      sample = child;
      break;
    }
  }
  if (!sample) sample = right;
  return isElementVisuallyOpaqueInTree(sample);
}

/** VOD: 하단이 사라질 때 오른쪽 버튼만 남아 불투명으로 보이는 경우가 있어, 시크·하단 박스 기준으로 페이드에 맞춤 */
function findPzpSeekSampleElement() {
  const scope = findPzpPlayerScope() || document;
  const candidates = [
    "[role='slider']",
    "input[type='range']",
    "[class*='progress'][class*='bar']",
    "[class*='seek'][class*='bar']"
  ];
  for (const selector of candidates) {
    const el = scope.querySelector(selector);
    if (!el || !el.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 120 && rect.top > 0) return el;
  }
  for (const selector of candidates) {
    const el = document.querySelector(selector);
    if (!el || !el.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 120 && rect.top > 0) return el;
  }
  return null;
}

/** VOD: 네이티브 하단 크롬이 "보이기 시작"하는 초반 페이드를 잘 반영하는 샘플 */
function findPzpEarlyChromeSampleElement() {
  const scope = findPzpPlayerScope() || document;
  const candidates = [
    ".pzp-pc__bottom-shadow",
    ".pzp-pc-ui-bottom-shadow",
    ".pzp-ui-bottom-shadow",
    ".pzp-ui-progress__wrap",
    ".pzp-pc__vod-time",
    ".pzp-pc__volume-control"
  ];
  for (const selector of candidates) {
    const el = scope.querySelector(selector) || document.querySelector(selector);
    if (!el || !el.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 40 && rect.height > 8) return el;
  }
  return null;
}

/** 부모 체인 곱 불투명도. `display:none` 등이면 null. */
function cmmDebugReadOpacityCompound(el) {
  if (!el || el.nodeType !== 1) return null;
  let compound = 1;
  let node = el;
  while (node && node.nodeType === 1) {
    const st = window.getComputedStyle(node);
    if (st.display === "none" || st.visibility === "hidden") return null;
    const o = parseFloat(st.opacity);
    if (!Number.isFinite(o)) return null;
    compound *= o;
    if (compound < 0.02) return compound;
    node = node.parentElement;
  }
  return compound;
}

/** `isPzpBottomChromeShownForOverlay`와 동일 기준의 샘플 DOM (시크 → 앵커 → 우측 네이티브 버튼). */
function getPzpChromeSampleElementForOverlay() {
  if (pageInfo.mode === "vod") {
    const seek = findPzpSeekSampleElement();
    if (seek) return { el: seek, kind: "seek" };
    const anchor = findPzpBottomChromeAnchor();
    if (anchor?.isConnected) {
      const r = anchor.getBoundingClientRect();
      if (r.height >= 20 && r.width >= 160) return { el: anchor, kind: "anchor" };
    }
  }
  const right = findPzpBottomButtonsRight(getVideo());
  if (!right) return { el: null, kind: "none" };
  const nativeBtn = right.querySelector(
    ".pzp-button, .pzp-pc-ui-button, button[class*='pzp-']"
  );
  let sample = null;
  if (nativeBtn && !nativeBtn.closest("#cmm-player-tools")) {
    sample = nativeBtn;
  } else {
    for (const child of right.children) {
      if (child.id === "cmm-player-tools") continue;
      sample = child;
      break;
    }
  }
  if (!sample) sample = right;
  return { el: sample, kind: "native" };
}

function isPzpBottomChromeShownForOverlay(currentlyVisible = false) {
  if (pageInfo.mode === "vod") {
    const earlyEl = findPzpEarlyChromeSampleElement();
    const seekEl = findPzpSeekSampleElement();
    const early = cmmDebugReadOpacityCompound(earlyEl);
    const seek = cmmDebugReadOpacityCompound(seekEl);
    if (currentlyVisible) {
      /* ON→OFF: seek 우선(안정), 없으면 early */
      const basis = seek ?? early;
      if (basis != null) return basis >= PZP_VOD_HIDE_MIN_COMPOUND;
    } else {
      /* OFF→ON: 둘 중 먼저 올라오는 쪽 반영 — early만 쓰면 seek가 먼저일 때 늦어짐 */
      const showOk =
        (early != null && early >= PZP_VOD_SHOW_MIN_COMPOUND) ||
        (seek != null && seek >= PZP_VOD_SHOW_MIN_COMPOUND);
      if (early != null || seek != null) return showOk;
    }
  }
  const { el } = getPzpChromeSampleElementForOverlay();
  if (!el) return true;
  return isElementVisuallyOpaqueInTree(el);
}

function clearPlayerUiVisibilityListeners() {
  playerUiVisibilityCleanup?.();
  playerUiVisibilityCleanup = null;
}

function clearToolsRelocateTimer() {
  if (toolsRelocateTimer) {
    clearInterval(toolsRelocateTimer);
    toolsRelocateTimer = null;
  }
}

function startToolsRelocateLoop() {
  clearToolsRelocateTimer();
  let attempts = 0;
  toolsRelocateTimer = setInterval(() => {
    reconcileExtensionPlayerUi();
    const wrap = document.getElementById("cmm-player-tools");
    if (!wrap) {
      clearToolsRelocateTimer();
      return;
    }
    const target = findPzpBottomButtonsRight(getVideo());
    if (target && wrap.parentElement !== target) {
      insertMemoToolsIntoPzpTarget(target, wrap);
      const host = getVideo()?.parentElement;
      if (host) host.dataset.cmmUiVisible = "1";
      clearPlayerUiVisibilityListeners();
      syncOverlayVisibility();
      if (pageInfo.mode === "vod") {
        ensureMarkerLayer();
        positionMarkerLayer();
      }
      clearToolsRelocateTimer();
      return;
    }
    attempts += 1;
    if (attempts > 60) clearToolsRelocateTimer();
  }, 400);
}

function getPlayerUiRootForVideo(video) {
  if (!video) return null;
  /* `.pzp-pc` 토큰만: `[class*='pzp-pc']`는 `pzp-pc__video` 등에 걸려 루트가 잘못 잡혀 reconcile가 매프레임 remount */
  return (
    video.closest(".pzp-pc") ||
    video.closest("[class*='webplayer']") ||
    video.parentElement
  );
}

function playerUiContainsTools(video, tools) {
  if (!video || !tools) return false;
  const root = getPlayerUiRootForVideo(video);
  return Boolean(root && root.contains(tools));
}

/**
 * PIP·SPA로 `<video>` 참조나 플레이어 트리가 바뀌면 첫 번째 video만 보던 기존 로직에서 도구가 끊기거나
 * 마커가 다른 타임라인에 붙을 수 있음 → 필요 시 제거 후 다시 마운트.
 */
function reconcileExtensionPlayerUi() {
  if (!pageInfo.isChzzk) return;
  const video = getVideo();
  if (!video) return;

  const srcKey = getVideoSourceKey(video);
  const tools = document.getElementById("cmm-player-tools");
  const toolsOk = Boolean(tools?.isConnected && playerUiContainsTools(video, tools));

  if (toolsOk && video === lastBoundVideoEl && srcKey === lastBoundVideoSrcKey) return;
  if (toolsOk && lastBoundVideoEl == null) {
    lastBoundVideoEl = video;
    lastBoundVideoSrcKey = srcKey;
    return;
  }

  uiMounted = false;
  tools?.remove();
  clearPlayerUiVisibilityListeners();
  clearToolsRelocateTimer();
  clearMarkerLayer();
  mountPlayerTools();
  if (pageInfo.mode === "vod") {
    ensureMarkerLayer();
    positionMarkerLayer();
    void renderVodMarkers();
    scheduleCommentImportScan();
  }
  syncOverlayVisibility();
}

function mountPlayerTools() {
  if (uiMounted) return;

  const video = getVideo();
  if (!video) return;
  uiMounted = true;

  const host = video.parentElement || document.body;
  const pos = window.getComputedStyle(host).position;
  if (pos === "static") host.style.position = "relative";

  const wrap = document.createElement("div");
  wrap.id = "cmm-player-tools";
  wrap.innerHTML = `
    <button type="button" id="cmm-open-memo" class="pzp-button pzp-pc-setting-button pzp-pc__setting-button pzp-pc-ui-button cmm-pzp-btn" aria-label="메모">
      <span class="pzp-button__tooltip pzp-button__tooltip--top cmm-pzp-tooltip-memo"></span>
      <span class="pzp-ui-icon pzp-pc-setting-button__icon cmm-pzp-icon" aria-hidden="true">📄</span>
    </button>
    ${
      pageInfo.mode === "vod"
        ? `<button type="button" id="cmm-open-bind" class="pzp-button pzp-pc-setting-button pzp-pc__setting-button pzp-pc-ui-button cmm-pzp-btn" aria-label="타임라인 연결">
      <span class="pzp-button__tooltip pzp-button__tooltip--top">타임라인 연결</span>
      <span class="pzp-ui-icon pzp-pc-setting-button__icon cmm-pzp-icon" aria-hidden="true">🔗</span>
    </button>`
        : ""
    }
  `;

  const pzpTarget = findPzpBottomButtonsRight(video);
  if (pzpTarget) {
    insertMemoToolsIntoPzpTarget(pzpTarget, wrap);
    host.dataset.cmmUiVisible = "1";
    syncOverlayVisibility();
    if (pageInfo.mode === "vod") {
      ensureMarkerLayer();
      positionMarkerLayer();
    }
  } else {
    host.appendChild(wrap);
    host.dataset.cmmUiVisible = "0";
    bindPlayerUiVisibility(host);
    startToolsRelocateLoop();
  }

  document.getElementById("cmm-open-memo")?.addEventListener("click", () => openMemoEditor().catch(() => {}));
  document.getElementById("cmm-open-bind")?.addEventListener("click", openBindPanel);
  applyMemoButtonLabels();
  lastBoundVideoEl = video;
  lastBoundVideoSrcKey = getVideoSourceKey(video);
}

function ensureEditorPanel() {
  if (document.getElementById("cmm-editor-panel")) return;
  const panel = document.createElement("div");
  panel.id = "cmm-editor-panel";
  panel.innerHTML = `
    <div class="cmm-editor-header">
      <span id="cmm-editor-title">메모 입력</span>
      <button id="cmm-editor-close" class="cmm-mini-btn">닫기</button>
    </div>
    <div id="cmm-editor-time" class="cmm-editor-time"></div>
    <input id="cmm-editor-input" class="cmm-editor-input" type="text" placeholder="내용을 입력하세요" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" name="cmm-memo-body" />
    <div class="cmm-editor-actions">
      <button id="cmm-editor-save" class="cmm-mini-btn">저장</button>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById("cmm-editor-close")?.addEventListener("click", closeEditor);
  document.getElementById("cmm-editor-save")?.addEventListener("click", saveEditorEntry);
  document.getElementById("cmm-editor-input")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void saveEditorEntry().catch(handleExtensionAsyncError);
  });
}

function ensureBindPanel() {
  if (document.getElementById("cmm-bind-panel")) return;
  const panel = document.createElement("div");
  panel.id = "cmm-bind-panel";
  panel.innerHTML = `
    <div class="cmm-editor-header">
      <span>타임라인 연결</span>
      <button id="cmm-bind-close" class="cmm-mini-btn">닫기</button>
    </div>
    <label class="cmm-field-label">스트리머</label>
    <select id="cmm-bind-streamer"></select>
    <label class="cmm-field-label">세션</label>
    <select id="cmm-bind-session"></select>
    <div class="cmm-editor-actions">
      <button id="cmm-bind-save" class="cmm-mini-btn">연결</button>
      <button id="cmm-bind-clear" class="cmm-mini-btn cmm-danger">연결 해제</button>
    </div>
  `;
  document.body.appendChild(panel);
  document.getElementById("cmm-bind-close")?.addEventListener("click", closeBindPanel);
  document.getElementById("cmm-bind-streamer")?.addEventListener("change", renderBindSessionOptions);
  document.getElementById("cmm-bind-save")?.addEventListener("click", bindVodToSelectedSession);
  document.getElementById("cmm-bind-clear")?.addEventListener("click", clearVodBinding);
}

function getVideoSourceKey(video) {
  if (!video) return "";
  try {
    return String(video.currentSrc || video.src || "");
  } catch (_) {
    return "";
  }
}

function getVideo() {
  try {
    const pip = document.pictureInPictureElement;
    if (pip && pip.tagName === "VIDEO" && pip.isConnected) return pip;
  } catch (_) {
    /* ignore */
  }

  const internalVids = Array.from(document.querySelectorAll("video.webplayer-internal-video")).filter(
    (v) => v.isConnected
  );
  /* 치지직 ‘내부 최소화’ 플레이어: 화면이 작아도 이 엘리먼트가 실제 재생 주체 */
  if (internalVids.length === 1) return internalVids[0];
  if (internalVids.length > 1) {
    const areaOf = (v) => {
      const r = v.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    };
    let best = null;
    let bestA = -1;
    for (const v of internalVids) {
      const a = areaOf(v);
      if (a > bestA) {
        bestA = a;
        best = v;
      }
    }
    if (best) return best;
  }

  const inPlayer = Array.from(
    document.querySelectorAll("video.webplayer-internal-video, .pzp-pc video, .pzp video")
  ).filter((v) => v.isConnected);

  const areaOf = (v) => {
    const r = v.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  };

  const pickLargest = (list, minArea) => {
    let best = null;
    let bestA = 0;
    for (const v of list) {
      const a = areaOf(v);
      if (a < minArea) continue;
      if (a > bestA) {
        bestA = a;
        best = v;
      }
    }
    return best;
  };

  const scoped = pickLargest(inPlayer, 80 * 44);
  if (scoped) return scoped;

  const any = Array.from(document.querySelectorAll("video")).filter((v) => v.isConnected);
  return pickLargest(any, 120) || any[0] || null;
}

function getCurrentSecond() {
  const video = getVideo();
  if (!video || Number.isNaN(video.currentTime)) return 0;
  return Math.max(0, Math.floor(video.currentTime));
}

async function getTimelineSecond() {
  if (pageInfo.mode !== "live") return getCurrentSecond();
  const startMs = await getLiveStartMs();
  if (!startMs) return getCurrentSecond();
  return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
}

function getDefaultCategory() {
  const categoryAnchors = Array.from(document.querySelectorAll("a[href*='/category/']"))
    .map((el) => (el.textContent || "").trim())
    .filter(Boolean)
    .filter(isValidCategoryText);
  if (categoryAnchors.length > 0) return categoryAnchors[0];

  const candidates = Array.from(document.querySelectorAll("a, span, div"))
    .map((el) => (el.textContent || "").trim())
    .filter(Boolean)
    .filter((t) => t.length <= 25)
    .filter(isValidCategoryText);
  return candidates.find((t) => /종합게임|게임|음악|토크|스포츠|먹방|ASMR|Just Chatting|리그|발로란트|롤|LOL|LCK/i.test(t)) || "";
}

function formatHms(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

async function openMemoEditor() {
  await openEditor();
}

async function openEditor() {
  const panel = document.getElementById("cmm-editor-panel");
  if (!panel) return;
  pageInfo = getPageInfo();
  const now = await getTimelineSecond();
  panel.dataset.sec = String(now);
  document.getElementById("cmm-editor-title").textContent = "메모 입력";
  document.getElementById("cmm-editor-time").textContent = formatHms(now);
  const input = document.getElementById("cmm-editor-input");
  input.value = "";
  input.placeholder = "메모 내용을 입력하세요";
  input.setAttribute("autocomplete", "off");
  panel.classList.add("show");
  if (pageInfo.mode === "vod") {
    setVodBlocker(true);
  }
  syncOverlayVisibility();
  /* 브라우저 자동완성/이전 입력 제안 완화(일부 브라우저는 readonly 1틱 후 해제 패턴만 수용) */
  input.readOnly = true;
  input.focus();
  requestAnimationFrame(() => {
    input.readOnly = false;
    input.select();
  });
}

function closeEditor() {
  document.getElementById("cmm-editor-panel")?.classList.remove("show");
  if (pageInfo.mode === "vod" && !isAnyPanelOpen()) {
    setVodBlocker(false);
  }
  syncOverlayVisibility();
}

async function saveEditorEntry() {
  const panel = document.getElementById("cmm-editor-panel");
  if (!panel) return;
  pageInfo = getPageInfo();
  const sec = Number(panel.dataset.sec || (await getTimelineSecond()));
  const input = document.getElementById("cmm-editor-input");
  const value = (input.value || "").trim();
  if (!value) return;

  const session = await ensureCurrentSession();
  const saved = await appendEntry(session, "memo", value, sec);
  closeEditor();
  if (saved) {
    toast("메모 저장됨");
  } else {
    toast("동일한 시간·내용의 메모가 이미 있어 저장하지 않았습니다.");
  }

  if (pageInfo.mode === "vod") safeRenderVodMarkers();
}

function openBindPanel() {
  if (pageInfo.mode !== "vod" || !pageInfo.vodId) return;
  const panel = document.getElementById("cmm-bind-panel");
  panel.classList.add("show");
  setVodBlocker(true);
  syncOverlayVisibility();
  void renderBindOptions().catch(handleExtensionAsyncError);
}

function closeBindPanel() {
  document.getElementById("cmm-bind-panel")?.classList.remove("show");
  if (pageInfo.mode === "vod" && !isAnyPanelOpen()) {
    setVodBlocker(false);
  }
  syncOverlayVisibility();
}

async function renderBindOptions() {
  const sessions = await getSessions();
  const streamerSelect = document.getElementById("cmm-bind-streamer");
  const grouped = groupSessionsByStreamer(sessions);
  const keys = Object.keys(grouped).sort((a, b) => a.localeCompare(b, "ko"));
  streamerSelect.innerHTML = "";
  if (keys.length === 0) {
    streamerSelect.innerHTML = `<option value="">세션 없음</option>`;
    renderBindSessionOptions();
    return;
  }
  for (const key of keys) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    streamerSelect.appendChild(option);
  }
  renderBindSessionOptions();
}

async function renderBindSessionOptions() {
  const sessions = await getSessions();
  const grouped = groupSessionsByStreamer(sessions);
  const streamerKey = document.getElementById("cmm-bind-streamer").value;
  const sessionSelect = document.getElementById("cmm-bind-session");
  const list = (grouped[streamerKey] || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  sessionSelect.innerHTML = "";
  if (list.length === 0) {
    sessionSelect.innerHTML = `<option value="">세션 없음</option>`;
    return;
  }
  for (const s of list) {
    const option = document.createElement("option");
    option.value = s.sessionId;
    const broadcast = sessionBroadcastTitle(s);
    const label = broadcast.length > 44 ? `${broadcast.slice(0, 41)}…` : broadcast;
    option.textContent = `${new Date(s.createdAt).toLocaleString()} · ${label}`;
    sessionSelect.appendChild(option);
  }
}

function groupSessionsByStreamer(sessions) {
  const out = {};
  for (const s of sessions) {
    const key = inferStreamerKey(s);
    if (!out[key]) out[key] = [];
    out[key].push(s);
  }
  return out;
}

function inferStreamerKey(session) {
  const title = (session?.title || "").replace(/\s+-\s+CHZZK.*$/i, "").trim();
  const fromTitle = title.includes(" - ") ? title.split(" - ")[0].trim() : "";
  if (isUsableStreamerName(fromTitle)) return fromTitle;

  const fromStreamer = (session?.streamerName || "").trim();
  if (isUsableStreamerName(fromStreamer)) return fromStreamer;

  const fromChannel = (session?.channelName || "").trim();
  if (isUsableStreamerName(fromChannel)) return fromChannel;

  return "기타";
}

/** 세션 제목 표시용: `스트리머 - 방송제목` 형태면 방송 제목만 */
function sessionBroadcastTitle(session) {
  const raw = String(session?.title || "")
    .replace(/\s+-\s+CHZZK.*$/i, "")
    .trim();
  const sep = " - ";
  const i = raw.indexOf(sep);
  if (i >= 0) {
    const rest = raw.slice(i + sep.length).trim();
    if (rest) return rest;
  }
  return raw || String(session?.sessionId || "");
}

function isUsableStreamerName(v) {
  if (!v) return false;
  if (v.length > 40) return false;
  if (v.includes("CHZZK")) return false;
  return true;
}

async function bindVodToSelectedSession() {
  if (pageInfo.mode !== "vod" || !pageInfo.vodId) return;
  const selectedId = document.getElementById("cmm-bind-session").value;
  if (!selectedId) return;
  const bindings = await getStorage(VOD_BINDING_KEY, {});
  bindings[pageInfo.vodId] = selectedId;
  await setStorage(VOD_BINDING_KEY, bindings);
  toast("세션 연결 완료");
  closeBindPanel();
  safeRenderVodMarkers();
  await publishActivePageContext();
}

async function clearVodBinding() {
  if (pageInfo.mode !== "vod" || !pageInfo.vodId) return;
  const bindings = await getStorage(VOD_BINDING_KEY, {});
  delete bindings[pageInfo.vodId];
  await setStorage(VOD_BINDING_KEY, bindings);
  clearMarkerLayer();
  toast("연결 해제됨");
  closeBindPanel();
  await publishActivePageContext();
}

async function publishActivePageContext() {
  if (!pageInfo.isChzzk) return;
  const pi = getPageInfo();
  const title = document.title.replace(/\s+-\s+CHZZK.*/i, "").trim();
  const bindings = await getStorage(VOD_BINDING_KEY, {});
  let resolvedSessionId = null;
  if (pi.mode === "vod" && pi.vodId) {
    resolvedSessionId = bindings[pi.vodId] || `vod:${pi.vodId}`;
  } else if (pi.mode === "live" && pi.liveId) {
    resolvedSessionId = `live:${pi.liveId}`;
  }
  const payload = {
    updatedAt: Date.now(),
    href: location.href,
    mode: pi.mode,
    vodId: pi.vodId,
    liveId: pi.liveId,
    pageTitle: title,
    resolvedSessionId
  };
  const json = JSON.stringify(payload);
  if (json === lastPublishedPageContextJson) return;
  lastPublishedPageContextJson = json;
  await setStorage(ACTIVE_PAGE_CONTEXT_KEY, payload);
}

function buildMergedVodSessionRecord(matches, canonicalId, vodId) {
  const entryDedup = new Map();
  for (const m of matches.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    for (const e of m.entries || []) {
      const key = e.id
        ? `id:${e.id}`
        : `legacy:${e.sec}:${e.type}:${(e.text || "").slice(0, 120)}`;
      if (!entryDedup.has(key)) entryDedup.set(key, e);
    }
  }
  const entries = Array.from(entryDedup.values()).sort((a, b) => {
    if (a.sec !== b.sec) return a.sec - b.sec;
    return String(a.type).localeCompare(String(b.type));
  });
  const primary = matches.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return {
    sessionId: canonicalId,
    source: "vod",
    sourceId: vodId,
    streamerName: primary.streamerName || getStreamerName(),
    title: primary.title || document.title.replace(/\s+-\s+CHZZK.*/i, "").trim(),
    createdAt: Math.min(...matches.map((m) => m.createdAt || Date.now())),
    updatedAt: Date.now(),
    entries
  };
}

async function swapSessionIdInStorage(oldId, newSession) {
  await runSessionStorageLocked(async () => {
    let sessions = dedupeSessionsBySessionId(await getSessions()).filter((s) => s.sessionId !== oldId);
    const idx = sessions.findIndex((s) => s.sessionId === newSession.sessionId);
    if (idx >= 0) sessions[idx] = newSession;
    else sessions.push(newSession);
    sessions = dedupeSessionsBySessionId(sessions);
    await setStorage(STORAGE_KEY, sessions);
    const bindings = await getStorage(VOD_BINDING_KEY, {});
    let bChanged = false;
    for (const k of Object.keys(bindings)) {
      if (bindings[k] === oldId) {
        bindings[k] = newSession.sessionId;
        bChanged = true;
      }
    }
    if (bChanged) await setStorage(VOD_BINDING_KEY, bindings);
  });
  lastPublishedPageContextJson = "";
  await publishActivePageContext();
}

async function removeSessionIdsAndInsertMerged(oldIds, mergedSession) {
  await runSessionStorageLocked(async () => {
    let next = dedupeSessionsBySessionId(await getSessions()).filter((s) => !oldIds.includes(s.sessionId));
    const idx = next.findIndex((s) => s.sessionId === mergedSession.sessionId);
    if (idx >= 0) next[idx] = mergedSession;
    else next.push(mergedSession);
    next = dedupeSessionsBySessionId(next);
    await setStorage(STORAGE_KEY, next);
    const bindings = await getStorage(VOD_BINDING_KEY, {});
    let bChanged = false;
    for (const k of Object.keys(bindings)) {
      if (oldIds.includes(bindings[k])) {
        bindings[k] = mergedSession.sessionId;
        bChanged = true;
      }
    }
    if (bChanged) await setStorage(VOD_BINDING_KEY, bindings);
  });
  lastPublishedPageContextJson = "";
  await publishActivePageContext();
}

function normalizeMemoTitleForMatch(raw) {
  return String(raw || "")
    .replace(/\s+-\s+CHZZK.*/i, "")
    .trim()
    .normalize("NFKC")
    .replace(/\u2026|…/g, "")
    .replace(/\.{2,}$/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** 스트리머 접두 제외한 ‘방송 제목’만 비교 (말줄임·공백·CHZZK 접미 차이 흡수) */
function episodeKeyFromMemoTitle(raw) {
  const k = normalizeMemoTitleForMatch(raw);
  const sep = " - ";
  const i = k.indexOf(sep);
  if (i < 0) return k;
  return k.slice(i + sep.length).trim() || k;
}

function pageVodEpisodeMatchKey() {
  const pageFull = document.title.replace(/\s+-\s+CHZZK.*/i, "").trim();
  return episodeKeyFromMemoTitle(pageFull);
}

function normalizeStreamerComparable(raw) {
  return String(raw || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * VOD당 하나의 저장 세션을 쓰도록 고정(vod:{id}). 예전 manual:* 분산본은 병합하거나 canonical id로 승격.
 * 사용자가 바인딩한 세션이 있으면 그쪽이 우선.
 */
async function getConsolidatedVodSession() {
  const vodId = pageInfo.vodId;
  if (!vodId) return null;
  const canonicalId = `vod:${vodId}`;
  const bindings = await getStorage(VOD_BINDING_KEY, {});
  const boundId = bindings[vodId];
  const rawSessions = await getSessions();
  let sessions = dedupeSessionsBySessionId(rawSessions);
  if (sessions.length !== rawSessions.length) {
    await runSessionStorageLocked(async () => {
      const s = dedupeSessionsBySessionId(await getSessions());
      await setStorage(STORAGE_KEY, s);
    });
    sessions = dedupeSessionsBySessionId(await getSessions());
  }

  if (boundId) {
    const bound = sessions.find((s) => s.sessionId === boundId);
    if (bound) return bound;
  }

  const matches = sessions.filter(
    (s) =>
      s.sessionId === canonicalId ||
      (s.sourceId === vodId && (s.source === "vod" || String(s.sessionId).startsWith("manual:")))
  );

  const pageEp = pageVodEpisodeMatchKey();
  const streamerCmp = normalizeStreamerComparable(getStreamerName());
  if (pageEp.length >= 6 && streamerCmp.length >= 2) {
    for (const s of sessions) {
      if (matches.includes(s)) continue;
      const sid = String(s.sessionId);
      if (sid.startsWith("vod:") && sid.slice(4) !== vodId) continue;
      if (!sid.startsWith("manual:")) continue;
      const src = s.sourceId;
      if (src && src !== vodId && src !== "unknown") continue;
      if (normalizeStreamerComparable(inferStreamerKey(s)) !== streamerCmp) continue;
      if (episodeKeyFromMemoTitle(s.title || "") !== pageEp) continue;
      matches.push(s);
    }
  }

  if (matches.length === 0) {
    return {
      sessionId: canonicalId,
      source: "vod",
      sourceId: vodId,
      streamerName: getStreamerName(),
      title: document.title.replace(/\s+-\s+CHZZK.*/i, "").trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      entries: []
    };
  }

  if (matches.length === 1) {
    const s = matches[0];
    if (s.sessionId !== canonicalId) {
      const migrated = {
        ...s,
        sessionId: canonicalId,
        source: "vod",
        sourceId: vodId,
        updatedAt: Date.now()
      };
      await swapSessionIdInStorage(s.sessionId, migrated);
      sessions = await getSessions();
      return sessions.find((x) => x.sessionId === canonicalId) || migrated;
    }
    return s;
  }

  const merged = buildMergedVodSessionRecord(matches, canonicalId, vodId);
  await removeSessionIdsAndInsertMerged(
    matches.map((m) => m.sessionId),
    merged
  );
  return merged;
}

async function ensureCurrentSession() {
  if (pageInfo.mode === "live" && pageInfo.liveId) {
    const sessions = await getSessions();
    const id = `live:${pageInfo.liveId}`;
    const found = sessions.find((s) => s.sessionId === id);
    if (found) return found;

    const created = {
      sessionId: id,
      source: "live",
      sourceId: pageInfo.liveId,
      streamerName: getStreamerName(),
      liveStartMs: await getLiveStartMs(),
      title: document.title.replace(/\s+-\s+CHZZK.*/i, "").trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      entries: []
    };
    return created;
  }

  if (pageInfo.mode === "vod" && pageInfo.vodId) {
    return getConsolidatedVodSession();
  }

  const fallbackId = `manual:${new Date().toISOString().slice(0, 10)}:${Math.random().toString(36).slice(2, 8)}`;
  return {
    sessionId: fallbackId,
    source: pageInfo.mode,
    sourceId: pageInfo.vodId || pageInfo.liveId || "unknown",
    streamerName: getStreamerName(),
    title: document.title.replace(/\s+-\s+CHZZK.*/i, "").trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entries: []
  };
}

/** 마커 호버 툴팁: 타임라인(시각) 없이 메모 본문만. 카테고리 마커는 툴팁 없음. */
function markerHoverTipText(entry) {
  if (entry.type === "category") return "";
  const t = (entry.text || "").trim();
  return t || "메모";
}

/**
 * @param {{ releaseMarkerHoverHold?: boolean }} [options]
 * `releaseMarkerHoverHold`: 목록을 닫은 뒤에도 포인터가 클러스터 마커 위에 남으면 호버 홀드가 유지되어
 * 하단바만 숨고 마커만 남는 경우가 있어, 항목 선택·바깥 클릭·Esc 등에서는 true로 호출.
 * 같은 마커를 다시 눌러 토글할 때만 false(기본).
 */
function closeClusterPopover(options = {}) {
  const releaseMarkerHoverHold = Boolean(options.releaseMarkerHoverHold);
  clusterPopoverCleanup?.();
  clusterPopoverCleanup = null;
  clusterPopoverAnchor = null;
  document.getElementById("cmm-marker-cluster-pop")?.remove();
  if (releaseMarkerHoverHold) {
    cmmPointerOverMarkerUi = false;
    syncOverlayVisibility();
  }
}

function isVodMarkerClusterPopoverOpen() {
  return Boolean(document.getElementById("cmm-marker-cluster-pop"));
}

/**
 * 시간순 정렬된 entries를 `gapSec` 이내로 이어진 구간끼리 묶음.
 * 단, 같은 그룹 내에서 (마지막이 아니라) 시작 지점과의 간격이 `maxSpanSec`를 넘으면 새 그룹으로 분리.
 */
function groupVodEntriesForClusters(entries, gapSec, maxSpanSec = Infinity) {
  if (!entries.length) return [];
  const groups = [];
  let cur = [entries[0]];
  let startSec = entries[0].sec;
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    const prev = cur[cur.length - 1];
    const gapOk = e.sec - prev.sec <= gapSec;
    const spanOk = e.sec - startSec <= maxSpanSec;
    if (gapOk && spanOk) {
      cur.push(e);
    } else {
      groups.push(cur);
      cur = [e];
      startSec = e.sec;
    }
  }
  groups.push(cur);
  return groups;
}

function getAdaptiveClusterGapSec(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return VOD_MARKER_CLUSTER_GAP_SEC;
  if (durationSec >= 15 * 3600) return 360;
  if (durationSec >= 13 * 3600) return 300; // 13~15시간
  if (durationSec >= 12 * 3600) return 270; // 12~13시간
  if (durationSec >= 11 * 3600) return 240; // 11~12시간
  if (durationSec >= 10 * 3600) return 210; // 10~11시간
  if (durationSec >= 9 * 3600) return 180; // 9~10시간
  if (durationSec >= 8 * 3600) return 150; // 8~9시간
  if (durationSec >= 7 * 3600) return 120; // 7~8시간
  if (durationSec >= 6 * 3600) return 90; // 6~7시간
  if (durationSec >= 5 * 3600) return 60; // 5~6시간
  if (durationSec >= 4 * 3600) return 50; // 4~5시간
  if (durationSec >= 3 * 3600) return 40; // 3~4시간
  if (durationSec >= 2 * 3600) return 30; // 2~3시간
  return 10; // 2시간 이하
}

function getMaxClusterSpanSec(durationSec) {
  const gap = getAdaptiveClusterGapSec(durationSec);
  // 각 클러스터가 좌우로 너무 퍼지지 않도록, 시작 시각 기준 최대 2.2배(최대 12분)까지만 허용
  return Math.min(720, Math.round(gap * 2.2));
}

function getAdaptivePixelMergeMaxCenterPx(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return VOD_MARKER_MERGE_MAX_CENTER_PX;
  if (durationSec <= 1 * 3600) return 8;
  if (durationSec <= 4 * 3600) return 24;
  if (durationSec <= 5 * 3600) return 28;
  if (durationSec <= 6 * 3600) return 34;
  if (durationSec <= 7 * 3600) return 42;
  return VOD_MARKER_MERGE_MAX_CENTER_PX;
}

function vodMarkerGroupCenterSec(group) {
  const secs = group.map((e) => e.sec);
  return (Math.min(...secs) + Math.max(...secs)) / 2;
}

/**
 * 클러스터 pill 너비 때문에 시간상 살짝 떨어진 단일 마커와 겹쳐 보일 때,
 * 진행 바 픽셀 거리로 환산한 초 차이가 충분히 작으면 한 클러스터로 합침.
 */
function mergeVodMarkerGroupsByTimelinePixelBleed(groups, duration, barW, maxCenterPx, centerSecCap) {
  if (!groups.length || groups.length < 2 || !duration) return groups;
  const safeW = Math.max(160, barW);
  const maxDeltaSec = Math.min(centerSecCap, (duration * maxCenterPx) / safeW);
  const sorted = groups
    .map((g) => g.slice().sort((a, b) => a.sec - b.sec))
    .sort((a, b) => vodMarkerGroupCenterSec(a) - vodMarkerGroupCenterSec(b));
  const out = [];
  let cur = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i];
    const dSec = Math.abs(vodMarkerGroupCenterSec(g) - vodMarkerGroupCenterSec(cur));
    if (dSec <= maxDeltaSec) {
      cur = cur.concat(g).sort((a, b) => a.sec - b.sec);
    } else {
      out.push(cur);
      cur = g;
    }
  }
  out.push(cur);
  return out;
}

/** 클러스터 팝오버 한 줄 라벨 */
function clusterEntryLine(entry) {
  if (entry.type === "category") {
    const t = (entry.text || "").trim();
    return t ? `카테고리 · ${t}` : "카테고리";
  }
  const t = (entry.text || "").trim();
  return t || "메모";
}

function openClusterPopover(anchorEl, items, video) {
  if (!anchorEl || !items?.length || !video) return;
  const existing = document.getElementById("cmm-marker-cluster-pop");
  if (existing && clusterPopoverAnchor === anchorEl) {
    closeClusterPopover();
    return;
  }

  closeClusterPopover();
  clusterPopoverAnchor = anchorEl;

  const pop = document.createElement("div");
  pop.id = "cmm-marker-cluster-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "이 시간대 메모 목록");

  const head = document.createElement("div");
  head.className = "cmm-cluster-pop-head";
  head.textContent = `${items.length}개 · 항목을 눌러 이동`;
  pop.appendChild(head);

  const list = document.createElement("div");
  list.className = "cmm-cluster-pop-list";

  for (const entry of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cmm-cluster-pop-item";

    const timeEl = document.createElement("span");
    timeEl.className = "cmm-cluster-pop-time";
    timeEl.textContent = formatHms(entry.sec);

    const textEl = document.createElement("span");
    textEl.className = "cmm-cluster-pop-text";
    textEl.textContent = clusterEntryLine(entry);

    row.appendChild(timeEl);
    row.appendChild(textEl);
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      video.currentTime = entry.sec;
      video.play().catch(() => {});
      closeClusterPopover({ releaseMarkerHoverHold: true });
      requestAnimationFrame(() => syncOverlayVisibility());
    });
    list.appendChild(row);
  }
  pop.appendChild(list);
  document.body.appendChild(pop);

  const rect = anchorEl.getBoundingClientRect();
  const margin = 8;
  let left = rect.left + rect.width / 2;
  let top = rect.bottom + 6;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;

  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    let l = left;
    let t = top;
    if (pr.right > window.innerWidth - margin) {
      l -= pr.right - (window.innerWidth - margin);
    }
    if (pr.left < margin) {
      l += margin - pr.left;
    }
    if (pr.bottom > window.innerHeight - margin) {
      t = Math.max(margin, rect.top - pr.height - 6);
    }
    pop.style.left = `${Math.round(l)}px`;
    pop.style.top = `${Math.round(t)}px`;
  });

  const onDown = (ev) => {
    if (pop.contains(ev.target) || anchorEl.contains(ev.target)) return;
    closeClusterPopover({ releaseMarkerHoverHold: true });
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") closeClusterPopover({ releaseMarkerHoverHold: true });
  };

  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);

  clusterPopoverCleanup = () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

async function renderVodMarkers() {
  if (!isExtensionContextValid()) {
    tearDownAfterInvalidExtensionContext();
    return;
  }
  try {
    if (pageInfo.mode !== "vod" || !pageInfo.vodId) return;
    const video = getVideo();
    if (!video) return;

    const session = await getConsolidatedVodSession();
    if (!session || !(session.entries || []).length) {
      clearMarkerLayer();
      return;
    }

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    /* duration 메타데이터 전에 innerHTML을 비우면 마커가 사라진 채로 남음 — 로드 후 다음 틱에 다시 그림 */
    if (!duration) {
      return;
    }

    if (isVodMarkerClusterPopoverOpen()) {
      const pop = document.getElementById("cmm-marker-cluster-pop");
      const anchor = clusterPopoverAnchor;
      if (!pop?.isConnected || !anchor?.isConnected) {
        closeClusterPopover({ releaseMarkerHoverHold: true });
      } else {
        return;
      }
    }

    ensureMarkerLayer();
    positionMarkerLayer();
    const layer = document.getElementById("cmm-marker-layer");
    if (!layer) return;
    closeClusterPopover({ releaseMarkerHoverHold: true });
    layer.innerHTML = "";

    const entries = (session.entries || []).slice().sort((a, b) => a.sec - b.sec);
    const adaptiveGapSec = getAdaptiveClusterGapSec(duration);
    const maxSpanSec = getMaxClusterSpanSec(duration);
    const mergeMaxCenterPx = getAdaptivePixelMergeMaxCenterPx(duration);
    let groups = groupVodEntriesForClusters(entries, adaptiveGapSec, maxSpanSec);
    const barW = Math.max(160, layer.getBoundingClientRect().width || 0);
    groups = mergeVodMarkerGroupsByTimelinePixelBleed(
      groups,
      duration,
      barW,
      mergeMaxCenterPx,
      VOD_MARKER_MERGE_CENTER_SEC_CAP
    );

    for (const group of groups) {
      const secs = group.map((e) => e.sec);
      const posSec = (Math.min(...secs) + Math.max(...secs)) / 2;
      const left = Math.max(0, Math.min(100, (posSec / duration) * 100));
      const dot = document.createElement("button");
      dot.type = "button";

      if (group.length === 1) {
        const entry = group[0];
        dot.className = "cmm-marker";
        dot.style.left = `${left}%`;
        const tip = markerHoverTipText(entry);
        if (tip) dot.dataset.cmmTip = tip;
        else dot.classList.add("cmm-marker--no-tip");
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          video.currentTime = entry.sec;
          video.play().catch(() => {});
        });
      } else {
        dot.className = "cmm-marker cmm-marker--cluster";
        dot.style.left = `${left}%`;
        dot.dataset.cmmTip = "클릭하여 펼치기";
        dot.setAttribute("aria-label", `${group.length}개 메모, 클릭하여 펼치기`);
        const badge = document.createElement("span");
        badge.className = "cmm-marker-cluster-badge";
        badge.textContent = String(group.length);
        dot.appendChild(badge);
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          openClusterPopover(dot, group, video);
        });
      }
      layer.appendChild(dot);
    }
  } catch (e) {
    handleExtensionAsyncError(e);
  }
}

function ensureMarkerLayer() {
  let layer = document.getElementById("cmm-marker-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "cmm-marker-layer";
  }

  /* 진행 바 위 고정 오버레이 — PZP 하단 DOM 안에 두지 않음(네이티브 버튼만 바 안에서 페이드). */
  if (layer.parentElement !== document.body) document.body.appendChild(layer);
  layer.dataset.cmmDocked = "overlay";
}

function positionMarkerLayer() {
  const layer = document.getElementById("cmm-marker-layer");
  const video = getVideo();
  if (!layer || !video) return;
  const progressRect = getProgressBarRect();

  if (progressRect) {
    layer.style.position = "fixed";
    layer.style.left = `${Math.round(progressRect.left)}px`;
    layer.style.top = `${Math.round(progressRect.top - 14)}px`;
    layer.style.width = `${Math.round(progressRect.width)}px`;
    layer.style.right = "auto";
    layer.style.bottom = "auto";
    return;
  }

  const rect = video.getBoundingClientRect();
  const fallbackWidth = rect.width * 0.88;
  layer.style.position = "fixed";
  layer.style.left = `${Math.round(rect.left + rect.width * 0.06)}px`;
  layer.style.top = `${Math.round(rect.bottom - 52)}px`;
  layer.style.width = `${Math.round(fallbackWidth)}px`;
  layer.style.right = "auto";
  layer.style.bottom = "auto";
}

function getProgressBarRect() {
  const scope = findPzpPlayerScope() || document;
  const candidates = [
    "[role='slider']",
    "input[type='range']",
    "[class*='progress'][class*='bar']",
    "[class*='seek'][class*='bar']"
  ];
  for (const selector of candidates) {
    const el = scope.querySelector(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 120 && rect.top > 0) return rect;
  }
  for (const selector of candidates) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 120 && rect.top > 0) return rect;
  }
  return null;
}

function clearMarkerLayer() {
  closeClusterPopover({ releaseMarkerHoverHold: true });
  document.getElementById("cmm-marker-layer")?.remove();
}

function toast(message) {
  const prev = document.getElementById("cmm-toast");
  if (prev) prev.remove();
  const el = document.createElement("div");
  el.id = "cmm-toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

async function ensureLiveCategoryOnJoin() {
  const session = await ensureCurrentSession();
  // 라이브 진입 직후에는 카테고리 DOM이 이전 방송 값일 수 있어 잠시 대기 후 읽는다.
  await delay(1200);
  let detected = getCurrentCategoryText();
  if (!detected) {
    await delay(1000);
    detected = getCurrentCategoryText();
  }
  if (detected) {
    await insertCategoryIfChanged(session, detected, await getTimelineSecond());
  }
  startCategoryWatch();
}

function startCategoryWatch() {
  window.setInterval(async () => {
    if (pageInfo.mode !== "live") return;
    const detected = getCurrentCategoryText();
    if (!detected) return;
    const session = await ensureCurrentSession();
    await insertCategoryIfChanged(session, detected, await getTimelineSecond());
  }, 5000);
}

function getCurrentCategoryText() {
  const preferredSelectors = [
    "em.video_information_game__18XV7 a",
    "em[class*='video_information_game'] a",
    "a[href*='/category/']"
  ];
  for (const sel of preferredSelectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const txt = (el.textContent || "").trim();
      if (isValidCategoryText(txt)) return txt;
    }
  }

  const keywords = ["카테고리", "Category"];
  for (const el of Array.from(document.querySelectorAll("span,div,a"))) {
    const txt = (el.textContent || "").trim();
    if (!txt || txt.length > 40) continue;
    if (keywords.includes(txt) && el.nextElementSibling) {
      const next = (el.nextElementSibling.textContent || "").trim();
      if (isValidCategoryText(next)) return next;
    }
  }
  return getDefaultCategory();
}

function normalizeText(v) {
  return (v || "").replace(/\s+/g, "").toLowerCase();
}

async function setCategoryState(v) {
  await setStorage(CATEGORY_STATE_KEY, v || "");
}

function isValidCategoryText(v) {
  const text = (v || "").trim();
  if (!text) return false;
  if (text.length > 50) return false;
  if (/검색|스튜디오|게임e스포츠|엔터\+/.test(text)) return false;
  if (/[<>|]|\/\//.test(text)) return false;
  if (/\d{2}:\d{2}/.test(text)) return false;
  // 카테고리는 플랫폼 표기 특성상 특수문자(· / ! ― - ~ 등)를 폭넓게 허용한다.
  // 단, 제어문자/개행/URL/태그성 문자는 위 조건에서 배제한다.
  if (/[\r\n\t]/.test(text)) return false;
  return /[\p{L}\p{N}]/u.test(text);
}

async function insertCategoryIfChanged(session, categoryText, sec) {
  if (!isValidCategoryText(categoryText)) return;
  const lastCategory = (session.entries || [])
    .slice()
    .reverse()
    .find((e) => e.type === "category");
  if (lastCategory && normalizeText(lastCategory.text) === normalizeText(categoryText)) {
    await setCategoryState(categoryText);
    return;
  }
  await appendEntry(session, "category", categoryText, sec);
  await setCategoryState(categoryText);
  toast(`카테고리 자동기록: ${categoryText}`);
}

function normalizeMemoDedupeText(v) {
  return String(v || "")
    .trim()
    .normalize("NFKC")
    .replace(/\s+/g, " ");
}

/** @returns {Promise<boolean>} 메모가 실제로 추가되면 true, 중복 등으로 생략이면 false */
async function appendEntry(session, type, text, sec) {
  const sessionId = session.sessionId;
  const secN = Math.max(0, Math.floor(sec));
  const textN = (text || "").trim();
  let inserted = false;
  await runSessionStorageLocked(async () => {
    let sessions = dedupeSessionsBySessionId(await getSessions());
    const idx = sessions.findIndex((s) => s.sessionId === sessionId);
    const base = idx >= 0 ? sessions[idx] : session;
    if (type === "memo") {
      const norm = normalizeMemoDedupeText(textN);
      const dup = (base.entries || []).some(
        (e) =>
          e.type === "memo" && e.sec === secN && normalizeMemoDedupeText(e.text || "") === norm
      );
      if (dup) {
        inserted = false;
        return;
      }
    }
    const newEntry = {
      id: crypto.randomUUID(),
      type,
      sec: secN,
      text: textN
    };
    const entries = [...(base.entries || []), newEntry];
    const merged = { ...base, entries, updatedAt: Date.now() };
    if (idx >= 0) sessions[idx] = merged;
    else sessions.push(merged);
    sessions = dedupeSessionsBySessionId(sessions);
    await setStorage(STORAGE_KEY, sessions);
    inserted = true;
  });
  return inserted;
}

async function getLiveStartMs() {
  if (pageInfo.mode !== "live" || !pageInfo.liveId) return null;
  const cache = await getStorage(LIVE_START_CACHE_KEY, {});
  if (cache[pageInfo.liveId]) return cache[pageInfo.liveId];

  const detected = detectLiveStartMsFromDom();
  if (detected) {
    cache[pageInfo.liveId] = detected;
    await setStorage(LIVE_START_CACHE_KEY, cache);
    return detected;
  }
  return null;
}

function detectLiveStartMsFromDom() {
  const parseStartMsFromText = (text) => {
    if (!text) return null;
    const isoRegexes = [
      /"live(Open|Start)(Date|At|Time)"\s*:\s*"([^"]+)"/i,
      /"broadcast(Open|Start)(Date|At|Time)"\s*:\s*"([^"]+)"/i,
      /"start(Date|At|Time)"\s*:\s*"([^"]+)"/i
    ];
    for (const re of isoRegexes) {
      const m = text.match(re);
      const dateStr = m?.[3];
      if (!dateStr) continue;
      const ms = Date.parse(dateStr);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }

    const epochRegexes = [
      /"live(Open|Start)(Date|At|Time)"\s*:\s*(\d{13})/i,
      /"broadcast(Open|Start)(Date|At|Time)"\s*:\s*(\d{13})/i,
      /"start(Date|At|Time)"\s*:\s*(\d{13})/i
    ];
    for (const re of epochRegexes) {
      const m = text.match(re);
      const ms = Number(m?.[3] || 0);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    return null;
  };

  /* 전체 innerHTML 스캔 대신, 데이터가 있을 가능성이 높은 script 텍스트만 제한적으로 확인 */
  const scriptCandidates = [];
  const nextData = document.getElementById("__NEXT_DATA__");
  if (nextData?.textContent) scriptCandidates.push(nextData.textContent);
  for (const s of Array.from(document.querySelectorAll("script[type='application/json'], script[type='application/ld+json'], script"))) {
    const t = s.textContent;
    if (!t || t.length < 16) continue;
    if (!/live|broadcast|start/i.test(t)) continue;
    scriptCandidates.push(t);
    if (scriptCandidates.length >= 30) break;
  }
  for (const t of scriptCandidates) {
    const ms = parseStartMsFromText(t);
    if (ms) return ms;
  }

  /* 최후 폴백: 메타 태그 값 일부만 확인 */
  const metaCandidates = Array.from(document.querySelectorAll("meta[content]"))
    .map((m) => m.getAttribute("content") || "")
    .filter((v) => /live|broadcast|start/i.test(v))
    .slice(0, 40);
  for (const t of metaCandidates) {
    const ms = parseStartMsFromText(t);
    if (ms) return ms;
  }

  return null;
}

function getStreamerName() {
  const title = document.title.replace(/\s+-\s+CHZZK.*$/i, "").trim();
  if (title.includes(" - ")) {
    const first = title.split(" - ")[0].trim();
    if (isUsableStreamerName(first)) return first;
  }
  const candidates = Array.from(document.querySelectorAll("h1, h2, [class*='name'], [class*='channel']"))
    .map((el) => (el.textContent || "").trim())
    .filter(Boolean)
    .filter((t) => t.length <= 30);
  return candidates[0] || document.title.split("-")[0].trim() || "unknown";
}

function bindPlayerUiVisibility(host) {
  clearPlayerUiVisibilityListeners();

  const show = () => {
    host.dataset.cmmUiVisible = "1";
    syncOverlayVisibility();
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(() => {
      if (!isAnyPanelOpen() && !isPointerInPlayerExtendedArea(lastMouseX, lastMouseY)) {
        host.dataset.cmmUiVisible = "0";
        syncOverlayVisibility();
      }
    }, 1800);
  };

  const onDocMove = (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    if (isAnyPanelOpen()) {
      host.dataset.cmmUiVisible = "1";
      syncOverlayVisibility();
      return;
    }
    if (isPointerInPlayerExtendedArea(lastMouseX, lastMouseY)) {
      show();
    }
  };

  document.addEventListener("mousemove", onDocMove, true);
  host.addEventListener("mouseenter", show, { passive: true });
  window.addEventListener("keydown", show, true);
  show();

  playerUiVisibilityCleanup = () => {
    document.removeEventListener("mousemove", onDocMove, true);
    host.removeEventListener("mouseenter", show);
    window.removeEventListener("keydown", show, true);
    if (controlsHideTimer) {
      clearTimeout(controlsHideTimer);
      controlsHideTimer = null;
    }
  };
}

function isPointerInPlayerExtendedArea(x, y) {
  const video = getVideo();
  if (!video) return false;
  const r = video.getBoundingClientRect();
  const below = 160;
  const side = 24;
  return x >= r.left - side && x <= r.right + side && y >= r.top && y <= r.bottom + below;
}

function isAnyPanelOpen() {
  return ["cmm-editor-panel", "cmm-bind-panel"].some((id) => {
    const el = document.getElementById(id);
    return Boolean(el?.classList?.contains("show"));
  });
}

function syncOverlayVisibility() {
  const video = getVideo();
  const host = video?.parentElement;
  const panelOpen = isAnyPanelOpen();

  const tools = document.getElementById("cmm-player-tools");
  const markers = document.getElementById("cmm-marker-layer");
  const toolsInBar = Boolean(tools?.classList.contains("cmm-in-controls"));
  const markerWasVisible = Boolean(markers && !markers.classList.contains("cmm-hidden"));

  /*
   * 도구: PZP `.pzp-pc__bottom-buttons-right` 안이면 네이티브 opacity에 맡기고 cmm-hidden을 쓰지 않음.
   * 마커: 항상 body 고정 오버레이 → PZP 샘플 compound(또는 플로팅 도구와 동일한 host 표시)로 동기화.
   */
  if (tools) {
    tools.classList.remove("cmm-tools-suppressed");
    if (toolsInBar) {
      tools.classList.remove("cmm-hidden");
    } else {
      const showTools = panelOpen ? false : host?.dataset.cmmUiVisible === "1";
      tools.classList.toggle("cmm-hidden", !showTools);
    }
  }

  let showMarkers = false;
  if (markers) {
    if (panelOpen && !toolsInBar) {
      showMarkers = false;
    } else if (toolsInBar) {
      const chromeShown = isPzpBottomChromeShownForOverlay(markerWasVisible);
      /*
       * 네이티브 하단바는 마커 위에 있어도 사이트 타이머로 숨을 수 있음.
       * 확장 마커 레이어만: 마커·목록 위에 포인터가 있으면 페이드아웃하지 않고, 벗어난 뒤 compound에 따름.
       */
      const holdMarkersForHover =
        pageInfo.mode === "vod" && (cmmPointerOverMarkerUi || isVodMarkerClusterPopoverOpen());
      showMarkers = holdMarkersForHover || chromeShown;
    } else {
      const holdMarkersForHover =
        pageInfo.mode === "vod" && (cmmPointerOverMarkerUi || isVodMarkerClusterPopoverOpen());
      showMarkers = holdMarkersForHover || host?.dataset.cmmUiVisible === "1";
    }
    markers.classList.toggle("cmm-hidden", !showMarkers);
  }

  if (pageInfo.mode === "vod" && toolsInBar && (cmmPointerOverMarkerUi || isVodMarkerClusterPopoverOpen())) {
    nudgePzpChromeWhileHoveringMarkers();
  }

  try {
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("cmmDebugPzp") === "1" &&
      markers
    ) {
      const { el: sampleEl, kind } = getPzpChromeSampleElementForOverlay();
      const compound = sampleEl ? cmmDebugReadOpacityCompound(sampleEl) : null;
      const pass =
        compound != null && compound >= PZP_CHROME_SHOW_MIN_COMPOUND;
      if (
        showMarkers !== cmmDebugPzpLastShow ||
        compound !== cmmDebugPzpLastCompound
      ) {
        console.log(
          "[CMM PZP]",
          performance.now().toFixed(1),
          "ms | markersShow=",
          showMarkers,
          "| compound=",
          compound === null ? "(null)" : compound.toFixed(4),
          "| >=threshold(",
          PZP_CHROME_SHOW_MIN_COMPOUND,
          ")=",
          pass,
          "| sample=",
          kind,
          "| panelOpen=",
          panelOpen,
          "| toolsInBar=",
          toolsInBar
        );
        cmmDebugPzpLastShow = showMarkers;
        cmmDebugPzpLastCompound = compound;
      }
    }
  } catch (e) {
    void e;
  }
}

function onWindowResizeForMarkers() {
  if (!isExtensionContextValid()) return;
  positionMarkerLayer();
}

function stopVodMarkerLoop() {
  if (markerRafId) cancelAnimationFrame(markerRafId);
  markerRafId = null;
  if (markerRenderTimer) clearInterval(markerRenderTimer);
  markerRenderTimer = null;
  cmmPointerOverMarkerUi = false;
  window.removeEventListener("resize", onWindowResizeForMarkers);
}

function startVodMarkerLoop() {
  stopVodMarkerLoop();
  safeRenderVodMarkers();
  const loop = () => {
    if (pageInfo.mode !== "vod") return;
    if (!isExtensionContextValid()) {
      tearDownAfterInvalidExtensionContext();
      return;
    }
    reconcileExtensionPlayerUi();
    positionMarkerLayer();
    syncOverlayVisibility();
    markerRafId = requestAnimationFrame(loop);
  };
  markerRafId = requestAnimationFrame(loop);
  markerRenderTimer = setInterval(() => {
    if (pageInfo.mode !== "vod") return;
    if (!isExtensionContextValid()) {
      tearDownAfterInvalidExtensionContext();
      return;
    }
    void syncPageInfoIfDrifted().catch(handleExtensionAsyncError);
    safeRenderVodMarkers();
  }, 3000);
  window.addEventListener("resize", onWindowResizeForMarkers);
}

async function getSessions() {
  return getStorage(STORAGE_KEY, []);
}

async function upsertSession(session) {
  await runSessionStorageLocked(async () => {
    let sessions = dedupeSessionsBySessionId(await getSessions());
    const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
    if (idx >= 0) sessions[idx] = session;
    else sessions.push(session);
    sessions = dedupeSessionsBySessionId(sessions);
    await setStorage(STORAGE_KEY, sessions);
  });
}

function getStorage(key, fallback) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      resolve(fallback);
      return;
    }
    try {
      chrome.storage.local.get([key], (result) => {
        try {
          if (chrome.runtime.lastError) {
            resolve(fallback);
            return;
          }
        } catch (e) {
          handleExtensionAsyncError(e);
          resolve(fallback);
          return;
        }
        resolve(result?.[key] ?? fallback);
      });
    } catch (e) {
      handleExtensionAsyncError(e);
      resolve(fallback);
    }
  });
}

function setStorage(key, value) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      tearDownAfterInvalidExtensionContext();
      resolve();
      return;
    }
    try {
      chrome.storage.local.set({ [key]: value }, () => {
        try {
          if (chrome.runtime.lastError) {
            resolve();
            return;
          }
        } catch (e) {
          handleExtensionAsyncError(e);
        }
        resolve();
      });
    } catch (e) {
      handleExtensionAsyncError(e);
      resolve();
    }
  });
}
