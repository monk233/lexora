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
(function () {
  "use strict";

  var API = window.quickAPI;
  var LP = window.LP || {};
  var LANGUAGES = Array.isArray(LP.LANGUAGES) ? LP.LANGUAGES.slice() : [];
  var MAX_CHARS = 20000;
  var MAX_HISTORY = 500;
  var TOAST_MS = 4000;

  /* ---- DOM ------------------------------------------------------------- */

  var sourceInput = document.getElementById("qt-source");
  var sourceCount = document.getElementById("qt-source-count");
  var sourceClear = document.getElementById("qt-source-clear");
  var limitHint = document.getElementById("qt-limit-hint");
  var translateButton = document.getElementById("qt-translate");
  var targetSelect = document.getElementById("qt-target-lang");
  var swapButton = document.getElementById("qt-swap");
  var pinButton = document.getElementById("qt-pin");
  var historyToggle = document.getElementById("qt-history-toggle");
  var resultNode = document.getElementById("qt-result");
  var resultCount = document.getElementById("qt-result-count");
  var resultError = document.getElementById("qt-result-error");
  var copyButton = document.getElementById("qt-copy");
  var elapsedNode = document.getElementById("qt-elapsed");
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
    history: [],
    historyOpen: false,
    historyQuery: "",
    historyClearArmed: false,
    clearTimer: null,
  };

  /* ------------------------------------------------------------------ */
  /* Pure helpers (extracted by web/quicktranslate.test.cjs)             */
  /* ------------------------------------------------------------------ */

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

  /* "842 ms"; the footer prefixes it with "耗时 ". */
  function qtFormatElapsed(milliseconds) {
    if (milliseconds === null || milliseconds === undefined || milliseconds === "") {
      return "—";
    }
    var value = Number(milliseconds);
    if (!isFinite(value) || value < 0) {
      return "—";
    }
    return Math.round(value) + " ms";
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

  function languageLabel(code) {
    var key = String(code == null ? "" : code);
    if (!key) {
      return "";
    }
    var labels = LP.LANG_LABELS || {};
    return labels[key] || key;
  }

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
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function renderTargetOptions() {
    targetSelect.innerHTML = "";
    LANGUAGES.forEach(function (language) {
      var option = document.createElement("option");
      option.value = String(language.value);
      option.textContent = String(language.label);
      targetSelect.appendChild(option);
    });
    targetSelect.value = normalizeTargetCode(state.quick.targetLang);
  }

  function updateSourceCount() {
    var count = qtCountChars(sourceInput.value);
    sourceCount.textContent = count + " / " + MAX_CHARS + " 字符";
    sourceCount.classList.toggle("is-over", count > MAX_CHARS);
  }

  function updateResultCount() {
    resultCount.textContent = qtCountChars(state.raw) + " 字符";
    copyButton.disabled = !state.raw;
  }

  function renderEmptyResult() {
    resultNode.setAttribute("data-state", "empty");
    resultNode.innerHTML = "";
    var wrapper = document.createElement("div");
    wrapper.className = "qt-empty";
    var title = document.createElement("p");
    title.className = "qt-empty-title";
    title.textContent = "译文会显示在这里";
    var hint = document.createElement("p");
    hint.className = "qt-empty-hint";
    hint.textContent = "按 Ctrl+Enter 或点击「翻译」";
    wrapper.appendChild(title);
    wrapper.appendChild(hint);
    resultNode.appendChild(wrapper);
    updateResultCount();
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
    label.textContent = "正在翻译…";
    wrapper.appendChild(spinner);
    wrapper.appendChild(label);
    resultNode.appendChild(wrapper);
    resultNode.scrollTop = 0;
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
    if (stick) {
      resultNode.scrollTop = resultNode.scrollHeight;
    }
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
    resultError.innerHTML = "";
    var text = document.createElement("div");
    text.className = "qt-result-error-text";
    var messageNode = document.createElement("span");
    messageNode.textContent = String(message == null ? "" : message) || "翻译失败";
    text.appendChild(messageNode);
    if (hint) {
      var hintNode = document.createElement("span");
      hintNode.className = "qt-result-error-hint";
      hintNode.textContent = String(hint);
      text.appendChild(hintNode);
    }
    var retry = document.createElement("button");
    retry.type = "button";
    retry.className = "qt-btn qt-btn-small qt-result-error-retry";
    retry.textContent = "重试";
    retry.addEventListener("click", function () {
      startTranslate();
    });
    resultError.appendChild(text);
    resultError.appendChild(retry);
    resultError.hidden = false;
  }

  function clearError() {
    resultError.hidden = true;
    resultError.innerHTML = "";
  }

  function setTranslatingUi(translating) {
    translateButton.textContent = translating ? "停止" : "翻译";
    translateButton.classList.toggle("is-stop", translating);
    translateButton.setAttribute("aria-label", translating ? "停止翻译" : "翻译");
    sourceClear.disabled = translating;
    swapButton.disabled = translating;
    targetSelect.disabled = translating;
    sourceInput.readOnly = translating;
  }

  function setPinUi(pinned) {
    pinButton.setAttribute("aria-pressed", pinned ? "true" : "false");
    pinButton.title = pinned ? "取消置顶" : "置顶显示";
    pinButton.setAttribute("aria-label", pinned ? "取消置顶" : "置顶显示");
  }

  function applyQuickConfig(quick) {
    var config = quick && typeof quick === "object" ? quick : {};
    state.quick = {
      enabled: config.enabled !== false,
      hotkey: String(config.hotkey || "Alt+Space"),
      targetLang: normalizeTargetCode(config.targetLang),
      prompt: String(config.prompt || ""),
      pinned: !!config.pinned,
    };
    targetSelect.value = state.quick.targetLang;
    setPinUi(state.quick.pinned);
  }

  /* ------------------------------------------------------------------ */
  /* Config / language                                                   */
  /* ------------------------------------------------------------------ */

  function refreshConfig() {
    if (!API || typeof API.ready !== "function") {
      return Promise.resolve();
    }
    return API.ready().then(
      function (result) {
        if (!result || result.ok === false) {
          toast((result && result.error) || "读取快捷翻译配置失败", "error");
          return;
        }
        state.ready = true;
        applyQuickConfig(result.quick);
        if (result.promptDefault) {
          state.promptDefault = String(result.promptDefault);
        }
      },
      function (error) {
        toast(String(error || "读取快捷翻译配置失败"), "error");
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
          toast(result.error || "切换目标语言失败", "error");
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
        toast(String(error || "切换目标语言失败"), "error");
        return false;
      }
    );
  }

  /* ------------------------------------------------------------------ */
  /* Translation                                                         */
  /* ------------------------------------------------------------------ */

  function startTranslate() {
    if (state.translating) {
      return;
    }
    if (!API || typeof API.translate !== "function") {
      toast("翻译接口不可用", "error");
      return;
    }
    var text = qtNormalizeInput(sourceInput.value);
    if (!text) {
      toast("请先输入要翻译的内容", "error");
      sourceInput.focus();
      return;
    }
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
    elapsedNode.textContent = "耗时 —";
    setTranslatingUi(true);
    API.translate(requestId, text, state.quick.targetLang).then(
      function (result) {
        if (!state.translating || state.requestId !== requestId) {
          return;
        }
        if (!result || result.ok === false) {
          failTranslate(
            (result && result.error) || "翻译服务没有响应",
            (result && result.hint) || ""
          );
        }
      },
      function (error) {
        if (!state.translating || state.requestId !== requestId) {
          return;
        }
        failTranslate(String(error || "翻译服务没有响应"), "");
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
    elapsedNode.textContent = "耗时 —";
    copyButton.disabled = !state.raw;
    if (notify) {
      toast("已停止翻译");
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
    elapsedNode.textContent = "耗时 " + qtFormatElapsed(state.elapsedMs);
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
    elapsedNode.textContent = "耗时 —";
    copyButton.disabled = !state.raw;
    toast(String(message == null ? "" : message) || "翻译失败", "error");
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
      failTranslate(event.message || "翻译失败", event.hint || "");
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
    var from = languageLabel(entry.sourceLang);
    var to = languageLabel(entry.targetLang);
    if (from && to) {
      parts.push(from + " → " + to);
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
    return value || "（空）";
  }

  function historyItem(entry) {
    var row = document.createElement("div");
    row.className = "qt-history-item";
    row.setAttribute("role", "listitem");

    var open = document.createElement("button");
    open.type = "button";
    open.className = "qt-history-open";
    open.title = "回填这条翻译";

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
    remove.title = "删除这条";
    remove.setAttribute("aria-label", "删除这条翻译历史");
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
      empty.textContent = state.history.length ? "没有匹配的记录" : "暂无翻译历史";
      historyList.appendChild(empty);
    } else {
      entries.forEach(function (entry) {
        historyList.appendChild(historyItem(entry));
      });
    }
    historySummary.textContent = state.history.length
      ? "共 " +
        state.history.length +
        " 条" +
        (state.historyQuery ? "，匹配 " + entries.length + " 条" : "")
      : "暂无翻译历史";
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
    elapsedNode.textContent = "耗时 " + qtFormatElapsed(state.elapsedMs);
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
          toast(result.error || "删除失败", "error");
          return;
        }
        state.history = state.history.filter(function (item) {
          return !item || item.id !== entry.id;
        });
        renderHistory();
        toast("已删除这条历史");
      },
      function (error) {
        toast(String(error || "删除失败"), "error");
      }
    );
  }

  function resetHistoryClearArmed() {
    state.historyClearArmed = false;
    if (state.clearTimer) {
      window.clearTimeout(state.clearTimer);
      state.clearTimer = null;
    }
    if (historyClear) {
      historyClear.classList.remove("is-armed");
      historyClear.textContent = "清空历史";
    }
  }

  function handleHistoryClearClick() {
    if (!state.history.length) {
      return;
    }
    if (!state.historyClearArmed) {
      state.historyClearArmed = true;
      historyClear.classList.add("is-armed");
      historyClear.textContent = "确认清空";
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
          toast(result.error || "清空失败", "error");
          return;
        }
        state.history = [];
        renderHistory();
        toast("历史已清空", "success");
      },
      function (error) {
        toast(String(error || "清空失败"), "error");
      }
    );
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */

  function hideWindow() {
    if (!API || typeof API.hide !== "function") {
      return;
    }
    API.hide().then(
      function (result) {
        if (!API.live) {
          toast("浏览器预览模式：打包后的应用会隐藏窗口");
        } else if (result && result.ok === false) {
          toast(result.error || "隐藏窗口失败", "error");
        }
      },
      function (error) {
        toast(String(error || "隐藏窗口失败"), "error");
      }
    );
  }

  function handleSwap() {
    if (state.translating) {
      return;
    }
    var detected = qtDetectSourceLang(sourceInput.value);
    if (state.raw) {
      sourceInput.value = state.raw;
      state.raw = "";
      state.elapsedMs = null;
      state.renderPending = false;
      clearError();
      renderEmptyResult();
      updateSourceCount();
      elapsedNode.textContent = "耗时 —";
      copyButton.disabled = true;
    }
    setTargetLang(detected);
    toast("目标语言已设为 " + languageLabel(detected));
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
          toast(result.error || "置顶切换失败", "error");
          return;
        }
        if (result && typeof result.pinned === "boolean") {
          state.quick.pinned = result.pinned;
          setPinUi(result.pinned);
        }
        toast(state.quick.pinned ? "已置顶显示" : "已取消置顶");
      },
      function (error) {
        state.quick.pinned = previous;
        setPinUi(previous);
        toast(String(error || "置顶切换失败"), "error");
      }
    );
  }

  function copyResult() {
    if (!state.raw) {
      toast("还没有可复制的译文", "error");
      return;
    }
    if (!API || typeof API.copy !== "function") {
      return;
    }
    API.copy(state.raw).then(
      function (result) {
        if (result && result.ok === false) {
          toast(result.error || "复制失败", "error");
          return;
        }
        toast("已复制译文", "success");
      },
      function (error) {
        toast(String(error || "复制失败"), "error");
      }
    );
  }

  function clearPanel() {
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
    elapsedNode.textContent = "耗时 —";
    copyButton.disabled = true;
    sourceInput.focus();
  }

  function handleShow() {
    if (state.historyOpen) {
      closeHistory();
    }
    refreshConfig().then(function () {
      sourceInput.focus();
    });
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
  }

  function init() {
    if (!sourceInput || !targetSelect || !resultNode) {
      return;
    }
    limitHint.textContent =
      "支持 " + LANGUAGES.length + " 种语言，最多 " + MAX_CHARS + " 字符";
    renderTargetOptions();
    applyQuickConfig(state.quick);
    updateSourceCount();
    updateResultCount();
    renderEmptyResult();
    elapsedNode.textContent = "耗时 —";
    setPinUi(false);
    setTranslatingUi(false);
    bindEvents();
    if (API) {
      if (typeof API.onTranslateEvent === "function") {
        API.onTranslateEvent(handleTranslateEvent);
      }
      if (typeof API.onShow === "function") {
        API.onShow(handleShow);
      }
    }
    refreshConfig().then(function () {
      updateSourceCount();
      updateResultCount();
      sourceInput.focus();
    });
    if (!API) {
      toast("前端桥接脚本未加载，界面处于只读预览", "error");
    }
  }

  init();
})();
