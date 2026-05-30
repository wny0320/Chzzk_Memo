const STORAGE_KEY = "chzzkMemoSessions";
const VOD_BINDING_KEY = "chzzkVodBindings";
const ACTIVE_PAGE_CONTEXT_KEY = "chzzkActivePageContext";
const MEMO_HOTKEY_KEY = "chzzkMemoHotkey";
const PLAYER_TOOLS_VISIBILITY_KEY = "chzzkPlayerToolsVisibility";
const DEFAULT_PLAYER_TOOLS_VISIBILITY = { showMemo: true, showBind: true };
const CATEGORY_AUTO_DETECT_KEY = "chzzkCategoryAutoDetect";
const CATEGORY_AUTO_DETECT_SCOPE_KEY = "chzzkCategoryAutoDetectScope";
const CATEGORY_AUTO_DETECT_ALLOWLIST_KEY = "chzzkCategoryAutoDetectAllowlist";
const MEMO_SORT_ORDER_KEY = "chzzkMemoSortOrder";
const EXPORT_FORMAT_OPTIONS_KEY = "chzzkExportFormatOptions";
const DEFAULT_EXPORT_FORMAT_OPTIONS = {
  includeStreamer: true,
  includeTitle: true,
  includeDate: true,
  includeCategoryMetaTimes: true
};
/** 팝업에서 라이브 세션을 컨텍스트와 퍼지 매칭할 때 (`content.js`와 동일한 2시간 창) */
const LIVE_CTX_FUZZY_MS = 2 * 60 * 60 * 1000;

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
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  code: "KeyN"
};
const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_IMPORT_LINES = 20000;
const MAX_IMPORT_ENTRIES = 5000;

const streamerSelect = document.getElementById("streamer-select");
const sessionSelect = document.getElementById("session-select");
const entryListEl = document.getElementById("entry-list");
const copyBtn = document.getElementById("copy-btn");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const deleteSessionBtn = document.getElementById("delete-session-btn");
const renameSessionBtn = document.getElementById("rename-session-btn");
const newSessionBtn = document.getElementById("new-session-btn");
const hkDisplay = document.getElementById("hk-display");
const hkCaptureBtn = document.getElementById("hk-capture");
const hkStatus = document.getElementById("hk-status");
const saveHotkeyBtn = document.getElementById("save-hotkey-btn");
const hotkeySaved = document.getElementById("hotkey-saved");
const sortDescCheck = document.getElementById("sort-desc");
const sortAscCheck = document.getElementById("sort-asc");
const popupVodSection = document.getElementById("popup-vod-bind-section");
const popupVodHint = document.getElementById("popup-vod-bind-hint");
const popupBindVodBtn = document.getElementById("popup-bind-vod-btn");
const popupBindStatus = document.getElementById("popup-bind-status");
const floatToggleMemo = document.getElementById("float-toggle-memo");
const floatToggleBind = document.getElementById("float-toggle-bind");
const categoryAutoDetectCheck = document.getElementById("category-auto-detect");
const categoryAutoDetectSubopts = document.getElementById("category-auto-detect-subopts");
const categoryAutoDetectAllowlistOnlyCheck = document.getElementById("category-auto-detect-allowlist-only");
const categoryAutoDetectAllowlistDisclosure = document.getElementById(
  "category-auto-detect-allowlist-disclosure"
);
const categoryAutoDetectAllowlistHint = document.getElementById("category-auto-detect-allowlist-hint");
const categoryAutoDetectAddBtn = document.getElementById("category-auto-detect-add-btn");
const categoryAutoDetectAllowlistListEl = document.getElementById("category-auto-detect-allowlist-list");
const categoryAutoDetectAllowlistEmptyEl = document.getElementById("category-auto-detect-allowlist-empty");
const sessionBroadcastDateEl = document.getElementById("session-broadcast-date");
const popupDockRow = document.getElementById("popup-dock-row");
const openStandalonePopupBtn = document.getElementById("open-standalone-popup-btn");
const exportFormatDisclosure = document.getElementById("export-format-disclosure");
const exportOptStreamer = document.getElementById("export-opt-streamer");
const exportOptTitle = document.getElementById("export-opt-title");
const exportOptDate = document.getElementById("export-opt-date");
const exportOptCategoryTimes = document.getElementById("export-opt-category-times");

/** @type {typeof DEFAULT_EXPORT_FORMAT_OPTIONS} */
let exportFormatOptions = { ...DEFAULT_EXPORT_FORMAT_OPTIONS };

let sessions = [];
/** @type {typeof DEFAULT_MEMO_HOTKEY | null} */
let workingHotkey = { ...DEFAULT_MEMO_HOTKEY };
let hkCapturing = false;
let editingEntryId = null;
let entrySortOrder = "asc";
/** `chrome.windows.create`와 맞춘 별도 창(도크) 바깥 너비(px). 가로 리사이즈 시 되돌린다. */
const DOCK_POPUP_OUTER_WIDTH_PX = 400;
let dockChromeWindowId = null;
let dockBoundsLockListenerAdded = false;

function normalizeCategoryKey(v) {
  return String(v || "").replace(/\s+/g, "").toLowerCase();
}

function findPrevCategoryInSorted(sortedEntries, entry) {
  const ix = sortedEntries.findIndex((e) => e.id && entry.id && e.id === entry.id);
  if (ix <= 0) return null;
  for (let i = ix - 1; i >= 0; i--) {
    if (sortedEntries[i].type === "category") return sortedEntries[i];
  }
  return null;
}

/** 목록 본문: 구형 접두어 제거 후 표시(신규 `autoMeta`는 본문만 저장). */
function getCategoryEntryDisplayBody(entry) {
  if (!entry || entry.type !== "category") return String(entry?.text || "");
  if (entry.autoMeta === "title" || entry.autoMeta === "both") return String(entry.text || "").trim();
  const raw = String(entry.text || "").trim();
  if (/^\[방제 변경\]\s*/.test(raw)) return raw.replace(/^\[방제 변경\]\s*/, "").trim();
  if (/^\[카테고리\/방제 변경\]\s*/.test(raw)) return raw.replace(/^\[카테고리\/방제 변경\]\s*/, "").trim();
  if (/^\[방제\/카테고리 변경\]\s*/.test(raw)) {
    const inner = raw.replace(/^\[방제\/카테고리 변경\]\s*/, "").trim();
    return inner.replace(/\s*\|\s*/, "/");
  }
  return raw;
}

/** 목록·기 표시용: 세션 시간순 기준 첫 카테고리 vs 이후 변경 구분(content.js 마커와 동일 규칙). */
function categoryEntryTypeLabel(entry, sortedEntries) {
  if (entry.type !== "category") return "메모";
  if (entry.autoMeta === "title") return "방제 변경";
  if (entry.autoMeta === "both") return "카테고리/방제 변경";
  const raw = (entry.text || "").trim();
  if (/^\[방제 변경\]/.test(raw)) return "방제 변경";
  if (/^\[카테고리\/방제 변경\]/.test(raw)) return "카테고리/방제 변경";
  if (/^\[방제\/카테고리 변경\]/.test(raw)) return "카테고리/방제 변경";
  const name = getCategoryEntryDisplayBody(entry);
  const prev = findPrevCategoryInSorted(sortedEntries, entry);
  const prevBody = prev && prev.type === "category" ? getCategoryEntryDisplayBody(prev) : "";
  const isChange = Boolean(prev && normalizeCategoryKey(prevBody) !== normalizeCategoryKey(name));
  return isChange ? "카테고리 변경" : "카테고리";
}

function groupSessionsByStreamer(list) {
  const out = {};
  for (const s of list) {
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

function isUsableStreamerName(v) {
  if (!v) return false;
  if (v.length > 40) return false;
  if (v.includes("CHZZK")) return false;
  return true;
}

/** 드롭다운 등: `스트리머 - 방송제목` 이면 방송 제목만 */
function msToBroadcastDateString(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function deriveBroadcastDateForSession(session) {
  if (session?.broadcastDate && /^\d{4}-\d{2}-\d{2}$/.test(session.broadcastDate)) {
    return session.broadcastDate;
  }
  if (Number.isFinite(session?.liveStartMs) && session.liveStartMs > 0) {
    return msToBroadcastDateString(session.liveStartMs);
  }
  if (Number.isFinite(session?.createdAt) && session.createdAt > 0) {
    return msToBroadcastDateString(session.createdAt);
  }
  return null;
}

function compareSessionsByBroadcastDate(a, b) {
  const da = deriveBroadcastDateForSession(a) || "";
  const db = deriveBroadcastDateForSession(b) || "";
  if (da !== db) return db.localeCompare(da);
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

function migrateSessionsBroadcastDates(list) {
  let changed = false;
  const next = list.map((s) => {
    const bd = deriveBroadcastDateForSession(s);
    if (!bd || s.broadcastDate === bd) return s;
    changed = true;
    return { ...s, broadcastDate: bd };
  });
  return { sessions: next, changed };
}

function normalizeStreamerAllowKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeCategoryAutoDetectAllowlist(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let ent = null;
    if (typeof item === "string") {
      const streamerName = item.trim();
      if (!streamerName || streamerName.length > 40) continue;
      ent = {
        id: crypto.randomUUID(),
        liveId: null,
        streamerName,
        addedAt: Date.now()
      };
    } else if (item && typeof item === "object") {
      const streamerName = String(item.streamerName || "").trim();
      const liveId = String(item.liveId || "").trim() || null;
      if (!streamerName && !liveId) continue;
      ent = {
        id: String(item.id || crypto.randomUUID()),
        liveId,
        streamerName: (streamerName || liveId || "").slice(0, 40),
        addedAt: Number(item.addedAt) || Date.now()
      };
    }
    if (!ent) continue;
    const dedupeKey = ent.liveId
      ? `live:${ent.liveId}`
      : `name:${normalizeStreamerAllowKey(ent.streamerName)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(ent);
  }
  return out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

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

/** HH:MM:SS / MM:SS / 초(숫자) → 초. 실패 시 null */
function parseHmsToSec(str) {
  const s = String(str ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10));
  const parts = s.split(":").map((x) => x.trim());
  if (parts.length === 2) {
    const mm = Number(parts[0]);
    const ss = Number(parts[1]);
    if (!Number.isFinite(mm) || !Number.isFinite(ss)) return null;
    if (mm < 0 || ss < 0 || ss >= 60) return null;
    return Math.max(0, Math.floor(mm) * 60 + Math.floor(ss));
  }
  if (parts.length === 3) {
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    const ss = Number(parts[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
    if (hh < 0 || mm < 0 || ss < 0 || mm >= 60 || ss >= 60) return null;
    return Math.max(0, Math.floor(hh) * 3600 + Math.floor(mm) * 60 + Math.floor(ss));
  }
  return null;
}

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

function sanitizeTimelineMemoChunk(raw) {
  let t = String(raw || "").replace(/\u00a0/g, " ");
  const replyWrite = t.indexOf("답글 쓰기");
  if (replyWrite !== -1) {
    t = t.slice(0, replyWrite);
  }
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

function formatHotkeyLabel(cfg) {
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

function updateHotkeyDisplay() {
  hkDisplay.textContent = workingHotkey ? formatHotkeyLabel(workingHotkey) : "—";
}

async function loadHotkeyFromStorage() {
  const stored = await getStorage(MEMO_HOTKEY_KEY, null);
  workingHotkey = normalizeMemoHotkey(stored);
  updateHotkeyDisplay();
}

function stopHotkeyCapture() {
  hkCapturing = false;
  hkCaptureBtn.classList.remove("active");
  document.removeEventListener("keydown", onHotkeyCaptureKey, true);
}

function startHotkeyCapture() {
  hkCapturing = true;
  hkStatus.textContent = "키를 누르세요… (Esc: 취소)";
  hkCaptureBtn.classList.add("active");
  document.addEventListener("keydown", onHotkeyCaptureKey, true);
}

function onHotkeyCaptureKey(e) {
  if (!hkCapturing) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.code === "Escape") {
    stopHotkeyCapture();
    hkStatus.textContent = "취소했습니다.";
    return;
  }

  if (e.repeat) return;

  const modifierOnly = /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code);
  if (modifierOnly) return;

  if (!/^Key[A-Z]$|^Digit[0-9]$/.test(e.code)) {
    hkStatus.textContent = "영문 알파벳 또는 숫자 키만 지정할 수 있습니다.";
    return;
  }

  if (isChzzkMemoCodeReserved(e.code)) {
    hkStatus.textContent = "방향키·K·스페이스·M·T·F·J는 치지직 기본 조작과 겹쳐 지정할 수 없습니다.";
    return;
  }

  workingHotkey = {
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    code: e.code
  };
  stopHotkeyCapture();
  updateHotkeyDisplay();
  hkStatus.textContent = "아래 「저장」을 눌러 확정하세요.";
}

async function onSaveHotkey() {
  if (!workingHotkey) return;
  if (isChzzkMemoCodeReserved(workingHotkey.code)) {
    window.alert("이 키는 치지직 플레이어 기본 단축키와 겹쳐 저장할 수 없습니다.");
    return;
  }
  await chrome.storage.local.set({ [MEMO_HOTKEY_KEY]: workingHotkey });
  hotkeySaved.hidden = false;
  setTimeout(() => {
    hotkeySaved.hidden = true;
  }, 1200);
  hkStatus.textContent = "";
}

function renderStreamerOptions(preserveStreamerKey) {
  streamerSelect.innerHTML = "";
  const grouped = groupSessionsByStreamer(sessions);
  const keys = Object.keys(grouped).sort((a, b) => a.localeCompare(b, "ko"));
  if (keys.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "저장된 세션 없음";
    streamerSelect.appendChild(opt);
    return;
  }
  for (const k of keys) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = `${k} (${grouped[k].length})`;
    streamerSelect.appendChild(opt);
  }
  if (preserveStreamerKey && keys.includes(preserveStreamerKey)) {
    streamerSelect.value = preserveStreamerKey;
  }
}

function renderSessionOptionsForStreamer(preserveSessionId) {
  sessionSelect.innerHTML = "";
  const key = streamerSelect.value;
  const grouped = groupSessionsByStreamer(sessions);
  const list = (grouped[key] || []).slice().sort(compareSessionsByBroadcastDate);
  if (list.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "세션 없음";
    sessionSelect.appendChild(opt);
    return;
  }
  for (const s of list) {
    const opt = document.createElement("option");
    opt.value = s.sessionId;
    const broadcast = sessionBroadcastTitle(s);
    const titleShort = broadcast.length > 60 ? `${broadcast.slice(0, 57)}…` : broadcast;
    const datePrefix = deriveBroadcastDateForSession(s);
    opt.textContent = datePrefix ? `${datePrefix} · ${titleShort}` : titleShort;
    sessionSelect.appendChild(opt);
  }
  if (preserveSessionId && list.some((s) => s.sessionId === preserveSessionId)) {
    sessionSelect.value = preserveSessionId;
  }
  updateSessionBroadcastDateLabel();
}

function updateSessionBroadcastDateLabel() {
  if (!sessionBroadcastDateEl) return;
  const session = getSelectedSession();
  const bd = session ? deriveBroadcastDateForSession(session) : null;
  if (!bd) {
    sessionBroadcastDateEl.hidden = true;
    sessionBroadcastDateEl.textContent = "";
    return;
  }
  sessionBroadcastDateEl.hidden = false;
  sessionBroadcastDateEl.textContent = `방송 날짜: ${bd}`;
}

function getSelectedSession() {
  const id = sessionSelect.value;
  if (!id) return null;
  return sessions.find((s) => s.sessionId === id) || null;
}

function renderEntryList() {
  if (!entryListEl) return;
  entryListEl.innerHTML = "";
  const session = getSelectedSession();
  const entries = session?.entries || [];
  if (!session || entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "entry-list-empty";
    empty.textContent = "기록이 없습니다.";
    entryListEl.appendChild(empty);
    return;
  }
  /** 카테고리「변경」판별은 방송 타임라인(시간) 순서 기준 — 목록 정렬(오름/내림)과 무관 */
  const sortedAsc = entries.slice().sort((a, b) => a.sec - b.sec);
  const sorted = entries
    .slice()
    .sort((a, b) => (entrySortOrder === "asc" ? a.sec - b.sec : b.sec - a.sec));
  for (const e of sorted) {
    const row = document.createElement("div");
    row.className = "entry-row";

    if (editingEntryId && e.id === editingEntryId) {
      const meta = document.createElement("div");
      meta.className = "entry-row-meta";
      const typeEl = document.createElement("span");
      typeEl.className = "entry-type";
      typeEl.textContent =
        e.type === "category" ? categoryEntryTypeLabel(e, sortedAsc) : "메모";
      meta.append(typeEl);

      const fields = document.createElement("div");
      fields.className = "entry-edit-fields";

      const timeLabel = document.createElement("label");
      timeLabel.className = "entry-field-label";
      timeLabel.setAttribute("for", `cmm-edit-sec-${e.id}`);
      timeLabel.textContent = "시간 (HH:MM:SS)";

      const timeInput = document.createElement("input");
      timeInput.type = "text";
      timeInput.id = `cmm-edit-sec-${e.id}`;
      timeInput.className = "entry-edit-input entry-edit-time";
      timeInput.value = formatHms(e.sec);
      timeInput.setAttribute("inputmode", "numeric");
      timeInput.setAttribute("autocomplete", "off");
      timeInput.setAttribute("spellcheck", "false");

      const textLabel = document.createElement("label");
      textLabel.className = "entry-field-label";
      textLabel.setAttribute("for", `cmm-edit-text-${e.id}`);
      textLabel.textContent =
        e.type === "category" ? "표시되는 카테고리 이름" : "메모 내용";

      const textInput = document.createElement("input");
      textInput.type = "text";
      textInput.id = `cmm-edit-text-${e.id}`;
      textInput.className = "entry-edit-input";
      textInput.value = e.type === "category" ? getCategoryEntryDisplayBody(e) : e.text || "";
      textInput.setAttribute("autocomplete", "off");
      textInput.setAttribute("spellcheck", "false");

      fields.append(timeLabel, timeInput, textLabel, textInput);

      const actions = document.createElement("div");
      actions.className = "entry-row-actions";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.textContent = "저장";

      const runSave = () =>
        void onSaveEntry(session.sessionId, e.id, textInput.value.trim(), timeInput.value);

      const onEditKeydown = (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          editingEntryId = null;
          renderEntryList();
          return;
        }
        if (ev.key !== "Enter" || ev.shiftKey) return;
        if (ev.isComposing || ev.keyCode === 229) return;
        ev.preventDefault();
        runSave();
      };

      saveBtn.addEventListener("click", runSave);
      timeInput.addEventListener("keydown", onEditKeydown);
      textInput.addEventListener("keydown", onEditKeydown);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn-secondary";
      cancelBtn.textContent = "취소";
      cancelBtn.addEventListener("click", () => {
        editingEntryId = null;
        renderEntryList();
      });
      actions.append(saveBtn, cancelBtn);
      row.append(meta, fields, actions);
    } else {
      const main = document.createElement("div");
      main.className = "entry-row-main";
      const timeEl = document.createElement("span");
      timeEl.className = "entry-time";
      timeEl.textContent = formatHms(e.sec);
      const textEl = document.createElement("span");
      textEl.className = "entry-text";
      textEl.textContent = e.type === "category" ? getCategoryEntryDisplayBody(e) : e.text || "";
      if (e.type === "category") {
        const typeEl = document.createElement("span");
        typeEl.className = "entry-type";
        typeEl.textContent = categoryEntryTypeLabel(e, sortedAsc);
        main.append(timeEl, typeEl, textEl);
      } else {
        main.append(timeEl, textEl);
      }

      const actions = document.createElement("div");
      actions.className = "entry-row-actions";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn-secondary entry-action-btn";
      editBtn.textContent = "수정";
      if (e.id) {
        editBtn.addEventListener("click", () => {
          editingEntryId = e.id;
          renderEntryList();
          requestAnimationFrame(() => {
            const t = entryListEl.querySelector(".entry-edit-time");
            t?.focus();
            t?.select();
          });
        });
      } else {
        editBtn.disabled = true;
        editBtn.title = "이 기록에는 id가 없어 수정할 수 없습니다.";
      }

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "entry-del btn-danger entry-action-btn";
      delBtn.textContent = "삭제";
      delBtn.addEventListener("click", () => void onDeleteEntry(session.sessionId, e));

      actions.append(editBtn, delBtn);
      row.append(main, actions);
    }
    entryListEl.appendChild(row);
  }
}

function applyEntrySortUi() {
  if (!sortDescCheck || !sortAscCheck) return;
  sortDescCheck.checked = entrySortOrder === "desc";
  sortAscCheck.checked = entrySortOrder === "asc";
}

async function setEntrySortOrder(order) {
  entrySortOrder = order === "asc" ? "asc" : "desc";
  applyEntrySortUi();
  renderEntryList();
  try {
    await chrome.storage.local.set({ [MEMO_SORT_ORDER_KEY]: entrySortOrder });
  } catch {
    /* ignore */
  }
}

async function onSaveEntry(sessionId, entryId, text, timeRaw) {
  if (!entryId) return;
  const sec = parseHmsToSec(timeRaw);
  if (sec == null) {
    await openConfirmModal("시간 형식이 올바르지 않습니다. HH:MM:SS, MM:SS, 또는 초(숫자)로 입력하세요.", {
      okLabel: "확인",
      confirmOnly: true
    });
    return;
  }
  const sIdx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (sIdx < 0) return;
  const ent = (sessions[sIdx].entries || []).find((x) => x.id === entryId);
  if (!ent) return;
  ent.text = text;
  ent.sec = sec;
  sessions[sIdx] = { ...sessions[sIdx], updatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  editingEntryId = null;
  renderEntryList();
}

async function onDeleteEntry(sessionId, entry) {
  const ok = await openConfirmModal(
    "이 기록(메모 또는 카테고리)을 삭제합니다. 되돌릴 수 없습니다. 정말 삭제할까요?",
    { okLabel: "삭제", danger: true }
  );
  if (!ok) return;

  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx < 0) return;

  const match = (en) => {
    if (entry.id && en.id) return en.id === entry.id;
    return en.sec === entry.sec && en.type === entry.type && (en.text || "") === (entry.text || "");
  };

  const nextEntries = (sessions[idx].entries || []).filter((en) => !match(en));
  sessions[idx] = { ...sessions[idx], entries: nextEntries, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  editingEntryId = null;
  renderEntryList();
}

async function onCopy() {
  const session = getSelectedSession();
  if (!session) return;
  const text = buildExportText(session);
  if (!text) return;
  await navigator.clipboard.writeText(text);
  copyBtn.textContent = "Copied!";
  setTimeout(() => {
    copyBtn.textContent = "Copy";
  }, 1000);
}

async function onExport() {
  const session = getSelectedSession();
  if (!session) return;
  const text = buildExportText(session);
  if (!text) return;

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const filename = `${sanitizeFilename(session.title || session.sessionId)}.txt`;

  await chrome.downloads.download({
    url,
    filename,
    saveAs: true
  });
  URL.revokeObjectURL(url);
}

async function onImportFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    importBtn.textContent = "파일 큼";
    setTimeout(() => (importBtn.textContent = "TXT Import"), 1200);
    window.alert("TXT 파일이 너무 큽니다. 2MB 이하 파일만 가져올 수 있습니다.");
    importFile.value = "";
    return;
  }
  const text = await file.text();
  const lineCount = text ? text.split(/\r?\n/).length : 0;
  if (lineCount > MAX_IMPORT_LINES) {
    importBtn.textContent = "줄 수 초과";
    setTimeout(() => (importBtn.textContent = "TXT Import"), 1200);
    window.alert("TXT 줄 수가 너무 많습니다. 20,000줄 이하로 줄여서 다시 시도해 주세요.");
    importFile.value = "";
    return;
  }
  const parsedEntries = parseImportText(text);
  if (parsedEntries.length === 0) {
    importBtn.textContent = "형식 오류";
    setTimeout(() => (importBtn.textContent = "TXT Import"), 1200);
    return;
  }
  if (parsedEntries.length > MAX_IMPORT_ENTRIES) {
    importBtn.textContent = "항목 수 초과";
    setTimeout(() => (importBtn.textContent = "TXT Import"), 1200);
    window.alert("가져온 기록이 너무 많습니다. 5,000개 이하로 나눠서 가져와 주세요.");
    importFile.value = "";
    return;
  }

  const now = Date.now();
  const importDate = new Date().toISOString().slice(0, 10);
  const session = {
    sessionId: `import:${importDate}:${Math.random().toString(36).slice(2, 8)}`,
    source: "import",
    sourceId: file.name,
    streamerName: "imported",
    title: file.name.replace(/\.txt$/i, ""),
    broadcastDate: importDate,
    createdAt: now,
    updatedAt: now,
    entries: parsedEntries
  };

  sessions.push(session);
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const sk = inferStreamerKey(session);
  const sid = session.sessionId;
  renderStreamerOptions(sk);
  renderSessionOptionsForStreamer(sid);
  editingEntryId = null;
  renderEntryList();
  importFile.value = "";
  importBtn.textContent = "Imported!";
  setTimeout(() => (importBtn.textContent = "TXT Import"), 1000);
}

function normalizeExportFormatOptions(raw) {
  const base = { ...DEFAULT_EXPORT_FORMAT_OPTIONS };
  if (!raw || typeof raw !== "object") return base;
  return {
    includeStreamer: raw.includeStreamer !== false,
    includeTitle: raw.includeTitle !== false,
    includeDate: raw.includeDate !== false,
    includeCategoryMetaTimes: raw.includeCategoryMetaTimes !== false
  };
}

function readExportFormatOptionsFromUi() {
  return {
    includeStreamer: exportOptStreamer?.checked !== false,
    includeTitle: exportOptTitle?.checked !== false,
    includeDate: exportOptDate?.checked !== false,
    includeCategoryMetaTimes: exportOptCategoryTimes?.checked !== false
  };
}

function applyExportFormatOptionsToUi(opts) {
  const o = normalizeExportFormatOptions(opts);
  if (exportOptStreamer) exportOptStreamer.checked = o.includeStreamer;
  if (exportOptTitle) exportOptTitle.checked = o.includeTitle;
  if (exportOptDate) exportOptDate.checked = o.includeDate;
  if (exportOptCategoryTimes) exportOptCategoryTimes.checked = o.includeCategoryMetaTimes;
}

async function loadExportFormatOptionsFromStorage() {
  const stored = await getStorage(EXPORT_FORMAT_OPTIONS_KEY, null);
  exportFormatOptions = normalizeExportFormatOptions(stored);
  applyExportFormatOptionsToUi(exportFormatOptions);
}

async function persistExportFormatOptionsFromUi() {
  exportFormatOptions = normalizeExportFormatOptions(readExportFormatOptionsFromUi());
  if (exportOptStreamer) exportOptStreamer.checked = exportFormatOptions.includeStreamer;
  if (exportOptTitle) exportOptTitle.checked = exportFormatOptions.includeTitle;
  if (exportOptDate) exportOptDate.checked = exportFormatOptions.includeDate;
  if (exportOptCategoryTimes) exportOptCategoryTimes.checked = exportFormatOptions.includeCategoryMetaTimes;
  await chrome.storage.local.set({ [EXPORT_FORMAT_OPTIONS_KEY]: exportFormatOptions });
}

function formatEntryExportLine(e, sortedAsc, opts = exportFormatOptions) {
  if (e.type === "category") {
    const label = categoryEntryTypeLabel(e, sortedAsc);
    const body = getCategoryEntryDisplayBody(e) || "";
    const core = body ? `${label} ${body}` : label;
    if (opts.includeCategoryMetaTimes) {
      return `${formatHms(e.sec)} [${core}]`.trim();
    }
    const bracket = body || label;
    return `[${bracket}]`;
  }
  const t = (e.text || "").trim();
  return `${formatHms(e.sec)} ${t}`.trimEnd();
}

function buildExportText(session, opts = exportFormatOptions) {
  const o = normalizeExportFormatOptions(opts);
  const entries = (session.entries || []).slice().sort((a, b) => a.sec - b.sec);
  const lines = [];
  const bd = deriveBroadcastDateForSession(session);
  const title = sessionBroadcastTitle(session);
  const streamer = inferStreamerKey(session);
  if (o.includeStreamer && streamer && streamer !== "기타") {
    lines.push(`# 스트리머: ${streamer}`);
  }
  if (o.includeTitle && title) {
    lines.push(`# 방송: ${title}`);
  }
  if (o.includeDate && bd) {
    lines.push(`# 날짜: ${bd}`);
  }
  const headerCount = lines.length;
  if (headerCount) lines.push("");

  for (const e of entries) {
    lines.push(formatEntryExportLine(e, entries, o));
  }
  const body = lines.slice(headerCount ? headerCount + 1 : 0);
  if (!body.length && !headerCount) return "";
  return lines.join("\n").trim() + "\n";
}

function flushImportMemoBlob(blobLines, out, lastSecHolder) {
  if (blobLines.length === 0) return;
  const blob = blobLines.join("\n");
  blobLines.length = 0;
  const matches = scanTimelinesInString(blob);
  if (matches.length === 0) return;
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].len;
    const end = i + 1 < matches.length ? matches[i + 1].index : blob.length;
    const memo = sanitizeTimelineMemoChunk(blob.slice(start, end));
    if (!memo) continue;
    lastSecHolder.sec = matches[i].sec;
    out.push({
      id: crypto.randomUUID(),
      type: "memo",
      sec: matches[i].sec,
      text: memo
    });
  }
}

/**
 * 줄마다 `HH:MM:SS 메모` 형식 또는, 치지직 복사본처럼 한 줄에 시각이 연속으로 붙은 덤프를 파싱.
 */
function parseImportText(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const out = [];
  const lastSecHolder = { sec: 0 };
  const blobLines = [];

  for (const raw of normalized.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#\s*/.test(line)) continue;

    const timedCat = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+\[([^\]]+)\]\s*(.*)$/);
    if (timedCat) {
      flushImportMemoBlob(blobLines, out, lastSecHolder);
      const sec = parseHmsToSec(timedCat[1]);
      if (sec == null) continue;
      lastSecHolder.sec = sec;
      const inner = timedCat[2].trim();
      const rest = (timedCat[3] || "").trim();
      const labelBody = rest ? `${inner} ${rest}`.trim() : inner;
      const parsed = parseCategoryImportLabelBody(labelBody, sec);
      out.push(parsed);
      continue;
    }

    const cat = line.match(/^\[(.+)\]$/);
    if (cat) {
      flushImportMemoBlob(blobLines, out, lastSecHolder);
      const parsed = parseCategoryImportLabelBody(cat[1].trim(), lastSecHolder.sec);
      out.push(parsed);
      continue;
    }
    blobLines.push(line);
  }
  flushImportMemoBlob(blobLines, out, lastSecHolder);
  return out;
}

/** `HH:MM:SS [방제 변경] 제목` / `[카테고리명]` 등 가져오기 */
function parseCategoryImportLabelBody(labelBody, sec) {
  const raw = String(labelBody || "").trim();
  let autoMeta;
  let text = raw;
  if (/^방제 변경(?:\s*[·|]\s*|\s+)/.test(raw)) {
    autoMeta = "title";
    text = raw.replace(/^방제 변경(?:\s*[·|]\s*|\s+)/, "").trim();
  } else if (/^카테고리\/방제 변경(?:\s*[·|]\s*|\s+)/.test(raw)) {
    autoMeta = "both";
    text = raw.replace(/^카테고리\/방제 변경(?:\s*[·|]\s*|\s+)/, "").trim();
  } else if (/^카테고리 변경(?:\s*[·|]\s*|\s+)/.test(raw)) {
    text = raw.replace(/^카테고리 변경(?:\s*[·|]\s*|\s+)/, "").trim();
  }
  const entry = {
    id: crypto.randomUUID(),
    type: "category",
    sec: Math.max(0, Math.floor(sec)),
    text
  };
  if (autoMeta === "title" || autoMeta === "both") entry.autoMeta = autoMeta;
  return entry;
}

/**
 * 수동 세션 기본값: 활성 치지직 탭(라이브/VOD) 제목 → 스트리머·방송/VOD 제목, 없으면 드롭다운 그룹.
 */
async function resolveStreamerDefaultsForNewManualSession() {
  const ctx = await getStorage(ACTIVE_PAGE_CONTEXT_KEY, null);
  if (ctx?.pageTitle) {
    const parsed = parseChzzkPageTitleForSession(ctx.pageTitle);
    if (parsed?.streamerName) {
      const sn = String(parsed.streamerName).trim();
      const display = String(parsed.displayTitle || "").trim();
      const broadcast = String(parsed.broadcastTitle || "").trim();
      const title =
        display ||
        (broadcast && sn ? `${sn} - ${broadcast}` : "") ||
        (sn && sn !== "기타" ? `${sn} - 새 세션` : "새 세션");
      return { streamerName: sn || "수동", title: title || "새 세션" };
    }
  }
  const key = (streamerSelect.value || "").trim();
  const grouped = groupSessionsByStreamer(sessions);
  if (key && grouped[key]?.length) {
    const sample = grouped[key][0];
    const name =
      sample && isUsableStreamerName(sample.streamerName)
        ? String(sample.streamerName).trim()
        : key;
    const title = name === "기타" ? "새 세션" : `${name} - 새 세션`;
    return { streamerName: name, title };
  }
  if (key && key !== "저장된 세션 없음") {
    const title = key === "기타" ? "새 세션" : `${key} - 새 세션`;
    return { streamerName: key, title };
  }
  return { streamerName: "수동", title: "새 세션" };
}

/** `content.js` ensureCurrentSession 퍼지 규칙과 맞춰 라이브 세션 후보 선택 */
function findLiveSessionMatchingPageContext(sessionList, ctx) {
  if (!ctx?.liveId) return null;
  const liveId = ctx.liveId;
  const ms = ctx.liveStartMs;
  const candidates = sessionList.filter((s) => {
    if (s.source !== "live" || s.sourceId !== liveId) return false;
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
      const st = s.liveStartMs;
      if (typeof st === "number" && Number.isFinite(st) && st > 0) {
        if (Math.abs(st - ms) < LIVE_CTX_FUZZY_MS) return true;
      }
      return false;
    }
    return Date.now() - (s.updatedAt || 0) < LIVE_CTX_FUZZY_MS;
  });
  if (!candidates.length) return null;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
    candidates.sort((a, b) => {
      const da = Number.isFinite(a.liveStartMs)
        ? Math.abs(a.liveStartMs - ms)
        : Number.POSITIVE_INFINITY;
      const db = Number.isFinite(b.liveStartMs)
        ? Math.abs(b.liveStartMs - ms)
        : Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  } else {
    candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return candidates[0];
}

async function onRenameSelectedSession() {
  const session = getSelectedSession();
  if (!session) return;
  const cur = (session.title || "").trim() || session.sessionId;
  const next = await openPromptModal("세션 제목을 입력하세요.", {
    defaultValue: cur,
    okLabel: "저장",
    cancelLabel: "취소",
    requireNonEmpty: true
  });
  if (next === null) return;
  const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
  if (idx < 0) return;
  sessions[idx] = { ...sessions[idx], title: next, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  const sk = streamerSelect.value;
  renderStreamerOptions(sk);
  renderSessionOptionsForStreamer(session.sessionId);
  renderEntryList();
}

async function onCreateManualSession() {
  const { streamerName, title } = await resolveStreamerDefaultsForNewManualSession();
  const id = `manual:${new Date().toISOString().slice(0, 10)}:${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const session = {
    sessionId: id,
    source: "manual",
    sourceId: "manual",
    streamerName,
    title,
    broadcastDate: msToBroadcastDateString(now),
    createdAt: now,
    updatedAt: now,
    entries: []
  };
  sessions.push(session);
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  const sk = inferStreamerKey(session);
  renderStreamerOptions(sk);
  streamerSelect.value = sk;
  renderSessionOptionsForStreamer(id);
  sessionSelect.value = id;
  editingEntryId = null;
  renderEntryList();
}

async function onDeleteSession() {
  const session = getSelectedSession();
  if (!session) return;
  const ok = await openConfirmModal(
    "선택한 세션과 그 안의 모든 기록을 삭제합니다. 이 작업은 되돌릴 수 없습니다. 정말 삭제할까요?",
    { okLabel: "삭제", danger: true }
  );
  if (!ok) return;

  const sessionId = session.sessionId;
  sessions = sessions.filter((s) => s.sessionId !== sessionId);

  const bindings = await getStorage(VOD_BINDING_KEY, {});
  for (const vodId of Object.keys(bindings)) {
    if (bindings[vodId] === sessionId) delete bindings[vodId];
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: sessions,
    [VOD_BINDING_KEY]: bindings
  });

  editingEntryId = null;
  await reloadSessionsFromStorage();
  deleteSessionBtn.textContent = "삭제됨";
  setTimeout(() => {
    deleteSessionBtn.textContent = "세션 삭제";
  }, 1000);
}

function formatHms(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function sanitizeFilename(v) {
  return v.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

function getStorage(key, fallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] ?? fallback);
    });
  });
}

function normalizePlayerToolsVisibility(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PLAYER_TOOLS_VISIBILITY };
  return {
    showMemo: raw.showMemo !== false,
    showBind: raw.showBind !== false
  };
}

async function loadFloatTogglesFromStorage() {
  const v = normalizePlayerToolsVisibility(
    await getStorage(PLAYER_TOOLS_VISIBILITY_KEY, DEFAULT_PLAYER_TOOLS_VISIBILITY)
  );
  if (floatToggleMemo) floatToggleMemo.setAttribute("aria-pressed", v.showMemo ? "true" : "false");
  if (floatToggleBind) floatToggleBind.setAttribute("aria-pressed", v.showBind ? "true" : "false");
}

/** @type {Array<{ id: string, liveId: string | null, streamerName: string, addedAt: number }>} */
let categoryAutoDetectAllowlist = [];

async function loadCategoryAutoDetectFromStorage() {
  const raw = await getStorage(CATEGORY_AUTO_DETECT_KEY, true);
  const on = raw !== false;
  if (categoryAutoDetectCheck) {
    categoryAutoDetectCheck.checked = on;
    categoryAutoDetectCheck.setAttribute("aria-checked", on ? "true" : "false");
  }
  const scope = await getStorage(CATEGORY_AUTO_DETECT_SCOPE_KEY, "all");
  const storedList = await getStorage(CATEGORY_AUTO_DETECT_ALLOWLIST_KEY, []);
  const normalizedList = normalizeCategoryAutoDetectAllowlist(storedList);
  if (JSON.stringify(normalizedList) !== JSON.stringify(storedList)) {
    await chrome.storage.local.set({ [CATEGORY_AUTO_DETECT_ALLOWLIST_KEY]: normalizedList });
  }
  categoryAutoDetectAllowlist = normalizedList;
  const allowlistOnly = scope === "allowlist";
  if (categoryAutoDetectSubopts) {
    categoryAutoDetectSubopts.hidden = !on;
  }
  if (categoryAutoDetectAllowlistOnlyCheck) {
    categoryAutoDetectAllowlistOnlyCheck.checked = allowlistOnly;
  }
  if (categoryAutoDetectAddBtn) {
    categoryAutoDetectAddBtn.disabled = !on;
  }
  renderCategoryAutoDetectAllowlist();
  void refreshCategoryAutoDetectAllowlistHint();
}

function renderCategoryAutoDetectAllowlist() {
  if (!categoryAutoDetectAllowlistListEl) return;
  categoryAutoDetectAllowlistListEl.innerHTML = "";
  const list = categoryAutoDetectAllowlist;
  if (categoryAutoDetectAllowlistEmptyEl) {
    categoryAutoDetectAllowlistEmptyEl.hidden = list.length > 0;
  }
  if (!list.length) return;

  for (const item of list) {
    const row = document.createElement("div");
    row.className = "cmm-allowlist-row";
    row.setAttribute("role", "listitem");

    const main = document.createElement("div");
    main.className = "cmm-allowlist-row-main";
    const nameEl = document.createElement("span");
    nameEl.className = "cmm-allowlist-name";
    nameEl.textContent = item.streamerName || item.liveId || "채널";
    main.appendChild(nameEl);
    if (item.liveId) {
      const sub = document.createElement("span");
      sub.className = "cmm-allowlist-sub";
      sub.textContent = `채널 ID · ${item.liveId}`;
      main.appendChild(sub);
    }

    const actions = document.createElement("div");
    actions.className = "cmm-allowlist-row-actions";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-danger entry-action-btn cmm-allowlist-del-btn";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => void onRemoveCategoryAutoDetectAllowlistItem(item.id));

    actions.appendChild(delBtn);
    row.append(main, actions);
    categoryAutoDetectAllowlistListEl.appendChild(row);
  }
}

async function refreshCategoryAutoDetectAllowlistHint() {
  if (!categoryAutoDetectAllowlistHint) return;
  const live = await resolveActiveLiveChannelForAllowlist();
  if (live?.streamerName) {
    categoryAutoDetectAllowlistHint.textContent = `지금 보는 채널: ${live.streamerName} — 「현재 채널 추가」로 목록에 넣을 수 있습니다.`;
    return;
  }
  categoryAutoDetectAllowlistHint.innerHTML =
    "치지직 <strong>라이브</strong> 페이지를 연 뒤 「현재 채널 추가」를 누르세요.";
}

async function resolveActiveLiveChannelForAllowlist() {
  const ctx = await getStorage(ACTIVE_PAGE_CONTEXT_KEY, null);
  if (ctx?.mode === "live" && ctx.liveId) {
    const parsed = ctx.pageTitle ? parseChzzkPageTitleForSession(ctx.pageTitle) : null;
    const streamerName = String(ctx.streamerName || parsed?.streamerName || "").trim();
    return {
      liveId: String(ctx.liveId),
      streamerName: streamerName || String(ctx.liveId)
    };
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const u = new URL(tab.url);
    if (!/chzzk\.naver\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/live\/([^/?#]+)/);
    if (!m) return null;
    const title = String(tab.title || "").replace(/\s+-\s+CHZZK.*/i, "").trim();
    const parsed = title ? parseChzzkPageTitleForSession(title) : null;
    return {
      liveId: m[1],
      streamerName: String(parsed?.streamerName || "").trim() || m[1]
    };
  } catch {
    return null;
  }
}

async function saveCategoryAutoDetectScopeFromUi() {
  const allowlistOnly = Boolean(categoryAutoDetectAllowlistOnlyCheck?.checked);
  const scope = allowlistOnly ? "allowlist" : "all";
  await chrome.storage.local.set({ [CATEGORY_AUTO_DETECT_SCOPE_KEY]: scope });
}

async function persistCategoryAutoDetectAllowlist(list) {
  categoryAutoDetectAllowlist = normalizeCategoryAutoDetectAllowlist(list);
  await chrome.storage.local.set({
    [CATEGORY_AUTO_DETECT_ALLOWLIST_KEY]: categoryAutoDetectAllowlist
  });
  renderCategoryAutoDetectAllowlist();
}

async function onAddCurrentChannelToCategoryAutoDetectAllowlist() {
  const live = await resolveActiveLiveChannelForAllowlist();
  if (!live?.liveId) {
    await openConfirmModal(
      "치지직 라이브(/live/…) 페이지를 연 탭에서 팝업을 열고 다시 시도해 주세요.",
      { confirmOnly: true, okLabel: "확인" }
    );
    return;
  }
  const next = normalizeCategoryAutoDetectAllowlist([
    ...categoryAutoDetectAllowlist,
    {
      id: crypto.randomUUID(),
      liveId: live.liveId,
      streamerName: live.streamerName,
      addedAt: Date.now()
    }
  ]);
  const added = next.length - categoryAutoDetectAllowlist.length;
  await persistCategoryAutoDetectAllowlist(next);
  if (categoryAutoDetectAddBtn) {
    categoryAutoDetectAddBtn.textContent = added > 0 ? "추가됨" : "이미 있음";
    setTimeout(() => {
      categoryAutoDetectAddBtn.textContent = "현재 채널 추가";
    }, 1200);
  }
  if (!categoryAutoDetectAllowlistOnlyCheck?.checked) {
    categoryAutoDetectAllowlistOnlyCheck.checked = true;
    await saveCategoryAutoDetectScopeFromUi();
    await loadCategoryAutoDetectFromStorage();
  }
}

async function onRemoveCategoryAutoDetectAllowlistItem(itemId) {
  const target = categoryAutoDetectAllowlist.find((x) => x.id === itemId);
  if (!target) return;
  const ok = await openConfirmModal(
    `「${target.streamerName || target.liveId}」을(를) 자동 감지 목록에서 삭제할까요?`,
    { okLabel: "삭제", danger: true }
  );
  if (!ok) return;
  await persistCategoryAutoDetectAllowlist(
    categoryAutoDetectAllowlist.filter((x) => x.id !== itemId)
  );
}

/** 활성 탭 URL 또는 콘텐츠 스크립트가 저장한 컨텍스트로 VOD id 판별 */
async function resolveActiveVodForPopup() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      try {
        const u = new URL(tab.url);
        if (/chzzk\.naver\.com$/i.test(u.hostname)) {
          const m = u.pathname.match(/^\/video\/([^/?#]+)/);
          if (m) return { vodId: m[1], href: tab.url, source: "tab" };
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* tabs 권한·내부 페이지 등 */
  }
  const ctx = await getStorage(ACTIVE_PAGE_CONTEXT_KEY, null);
  if (ctx && ctx.mode === "vod" && ctx.vodId) {
    return { vodId: ctx.vodId, href: ctx.href || "", source: "context" };
  }
  return null;
}

async function refreshPopupVodBindPanel() {
  if (!popupVodSection || !popupVodHint || !popupBindVodBtn) return;
  const vod = await resolveActiveVodForPopup();
  if (!vod) {
    popupVodHint.textContent =
      "치지직 VOD(/video/…) 재생 탭을 연 뒤 팝업을 열면 여기서 타임라인을 연결할 수 있습니다. (탭 URL을 읽지 못하면 방금 본 페이지 정보로 시도합니다.)";
    popupBindVodBtn.disabled = true;
    return;
  }
  popupBindVodBtn.disabled = false;
  const shortId = vod.vodId.length > 14 ? `${vod.vodId.slice(0, 14)}…` : vod.vodId;
  const src = vod.source === "context" ? "페이지 컨텍스트" : "현재 탭";
  popupVodHint.textContent = `${src} 기준 VOD입니다 (영상 ${shortId}). 위에서 스트리머·세션을 고른 뒤 「연결」을 누르세요.`;
}

function isImportSourceSession(session) {
  if (!session) return false;
  if (session.source === "import") return true;
  return String(session.sessionId || "").startsWith("import:");
}

/** 브라우저 탭 제목·컨텍스트의 CHZZK 접미사 제거 후 스트리머·방송 제목 분리 */
function parseChzzkPageTitleForSession(raw) {
  const t = String(raw || "")
    .replace(/\s+-\s+CHZZK.*$/i, "")
    .trim();
  if (!t) return null;
  const sep = " - ";
  const i = t.indexOf(sep);
  if (i >= 0) {
    const left = t.slice(0, i).trim();
    const right = t.slice(i + sep.length).trim();
    return {
      streamerName: left || t,
      broadcastTitle: right || t,
      displayTitle: t
    };
  }
  return { streamerName: t, broadcastTitle: t, displayTitle: t };
}

async function getVodPageMetaForPopup(vod) {
  if (!vod?.vodId) return null;
  let raw = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.title) raw = tab.title;
  } catch {
    /* ignore */
  }
  if (!raw) {
    const ctx = await getStorage(ACTIVE_PAGE_CONTEXT_KEY, null);
    if (ctx && ctx.vodId === vod.vodId && ctx.pageTitle) raw = ctx.pageTitle;
  }
  return parseChzzkPageTitleForSession(raw);
}

async function applyVodMetaToImportSessionInStorage(sessionId, vodId, meta) {
  const list = await getStorage(STORAGE_KEY, []);
  const idx = list.findIndex((s) => s.sessionId === sessionId);
  if (idx < 0) return false;
  const s = { ...list[idx] };
  if (meta.streamerName) s.streamerName = meta.streamerName;
  if (meta.displayTitle) s.title = meta.displayTitle;
  s.sourceId = vodId;
  s.updatedAt = Date.now();
  list[idx] = s;
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
  return true;
}

async function onPopupBindVod() {
  if (popupBindStatus) popupBindStatus.textContent = "";
  const vod = await resolveActiveVodForPopup();
  if (!vod) {
    if (popupBindStatus) popupBindStatus.textContent = "치지직 VOD 페이지가 열린 탭에서 팝업을 열어주세요.";
    return;
  }
  const sessionId = sessionSelect.value;
  if (!sessionId) {
    if (popupBindStatus) popupBindStatus.textContent = "연결할 세션을 먼저 선택하세요.";
    return;
  }
  const session = sessions.find((s) => s.sessionId === sessionId);
  const shouldOfferVodMetaSync =
    isImportSourceSession(session) || (session && session.source === "live");

  if (shouldOfferVodMetaSync) {
    const preview = await getVodPageMetaForPopup(vod);
    const detail = preview
      ? `현재 VOD 탭 기준으로 세션 정보를 다음처럼 맞춥니다.\n스트리머: ${preview.streamerName}\n세션 제목(방송 제목): ${preview.broadcastTitle || preview.displayTitle}\n\n`
      : "현재 VOD 탭 제목을 읽을 수 있으면 스트리머·세션 제목을 그에 맞게 바꿉니다.\n\n";
    const importTail =
      "브라우저(확장 프로그램 저장소)에만 반영되며, 원본으로 가져온 TXT 파일 자체는 자동으로 바뀌지 않습니다. 갱신된 목록은 「TXT Export」로 다시 저장할 수 있습니다.\n\n";
    const liveTail = "라이브로 적힌 메모·카테고리 기록은 그대로이며, 표시 이름만 VOD 탭 제목에 맞춥니다.\n\n";
    const tail = isImportSourceSession(session) ? importTail : liveTail;
    const ok = await openConfirmModal(`${detail}${tail}이대로 연결할까요?`, {
      okLabel: "연결하기",
      danger: false
    });
    if (!ok) return;
  }

  const bindings = await getStorage(VOD_BINDING_KEY, {});
  bindings[vod.vodId] = sessionId;
  await chrome.storage.local.set({ [VOD_BINDING_KEY]: bindings });

  if (session && (isImportSourceSession(session) || session.source === "live")) {
    const meta = await getVodPageMetaForPopup(vod);
    if (meta?.displayTitle) {
      await applyVodMetaToImportSessionInStorage(sessionId, vod.vodId, meta);
      await reloadSessionsFromStorage();
    }
  }

  if (popupBindStatus) {
    popupBindStatus.textContent =
      isImportSourceSession(session) || (session && session.source === "live")
        ? "연결 및 세션 정보 반영이 완료되었습니다. TXT Export로 파일을 다시 저장할 수 있습니다."
        : "타임라인 연결이 저장되었습니다. VOD 탭에서 마커가 갱신됩니다.";
  }
}

function openConfirmModal(message, options = {}) {
  const okLabel = options.okLabel ?? "확인";
  const danger = options.danger === true;
  const confirmOnly = options.confirmOnly === true;
  return new Promise((resolve) => {
    const modal = document.getElementById("cmm-confirm-modal");
    const msgEl = document.getElementById("cmm-confirm-message");
    const okBtn = document.getElementById("cmm-confirm-ok");
    const cancelBtn = document.getElementById("cmm-confirm-cancel");
    if (!modal || !msgEl || !okBtn || !cancelBtn) {
      resolve(false);
      return;
    }
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    okBtn.classList.remove("btn-danger", "btn-primary");
    okBtn.classList.add(danger ? "btn-danger" : "btn-primary");
    cancelBtn.hidden = confirmOnly;
    modal.hidden = false;

    function cleanup() {
      modal.hidden = true;
      cancelBtn.hidden = false;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onDocKey, true);
    }

    function onOk() {
      cleanup();
      resolve(true);
    }
    function onCancel() {
      cleanup();
      resolve(false);
    }
    function onBackdrop(ev) {
      if (ev.target === modal) {
        if (confirmOnly) onOk();
        else onCancel();
      }
    }
    function onDocKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        if (confirmOnly) onOk();
        else onCancel();
      }
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onDocKey, true);
    (confirmOnly ? okBtn : cancelBtn).focus();
  });
}

/**
 * @param {string} message
 * @param {{ defaultValue?: string, okLabel?: string, cancelLabel?: string, requireNonEmpty?: boolean }} [options]
 * @returns {Promise<string | null>} 저장 시 입력값(트림), 취소 시 null
 */
function openPromptModal(message, options = {}) {
  const okLabel = options.okLabel ?? "저장";
  const cancelLabel = options.cancelLabel ?? "취소";
  const defaultValue = options.defaultValue ?? "";
  const requireNonEmpty = options.requireNonEmpty === true;
  return new Promise((resolve) => {
    const modal = document.getElementById("cmm-prompt-modal");
    const msgEl = document.getElementById("cmm-prompt-message");
    const input = document.getElementById("cmm-prompt-input");
    const okBtn = document.getElementById("cmm-prompt-ok");
    const cancelBtn = document.getElementById("cmm-prompt-cancel");
    if (!modal || !msgEl || !input || !okBtn || !cancelBtn) {
      resolve(null);
      return;
    }
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    input.value = defaultValue;
    modal.hidden = false;
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    function cleanup() {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      input.removeEventListener("keydown", onInputKey);
      document.removeEventListener("keydown", onDocKey, true);
    }

    function finish(value) {
      cleanup();
      resolve(value);
    }

    function onOk() {
      const v = (input.value || "").trim();
      if (!v && requireNonEmpty) {
        void openConfirmModal("제목을 한 글자 이상 입력해 주세요.", { confirmOnly: true, okLabel: "확인" });
        return;
      }
      finish(v);
    }

    function onCancel() {
      finish(null);
    }

    function onBackdrop(ev) {
      if (ev.target === modal) onCancel();
    }

    function onInputKey(ev) {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        onOk();
      }
    }

    function onDocKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onCancel();
      }
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    input.addEventListener("keydown", onInputKey);
    document.addEventListener("keydown", onDocKey, true);
  });
}

async function reloadSessionsFromStorage() {
  sessions = await getStorage(STORAGE_KEY, []);
  const migrated = migrateSessionsBroadcastDates(sessions);
  sessions = migrated.sessions;
  if (migrated.changed) {
    await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  }
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const prevStreamer = streamerSelect.value;
  const prevSession = sessionSelect.value;
  renderStreamerOptions(prevStreamer);
  if (!streamerSelect.value || !groupSessionsByStreamer(sessions)[streamerSelect.value]) {
    if (streamerSelect.options[0]?.value) streamerSelect.selectedIndex = 0;
  }
  renderSessionOptionsForStreamer(prevSession);
  const list = groupSessionsByStreamer(sessions)[streamerSelect.value] || [];
  if (
    !sessionSelect.value ||
    (prevSession && !list.some((s) => s.sessionId === prevSession))
  ) {
    if (sessionSelect.options[0]?.value) sessionSelect.selectedIndex = 0;
  }
  renderEntryList();
  updateSessionBroadcastDateLabel();

  const sessionStillValid = Boolean(prevSession && sessions.some((s) => s.sessionId === prevSession));
  if (prevSession && !sessionStillValid) {
    await applyActivePageContextSelection(await getStorage(ACTIVE_PAGE_CONTEXT_KEY, null));
  }
}

/**
 * 치지직 탭에서 콘텐츠 스크립트가 기록한 현재 페이지 컨텍스트에 맞춰 스트리머·세션 선택을 맞춤.
 * 팝업을 열 때마다 시청 중인 라이브·VOD에 해당하는 세션을 우선 선택한다.
 */
async function applyActivePageContextSelection(ctx) {
  if (!ctx || typeof ctx !== "object") return;
  editingEntryId = null;
  sessions = await getStorage(STORAGE_KEY, []);
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  let target = null;
  if (ctx.resolvedSessionId) {
    target = sessions.find((s) => s.sessionId === ctx.resolvedSessionId) || null;
  }
  if (!target && ctx.vodId && (ctx.mode === "vod" || ctx.mode == null)) {
    target =
      sessions.find(
        (s) =>
          s.sourceId === ctx.vodId &&
          (s.source === "vod" || String(s.sessionId).startsWith("manual:"))
      ) || null;
  }
  if (!target && ctx.liveId && (ctx.mode === "live" || ctx.mode == null)) {
    const ms = ctx.liveStartMs;
    if (typeof ms === "number" && Number.isFinite(ms)) {
      target =
        sessions.find((s) => s.sessionId === `live:${ctx.liveId}:${Math.floor(ms)}`) || null;
    }
    if (!target) {
      target = findLiveSessionMatchingPageContext(sessions, ctx);
    }
  }
  if (!target) {
    renderStreamerOptions(streamerSelect.value);
    renderSessionOptionsForStreamer(sessionSelect.value);
    renderEntryList();
    return;
  }

  const sk = inferStreamerKey(target);
  renderStreamerOptions(sk);
  streamerSelect.value = sk;
  renderSessionOptionsForStreamer(target.sessionId);
  sessionSelect.value = target.sessionId;
  renderEntryList();
}

init();

function isStandaloneDockPopup() {
  try {
    return new URLSearchParams(window.location.search).get("dock") === "1";
  } catch {
    return false;
  }
}

/** 별도 창: 가로만 고정(브라우저 창 너비 보정). 세로는 사용자가 조절 가능. */
function setupDockWindowWidthLock() {
  if (!chrome.windows?.getCurrent || !chrome.windows?.update || !chrome.windows?.onBoundsChanged) return;

  const snapWidth = (w) => {
    if (!w?.id || w.width == null) return;
    const tol = 6;
    if (Math.abs(w.width - DOCK_POPUP_OUTER_WIDTH_PX) > tol) {
      chrome.windows.update(w.id, { width: DOCK_POPUP_OUTER_WIDTH_PX });
    }
  };

  chrome.windows.getCurrent((win) => {
    if (chrome.runtime?.lastError || !win?.id) return;
    dockChromeWindowId = win.id;
    snapWidth(win);
    if (dockBoundsLockListenerAdded) return;
    dockBoundsLockListenerAdded = true;
    chrome.windows.onBoundsChanged.addListener((changed) => {
      if (changed.id === dockChromeWindowId) snapWidth(changed);
    });
  });
}

async function onOpenStandalonePopupWindow() {
  try {
    const url = chrome.runtime.getURL("popup.html?dock=1");
    await chrome.windows.create({
      url,
      type: "popup",
      width: 400,
      height: 700,
      focused: true
    });
  } catch {
    await openConfirmModal(
      "별도 창을 열 수 없습니다. 브라우저가 확장 창 생성을 허용하는지 확인해 주세요.",
      { confirmOnly: true, okLabel: "확인" }
    );
  }
}

async function init() {
  if (isStandaloneDockPopup()) {
    document.documentElement.classList.add("cmm-dock-html");
    document.body.classList.add("cmm-dock-window");
    document.title = "CHZZK Memo";
    const vp = document.createElement("meta");
    vp.name = "viewport";
    vp.content =
      "width=380, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
    document.head.prepend(vp);
    setupDockWindowWidthLock();
  }

  await loadHotkeyFromStorage();
  const storedSort = await getStorage(MEMO_SORT_ORDER_KEY, null);
  if (storedSort === "asc" || storedSort === "desc") {
    entrySortOrder = storedSort;
  }
  await reloadSessionsFromStorage();

  openStandalonePopupBtn?.addEventListener("click", () => void onOpenStandalonePopupWindow());

  streamerSelect.addEventListener("change", () => {
    editingEntryId = null;
    renderSessionOptionsForStreamer();
    renderEntryList();
  });
  sessionSelect.addEventListener("change", () => {
    editingEntryId = null;
    renderEntryList();
    updateSessionBroadcastDateLabel();
  });
  copyBtn.addEventListener("click", () => void onCopy());
  exportBtn.addEventListener("click", () => void onExport());

  for (const el of [exportOptStreamer, exportOptTitle, exportOptDate, exportOptCategoryTimes]) {
    el?.addEventListener("change", () => void persistExportFormatOptionsFromUi());
  }
  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", (ev) => void onImportFileSelected(ev));
  deleteSessionBtn.addEventListener("click", () => void onDeleteSession());
  renameSessionBtn?.addEventListener("click", () => void onRenameSelectedSession());
  newSessionBtn?.addEventListener("click", () => void onCreateManualSession());
  saveHotkeyBtn.addEventListener("click", () => void onSaveHotkey());
  hkCaptureBtn.addEventListener("click", () => {
    if (hkCapturing) {
      stopHotkeyCapture();
      hkStatus.textContent = "입력을 중단했습니다.";
      return;
    }
    startHotkeyCapture();
  });
  sortDescCheck?.addEventListener("change", () => {
    void (async () => {
      if (sortDescCheck.checked) await setEntrySortOrder("desc");
      else await setEntrySortOrder("asc");
    })();
  });
  sortAscCheck?.addEventListener("change", () => {
    void (async () => {
      if (sortAscCheck.checked) await setEntrySortOrder("asc");
      else await setEntrySortOrder("desc");
    })();
  });
  applyEntrySortUi();

  await loadFloatTogglesFromStorage();
  await loadExportFormatOptionsFromStorage();
  await loadCategoryAutoDetectFromStorage();
  await refreshPopupVodBindPanel();
  await applyActivePageContextSelection(await getStorage(ACTIVE_PAGE_CONTEXT_KEY, null));

  categoryAutoDetectCheck?.addEventListener("change", async () => {
    const on = categoryAutoDetectCheck.checked;
    categoryAutoDetectCheck.setAttribute("aria-checked", on ? "true" : "false");
    await chrome.storage.local.set({ [CATEGORY_AUTO_DETECT_KEY]: on });
    await loadCategoryAutoDetectFromStorage();
  });

  categoryAutoDetectAllowlistOnlyCheck?.addEventListener("change", async () => {
    await saveCategoryAutoDetectScopeFromUi();
    await loadCategoryAutoDetectFromStorage();
  });

  categoryAutoDetectAddBtn?.addEventListener("click", () =>
    void onAddCurrentChannelToCategoryAutoDetectAllowlist()
  );

  floatToggleMemo?.addEventListener("click", async () => {
    const cur = normalizePlayerToolsVisibility(
      await getStorage(PLAYER_TOOLS_VISIBILITY_KEY, DEFAULT_PLAYER_TOOLS_VISIBILITY)
    );
    const next = { ...cur, showMemo: !cur.showMemo };
    await chrome.storage.local.set({ [PLAYER_TOOLS_VISIBILITY_KEY]: next });
    floatToggleMemo.setAttribute("aria-pressed", next.showMemo ? "true" : "false");
  });
  floatToggleBind?.addEventListener("click", async () => {
    const cur = normalizePlayerToolsVisibility(
      await getStorage(PLAYER_TOOLS_VISIBILITY_KEY, DEFAULT_PLAYER_TOOLS_VISIBILITY)
    );
    const next = { ...cur, showBind: !cur.showBind };
    await chrome.storage.local.set({ [PLAYER_TOOLS_VISIBILITY_KEY]: next });
    floatToggleBind.setAttribute("aria-pressed", next.showBind ? "true" : "false");
  });
  popupBindVodBtn?.addEventListener("click", () => void onPopupBindVod());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[MEMO_HOTKEY_KEY]) {
      void loadHotkeyFromStorage();
    }
    if (changes[STORAGE_KEY]) {
      void reloadSessionsFromStorage();
    }
    if (changes[ACTIVE_PAGE_CONTEXT_KEY]) {
      void applyActivePageContextSelection(changes[ACTIVE_PAGE_CONTEXT_KEY].newValue);
    }
    if (changes[PLAYER_TOOLS_VISIBILITY_KEY]) {
      void loadFloatTogglesFromStorage();
    }
    if (changes[CATEGORY_AUTO_DETECT_KEY]) {
      void loadCategoryAutoDetectFromStorage();
    }
    if (changes[CATEGORY_AUTO_DETECT_SCOPE_KEY] || changes[CATEGORY_AUTO_DETECT_ALLOWLIST_KEY]) {
      void loadCategoryAutoDetectFromStorage();
    }
    if (changes[EXPORT_FORMAT_OPTIONS_KEY]) {
      void loadExportFormatOptionsFromStorage();
    }
    if (changes[ACTIVE_PAGE_CONTEXT_KEY]) {
      void refreshCategoryAutoDetectAllowlistHint();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void (async () => {
      await applyActivePageContextSelection(await getStorage(ACTIVE_PAGE_CONTEXT_KEY, null));
      await refreshPopupVodBindPanel();
      await refreshCategoryAutoDetectAllowlistHint();
    })();
  });
}
