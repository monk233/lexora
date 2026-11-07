/* Lexora quick-translate window (contract §6).
 *
 * Independent always-on-top translation panel opened by the global hotkey.
 * The shell owns the window and the translation stream; this renderer keeps the
 * whole UI usable in two cases:
 *
 *   - packaged app: `window.quickAPI` forwards to Tauri commands and
 *     `translate-event` / `quick-show` events (web/shared/tauri-api.js);
 *   - browser preview (file://): the same API runs against the in-memory mock
 *     backend, so every interaction can be checked without Rust.
 *
 * Layout: top language bar (auto source -> target, swap, pin, history), two
 * equal columns (source textarea / streamed Markdown translation), history
 * overlay and toasts. Streamed chunks are merged into one rAF render, the same
 * approach as the picker result panel.
 */
/* Lexora quick-translate window (contract §6, frameless adaptive panel).
 *
 * The shell owns the window and the translation stream; this renderer keeps the
 * whole UI usable in two cases:
 *
 *   - packaged app: `window.quickAPI` forwards to Tauri commands and
 *     `translate-event` / `quick-show` events (web/shared/tauri-api.js). The
 *     window is transparent and undecorated: the visible card is .qt-shell
 *     inside a 6px transparent .qt-win padding, the top bar drags the window
 *     (`quick_drag_panel`) and the height follows the content
 *     (`quick_resize`, 900px wide, throttled).
 *   - browser preview (file://): the same API runs against the in-memory mock
 *     backend, so every interaction can be checked without Rust.
 *
 * Layout: top language bar (auto source -> target, swap, pin, history, close),
 * two equal columns (source textarea / streamed Markdown translation), history
 * overlay and toasts. Streamed chunks are merged into one rAF render, the same
 * approach as the picker result panel. Both columns scroll internally with the
 * scrollbars hidden.
 */
(function () {
  "use strict";

  var API = window.quickAPI;
  var LP = window.LP || {};
  var LANGUAGES = Array.isArray(LP.LANGUAGES) ? LP.LANGUAGES.slice() : [];
  /* Extra common source languages beyond the project's target-language table
   * (mirrored by MOCK_EXTRA_SOURCE_LANGS in shared/tauri-api.js). Only codes
   * live here; the visible names come from language.<code> in the packs. */
  var EXTRA_SOURCE_LANGS = [
    "sv", "no", "da", "fi", "el", "hu", "ro", "sk", "sl", "hr", "sr", "lt", "lv",
    "et", "is", "bg", "be", "az", "uz", "ka", "hy", "sq", "ca", "cy", "ga", "mt",
    "af", "sw",
  ];
  /* Source-language selector list: "自动识别" plus every project language and
   * the extra common source codes. Built by qtSourceLanguages() below. */
  var SOURCE_LANGUAGES = qtSourceLanguages(LANGUAGES);
  var MAX_CHARS = 20000;
  var MAX_HISTORY = 500;
  var TOAST_MS = 4000;

  /* Frameless window: fixed 900px width, content-driven height. */
  var WINDOW_WIDTH = 900;
  var MIN_WINDOW_HEIGHT = 420;
  var MAX_WINDOW_HEIGHT = 760;
  var MIN_SOURCE_HEIGHT = 260; // matches .qt-textarea min-height
  var EMPTY_RESULT_HEIGHT = 120; // matches .qt-empty min-height
  var LOADING_RESULT_HEIGHT = 44;
  var RESIZE_THROTTLE_MS = 120;
  var RESIZE_SCREEN_MARGIN = 80;

  /* ---- DOM ------------------------------------------------------------- */

  var winNode = document.getElementById("qt-win");
  var shellNode = document.getElementById("qt-shell");
  var topbarNode = document.getElementById("qt-topbar");
  var bodyNode = document.getElementById("qt-body");
  var closeButton = document.getElementById("qt-close");
  var sourceInput = document.getElementById("qt-source");
  var sourceCount = document.getElementById("qt-source-count");
  var sourceClear = document.getElementById("qt-source-clear");
  var limitHint = document.getElementById("qt-limit-hint");
  var translateButton = document.getElementById("qt-translate");
  var sourceSelect = document.getElementById("qt-source-lang");
  var targetSelect = document.getElementById("qt-target-lang");
  var swapButton = document.getElementById("qt-swap");
  var pinButton = document.getElementById("qt-pin");
  var historyToggle = document.getElementById("qt-history-toggle");
  var resultNode = document.getElementById("qt-result");
  var resultCount = document.getElementById("qt-result-count");
  var resultError = document.getElementById("qt-result-error");
  var copyButton = document.getElementById("qt-copy");
  var speakButton = document.getElementById("qt-speak");
  var elapsedNode = document.getElementById("qt-elapsed");
  var sourceHeadNode = document.getElementById("qt-source-head");
  var sourceBodyNode = document.getElementById("qt-source-body");
  var sourceFootNode = document.getElementById("qt-source-foot");
  var resultHeadNode = document.getElementById("qt-result-head");
  var resultBodyNode = document.getElementById("qt-result-body");
  var resultFootNode = document.getElementById("qt-result-foot");
  var historyOverlay = document.getElementById("qt-history-overlay");
  var historyClose = document.getElementById("qt-history-close");
  var historySearch = document.getElementById("qt-history-search");
  var historyList = document.getElementById("qt-history-list");
  var historySummary = document.getElementById("qt-history-summary");
  var historyClear = document.getElementById("qt-history-clear");
  var toastStack = document.getElementById("qt-toast-stack");

  var state = {
    ready: false,
    promptDefault: "",
    quick: {
      enabled: true,
      hotkey: "Alt+Space",
      sourceLang: "auto",
      targetLang: "zh",
      prompt: "",
      pinned: false,
    },
    translating: false,
    requestId: "",
    raw: "",
    startedAt: 0,
    elapsedMs: null,
    renderPending: false,
    windowHeight: 0,
    history: [],
    historyOpen: false,
    historyQuery: "",
    historyClearArmed: false,
    clearTimer: null,
    /* Last rendered error (message/hint) so a locale switch can retranslate the
     * retry button and fallback title without losing the backend's wording. */
    error: null,
  };

  /* Window drag (top bar) and adaptive resize bookkeeping. */
  var TOPBAR_DRAG_EXCLUDE = "button, select, input, textarea, a, label, [contenteditable]";
  var dragState = {
    active: false,
    session: 0,
    lastX: 0,
    lastY: 0,
    pendingX: 0,
    pendingY: 0,
    frame: 0,
  };
  var resizeState = { timer: 0, lastHeight: 0 };

  /* Speech synthesis state (same flags as picker.js). */
  var speech = {
    utterance: null,
    speaking: false,
    loading: false,
    cancelRequested: false,
  };

  /* ------------------------------------------------------------------ */
  /* Pure helpers (extracted by web/quicktranslate.test.cjs)             */
  /* ------------------------------------------------------------------ */

  /* Message lookup with a graceful fallback: an older cached i18n.js must never
   * crash the panel, it simply shows the keys. */
  function tr(key, params) {
    return typeof LP.t === "function" ? LP.t(key, params) : String(key);
  }

  /* Localized language name from the active pack (shared/lang.js). Falls back
   * to the shared table for a code the pack does not know yet. */
  function languageLabel(code) {
    var key = String(code == null ? "" : code).trim();
    if (!key) {
      return "";
    }
    if (typeof LP.languageLabel === "function") {
      return LP.languageLabel(key);
    }
    var labels = LP.LANG_LABELS || {};
    return labels[key] || key;
  }

  /* Complete source-language selector list: the auto-detect entry first, then
   * the project languages, then the extra common source languages (same order
   * as the patch spec). Labels are resolved through the active pack, so a
   * locale switch just rebuilds the options. Duplicate codes are dropped so the
   * list stays valid if the project table ever grows into the extra set. */
  function qtSourceLanguages(baseLanguages) {
    var result = [{ value: "auto", label: tr("quick.lang.auto") }];
    var seen = { auto: true };
    (Array.isArray(baseLanguages) ? baseLanguages : []).forEach(function (entry) {
      if (!entry || !entry.value || seen[entry.value]) {
        return;
      }
      seen[entry.value] = true;
      result.push({
        value: String(entry.value),
        label: languageLabel(entry.value),
      });
    });
    EXTRA_SOURCE_LANGS.forEach(function (code) {
      if (seen[code]) {
        return;
      }
      seen[code] = true;
      result.push({ value: code, label: languageLabel(code) });
    });
    return result;
  }

  /* Resolve a stored source-language code to a selectable value ("auto" for
   * empty/unknown codes, so a stale setting never breaks the selector). */
  function qtNormalizeSourceLang(code, languages) {
    var value = String(code == null ? "" : code).trim();
    if (!value) {
      return "auto";
    }
    var list = Array.isArray(languages) ? languages : [];
    for (var index = 0; index < list.length; index += 1) {
      var entry = list[index];
      if (entry && entry.value === value) {
        return value;
      }
    }
    return "auto";
  }

  /* Label of a history row's detected source language. "auto" is never shown as
   * an actual source language; only codes known to the selector get a localized
   * name, unknown codes fall back to their upper-cased code so the row still
   * describes what was detected. */
  function qtSourceLangLabel(code, languages) {
    var value = String(code == null ? "" : code).trim();
    if (!value || value === "auto") {
      return "";
    }
    var list = Array.isArray(languages) ? languages : [];
    for (var index = 0; index < list.length; index += 1) {
      var entry = list[index];
      if (entry && entry.value === value) {
        return languageLabel(value);
      }
    }
    return value.toUpperCase();
  }

  /* Characters are counted by Unicode code point so the counter matches the
   * Rust side, which truncates the input with `chars().take(20000)`. */
  function qtCountChars(text) {
    if (text === null || text === undefined) {
      return 0;
    }
    var value = String(text);
    return Array.from(value).length;
  }

  /* Source-language heuristic; must stay in sync with the Rust
   * `quicktranslate::detect_source_lang` (contract §5):
   * kana -> ja, Han -> zh, Hangul -> ko, Cyrillic -> ru, Arabic -> ar,
   * Thai -> th, Devanagari -> hi, Hebrew -> he, otherwise en. */
  function qtDetectSourceLang(text) {
    var value = String(text == null ? "" : text);
    if (/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/.test(value)) {
      return "ja";
    }
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(value)) {
      return "zh";
    }
    if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(value)) {
      return "ko";
    }
    if (/[\u0400-\u04ff]/.test(value)) {
      return "ru";
    }
    if (/[\u0600-\u06ff\u0750-\u077f]/.test(value)) {
      return "ar";
    }
    if (/[\u0e00-\u0e7f]/.test(value)) {
      return "th";
    }
    if (/[\u0900-\u097f]/.test(value)) {
      return "hi";
    }
    if (/[\u0590-\u05ff]/.test(value)) {
      return "he";
    }
    return "en";
  }

  /* Case-insensitive contains over the source and translation summaries. */
  function qtFilterHistory(entries, query) {
    var list = Array.isArray(entries) ? entries : [];
    var needle = String(query == null ? "" : query).trim().toLowerCase();
    if (!needle) {
      return list.slice();
    }
    return list.filter(function (entry) {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      var source = String(entry.source == null ? "" : entry.source).toLowerCase();
      var target = String(entry.target == null ? "" : entry.target).toLowerCase();
      return source.indexOf(needle) >= 0 || target.indexOf(needle) >= 0;
    });
  }

  /* "1.1 秒" / "1.1s" (one decimal, localized); zero/unknown shows a dash. The
   * footer prefixes it with the localized "耗时 " / "Took " label. */
  function qtFormatElapsed(milliseconds) {
    if (milliseconds === null || milliseconds === undefined || milliseconds === "") {
      return "—";
    }
    var value = Number(milliseconds);
    if (!isFinite(value) || value <= 0) {
      return "—";
    }
    return tr("quick.elapsedSeconds", { seconds: (value / 1000).toFixed(1) });
  }

  /* Footer text: "耗时 1.1 秒" / "Took 1.1s", or the localized placeholder. */
  function qtElapsedText(milliseconds) {
    if (milliseconds === null || milliseconds === undefined || milliseconds === "") {
      return tr("quick.elapsedNone");
    }
    var value = Number(milliseconds);
    if (!isFinite(value) || value <= 0) {
      return tr("quick.elapsedNone");
    }
    return tr("quick.elapsed", { time: qtFormatElapsed(value) });
  }

  /* History rows show "2026/11/02 10:15"; empty when the stamp is unusable. */
  function qtFormatHistoryTime(milliseconds) {
    var value = Number(milliseconds);
    if (!isFinite(value) || value <= 0) {
      return "";
    }
    var date = new Date(value);
    function pad(number) {
      return number < 10 ? "0" + number : String(number);
    }
    return (
      date.getFullYear() +
      "/" +
      pad(date.getMonth() + 1) +
      "/" +
      pad(date.getDate()) +
      " " +
      pad(date.getHours()) +
      ":" +
      pad(date.getMinutes())
    );
  }

  /* Unique id for one stream; the backend echoes it on every translate-event. */
  function qtMakeRequestId() {
    var random = Math.random().toString(36).slice(2, 8);
    return "quick-" + Date.now().toString(36) + "-" + ("000000" + random).slice(-6);
  }

  /* trim + truncate to the backend limit (code points). */
  function qtNormalizeInput(text) {
    var value = String(text == null ? "" : text).trim();
    var chars = Array.from(value);
    if (chars.length > MAX_CHARS) {
      return chars.slice(0, MAX_CHARS).join("");
    }
    return value;
  }

  /* ------------------------------------------------------------------ */
  /* Small UI helpers                                                    */
  /* ------------------------------------------------------------------ */

  function normalizeTargetCode(code) {
    var value = String(code == null ? "" : code);
    var match = LANGUAGES.filter(function (language) {
      return language.value === value;
    })[0];
    return match ? match.value : "zh";
  }

  function toast(message, tone) {
    if (!toastStack) {
      return;
    }
    var node = document.createElement("div");
    node.className = "qt-toast";
    node.setAttribute("data-tone", tone || "info");
    node.textContent = String(message == null ? "" : message);
    toastStack.appendChild(node);
    while (toastStack.children.length > 4) {
      toastStack.removeChild(toastStack.firstChild);
    }
    window.setTimeout(function () {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }, TOAST_MS);
  }

  function isNearBottom(node) {
    if (!node) {
      return true;
    }
    return node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }

  /* ------------------------------------------------------------------ */
  /* Frameless window: drag handle + adaptive height                     */
  /* ------------------------------------------------------------------ */

  /* Interactive header elements keep their normal behaviour; the rest of the
   * top bar acts as the window drag handle (same pattern as picker.js). */
  function isDragExcludedTarget(target) {
    var node = target;
    if (node && node.nodeType !== 1) {
      node = node.parentElement;
    }
    if (!node || typeof node.closest !== "function") {
      return true;
    }
    return !!node.closest(TOPBAR_DRAG_EXCLUDE);
  }

  function beginWindowDrag(event) {
    if (!event || event.button !== 0 || !topbarNode) {
      return;
    }
    if (isDragExcludedTarget(event.target)) {
      return;
    }
    dragState.active = true;
    dragState.session += 1;
    dragState.lastX = Number(event.screenX) || 0;
    dragState.lastY = Number(event.screenY) || 0;
    dragState.pendingX = 0;
    dragState.pendingY = 0;
    topbarNode.classList.add("is-dragging");
    // No text selection / native drag while the window follows the cursor.
    event.preventDefault();
  }

  function endWindowDrag() {
    if (!dragState.active) {
      return;
    }
    dragState.active = false;
    if (dragState.frame) {
      window.cancelAnimationFrame(dragState.frame);
      dragState.frame = 0;
    }
    flushWindowDrag();
    if (topbarNode) {
      topbarNode.classList.remove("is-dragging");
    }
  }

  /* Batches mousemove deltas into one shell call per animation frame. */
  function queueWindowDrag(dx, dy) {
    dragState.pendingX += dx;
    dragState.pendingY += dy;
    if (!dragState.frame) {
      dragState.frame = window.requestAnimationFrame(flushWindowDrag);
    }
  }

  function flushWindowDrag() {
    dragState.frame = 0;
    var dx = dragState.pendingX;
    var dy = dragState.pendingY;
    dragState.pendingX = 0;
    dragState.pendingY = 0;
    if (!dx && !dy) {
      return;
    }
    if (!API || typeof API.dragPanel !== "function") {
      endWindowDrag();
      return;
    }
    var session = dragState.session;
    var result = API.dragPanel(dx, dy);
    // If the shell rejects the drag (command unavailable), stop the drag
    // instead of leaving the card in the "dragging" cursor state.
    if (result && typeof result.then === "function") {
      result.then(function (response) {
        if (
          response &&
          response.ok === false &&
          dragState.active &&
          dragState.session === session
        ) {
          endWindowDrag();
        }
      });
    }
  }

  function handleWindowDragMove(event) {
    if (!dragState.active) {
      return;
    }
    if (event.buttons === 0) {
      endWindowDrag();
      return;
    }
    var x = Number(event.screenX) || 0;
    var y = Number(event.screenY) || 0;
    var dx = x - dragState.lastX;
    var dy = y - dragState.lastY;
    if (!dx && !dy) {
      return;
    }
    dragState.lastX = x;
    dragState.lastY = y;
    queueWindowDrag(dx, dy);
  }

  function measureNodeHeight(node) {
    if (!node) {
      return 0;
    }
    var height = node.offsetHeight;
    if (!isFinite(height) || height <= 0) {
      var rect = node.getBoundingClientRect();
      height = rect && isFinite(rect.height) ? rect.height : 0;
    }
    return height;
  }

  function verticalPadding(style) {
    var top = parseFloat(style && style.paddingTop) || 0;
    var bottom = parseFloat(style && style.paddingBottom) || 0;
    return top + bottom;
  }

  function rowGap(style) {
    var gap = parseFloat(style && style.rowGap);
    if (!isFinite(gap)) {
      gap = parseFloat(style && style.gap);
    }
    return isFinite(gap) ? gap : 0;
  }

  /* The window may never exceed the screen working area. */
  function screenMaxWindowHeight() {
    var available =
      window.screen && isFinite(window.screen.availHeight) && window.screen.availHeight > 0
        ? Number(window.screen.availHeight)
        : MAX_WINDOW_HEIGHT + RESIZE_SCREEN_MARGIN;
    return Math.max(
      MIN_WINDOW_HEIGHT,
      Math.min(MAX_WINDOW_HEIGHT, available - RESIZE_SCREEN_MARGIN)
    );
  }

  /* Natural height of the rendered translation. A Range measures the content
   * independently of the (stretched) result box, so the window can also shrink
   * again when a shorter history entry is restored. */
  function measureResultContentHeight() {
    if (!resultNode) {
      return 0;
    }
    var dataState = resultNode.getAttribute("data-state");
    if (dataState === "empty") {
      return EMPTY_RESULT_HEIGHT;
    }
    if (dataState === "loading") {
      return LOADING_RESULT_HEIGHT;
    }
    if (!state.raw) {
      return EMPTY_RESULT_HEIGHT;
    }
    try {
      var range = document.createRange();
      range.selectNodeContents(resultNode);
      var rect = range.getBoundingClientRect();
      if (rect && isFinite(rect.height) && rect.height > 0) {
        // Range slightly under-measures the outer block margins.
        return Math.ceil(rect.height) + 8;
      }
    } catch (error) {
      /* fall through to scrollHeight */
    }
    return resultNode.scrollHeight || 0;
  }

  function computeDesiredWindowHeight() {
    if (!winNode || !shellNode || !topbarNode || !bodyNode) {
      return MIN_WINDOW_HEIGHT;
    }
    var winStyle = window.getComputedStyle(winNode);
    var shellStyle = window.getComputedStyle(shellNode);
    var bodyStyle = window.getComputedStyle(bodyNode);
    var sourceBodyStyle = window.getComputedStyle(sourceBodyNode);
    var resultBodyStyle = window.getComputedStyle(resultBodyNode);

    var chrome =
      verticalPadding(winStyle) +
      (parseFloat(shellStyle.borderTopWidth) || 0) +
      (parseFloat(shellStyle.borderBottomWidth) || 0) +
      measureNodeHeight(topbarNode) +
      verticalPadding(bodyStyle);

    // Source column: header + padding + minimum editor + gap + footer row.
    var sourceNeeded =
      measureNodeHeight(sourceHeadNode) +
      verticalPadding(sourceBodyStyle) +
      MIN_SOURCE_HEIGHT +
      rowGap(sourceBodyStyle) +
      measureNodeHeight(sourceFootNode);

    // Result column: header + padding + natural translation height + footer.
    var errorNeeded =
      resultError && !resultError.hidden
        ? measureNodeHeight(resultError) + rowGap(resultBodyStyle)
        : 0;
    var resultNeeded =
      measureNodeHeight(resultHeadNode) +
      verticalPadding(resultBodyStyle) +
      measureResultContentHeight() +
      rowGap(resultBodyStyle) +
      measureNodeHeight(resultFootNode) +
      errorNeeded;

    var desired = Math.round(chrome + Math.max(sourceNeeded, resultNeeded));
    return Math.min(
      screenMaxWindowHeight(),
      Math.max(MIN_WINDOW_HEIGHT, desired)
    );
  }

  function applyWindowResize() {
    var height = computeDesiredWindowHeight();
    state.windowHeight = height;
    if (height === resizeState.lastHeight) {
      return;
    }
    resizeState.lastHeight = height;
    if (!API || typeof API.resize !== "function") {
      return;
    }
    API.resize(WINDOW_WIDTH, height).then(
      function (result) {
        // Growing the window after the last paint must keep the newest stream
        // text pinned to the bottom of the result area.
        if (state.translating && resultNode) {
          resultNode.scrollTop = resultNode.scrollHeight;
        }
        if (result && result.ok === false) {
          console.warn("[quicktranslate] resize failed:", result.error || "");
        }
      },
      function (error) {
        console.warn("[quicktranslate] resize failed:", error);
      }
    );
  }

  /* Throttled to one measurement/call per ~120ms while the stream grows. */
  function scheduleWindowResize() {
    if (resizeState.timer) {
      return;
    }
    resizeState.timer = window.setTimeout(function () {
      resizeState.timer = 0;
      applyWindowResize();
    }, RESIZE_THROTTLE_MS);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function renderTargetOptions() {
    targetSelect.innerHTML = "";
    LANGUAGES.forEach(function (language) {
      var option = document.createElement("option");
      option.value = String(language.value);
      option.textContent = languageLabel(language.value);
      targetSelect.appendChild(option);
    });
    targetSelect.value = normalizeTargetCode(state.quick.targetLang);
  }

  function renderSourceOptions() {
    if (!sourceSelect) {
      return;
    }
    sourceSelect.innerHTML = "";
    SOURCE_LANGUAGES.forEach(function (language) {
      var option = document.createElement("option");
      option.value = String(language.value);
      /* Labels are re-resolved per render: SOURCE_LANGUAGES was built on the
       * first paint, so its labels may belong to the previous locale. */
      option.textContent =
        language.value === "auto"
          ? tr("quick.lang.auto")
          : languageLabel(language.value);
      sourceSelect.appendChild(option);
    });
    sourceSelect.value = qtNormalizeSourceLang(state.quick.sourceLang, SOURCE_LANGUAGES);
  }

  function updateSourceCount() {
    var count = qtCountChars(sourceInput.value);
    sourceCount.textContent = tr("quick.source.count", {
      count: count,
      limit: MAX_CHARS,
    });
    sourceCount.classList.toggle("is-over", count > MAX_CHARS);
  }

  function updateResultCount() {
    resultCount.textContent = tr("quick.result.count", {
      count: qtCountChars(state.raw),
    });
    copyButton.disabled = !state.raw;
    speakButton.disabled = !state.raw;
    syncSpeakUi();
  }

  function renderEmptyResult() {
    resultNode.setAttribute("data-state", "empty");
    resultNode.innerHTML = "";
    var wrapper = document.createElement("div");
    wrapper.className = "qt-empty";
    var title = document.createElement("p");
    title.className = "qt-empty-title";
    title.textContent = tr("quick.empty.title");
    var hint = document.createElement("p");
    hint.className = "qt-empty-hint";
    hint.textContent = tr("quick.empty.hint");
    wrapper.appendChild(title);
    wrapper.appendChild(hint);
    resultNode.appendChild(wrapper);
    updateResultCount();
    scheduleWindowResize();
  }

  function renderLoading() {
    resultNode.setAttribute("data-state", "loading");
    resultNode.innerHTML = "";
    var wrapper = document.createElement("div");
    wrapper.className = "qt-loading";
    var spinner = document.createElement("span");
    spinner.className = "qt-spinner";
    spinner.setAttribute("aria-hidden", "true");
    var label = document.createElement("span");
    label.textContent = tr("quick.loading");
    wrapper.appendChild(spinner);
    wrapper.appendChild(label);
    resultNode.appendChild(wrapper);
    resultNode.scrollTop = 0;
    scheduleWindowResize();
  }

  function renderResult() {
    if (!state.raw) {
      renderEmptyResult();
      return;
    }
    var stick = isNearBottom(resultNode);
    resultNode.setAttribute("data-state", "ready");
    if (typeof LP.renderMarkdown === "function") {
      // renderMarkdown escapes its input, so model output cannot inject HTML.
      resultNode.innerHTML = LP.renderMarkdown(state.raw);
    } else {
      resultNode.textContent = state.raw;
    }
    updateResultCount();
    // Streaming keeps the newest text in view; after done only stick if the
    // reader had not scrolled away.
    if (state.translating || stick) {
      resultNode.scrollTop = resultNode.scrollHeight;
    }
    scheduleWindowResize();
  }

  /* Merge streamed chunks into one rAF paint (same idea as picker.js). */
  function scheduleResultRender() {
    if (state.renderPending) {
      return;
    }
    state.renderPending = true;
    window.requestAnimationFrame(function () {
      state.renderPending = false;
      renderResult();
    });
  }

  function renderError(message, hint) {
    /* Remember the backend wording: a locale switch rebuilds this block with the
     * same message/hint and the freshly localized title/retry label. */
    state.error = {
      message: String(message == null ? "" : message),
      hint: String(hint == null ? "" : hint),
    };
    resultError.innerHTML = "";
    var text = document.createElement("div");
    text.className = "qt-result-error-text";
    var messageNode = document.createElement("span");
    messageNode.textContent = state.error.message || tr("quick.error.title");
    text.appendChild(messageNode);
    if (state.error.hint) {
      var hintNode = document.createElement("span");
      hintNode.className = "qt-result-error-hint";
      hintNode.textContent = state.error.hint;
      text.appendChild(hintNode);
    }
    var retry = document.createElement("button");
    retry.type = "button";
    retry.className = "qt-btn qt-btn-small qt-result-error-retry";
    retry.textContent = tr("quick.error.retry");
    retry.addEventListener("click", function () {
      startTranslate();
    });
    resultError.appendChild(text);
    resultError.appendChild(retry);
    resultError.hidden = false;
  }

  function clearError() {
    state.error = null;
    if (!resultError) {
      return;
    }
    resultError.hidden = true;
    resultError.innerHTML = "";
  }

  function setTranslatingUi(translating) {
    translateButton.textContent = translating
      ? tr("quick.action.stop")
      : tr("quick.action.translate");
    translateButton.classList.toggle("is-stop", translating);
    translateButton.setAttribute(
      "aria-label",
      translating ? tr("quick.action.stopAria") : tr("quick.action.translateAria")
    );
    sourceClear.disabled = translating;
    sourceSelect.disabled = translating;
    targetSelect.disabled = translating;
    sourceInput.readOnly = translating;
    // The swap button is also disabled while the source language is "auto".
    syncSwapState();
  }

  function setPinUi(pinned) {
    pinButton.setAttribute("aria-pressed", pinned ? "true" : "false");
    pinButton.title = pinned ? tr("quick.action.unpin") : tr("quick.action.pin");
    pinButton.setAttribute(
      "aria-label",
      pinned ? tr("quick.action.unpin") : tr("quick.action.pin")
    );
  }

  function applyQuickConfig(quick) {
    var config = quick && typeof quick === "object" ? quick : {};
    state.quick = {
      enabled: config.enabled !== false,
      hotkey: String(config.hotkey || "Alt+Space"),
      sourceLang: qtNormalizeSourceLang(config.sourceLang, SOURCE_LANGUAGES),
      targetLang: normalizeTargetCode(config.targetLang),
      prompt: String(config.prompt || ""),
      pinned: !!config.pinned,
    };
    if (sourceSelect) {
      sourceSelect.value = state.quick.sourceLang;
    }
    targetSelect.value = state.quick.targetLang;
    setPinUi(state.quick.pinned);
    syncSwapState();
  }

  /* Swap is only meaningful with a pinned source language; keep its disabled
   * state and tooltip in sync with the selector and the stream state. */
  function syncSwapState() {
    if (!swapButton) {
      return;
    }
    var auto = state.quick.sourceLang === "auto";
    swapButton.disabled = auto || state.translating;
    var label = auto ? tr("quick.action.swapDisabled") : tr("quick.action.swap");
    swapButton.title = label;
    swapButton.setAttribute("aria-label", label);
  }

  /* ------------------------------------------------------------------ */
  /* Config / language                                                   */
  /* ------------------------------------------------------------------ */

  /* Set once the shared runtime has applied its static pass, so a later locale
   * read never runs a full init again. */
  var localeInitialized = false;

  /* Applies the UI language from quick_ready()/the quick-locale event and
   * reports whether it changed. Any actual change re-renders the dynamic chrome
   * (see refreshLocaleChrome) while the streamed translation text is kept. */
  function applyLocale(locale) {
    var raw = String(locale == null ? "" : locale).trim().toLowerCase();
    var value = "";
    if (raw.indexOf("zh") === 0) {
      value = "zh";
    } else if (raw.indexOf("en") === 0) {
      value = "en";
    }
    if (!value) {
      return false;
    }
    if (!LP.i18n || typeof LP.i18n.init !== "function") {
      return false;
    }
    var previous =
      typeof LP.i18n.currentLocale === "function" ? LP.i18n.currentLocale() : "";
    if (!localeInitialized) {
      LP.i18n.init(value);
      localeInitialized = true;
    } else if (!LP.i18n.setLocale(value)) {
      /* Same locale: no static pass, so the rendered copy stays untouched. */
      return false;
    }
    var next =
      typeof LP.i18n.currentLocale === "function" ? LP.i18n.currentLocale() : previous;
    return previous !== next;
  }

  /* Re-renders every localized piece quicktranslate.js builds itself. The
   * translation content (state.raw) and the in-flight stream are never reset:
   * only chrome, counters, tooltips and the history list are refreshed. */
  function refreshLocaleChrome() {
    if (!sourceInput || !targetSelect || !resultNode) {
      return;
    }
    if (limitHint) {
      limitHint.textContent = tr("quick.source.limitHint", {
        count: LANGUAGES.length,
        limit: MAX_CHARS,
      });
    }
    renderTargetOptions();
    renderSourceOptions();
    updateSourceCount();
    var dataState = resultNode.getAttribute("data-state");
    if (dataState === "empty") {
      renderEmptyResult();
    } else if (dataState === "loading") {
      renderLoading();
    } else {
      updateResultCount();
      if (resultError && !resultError.hidden) {
        renderError(state.error ? state.error.message : "", state.error ? state.error.hint : "");
      }
    }
    if (elapsedNode) {
      elapsedNode.textContent = qtElapsedText(state.elapsedMs);
    }
    setTranslatingUi(state.translating);
    setPinUi(state.quick.pinned);
    syncSwapState();
    syncSpeakUi();
    syncHistoryClearLabel();
    if (state.historyOpen) {
      renderHistory();
    }
  }

  function refreshConfig() {
    if (!API || typeof API.ready !== "function") {
      return Promise.resolve();
    }
    return API.ready().then(
      function (result) {
        if (!result || result.ok === false) {
          toast((result && result.error) || tr("quick.toast.readConfigFailed"), "error");
          return;
        }
        state.ready = true;
        applyQuickConfig(result.quick);
        /* quick_ready carries the effective UI language (R1): the first payload
         * initializes the shared runtime, later ones switch it. A changed locale
         * re-renders the chrome without touching the translation text. */
        if (applyLocale(result.locale)) {
          refreshLocaleChrome();
        }
        if (result.promptDefault) {
          state.promptDefault = String(result.promptDefault);
        }
      },
      function (error) {
        toast(String(error || tr("quick.toast.readConfigFailed")), "error");
      }
    );
  }

  function setTargetLang(code) {
    var next = normalizeTargetCode(code);
    var previous = state.quick.targetLang;
    if (next === previous) {
      targetSelect.value = next;
      return Promise.resolve(true);
    }
    state.quick.targetLang = next;
    targetSelect.value = next;
    if (!API || typeof API.setTargetLang !== "function") {
      return Promise.resolve(true);
    }
    return API.setTargetLang(next).then(
      function (result) {
        if (result && result.ok === false) {
          state.quick.targetLang = previous;
          targetSelect.value = previous;
          toast(result.error || tr("quick.toast.setTargetFailed"), "error");
          return false;
        }
        if (result && result.targetLang) {
          state.quick.targetLang = normalizeTargetCode(result.targetLang);
          targetSelect.value = state.quick.targetLang;
        }
        return true;
      },
      function (error) {
        state.quick.targetLang = previous;
        targetSelect.value = previous;
        toast(String(error || tr("quick.toast.setTargetFailed")), "error");
        return false;
      }
    );
  }

  /* Remembers the pinned source language ("auto" = detect per request). */
  function setSourceLang(code) {
    var next = qtNormalizeSourceLang(code, SOURCE_LANGUAGES);
    var previous = state.quick.sourceLang;
    if (next === previous) {
      if (sourceSelect) {
        sourceSelect.value = next;
      }
      syncSwapState();
      return Promise.resolve(true);
    }
    state.quick.sourceLang = next;
    if (sourceSelect) {
      sourceSelect.value = next;
    }
    syncSwapState();
    if (!API || typeof API.setSourceLang !== "function") {
      return Promise.resolve(true);
    }
    return API.setSourceLang(next).then(
      function (result) {
        if (result && result.ok === false) {
          state.quick.sourceLang = previous;
          if (sourceSelect) {
            sourceSelect.value = previous;
          }
          syncSwapState();
          toast(result.error || tr("quick.toast.setSourceFailed"), "error");
          return false;
        }
        if (result && result.sourceLang) {
          state.quick.sourceLang = qtNormalizeSourceLang(
            result.sourceLang,
            SOURCE_LANGUAGES
          );
          if (sourceSelect) {
            sourceSelect.value = state.quick.sourceLang;
          }
          syncSwapState();
        }
        return true;
      },
      function (error) {
        state.quick.sourceLang = previous;
        if (sourceSelect) {
          sourceSelect.value = previous;
        }
        syncSwapState();
        toast(String(error || tr("quick.toast.setSourceFailed")), "error");
        return false;
      }
    );
  }

  /* ------------------------------------------------------------------ */
  /* Speech (Windows system voices via speechSynthesis)                  */
  /* ------------------------------------------------------------------ */

  function syncSpeakUi() {
    if (!speakButton) {
      return;
    }
    var active = !!speech.speaking;
    speakButton.classList.toggle("is-active", active);
    speakButton.setAttribute("aria-pressed", active ? "true" : "false");
    // Icon-only button: the label lives in the tooltip / accessible name.
    var label = active ? tr("quick.result.speakStop") : tr("quick.result.speak");
    speakButton.title = label;
    speakButton.setAttribute("aria-label", label);
    if (!active) {
      speakButton.disabled = !state.raw;
    }
  }

  function clearSpeechState(utterance) {
    if (speech.utterance !== utterance) {
      return;
    }
    speech.utterance = null;
    if (speech.speaking) {
      speech.speaking = false;
      syncSpeakUi();
    }
  }

  /* Intentional stop (second click, new translation, hide, clear...):
   * `speechSynthesis.cancel()` still fires `onerror` on the cancelled
   * utterance - the flags below keep that path silent. */
  function stopSpeech() {
    var utterance = speech.utterance;
    if (utterance) {
      utterance.__lexoraCancelled = true;
    }
    speech.utterance = null;
    speech.cancelRequested = true;
    var synth = window.speechSynthesis;
    if (synth) {
      try {
        synth.cancel();
      } catch (error) {
        /* ignore */
      }
    }
    if (speech.speaking) {
      speech.speaking = false;
      syncSpeakUi();
    }
  }

  function getVoices() {
    return new Promise(function (resolve) {
      var synth = window.speechSynthesis;
      if (!synth) {
        resolve([]);
        return;
      }
      var voices = synth.getVoices() || [];
      if (voices.length) {
        resolve(voices);
        return;
      }
      var settled = false;
      var timer = window.setTimeout(finish, 900);
      function finish() {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        try {
          synth.removeEventListener("voiceschanged", finish);
        } catch (error) {
          /* ignore */
        }
        try {
          resolve(synth.getVoices() || []);
        } catch (error) {
          resolve([]);
        }
      }
      try {
        synth.addEventListener("voiceschanged", finish);
      } catch (error) {
        synth.onvoiceschanged = finish;
      }
    });
  }

  function pickVoice(voices, text) {
    var wantsChinese = /[\u4e00-\u9fff]/.test(text);
    var preferred = voices.filter(function (voice) {
      var lang = String(voice.lang || "").toLowerCase();
      return wantsChinese ? lang.indexOf("zh") === 0 : lang.indexOf("en") === 0;
    });
    return preferred[0] || voices[0] || null;
  }

  function speak(text) {
    var value = String(text || "").trim();
    if (!value) {
      toast(tr("quick.toast.noText"), "error");
      return;
    }
    if (speech.speaking) {
      stopSpeech();
      return;
    }
    var synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== "function") {
      toast(tr("quick.toast.noVoice"), "error");
      return;
    }
    if (speech.loading) {
      return;
    }
    speech.loading = true;
    getVoices().then(function (voices) {
      speech.loading = false;
      if (!voices || !voices.length) {
        toast(tr("quick.toast.noVoice"), "error");
        return;
      }
      var voice = pickVoice(voices, value);
      var utterance = new window.SpeechSynthesisUtterance(value);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang || "zh-CN";
      }
      utterance.rate = 1.0;
      utterance.onend = function () {
        clearSpeechState(utterance);
      };
      utterance.onerror = function (event) {
        var wasCurrent = speech.utterance === utterance;
        var cancelled =
          !!utterance.__lexoraCancelled ||
          speech.cancelRequested ||
          (event &&
            (event.error === "interrupted" ||
              event.error === "canceled" ||
              event.error === "cancelled"));
        clearSpeechState(utterance);
        // A user stop or a replaced utterance ends silently; only a genuine
        // failure of the utterance we started is worth reporting.
        if (wasCurrent && !cancelled) {
          toast(tr("quick.toast.speechFailed"), "error");
        }
      };
      speech.cancelRequested = false;
      speech.utterance = utterance;
      speech.speaking = true;
      syncSpeakUi();
      try {
        synth.cancel();
        synth.speak(utterance);
      } catch (error) {
        clearSpeechState(utterance);
        toast(tr("quick.toast.speechFailed"), "error");
      }
    });
  }

  /* Reads the plain text of the Markdown translation, not its markup. */
  function speakResult() {
    var value = String(state.raw || "").trim();
    if (!value) {
      toast(tr("quick.toast.noText"), "error");
      return;
    }
    if (speech.speaking) {
      stopSpeech();
      return;
    }
    var plain = typeof LP.markdownToPlain === "function" ? LP.markdownToPlain(value) : value;
    speak(plain);
  }

  /* ------------------------------------------------------------------ */
  /* Translation                                                         */
  /* ------------------------------------------------------------------ */

  function startTranslate() {
    if (state.translating) {
      return;
    }
    if (!API || typeof API.translate !== "function") {
      toast(tr("quick.toast.translateUnavailable"), "error");
      return;
    }
    var text = qtNormalizeInput(sourceInput.value);
    if (!text) {
      toast(tr("quick.toast.emptyInput"), "error");
      sourceInput.focus();
      return;
    }
    // A new round replaces the previous translation, so its speech too.
    stopSpeech();
    var requestId = qtMakeRequestId();
    state.requestId = requestId;
    state.raw = "";
    state.startedAt = Date.now();
    state.elapsedMs = null;
    state.translating = true;
    state.renderPending = false;
    clearError();
    renderLoading();
    updateResultCount();
    elapsedNode.textContent = qtElapsedText(null);
    setTranslatingUi(true);
    // `sourceLang` is "auto" (detect on the shell side) or the pinned code.
    API.translate(
      requestId,
      text,
      state.quick.targetLang,
      state.quick.sourceLang
    ).then(
      function (result) {
        if (!state.translating || state.requestId !== requestId) {
          return;
        }
        if (!result || result.ok === false) {
          failTranslate(
            (result && result.error) || tr("quick.toast.noResponse"),
            (result && result.hint) || ""
          );
        }
      },
      function (error) {
        if (!state.translating || state.requestId !== requestId) {
          return;
        }
        failTranslate(String(error || tr("quick.toast.noResponse")), "");
      }
    );
  }

  function stopTranslate(notify) {
    if (!state.translating) {
      return;
    }
    var requestId = state.requestId;
    state.translating = false;
    state.requestId = "";
    state.renderPending = false;
    setTranslatingUi(false);
    if (requestId && API && typeof API.abortTranslate === "function") {
      API.abortTranslate(requestId).then(
        function (result) {
          if (result && result.ok === false) {
            console.warn("[quicktranslate] abort failed:", result.error || "");
          }
        },
        function (error) {
          console.warn("[quicktranslate] abort failed:", error);
        }
      );
    }
    if (state.raw) {
      renderResult();
    } else {
      renderEmptyResult();
    }
    elapsedNode.textContent = qtElapsedText(null);
    copyButton.disabled = !state.raw;
    if (notify) {
      toast(tr("quick.toast.stopped"));
    }
  }

  function finishTranslate(elapsedMs) {
    if (!state.translating) {
      return;
    }
    state.translating = false;
    state.requestId = "";
    state.renderPending = false;
    state.elapsedMs =
      typeof elapsedMs === "number" && isFinite(elapsedMs) && elapsedMs >= 0
        ? Math.round(elapsedMs)
        : Math.max(0, Date.now() - state.startedAt);
    setTranslatingUi(false);
    renderResult();
    elapsedNode.textContent = qtElapsedText(state.elapsedMs);
    copyButton.disabled = !state.raw;
    sourceInput.focus();
    // The shell already stored this round; only the in-memory list needs a refresh.
    refreshHistory();
  }

  function failTranslate(message, hint) {
    state.translating = false;
    state.requestId = "";
    state.renderPending = false;
    setTranslatingUi(false);
    if (state.raw) {
      renderResult();
    } else {
      renderEmptyResult();
    }
    renderError(message, hint);
    elapsedNode.textContent = qtElapsedText(null);
    copyButton.disabled = !state.raw;
    // The error block adds a row below the result area.
    scheduleWindowResize();
    toast(String(message == null ? "" : message) || tr("quick.error.title"), "error");
    sourceInput.focus();
  }

  function handleTranslateEvent(event) {
    if (!event || typeof event !== "object") {
      return;
    }
    var requestId = String(event.requestId || "");
    if (!state.translating || !requestId || requestId !== state.requestId) {
      return;
    }
    if (event.type === "chunk") {
      var text = event.text == null ? "" : String(event.text);
      if (!text) {
        return;
      }
      state.raw += text;
      updateResultCount();
      scheduleResultRender();
      return;
    }
    if (event.type === "done") {
      finishTranslate(event.elapsedMs);
      return;
    }
    if (event.type === "error") {
      failTranslate(event.message || tr("quick.error.title"), event.hint || "");
    }
  }

  /* ------------------------------------------------------------------ */
  /* History                                                             */
  /* ------------------------------------------------------------------ */

  function refreshHistory() {
    if (!API || typeof API.historyList !== "function") {
      return Promise.resolve();
    }
    return API.historyList().then(
      function (result) {
        if (!result || result.ok === false) {
          return;
        }
        state.history = Array.isArray(result.entries)
          ? result.entries.slice(0, MAX_HISTORY)
          : [];
        if (state.historyOpen) {
          renderHistory();
        }
      },
      function () {
        /* A failed history refresh must not interrupt translation. */
      }
    );
  }

  function historyMeta(entry) {
    if (!entry || typeof entry !== "object") {
      return "";
    }
    var parts = [];
    var time = qtFormatHistoryTime(entry.createdAt);
    if (time) {
      parts.push(time);
    }
    // The shell stores the actual detected source language; "auto" is never
    // shown as a source language.
    var from = qtSourceLangLabel(entry.sourceLang, SOURCE_LANGUAGES);
    var to = languageLabel(entry.targetLang);
    if (from && to) {
      parts.push(from + " → " + to);
    } else if (to) {
      parts.push(to);
    }
    return parts.join(" · ");
  }

  function singleLine(text) {
    var value = String(text == null ? "" : text)
      .replace(/\s+/g, " ")
      .trim();
    if (value.length > 120) {
      value = value.slice(0, 120) + "…";
    }
    return value || tr("quick.history.emptyText");
  }

  function historyItem(entry) {
    var row = document.createElement("div");
    row.className = "qt-history-item";
    row.setAttribute("role", "listitem");

    var open = document.createElement("button");
    open.type = "button";
    open.className = "qt-history-open";
    open.title = tr("quick.history.backfill");

    var meta = document.createElement("span");
    meta.className = "qt-history-meta";
    meta.textContent = historyMeta(entry);
    open.appendChild(meta);

    var sourceLine = document.createElement("span");
    sourceLine.className = "qt-history-source";
    sourceLine.textContent = singleLine(entry && entry.source);
    open.appendChild(sourceLine);

    var targetLine = document.createElement("span");
    targetLine.className = "qt-history-target";
    targetLine.textContent = singleLine(entry && entry.target);
    open.appendChild(targetLine);

    open.addEventListener("click", function () {
      backfillHistory(entry);
    });

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "qt-history-delete";
    remove.title = tr("quick.history.delete");
    remove.setAttribute("aria-label", tr("quick.history.deleteAria"));
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
    remove.addEventListener("click", function (event) {
      event.stopPropagation();
      deleteHistoryEntry(entry);
    });

    row.appendChild(open);
    row.appendChild(remove);
    return row;
  }

  function renderHistory() {
    if (!historyList) {
      return;
    }
    var entries = qtFilterHistory(state.history, state.historyQuery);
    historyList.innerHTML = "";
    if (!entries.length) {
      var empty = document.createElement("div");
      empty.className = "qt-history-empty";
      empty.textContent = state.history.length
        ? tr("quick.history.noMatch")
        : tr("quick.history.empty");
      historyList.appendChild(empty);
    } else {
      entries.forEach(function (entry) {
        historyList.appendChild(historyItem(entry));
      });
    }
    if (state.history.length) {
      historySummary.textContent = state.historyQuery
        ? tr("quick.history.summaryFiltered", {
            total: state.history.length,
            count: entries.length,
          })
        : tr("quick.history.summary", { count: state.history.length });
    } else {
      historySummary.textContent = tr("quick.history.empty");
    }
    historyClear.disabled = !state.history.length;
    if (!state.history.length) {
      resetHistoryClearArmed();
    }
  }

  function openHistory() {
    state.historyOpen = true;
    historyOverlay.hidden = false;
    historyToggle.setAttribute("aria-expanded", "true");
    historySearch.value = "";
    state.historyQuery = "";
    resetHistoryClearArmed();
    renderHistory();
    historySearch.focus();
    refreshHistory();
  }

  function closeHistory() {
    if (!state.historyOpen) {
      return;
    }
    state.historyOpen = false;
    historyOverlay.hidden = true;
    historyToggle.setAttribute("aria-expanded", "false");
    resetHistoryClearArmed();
    sourceInput.focus();
  }

  function backfillHistory(entry) {
    if (!entry || typeof entry !== "object") {
      return;
    }
    stopSpeech();
    if (state.translating) {
      stopTranslate(false);
    }
    sourceInput.value = qtNormalizeInput(entry.source);
    state.raw = String(entry.target == null ? "" : entry.target);
    state.elapsedMs =
      typeof entry.elapsedMs === "number" && isFinite(entry.elapsedMs)
        ? Math.round(entry.elapsedMs)
        : null;
    state.requestId = "";
    state.renderPending = false;
    updateSourceCount();
    clearError();
    if (state.raw) {
      renderResult();
    } else {
      renderEmptyResult();
    }
    elapsedNode.textContent = qtElapsedText(state.elapsedMs);
    copyButton.disabled = !state.raw;
    if (entry.targetLang) {
      setTargetLang(entry.targetLang);
    }
    closeHistory();
  }

  function deleteHistoryEntry(entry) {
    if (!entry || !entry.id) {
      return;
    }
    if (!API || typeof API.historyDelete !== "function") {
      return;
    }
    API.historyDelete(String(entry.id)).then(
      function (result) {
        if (result && result.ok === false) {
          toast(result.error || tr("quick.toast.deleteFailed"), "error");
          return;
        }
        state.history = state.history.filter(function (item) {
          return !item || item.id !== entry.id;
        });
        renderHistory();
        toast(tr("quick.toast.deleted"));
      },
      function (error) {
        toast(String(error || tr("quick.toast.deleteFailed")), "error");
      }
    );
  }

  /* Keeps the clear button label in sync with the armed state and the current
   * locale. */
  function syncHistoryClearLabel() {
    if (!historyClear) {
      return;
    }
    historyClear.textContent = state.historyClearArmed
      ? tr("quick.history.confirmClear")
      : tr("quick.history.clear");
  }

  function resetHistoryClearArmed() {
    state.historyClearArmed = false;
    if (state.clearTimer) {
      window.clearTimeout(state.clearTimer);
      state.clearTimer = null;
    }
    if (historyClear) {
      historyClear.classList.remove("is-armed");
      historyClear.textContent = tr("quick.history.clear");
    }
  }

  function handleHistoryClearClick() {
    if (!state.history.length) {
      return;
    }
    if (!state.historyClearArmed) {
      state.historyClearArmed = true;
      historyClear.classList.add("is-armed");
      historyClear.textContent = tr("quick.history.confirmClear");
      if (state.clearTimer) {
        window.clearTimeout(state.clearTimer);
      }
      state.clearTimer = window.setTimeout(resetHistoryClearArmed, 4000);
      return;
    }
    resetHistoryClearArmed();
    if (!API || typeof API.historyClear !== "function") {
      return;
    }
    API.historyClear().then(
      function (result) {
        if (result && result.ok === false) {
          toast(result.error || tr("quick.toast.clearFailed"), "error");
          return;
        }
        state.history = [];
        renderHistory();
        toast(tr("quick.toast.cleared"), "success");
      },
      function (error) {
        toast(String(error || tr("quick.toast.clearFailed")), "error");
      }
    );
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */

  function hideWindow() {
    // Hiding the panel also ends any speech (contract §6).
    stopSpeech();
    if (!API || typeof API.hide !== "function") {
      return;
    }
    API.hide().then(
      function (result) {
        if (!API.live) {
          toast(tr("quick.toast.previewHide"));
        } else if (result && result.ok === false) {
          toast(result.error || tr("quick.toast.hideFailed"), "error");
        }
      },
      function (error) {
        toast(String(error || tr("quick.toast.hideFailed")), "error");
      }
    );
  }

  function handleSwap() {
    if (state.translating) {
      return;
    }
    // Auto detection means there is no pinned source language to swap with.
    if (state.quick.sourceLang === "auto") {
      toast(tr("quick.action.swapDisabled"), "error");
      return;
    }
    stopSpeech();
    var previousSource = state.quick.sourceLang;
    var previousTarget = state.quick.targetLang;
    if (state.raw) {
      sourceInput.value = state.raw;
      state.raw = "";
      state.elapsedMs = null;
      state.renderPending = false;
      clearError();
      renderEmptyResult();
      updateSourceCount();
      elapsedNode.textContent = qtElapsedText(null);
      copyButton.disabled = true;
    }
    // Swap both selectors and remember the new values.
    setSourceLang(previousTarget);
    setTargetLang(previousSource);
    toast(
      tr("quick.toast.swapped", {
        from: languageLabel(previousSource),
        to: languageLabel(previousTarget),
      })
    );
    sourceInput.focus();
  }

  function togglePin() {
    var previous = state.quick.pinned;
    var next = !previous;
    state.quick.pinned = next;
    setPinUi(next);
    if (!API || typeof API.pin !== "function") {
      return;
    }
    API.pin(next).then(
      function (result) {
        if (result && result.ok === false) {
          state.quick.pinned = previous;
          setPinUi(previous);
          toast(result.error || tr("quick.toast.pinFailed"), "error");
          return;
        }
        if (result && typeof result.pinned === "boolean") {
          state.quick.pinned = result.pinned;
          setPinUi(result.pinned);
        }
        toast(state.quick.pinned ? tr("quick.toast.pinned") : tr("quick.toast.unpinned"));
      },
      function (error) {
        state.quick.pinned = previous;
        setPinUi(previous);
        toast(String(error || tr("quick.toast.pinFailed")), "error");
      }
    );
  }

  function copyResult() {
    if (!state.raw) {
      toast(tr("quick.toast.copyEmpty"), "error");
      return;
    }
    if (!API || typeof API.copy !== "function") {
      return;
    }
    API.copy(state.raw).then(
      function (result) {
        if (result && result.ok === false) {
          toast(result.error || tr("quick.toast.copyFailed"), "error");
          return;
        }
        toast(tr("quick.toast.copied"), "success");
      },
      function (error) {
        toast(String(error || tr("quick.toast.copyFailed")), "error");
      }
    );
  }

  function clearPanel() {
    stopSpeech();
    if (state.translating) {
      stopTranslate(false);
    }
    sourceInput.value = "";
    state.raw = "";
    state.requestId = "";
    state.elapsedMs = null;
    state.renderPending = false;
    clearError();
    updateSourceCount();
    renderEmptyResult();
    elapsedNode.textContent = qtElapsedText(null);
    copyButton.disabled = true;
    sourceInput.focus();
  }

  function handleShow() {
    if (state.historyOpen) {
      closeHistory();
    }
    /* Re-reads quick_ready on every show: the summon may happen long after the
     * window was hidden and the UI language (or the quick settings) changed. */
    refreshConfig().then(function () {
      scheduleWindowResize();
      sourceInput.focus();
    });
  }

  /* quick-locale (R1): the settings page broadcasts a language switch to this
   * window, which may be hidden. Refresh the chrome in place and keep whatever
   * translation text (or in-flight stream) is currently shown. */
  function handleLocaleEvent(payload) {
    var locale = payload && typeof payload === "object" ? payload.locale : payload;
    if (applyLocale(locale)) {
      refreshLocaleChrome();
      scheduleWindowResize();
    }
  }

  function handleKeydown(event) {
    if (!event) {
      return;
    }
    var insideOverlay =
      state.historyOpen && historyOverlay && historyOverlay.contains(event.target);
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.historyOpen) {
        closeHistory();
      } else {
        hideWindow();
      }
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      if (insideOverlay) {
        return;
      }
      event.preventDefault();
      if (state.translating) {
        return;
      }
      startTranslate();
    }
  }

  function bindEvents() {
    sourceInput.addEventListener("input", updateSourceCount);
    if (sourceSelect) {
      sourceSelect.addEventListener("change", function () {
        setSourceLang(sourceSelect.value);
      });
    }
    targetSelect.addEventListener("change", function () {
      setTargetLang(targetSelect.value);
    });
    sourceClear.addEventListener("click", function () {
      if (!state.translating) {
        clearPanel();
      }
    });
    translateButton.addEventListener("click", function () {
      if (state.translating) {
        stopTranslate(true);
      } else {
        startTranslate();
      }
    });
    copyButton.addEventListener("click", copyResult);
    if (speakButton) {
      speakButton.addEventListener("click", speakResult);
    }
    if (closeButton) {
      closeButton.addEventListener("click", hideWindow);
    }
    swapButton.addEventListener("click", handleSwap);
    pinButton.addEventListener("click", togglePin);
    historyToggle.addEventListener("click", function () {
      if (state.historyOpen) {
        closeHistory();
      } else {
        openHistory();
      }
    });
    historyClose.addEventListener("click", closeHistory);
    historyOverlay.addEventListener("mousedown", function (event) {
      if (event.target === historyOverlay) {
        closeHistory();
      }
    });
    historySearch.addEventListener("input", function () {
      state.historyQuery = historySearch.value;
      renderHistory();
    });
    historyClear.addEventListener("click", handleHistoryClearClick);
    document.addEventListener("keydown", handleKeydown, true);
    if (topbarNode) {
      topbarNode.addEventListener("mousedown", beginWindowDrag);
      document.addEventListener("mousemove", handleWindowDragMove);
      document.addEventListener("mouseup", endWindowDrag);
      window.addEventListener("blur", endWindowDrag);
    }
    window.addEventListener("resize", scheduleWindowResize);
  }

  function init() {
    if (!sourceInput || !targetSelect || !resultNode) {
      return;
    }
    limitHint.textContent = tr("quick.source.limitHint", {
      count: LANGUAGES.length,
      limit: MAX_CHARS,
    });
    renderTargetOptions();
    renderSourceOptions();
    applyQuickConfig(state.quick);
    updateSourceCount();
    updateResultCount();
    renderEmptyResult();
    elapsedNode.textContent = qtElapsedText(null);
    setPinUi(false);
    setTranslatingUi(false);
    syncSpeakUi();
    bindEvents();
    if (API) {
      if (typeof API.onTranslateEvent === "function") {
        API.onTranslateEvent(handleTranslateEvent);
      }
      if (typeof API.onShow === "function") {
        API.onShow(handleShow);
      }
      if (typeof API.onLocale === "function") {
        API.onLocale(handleLocaleEvent);
      }
    }
    scheduleWindowResize();
    refreshConfig().then(function () {
      updateSourceCount();
      updateResultCount();
      scheduleWindowResize();
      sourceInput.focus();
    });
    if (!API) {
      toast(tr("quick.toast.bridgeMissing"), "error");
    }
  }

  init();
})();
