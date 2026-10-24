/* Word-selection toolbar renderer.
 *
 * Receives the selected text + configuration from the Rust shell through
 * `window.pickerAPI` (see shared/tauri-api.js) and renders the skill toolbar
 * with the five skills:
 *   translate        - streaming translation through the engine
 *   summarize/explain- one-shot assist through the engine
 *   read             - Windows system voices via speechSynthesis
 *   copy             - clipboard through the shell
 *
 * Window sizing is driven from here: the Tauri window is transparent and has
 * no decorations, so the renderer reports the content size through
 * picker_resize and the Rust side applies it (menus/panels need more room).
 */
(function () {
  "use strict";

  var API = window.pickerAPI;
  var LP = window.LP || {};
  var DEFAULT_SKILLS = ["translate", "summarize", "explain", "read", "copy"];
  var NO_VOICE_MESSAGE =
    "系统未安装可用的语音包：可在 Windows 设置 → 时间和语言 → 语音 中添加";

  var SKILL_LABELS = {
    translate: "翻译",
    summarize: "总结",
    explain: "解释",
    read: "朗读",
    copy: "复制",
  };

  /* Target languages come from the shared language table (shared/constants.js)
   * so the picker dropdown stays in sync with the settings window. The fallback
   * list keeps the panel usable when the shared script failed to load. */
  var FALLBACK_TARGET_LANG = "zh";
  var LANGUAGE_VALUES = {};
  var LANGUAGE_LIST = [];
  (function buildLanguageTable() {
    var source = LP && Array.isArray(LP.LANGUAGES) ? LP.LANGUAGES : [];
    source.forEach(function (language) {
      var value = String((language && language.value) || "")
        .trim()
        .toLowerCase();
      if (!value || LANGUAGE_VALUES[value]) {
        return;
      }
      LANGUAGE_VALUES[value] = true;
      LANGUAGE_LIST.push({
        value: value,
        label: String((language && language.label) || value),
      });
    });
    if (!LANGUAGE_LIST.length) {
      LANGUAGE_LIST.push({ value: FALLBACK_TARGET_LANG, label: "中文" });
      LANGUAGE_VALUES[FALLBACK_TARGET_LANG] = true;
    }
  })();

  var ICONS = {
    translate:
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h9"></path><path d="M7.5 3v2"></path><path d="M4.5 9.4c1.3 2.4 3.1 4 5.4 5"></path><path d="M11.5 5c-.5 3-2.3 5.4-5.2 7.1"></path><path d="m12.6 20 3.6-8.6 3.6 8.6"></path><path d="M13.9 17h4.6"></path></svg>',
    summarize:
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6h14"></path><path d="M5 10h14"></path><path d="M5 14h9"></path><path d="M5 18h6"></path></svg>',
    explain:
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-1.6 1.9-2.2 2.6-.3.4-.4.8-.4 1.4"></path><path d="M12 17h.01"></path></svg>',
    read:
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h3l5 4V5L7 9H4z"></path><path d="M16 9a4 4 0 0 1 0 6"></path><path d="M18.5 6.5a8 8 0 0 1 0 11"></path></svg>',
    copy:
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    more:
      '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>',
    settings:
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
    shield:
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 2.9 8.2 7 10 4.1-1.8 7-5.5 7-10V6l-7-3z"></path><path d="m9 12 2 2 4-4"></path></svg>',
    power:
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v9"></path><path d="M6.3 6.3a8 8 0 1 0 11.4 0"></path></svg>',
    refresh:
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4"></path><path d="M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"></path></svg>',
  };

  var state = {
    text: "",
    programName: "",
    skills: DEFAULT_SKILLS.slice(),
    compact: false,
    defaultTargetLang: "auto",
    panelPinned: false,
    panelOpen: false,
    menuOpen: false,
    panelLang: "",
    targetLang: "",
    panelRetry: null,
    panelSpeakText: "",
    panelCopyText: "",
    speaking: false,
    translating: false,
  };

  /* The translation currently streaming into the panel. */
  var activeRequest = null;
  /* `cancelRequested` marks an intentional stop: speechSynthesis.cancel()
   * reports the cancelled utterance through `onerror`, and that must never
   * surface as a "speech failed" toast. */
  var speech = { utterance: null, loading: false, cancelRequested: false };

  var pickerEl = document.getElementById("picker");
  var toolbar = document.getElementById("toolbar");
  var panel = document.getElementById("panel");
  var panelHead = document.getElementById("panel-head");
  var panelTitle = document.getElementById("panel-title");
  var panelLangControl = document.getElementById("panel-lang-control");
  var panelTargetSelect = document.getElementById("panel-target-lang");
  var panelBody = document.getElementById("panel-body");
  var panelPin = document.getElementById("panel-pin");
  var panelSpeak = document.getElementById("panel-speak");
  var panelCopy = document.getElementById("panel-copy");
  var panelRetry = document.getElementById("panel-retry");
  var menu = document.getElementById("menu");
  var toastEl = document.getElementById("toast");

  /* ---- Small helpers --------------------------------------------------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(function () {
      toastEl.hidden = true;
    }, 2000);
  }

  function makeRequestId() {
    return (
      "translate-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
    );
  }

  /* ---- Window sizing --------------------------------------------------- */

  function resizeToolbar() {
    // Never shrink while a menu or the result panel is open: the window must
    // stay large enough for the visible content (this was the clipped-menu bug).
    if (state.panelOpen || state.menuOpen) {
      return;
    }
    var rect = toolbar.getBoundingClientRect();
    // Window = card + transparent padding (2px each side); keep it snug so the
    // transparent area around the card stays minimal.
    API.resize(Math.ceil(rect.width + 4), Math.ceil(rect.height + 4));
  }

  function scheduleToolbarResize() {
    window.requestAnimationFrame(resizeToolbar);
  }

  function resizePanelForContent() {
    window.requestAnimationFrame(function () {
      if (!state.panelOpen) {
        return;
      }
      var flat = String(panelBody.innerText || "").replace(/\s+/g, "");
      var width = 480;
      if (flat.length > 140) {
        width = 560;
      }
      if (flat.length > 320) {
        width = 640;
      }
      if (flat.length > 620) {
        width = 720;
      }
      var height = Math.min(600, Math.max(300, panel.scrollHeight + 6));
      API.resize(width, height);
    });
  }

  /* ---- Panel head ------------------------------------------------------ */

  function normalizeTargetLang(code) {
    var value = String(code == null ? "" : code)
      .trim()
      .toLowerCase();
    return LANGUAGE_VALUES[value] ? value : FALLBACK_TARGET_LANG;
  }

  /* Fill the target-language dropdown from the shared language table. */
  function populateTargetLanguages() {
    if (!panelTargetSelect) {
      return;
    }
    panelTargetSelect.innerHTML = "";
    LANGUAGE_LIST.forEach(function (language) {
      var option = document.createElement("option");
      option.value = language.value;
      option.textContent = language.label;
      panelTargetSelect.appendChild(option);
    });
    panelTargetSelect.value = FALLBACK_TARGET_LANG;
  }

  function setPanelLanguage(targetLang) {
    var code = String(targetLang || "").trim();
    if (!code) {
      state.panelLang = "";
      panelLangControl.hidden = true;
      return;
    }
    var normalized = normalizeTargetLang(code);
    state.panelLang = normalized;
    panelLangControl.hidden = false;
    if (panelTargetSelect.value !== normalized) {
      panelTargetSelect.value = normalized;
    }
  }

  function syncPanelFoot() {
    panelSpeak.disabled = !state.panelSpeakText;
    panelCopy.disabled = !panelBody.textContent.trim();
    panelRetry.hidden = typeof state.panelRetry !== "function";
  }

  function setPanelRetry(callback) {
    state.panelRetry = typeof callback === "function" ? callback : null;
    syncPanelFoot();
  }

  function setPanelSpeakText(text) {
    state.panelSpeakText = String(text || "");
    syncPanelFoot();
  }

  function syncPanelPin() {
    var label = state.panelPinned ? "取消固定" : "固定到桌面";
    panelPin.classList.toggle("is-active", state.panelPinned);
    panelPin.setAttribute("aria-pressed", state.panelPinned ? "true" : "false");
    panelPin.setAttribute("aria-label", label);
    panelPin.title = label;
  }

  /* ---- Drag the whole picker window by the panel head ------------------- */

  /* Interactive header elements keep their normal behaviour; the rest of the
   * head acts as a window drag handle. */
  var PANEL_DRAG_EXCLUDE = "button, select, input, textarea, a, label, [contenteditable]";

  var panelDrag = {
    active: false,
    session: 0,
    lastX: 0,
    lastY: 0,
    pendingX: 0,
    pendingY: 0,
    frame: 0,
  };

  function isDragExcludedTarget(target) {
    var node = target;
    if (node && node.nodeType !== 1) {
      node = node.parentElement;
    }
    if (!node || typeof node.closest !== "function") {
      return true;
    }
    return !!node.closest(PANEL_DRAG_EXCLUDE);
  }

  /* Batches mousemove deltas into one shell call per animation frame. */
  function flushPanelDrag() {
    panelDrag.frame = 0;
    var dx = panelDrag.pendingX;
    var dy = panelDrag.pendingY;
    panelDrag.pendingX = 0;
    panelDrag.pendingY = 0;
    if (!dx && !dy) {
      return;
    }
    if (!API || typeof API.dragPanel !== "function") {
      endPanelDrag();
      return;
    }
    var session = panelDrag.session;
    var result = API.dragPanel(dx, dy);
    // If the shell rejects the drag (e.g. the command is unavailable), stop the
    // drag instead of leaving the window in the "dragging" cursor state.
    if (result && typeof result.then === "function") {
      result.then(function (response) {
        var rejected =
          response && response.ok === false && panelDrag.active && panelDrag.session === session;
        if (rejected) {
          endPanelDrag();
        }
      });
    }
  }

  function queuePanelDrag(dx, dy) {
    panelDrag.pendingX += dx;
    panelDrag.pendingY += dy;
    if (!panelDrag.frame) {
      panelDrag.frame = window.requestAnimationFrame(flushPanelDrag);
    }
  }

  function beginPanelDrag(event) {
    if (!state.panelOpen || event.button !== 0) {
      return;
    }
    if (isDragExcludedTarget(event.target)) {
      return;
    }
    panelDrag.active = true;
    panelDrag.session += 1;
    panelDrag.lastX = Number(event.screenX) || 0;
    panelDrag.lastY = Number(event.screenY) || 0;
    panelDrag.pendingX = 0;
    panelDrag.pendingY = 0;
    panel.classList.add("is-dragging-panel");
    document.body.classList.add("is-dragging-panel");
    // No text selection / native drag while the window follows the cursor.
    event.preventDefault();
  }

  function endPanelDrag() {
    if (!panelDrag.active) {
      return;
    }
    panelDrag.active = false;
    if (panelDrag.frame) {
      window.cancelAnimationFrame(panelDrag.frame);
      panelDrag.frame = 0;
    }
    flushPanelDrag();
    panel.classList.remove("is-dragging-panel");
    document.body.classList.remove("is-dragging-panel");
  }

  function handlePanelDragMove(event) {
    if (!panelDrag.active) {
      return;
    }
    if (!state.panelOpen || event.buttons === 0) {
      endPanelDrag();
      return;
    }
    var x = Number(event.screenX) || 0;
    var y = Number(event.screenY) || 0;
    var dx = x - panelDrag.lastX;
    var dy = y - panelDrag.lastY;
    if (!dx && !dy) {
      return;
    }
    panelDrag.lastX = x;
    panelDrag.lastY = y;
    queuePanelDrag(dx, dy);
  }

  /* ---- Toolbar --------------------------------------------------------- */

  function iconButton(skill) {
    var button = el("button", "tool-btn");
    button.type = "button";
    button.setAttribute("data-skill", skill);
    button.innerHTML = ICONS[skill] || ICONS.more;
    var label = el("span", "label", SKILL_LABELS[skill] || skill);
    button.appendChild(label);
    button.addEventListener("click", function () {
      runSkill(skill, button);
    });
    return button;
  }

  function renderToolbar() {
    toolbar.innerHTML = "";
    toolbar.classList.toggle("compact", state.compact);
    state.skills.forEach(function (skill) {
      toolbar.appendChild(iconButton(skill));
    });
    toolbar.appendChild(el("span", "divider"));
    var more = el("button", "tool-btn more-btn");
    more.type = "button";
    more.title = "更多";
    more.setAttribute("aria-label", "更多");
    more.innerHTML = ICONS.more;
    more.addEventListener("click", function (event) {
      event.stopPropagation();
      toggleMenu();
    });
    toolbar.appendChild(more);
    syncSpeakUi();
    scheduleToolbarResize();
  }

  /* ---- More menu ------------------------------------------------------- */

  function menuItem(iconName, label, sublabel, onClick, options) {
    var opts = options || {};
    var item = el("button", "menu-item" + (opts.danger ? " is-danger" : ""));
    item.type = "button";
    item.setAttribute("role", "menuitem");
    if (opts.disabled) {
      item.disabled = true;
    }
    item.innerHTML =
      '<span class="menu-item-icon">' +
      (ICONS[iconName] || ICONS.settings) +
      "</span>" +
      '<span class="menu-item-text">' +
      '<span class="menu-item-label">' +
      label +
      "</span>" +
      (sublabel ? '<span class="menu-item-sub">' + sublabel + "</span>" : "") +
      "</span>";
    if (!opts.disabled && typeof onClick === "function") {
      item.addEventListener("click", function () {
        closeMenu();
        onClick();
      });
    }
    return item;
  }

  function closeMenu() {
    if (menu.hidden) {
      return;
    }
    state.menuOpen = false;
    menu.hidden = true;
    menu.style.visibility = "";
    if (!state.panelOpen) {
      scheduleToolbarResize();
    }
  }

  function resizeForMenu() {
    state.menuOpen = true;
    menu.hidden = false;
    menu.style.visibility = "hidden";
    var toolbarRect = toolbar.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var width = Math.ceil(Math.max(toolbarRect.width, menuRect.width) + 4);
    var height = Math.ceil(toolbarRect.height + menuRect.height + 4 + 4);
    // Show the menu only after the shell applied the larger bounds, otherwise
    // the window clips it.
    Promise.resolve(
      API.resize(Math.min(780, Math.max(220, width)), Math.min(620, height))
    ).then(function () {
      window.requestAnimationFrame(function () {
        if (state.menuOpen) {
          menu.style.visibility = "visible";
        }
      });
    });
  }

  function toggleMenu() {
    if (!menu.hidden) {
      closeMenu();
      return;
    }
    menu.innerHTML = "";
    var appName = state.programName || "";

    menu.appendChild(
      menuItem(
        "shield",
        "在此应用中禁用",
        appName || "未识别当前应用",
        function () {
          disableInApp();
        },
        { disabled: !appName }
      )
    );
    menu.appendChild(
      menuItem("settings", "划词设置…", "打开设置窗口的划词行为", function () {
        API.openSettings();
      })
    );
    menu.appendChild(
      menuItem("power", "禁用划词工具", "可在设置中重新启用", function () {
        disableTool();
      })
    );

    resizeForMenu();
  }

  function disableInApp() {
    if (!state.programName) {
      showToast("未识别当前应用，无法快速禁用");
      return;
    }
    API.disableInApp(state.programName).then(function (result) {
      if (!result || !result.ok) {
        showToast("禁用失败：" + ((result && result.error) || "未知错误"));
        return;
      }
      showToast("已在 " + state.programName + " 中禁用划词工具");
      window.setTimeout(function () {
        API.close();
      }, 850);
    });
  }

  function disableTool() {
    API.disableTool().then(function (result) {
      if (!result || !result.ok) {
        showToast("禁用失败：" + ((result && result.error) || "未知错误"));
        return;
      }
      showToast("已禁用划词工具，可在设置中重新启用");
      window.setTimeout(function () {
        API.close();
      }, 900);
    });
  }

  /* ---- Pin / panel lifecycle ------------------------------------------ */

  function setPanelPinned(pinned, silent) {
    var next = !!pinned;
    if (state.panelPinned === next) {
      syncPanelPin();
      return;
    }
    state.panelPinned = next;
    syncPanelPin();
    API.pin(next).then(function (result) {
      if (result && result.ok && typeof result.pinned === "boolean") {
        if (result.pinned !== state.panelPinned) {
          state.panelPinned = result.pinned;
          syncPanelPin();
        }
      } else if (result && result.ok === false) {
        state.panelPinned = !next;
        syncPanelPin();
        if (!silent) {
          showToast("无法固定面板，请重试");
        }
        return;
      }
      if (!silent) {
        showToast(next ? "面板已固定到桌面" : "已取消固定");
      }
    });
  }

  function togglePanelPinned() {
    setPanelPinned(!state.panelPinned, false);
  }

  function openPanel(title) {
    closeMenu();
    abortActiveRequest();
    stopSpeech();
    state.panelOpen = true;
    state.panelRetry = null;
    state.panelSpeakText = "";
    panel.hidden = false;
    setPanelCopyText("");
    panelTitle.textContent = title;
    setPanelLanguage("");
    pickerEl.classList.add("panel-mode");
    syncPanelPin();
    syncPanelFoot();
    API.resize(520, 360);
    resizePanelForContent();
  }

  function closePanel() {
    if (!state.panelOpen) {
      return;
    }
    if (state.panelPinned) {
      setPanelPinned(false, true);
    }
    abortActiveRequest();
    stopSpeech();
    panel.hidden = true;
    state.panelOpen = false;
    state.panelRetry = null;
    state.panelSpeakText = "";
    setPanelCopyText("");
    pickerEl.classList.remove("panel-mode");
    scheduleToolbarResize();
  }

  function setBody(node) {
    panelBody.innerHTML = "";
    panelBody.appendChild(node);
    panelBody.scrollTop = 0;
    syncPanelFoot();
  }

  function isNearBottom(node) {
    if (!node) {
      return true;
    }
    return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  }

  /* Render model output as Markdown (safe subset, HTML-escaped by the helper). */
  function renderMarkdownInto(node, text) {
    if (!node) {
      return;
    }
    node.classList.add("markdown");
    var value = String(text == null ? "" : text);
    if (LP.renderMarkdown) {
      node.innerHTML = LP.renderMarkdown(value);
    } else {
      node.textContent = value;
    }
  }

  function plainFromMarkdown(text) {
    return LP.markdownToPlain ? LP.markdownToPlain(text) : String(text == null ? "" : text);
  }

  function setPanelCopyText(text) {
    state.panelCopyText = String(text == null ? "" : text);
    syncPanelFoot();
  }

  function loadingNode(text) {
    var wrap = el("div", "loading");
    wrap.appendChild(el("span", "spinner"));
    wrap.appendChild(el("span", null, text || "处理中…"));
    return wrap;
  }

  function sourceNode() {
    var wrap = el("div");
    wrap.appendChild(el("p", "source-label", "原文"));
    wrap.appendChild(el("p", "source-text", state.text));
    return wrap;
  }

  function hintForError(message, kind) {
    var text = String(message || "");
    if (/API Key|apiKey|401|403|429|Unauthorized|认证|服务地址|baseUrl|超时|timeout/i.test(text)) {
      return "打开设置 → 翻译服务，检查在线 API 的服务地址、API Key 与模型名。";
    }
    if (/引擎|GGUF|llama|本地模型|模型|未安装|未配置|未选择/i.test(text)) {
      return "打开设置 → 翻译服务，下载并启动本地引擎与模型，或切换到在线 API。";
    }
    if (kind === "assist") {
      return "总结与解释使用与翻译相同的服务，请检查在线 API 或本地模型状态。";
    }
    return "打开设置检查翻译服务状态，或重启应用后重试。";
  }

  function friendlyError(message) {
    var text = String(message == null ? "" : message).trim();
    if (!text || text === "undefined" || text === "null") {
      return "未知错误";
    }
    return text;
  }

  function renderErrorPanel(title, message, hint, retry) {
    var wrap = el("div", "panel-error");
    wrap.appendChild(el("p", "error-title", title));
    wrap.appendChild(el("p", "error-message", message));
    if (hint) {
      wrap.appendChild(el("p", "error-hint", hint));
    }
    var actions = el("div", "error-actions");
    if (typeof retry === "function") {
      var retryButton = el("button", "panel-action", "重试");
      retryButton.type = "button";
      retryButton.addEventListener("click", retry);
      actions.appendChild(retryButton);
    }
    var settingsButton = el("button", "panel-action", "打开设置");
    settingsButton.type = "button";
    settingsButton.addEventListener("click", function () {
      API.openSettings();
    });
    actions.appendChild(settingsButton);
    wrap.appendChild(actions);
    setPanelRetry(retry);
    setPanelSpeakText("");
    setPanelCopyText("");
    setBody(wrap);
    resizePanelForContent();
  }

  function appendErrorNote(container, message) {
    if (container.querySelector(".error-note")) {
      return;
    }
    container.appendChild(el("p", "error-note", message));
    resizePanelForContent();
  }

  /* ---- Translation ----------------------------------------------------- */

  function abortActiveRequest() {
    var request = activeRequest;
    activeRequest = null;
    state.translating = false;
    if (request && request.active) {
      request.active = false;
      API.abortTranslate(request.id);
    }
  }

  function removeLoadingRow(request) {
    if (request && request.loading && request.loading.parentNode) {
      request.loading.parentNode.removeChild(request.loading);
      request.loading = null;
    }
  }

  function finishTranslation(request) {
    if (!request || !request.active) {
      return;
    }
    request.active = false;
    if (activeRequest === request) {
      activeRequest = null;
    }
    state.translating = false;
    removeLoadingRow(request);
    if (!String(request.raw || "").trim()) {
      failTranslation(request, "翻译服务没有返回结果（可能正在启动或引擎不可用）。");
      return;
    }
    renderMarkdownInto(request.result, request.raw);
    setPanelSpeakText(plainFromMarkdown(request.raw));
    setPanelCopyText(plainFromMarkdown(request.raw));
    resizePanelForContent();
  }

  function failTranslation(request, message, hint) {
    if (!request || request.failed) {
      return;
    }
    request.failed = true;
    request.active = false;
    if (activeRequest === request) {
      activeRequest = null;
    }
    state.translating = false;
    removeLoadingRow(request);
    var text = friendlyError(message || "翻译失败");
    if (String(request.raw || "").trim()) {
      appendErrorNote(request.target, text);
      renderMarkdownInto(request.result, request.raw);
      setPanelSpeakText(plainFromMarkdown(request.raw));
      setPanelCopyText(plainFromMarkdown(request.raw));
      resizePanelForContent();
      return;
    }
    renderErrorPanel(
      "翻译失败",
      text,
      hint || hintForError(text, "translate"),
      function () {
        translateSkill(panelTargetSelect.value);
      }
    );
  }

  function renderTranslationDraft(request) {
    if (!request || !request.active || request.renderPending) {
      return;
    }
    request.renderPending = true;
    window.requestAnimationFrame(function () {
      request.renderPending = false;
      if (!request.active) {
        return;
      }
      var stickToBottom = isNearBottom(panelBody);
      renderMarkdownInto(request.result, request.raw);
      if (stickToBottom) {
        panelBody.scrollTop = panelBody.scrollHeight;
      }
      setPanelSpeakText(plainFromMarkdown(request.raw));
      setPanelCopyText(plainFromMarkdown(request.raw));
    });
  }

  function handleTranslateEvent(event) {
    var request = activeRequest;
    if (!request || !request.active || !event) {
      return;
    }
    if (String(event.requestId || "") !== request.id) {
      return;
    }
    if (event.type === "chunk") {
      request.sawContent = true;
      removeLoadingRow(request);
      request.raw += event.text || "";
      renderTranslationDraft(request);
      return;
    }
    if (event.type === "done") {
      finishTranslation(request);
      return;
    }
    if (event.type === "error") {
      failTranslation(request, event.message || "翻译失败");
    }
  }

  function translateSkill(targetOverride) {
    openPanel("翻译");
    var configured =
      state.defaultTargetLang && state.defaultTargetLang !== "auto"
        ? normalizeTargetLang(state.defaultTargetLang)
        : "";
    var resolved =
      targetOverride ||
      state.targetLang ||
      configured ||
      (LP.resolveTargetLang ? LP.resolveTargetLang(state.text, "auto") : FALLBACK_TARGET_LANG);
    var targetLang = normalizeTargetLang(resolved);
    state.targetLang = targetLang;
    setPanelLanguage(targetLang);
    setPanelRetry(function () {
      translateSkill(panelTargetSelect.value);
    });

    var target = el("div");
    target.appendChild(sourceNode());
    var loadingRow = loadingNode("正在翻译…");
    target.appendChild(loadingRow);
    var result = el("div", "result-text markdown");
    target.appendChild(result);
    setBody(target);

    var request = {
      id: makeRequestId(),
      target: target,
      result: result,
      raw: "",
      renderPending: false,
      loading: loadingRow,
      active: true,
      failed: false,
      sawContent: false,
    };
    activeRequest = request;
    state.translating = true;
    resizePanelForContent();

    API.translate(request.id, state.text, targetLang).then(
      function (response) {
        if (!request.active) {
          return;
        }
        if (!response || !response.ok) {
          failTranslation(
            request,
            (response && response.error) || "翻译服务没有响应",
            (response && response.hint) || ""
          );
        }
      },
      function (error) {
        failTranslation(request, String(error));
      }
    );
  }

  /* ---- Summarize / explain -------------------------------------------- */

  function assistSkill(action) {
    var label = action === "summarize" ? "总结" : "解释";
    openPanel(label);
    setPanelLanguage("");
    setPanelRetry(function () {
      assistSkill(action);
    });
    var body = el("div");
    body.appendChild(sourceNode());
    body.appendChild(loadingNode(action === "summarize" ? "正在总结…" : "正在解释…"));
    setBody(body);
    resizePanelForContent();

    API.assist(action, state.text).then(function (response) {
      if (!state.panelOpen) {
        return;
      }
      if (!response || !response.ok) {
        var message = friendlyError((response && response.error) || label + "失败");
        renderErrorPanel(
          label + "失败",
          message,
          (response && response.hint) || hintForError(message, "assist"),
          function () {
            assistSkill(action);
          }
        );
        return;
      }
      var resultText = String(response.text || "").trim();
      if (!resultText) {
        renderErrorPanel(
          label + "失败",
          label + "服务没有返回内容。",
          hintForError("", "assist"),
          function () {
            assistSkill(action);
          }
        );
        return;
      }
      var wrap = el("div");
      wrap.appendChild(sourceNode());
      var resultNode = el("div", "result-text markdown");
      renderMarkdownInto(resultNode, resultText);
      wrap.appendChild(resultNode);
      setBody(wrap);
      setPanelSpeakText(plainFromMarkdown(resultText));
      setPanelCopyText(plainFromMarkdown(resultText));
      resizePanelForContent();
    });
  }

  /* ---- Speech (Windows system voices only) ----------------------------- */

  function syncSpeakUi() {
    var active = !!state.speaking;
    var readButton = toolbar.querySelector('[data-skill="read"]');
    if (readButton) {
      readButton.classList.toggle("is-active", active);
    }
    panelSpeak.classList.toggle("is-active", active);
  }

  function clearSpeechState(utterance) {
    if (speech.utterance !== utterance) {
      return;
    }
    speech.utterance = null;
    if (state.speaking) {
      state.speaking = false;
      syncSpeakUi();
    }
  }

  /* Intentional stop (second click on 朗读, panel close, new selection...):
   * never report a failure, just restore the idle UI. `speechSynthesis.cancel()`
   * still fires `onerror` on the cancelled utterance - the flags below make
   * that path silent. */
  function stopSpeech() {
    var utterance = speech.utterance;
    if (utterance) {
      utterance.__lingopickCancelled = true;
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
    if (state.speaking) {
      state.speaking = false;
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
      showToast("没有可朗读的文本");
      return;
    }
    if (state.speaking) {
      stopSpeech();
      return;
    }
    var synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== "function") {
      showToast(NO_VOICE_MESSAGE);
      return;
    }
    if (speech.loading) {
      return;
    }
    speech.loading = true;
    getVoices().then(function (voices) {
      speech.loading = false;
      if (!voices || !voices.length) {
        showToast(NO_VOICE_MESSAGE);
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
          !!utterance.__lingopickCancelled ||
          speech.cancelRequested ||
          (event &&
            (event.error === "interrupted" ||
              event.error === "canceled" ||
              event.error === "cancelled"));
        clearSpeechState(utterance);
        // A user stop or a replaced utterance ends silently; only a genuine
        // failure of the utterance we started is worth reporting.
        if (wasCurrent && !cancelled) {
          showToast("朗读失败，请检查 Windows 的语音设置");
        }
      };
      speech.cancelRequested = false;
      speech.utterance = utterance;
      state.speaking = true;
      syncSpeakUi();
      try {
        synth.cancel();
        synth.speak(utterance);
      } catch (error) {
        clearSpeechState(utterance);
        showToast("朗读失败，请检查 Windows 的语音设置");
      }
    });
  }

  /* ---- Skills ---------------------------------------------------------- */

  function copyToClipboard(text, successMessage, closeAfter) {
    API.copy(text).then(function (result) {
      if (result && result.ok === false) {
        showToast("复制失败：" + (result.error || "请检查剪贴板权限"));
        return;
      }
      showToast(successMessage);
      if (closeAfter) {
        window.setTimeout(function () {
          API.close();
        }, 250);
      }
    });
  }

  function runSkill(skill, button) {
    if (skill === "translate") {
      translateSkill();
    } else if (skill === "summarize" || skill === "explain") {
      assistSkill(skill);
    } else if (skill === "read") {
      speak(state.text);
    } else if (skill === "copy") {
      copyToClipboard(state.text, "已复制选中文本", true);
    }
  }

  /* ---- Reset / data ---------------------------------------------------- */

  function resetForHidden() {
    abortActiveRequest();
    stopSpeech();
    state.panelPinned = false;
    state.panelSpeakText = "";
    state.panelRetry = null;
    syncPanelPin();
    panel.hidden = true;
    state.panelOpen = false;
    pickerEl.classList.remove("panel-mode");
    closeMenu();
    scheduleToolbarResize();
  }

  /* ---- Events ---------------------------------------------------------- */

  panelTargetSelect.addEventListener("change", function () {
    if (state.panelOpen) {
      translateSkill(panelTargetSelect.value);
    }
  });
  panelHead.addEventListener("mousedown", beginPanelDrag);
  document.addEventListener("mousemove", handlePanelDragMove);
  document.addEventListener("mouseup", endPanelDrag);
  window.addEventListener("blur", endPanelDrag);
  panelPin.addEventListener("click", togglePanelPinned);
  document.getElementById("panel-close").addEventListener("click", closePanel);
  panelSpeak.innerHTML = ICONS.read + "<span>朗读</span>";
  panelCopy.innerHTML = ICONS.copy + "<span>复制</span>";
  panelRetry.innerHTML = ICONS.refresh + "<span>重试</span>";
  panelSpeak.addEventListener("click", function () {
    speak(state.panelSpeakText);
  });
  panelCopy.addEventListener("click", function () {
    var text = state.panelCopyText || state.panelSpeakText || panelBody.textContent || "";
    copyToClipboard(text, "已复制结果", false);
  });
  // Markdown links are opened through the shell (https only), never navigated in
  // the transparent webview.
  panelBody.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[data-external]") : null;
    if (!link) {
      return;
    }
    event.preventDefault();
    var href = String(link.getAttribute("href") || "");
    if (/^https?:\/\//i.test(href)) {
      API.openExternal(href);
    }
  });
  panelRetry.addEventListener("click", function () {
    if (typeof state.panelRetry === "function") {
      state.panelRetry();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") {
      return;
    }
    if (!menu.hidden) {
      closeMenu();
    } else if (state.panelOpen) {
      closePanel();
    } else {
      API.close();
    }
  });

  API.onTranslateEvent(handleTranslateEvent);

  API.onData(function (payload) {
    var data = payload || {};
    var config = data.config || {};
    state.text = String(data.text || "");
    state.programName = String(data.programName || "");
    state.defaultTargetLang = String(config.defaultTargetLang || "auto");
    state.targetLang = "";
    state.panelPinned = false;
    var skills = Array.isArray(config.skills)
      ? config.skills.filter(function (skill) {
          return !!SKILL_LABELS[skill];
        })
      : [];
    state.skills = skills.length ? skills : DEFAULT_SKILLS.slice();
    state.compact = config.compact === true;
    resetForHidden();
    renderToolbar();
  });

  API.onHidden(function () {
    resetForHidden();
  });

  /* ---- Boot ------------------------------------------------------------ */

  syncPanelPin();
  syncPanelFoot();
  populateTargetLanguages();
  renderToolbar();
  // DOM is ready: tell the shell the renderer can receive picker-data now.
  API.ready();
})();
