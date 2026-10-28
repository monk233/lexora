/* Word-selection toolbar renderer.
 *
 * Receives the selected text + configuration from the Rust shell through
 * `window.pickerAPI` (see shared/tauri-api.js) and renders the skill toolbar
 * with the seven built-in skills:
 *   translate        - streaming translation through the engine
 *   summarize/explain- streaming assist through the engine
 *   polish           - streaming rewrite through the engine
 *   read             - Windows system voices via speechSynthesis
 *   copy             - clipboard through the shell
 *   search           - opens the selected text in the configured search engine
 *
 * Built-in labels/icons come from the shared LP.SKILL_MAP (icon values are icon
 * keys such as "languages", not skill ids). `config.customSkills` adds
 * user-defined skills: they reuse the translation pipeline
 * (`picker_custom_skill` streams through translate-event) with their own
 * id/label/icon. Skill icons live in shared/skill-icons.js (LP.skillIconSvg).
 *
 * Window sizing is driven from here: the Tauri window is transparent and has
 * no decorations, so the renderer reports the content size through
 * picker_resize and the Rust side applies it (menus/panels need more room).
 */
(function () {
  "use strict";

  var API = window.pickerAPI;
  var LP = window.LP || {};
  var PICKER_SURFACE = API && API.surface === "toolbar" ? "toolbar" : "panel";
  /* Shared LP.DEFAULT_SKILLS is the source of truth (built-in skills); the
   * local list only keeps the toolbar usable if the shared script failed. */
  var FALLBACK_SKILLS = [
    "translate",
    "summarize",
    "explain",
    "polish",
    "read",
    "copy",
    "screenshot",
    "search",
  ];
  var DEFAULT_SKILLS =
    LP && Array.isArray(LP.DEFAULT_SKILLS) && LP.DEFAULT_SKILLS.length
      ? LP.DEFAULT_SKILLS.slice()
      : FALLBACK_SKILLS.slice();
  var NO_VOICE_MESSAGE =
    "系统未安装可用的语音包：可在 Windows 设置 → 时间和语言 → 语音 中添加";

  /* Toolbar overflow budget (CSS/logical px). Skills that no longer fit are
   * moved into the "more" menu instead of widening (and clipping) the window.
   * The divider and "more" button are measured during layout, so the budget
   * below only caps the whole toolbar. */
  var MAX_TOOLBAR_WIDTH = 560;
  var COMPACT_MAX_TOOLBAR_WIDTH = 420;
  var TOOLBAR_BUTTON_GAP = 2;

  /* Result panel: remembered manual size (scroll mode only) + panel mode.
   * The window follows the configuration minimum (360x240) with no maximum;
   * the shell applies the real screen limits. */
  var PANEL_SIZE_KEY = "lexora.panelSize";
  var PANEL_MIN_WIDTH = 360;
  var PANEL_MIN_HEIGHT = 240;
  var DEFAULT_PANEL_WIDTH = 520;
  var DEFAULT_PANEL_HEIGHT = 360;
  /* Auto mode uses one deliberate reading width. Its height follows content
   * until the screen-aware ceiling, then the hidden-scrollbar body follows the
   * streamed answer from the bottom. */
  var AUTO_PANEL_WIDTH = PANEL_MIN_WIDTH;
  var AUTO_PANEL_MAX_HEIGHT = 760;
  var AUTO_PANEL_SCREEN_MARGIN = 80;
  var AUTO_PANEL_RESIZE_INTERVAL_MS = 200;
  var AUTO_PANEL_HEIGHT_STEP = 48;

  /* Label fallback only: LP.SKILL_MAP is the primary source for built-in
   * labels/icons (see builtinSkillMeta). */
  var SKILL_LABELS = {
    translate: "翻译",
    summarize: "总结",
    explain: "解释",
    polish: "润色",
    read: "朗读",
    copy: "复制",
    screenshot: "截图",
    search: "搜索",
  };

  /* Screenshot skills (picker-image, see contracts §10.5). They reuse the text
   * skill result panel: only the loading wording, the source row and the
   * renderer (OCR is literal text, everything else Markdown) differ. */
  var IMAGE_ACTION_LABELS = {
    ocr: "提取文字",
    translate: "翻译",
    explain: "解释图片",
    custom: "图片技能",
  };
  var IMAGE_CLIPBOARD_HINT = "截图已复制到剪贴板";
  /* Shown in the header while the shell resolves the real target language of a
   * screenshot translation from the recognized text (contract §10.3). */
  var IMAGE_TARGET_PENDING = "识别中…";

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

  /* Skill icons (built-in ids and the 200-icon custom gallery) live in
   * shared/skill-icons.js and are exposed through LP.skillIconSvg, keyed by
   * icon names such as "languages" or "wand-sparkles" (never by skill id).
   * Only picker-only UI icons stay local. */
  var ICONS = {
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

  function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
  }

  function defaultCustomIcon() {
    return typeof LP.CUSTOM_SKILL_DEFAULT_ICON === "string" && LP.CUSTOM_SKILL_DEFAULT_ICON
      ? LP.CUSTOM_SKILL_DEFAULT_ICON
      : "sparkles";
  }

  /* Resolve an icon key to SVG markup, injecting the sizing class the shared
   * markup intentionally omits. Unknown keys fall back to the default custom
   * icon (sparkles) and finally to the generic "more" placeholder. */
  function skillIconSvg(key) {
    var svg = "";
    if (typeof LP.skillIconSvg === "function") {
      svg = String(LP.skillIconSvg(key) || "");
      if (!svg) {
        svg = String(LP.skillIconSvg(defaultCustomIcon()) || "");
      }
    }
    if (!svg) {
      return ICONS.more;
    }
    return svg.replace("<svg ", '<svg class="icon" ');
  }

  /* Search engine configuration (search skill). The URL prefix table lives in
   * shared/constants.js as LP.SEARCH_ENGINE_MAP; picker-data only sends the
   * selected engine value. */
  function defaultSearchEngine() {
    var fallback =
      typeof LP.DEFAULT_SEARCH_ENGINE === "string" && LP.DEFAULT_SEARCH_ENGINE
        ? LP.DEFAULT_SEARCH_ENGINE
        : "google";
    return hasOwn(LP.SEARCH_ENGINE_MAP || {}, fallback) ? fallback : "google";
  }

  function normalizeSearchEngine(value) {
    var code = String(value == null ? "" : value)
      .trim()
      .toLowerCase();
    if (code && hasOwn(LP.SEARCH_ENGINE_MAP || {}, code)) {
      return code;
    }
    return defaultSearchEngine();
  }

  /* Built-in skill metadata from the shared table. `icon` is an icon key (for
   * example translate -> "languages"), never the skill id. `kind` is "image"
   * for skills that open the screenshot overlay instead of a text panel. */
  function builtinSkillMeta(skill) {
    var map = LP.SKILL_MAP || {};
    var entry = hasOwn(map, skill) ? map[skill] : null;
    return {
      id: skill,
      label: (entry && entry.label) || SKILL_LABELS[skill] || skill,
      icon: (entry && entry.icon) || defaultCustomIcon(),
      kind: (entry && entry.kind) || (skill === "screenshot" ? "image" : "text"),
      builtin: true,
    };
  }

  function isBuiltinSkill(skill) {
    return hasOwn(SKILL_LABELS, skill) || hasOwn(LP.SKILL_MAP || {}, skill);
  }

  var state = {
    text: "",
    programName: "",
    skills: DEFAULT_SKILLS.slice(),
    /* Skills moved out of the toolbar because they do not fit (in toolbar
     * order); the "more" menu renders them as skill items. */
    overflowSkills: [],
    /* Safety margin (px) added when a DPI/font-metrics mismatch still clipped
     * the toolbar after resize; reset for every new picker payload. */
    overflowBias: 0,
    /* id -> {id, label, icon} for the custom skills enabled in settings. */
    customSkills: {},
    compact: false,
    defaultTargetLang: "auto",
    searchEngine: defaultSearchEngine(),
    panelPinned: false,
    panelOpen: false,
    menuOpen: false,
    panelLang: "",
    targetLang: "",
    panelRetry: null,
    panelSpeakText: "",
    panelCopyText: "",
    /* Manual panel size: once the user drags the resize grip the window stops
     * following the content size (double-clicking the grip restores that). */
    panelAutoResize: true,
    panelManualSize: null,
    /* picker-data config.panelMode: "auto" (fixed width, screen-limited height,
     * hidden scrollbar follows new content) or "scroll" (fixed user size). */
    panelMode: "auto",
    autoPanelFollow: true,
    /* Last auto-mode window size sent to the shell, to avoid redundant resizes
     * on every streamed chunk. */
    lastAutoPanelSize: null,
    /* Remembered pin preference (picker-data config.panelPinned): result
     * panels start pinned when enabled. */
    panelPinnedPreference: false,
    /* Screenshot skill that opened the current panel:
     * {requestId, action, skillId, label, targetLang, clipboard, hint}.
     * null for ordinary text-skill panels (cleared when the panel is closed,
     * reset or replaced). */
    image: null,
    /* Follow-up conversation of the current AI panel. */
    followupHistory: [],
    followupAnswer: "",
    followupBusy: false,
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
  var panelFollowup = document.getElementById("panel-followup");
  var panelSuggestions = document.getElementById("panel-suggestions");
  var panelFollowupInput = document.getElementById("panel-followup-input");
  var panelFollowupSend = document.getElementById("panel-followup-send");
  var panelResizeGrip = document.getElementById("panel-resize-grip");
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

  /* Request ids for screenshot retry/follow-up streams (same translate-event
   * channel as text skills, see contracts §10.3). */
  function makeCaptureRequestId() {
    return "capture-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /* ---- Window sizing --------------------------------------------------- */

  function maxToolbarWidth() {
    return state.compact ? COMPACT_MAX_TOOLBAR_WIDTH : MAX_TOOLBAR_WIDTH;
  }

  function resizeToolbar() {
    // Never shrink while a menu or the result panel is open: the window must
    // stay large enough for the visible content (this was the clipped-menu bug).
    if (state.panelOpen || state.menuOpen) {
      return;
    }
    // Measure without the `max-width:100%` cap: when the window is still at its
    // previous (narrower) size, the capped rect would under-report the natural
    // width and resize the window too small — clipping the trailing "more"
    // button.
    var previousMaxWidth = toolbar.style.maxWidth;
    toolbar.style.maxWidth = "none";
    var rect = toolbar.getBoundingClientRect();
    toolbar.style.maxWidth = previousMaxWidth;
    var width = Math.min(Math.ceil(rect.width + 4), maxToolbarWidth());
    Promise.resolve(API.resize(width, Math.ceil(rect.height + 4))).then(function () {
      window.requestAnimationFrame(guardToolbarClipping);
    });
  }

  /* Safety net: if the window is still narrower than the rendered toolbar (DPI
   * rounding, font fallbacks), move one more skill into the overflow menu and
   * re-render. Bounded by `overflowBias` so this can never loop forever. */
  function guardToolbarClipping() {
    if (state.panelOpen || state.menuOpen) {
      return;
    }
    if (toolbar.scrollWidth + 4 <= window.innerWidth + 1) {
      return;
    }
    if (state.overflowBias >= 120) {
      return;
    }
    state.overflowBias += 24;
    renderToolbar();
  }

  function scheduleToolbarResize() {
    window.requestAnimationFrame(resizeToolbar);
  }

  var autoPanelScrollFrame = 0;
  var autoPanelResizeTimer = 0;

  function scrollAutoPanelToEnd() {
    if (state.panelOpen && state.panelMode === "auto" && state.autoPanelFollow) {
      panelBody.scrollTop = panelBody.scrollHeight;
    }
  }

  function followAutoPanelContent() {
    if (
      !state.panelOpen ||
      state.panelMode !== "auto" ||
      !state.autoPanelFollow ||
      autoPanelScrollFrame
    ) {
      return;
    }
    autoPanelScrollFrame = window.requestAnimationFrame(function () {
      autoPanelScrollFrame = window.requestAnimationFrame(function () {
        autoPanelScrollFrame = 0;
        if (state.panelOpen && state.panelMode === "auto" && state.autoPanelFollow) {
          panelBody.scrollTop = panelBody.scrollHeight;
        }
      });
    });
  }
  function autoPanelMaxHeight() {
    var available = Number(window.screen && window.screen.availHeight) || AUTO_PANEL_MAX_HEIGHT;
    return Math.max(
      PANEL_MIN_HEIGHT,
      Math.min(AUTO_PANEL_MAX_HEIGHT, Math.floor(available - AUTO_PANEL_SCREEN_MARGIN))
    );
  }

  function flushAutoPanelResize() {
    autoPanelResizeTimer = 0;
    // Only auto mode follows the content; scroll mode keeps the user's size.
    if (!state.panelOpen || state.panelMode !== "auto") {
      return;
    }
    var width = AUTO_PANEL_WIDTH;
    // Measure from scrollHeight without changing the panel's flex mode. Toggling
    // a "natural height" class on every streamed chunk causes reflow flicker.
    var panelHeight = panel.getBoundingClientRect().height;
    var bodyHeight = panelBody.getBoundingClientRect().height;
    var naturalHeight = panelHeight - bodyHeight + panelBody.scrollHeight + 4;
    if (!isFinite(naturalHeight) || naturalHeight <= 0) {
      return;
    }
    var maxHeight = autoPanelMaxHeight();
    var desiredHeight = Math.ceil(naturalHeight);
    if (desiredHeight < maxHeight) {
      desiredHeight =
        Math.ceil(desiredHeight / AUTO_PANEL_HEIGHT_STEP) * AUTO_PANEL_HEIGHT_STEP;
    }
    var height = Math.max(
      PANEL_MIN_HEIGHT,
      Math.min(maxHeight, desiredHeight)
    );
    var previous = state.lastAutoPanelSize;
    // Intermediate Markdown layouts can transiently become shorter. During the
    // stream, grow only: repeated grow/shrink cycles cause visible window flicker.
    if (previous && previous[0] === width && height < previous[1]) {
      height = previous[1];
    }
    scrollAutoPanelToEnd();
    followAutoPanelContent();
    if (previous && previous[0] === width && previous[1] === height) {
      return;
    }
    state.lastAutoPanelSize = [width, height];
    Promise.resolve(API.resize(width, height)).then(function () {
      if (!state.panelOpen || state.panelMode !== "auto" || !state.autoPanelFollow) {
        return;
      }
      followAutoPanelContent();
    });
  }

  function resizePanelForContent() {
    if (!state.panelOpen || state.panelMode !== "auto" || autoPanelResizeTimer) {
      return;
    }
    autoPanelResizeTimer = window.setTimeout(
      flushAutoPanelResize,
      AUTO_PANEL_RESIZE_INTERVAL_MS
    );
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

  /* Screenshot translation needs a concrete target language ("自动识别" is a
   * source-side notion only). Returns "" while the shell has not resolved it. */
  function imageTargetLanguageCode(raw) {
    var value = String(raw == null ? "" : raw)
      .trim()
      .toLowerCase();
    if (!value || value === "auto") {
      return "";
    }
    return LANGUAGE_VALUES[value] ? value : "";
  }

  /* The auto option belongs to the text pipeline only; hide it defensively while
   * a screenshot translation panel is open (no-op when the table has none). */
  function setAutoTargetOptionHidden(hidden) {
    if (!panelTargetSelect) {
      return;
    }
    var autoOption = panelTargetSelect.querySelector('option[value="auto"]');
    if (!autoOption) {
      return;
    }
    autoOption.hidden = !!hidden;
    autoOption.disabled = !!hidden;
  }

  /* Placeholder for the window between opening a screenshot translation panel
   * and the shell resolving the real target language from the text
   * (translate-event type=target, contract §10.3). */
  function clearPendingImageTarget() {
    if (!panelTargetSelect) {
      return;
    }
    var pending = panelTargetSelect.querySelector('option[data-pending-target="1"]');
    if (pending && pending.parentNode) {
      pending.parentNode.removeChild(pending);
    }
  }

  function showPendingImageTarget() {
    if (!panelTargetSelect) {
      return;
    }
    clearPendingImageTarget();
    var pending = document.createElement("option");
    pending.value = "";
    pending.textContent = IMAGE_TARGET_PENDING;
    pending.disabled = true;
    pending.setAttribute("data-pending-target", "1");
    panelTargetSelect.appendChild(pending);
    panelTargetSelect.value = "";
    state.panelLang = "";
    panelLangControl.hidden = false;
  }

  /* Shows the target language of a screenshot translation panel: the concrete
   * code when known, otherwise the "识别中…" placeholder. Returns the code. */
  function applyImageTargetLanguage(raw) {
    var code = imageTargetLanguageCode(raw);
    if (code) {
      clearPendingImageTarget();
      setPanelLanguage(code);
      return code;
    }
    showPendingImageTarget();
    return "";
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

  /* ---- Result panel size (grip drag + remembered size) ----------------- */

  function normalizePanelMode(value) {
    return String(value == null ? "" : value)
      .trim()
      .toLowerCase() === "scroll"
      ? "scroll"
      : "auto";
  }

  /* Valid positive sizes are clamped up to the 360x240 minimum; there is no
   * maximum on the webview side any more. */
  function validPanelSize(width, height) {
    var w = Math.round(Number(width));
    var h = Math.round(Number(height));
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
      return null;
    }
    return {
      width: Math.max(PANEL_MIN_WIDTH, w),
      height: Math.max(PANEL_MIN_HEIGHT, h),
    };
  }

  /* localStorage may be unavailable or hold a broken value; none of that may
   * prevent the panel from opening. */
  function loadPanelSize() {
    try {
      var raw = window.localStorage.getItem(PANEL_SIZE_KEY);
      if (!raw) {
        return null;
      }
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return validPanelSize(parsed.width, parsed.height);
    } catch (error) {
      return null;
    }
  }

  function savePanelSize(size) {
    try {
      window.localStorage.setItem(
        PANEL_SIZE_KEY,
        JSON.stringify({ width: size.width, height: size.height })
      );
    } catch (error) {
      /* persistence is a convenience; ignore quota/security errors */
    }
  }

  function clearPanelSize() {
    try {
      window.localStorage.removeItem(PANEL_SIZE_KEY);
    } catch (error) {
      /* ignore */
    }
  }

  var panelResize = {
    active: false,
    applied: false,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    targetWidth: 0,
    targetHeight: 0,
    size: null,
    frame: 0,
  };

  function flushPanelResize() {
    panelResize.frame = 0;
    if (!panelResize.active || state.panelMode !== "scroll") {
      return;
    }
    var targetWidth = Number(panelResize.targetWidth);
    var targetHeight = Number(panelResize.targetHeight);
    if (!isFinite(targetWidth) || !isFinite(targetHeight)) {
      return;
    }
    // Dragging past the top-left edge clamps to the 360x240 minimum (there is
    // no maximum); invalid non-numeric targets are ignored.
    var size = {
      width: Math.max(PANEL_MIN_WIDTH, Math.round(targetWidth)),
      height: Math.max(PANEL_MIN_HEIGHT, Math.round(targetHeight)),
    };
    if (
      panelResize.size &&
      size.width === panelResize.size.width &&
      size.height === panelResize.size.height
    ) {
      return;
    }
    panelResize.size = size;
    panelResize.applied = true;
    // Manual size wins over content-based sizing until a double-click resets it.
    state.panelAutoResize = false;
    state.panelManualSize = { width: size.width, height: size.height };
    // A manual panel fills the whole window so no transparent strip remains
    // below the card; the body scrolls inside.
    panel.classList.add("is-manual-size");
    if (API && typeof API.resize === "function") {
      API.resize(size.width, size.height);
    }
  }

  function queuePanelResize(width, height) {
    panelResize.targetWidth = width;
    panelResize.targetHeight = height;
    if (!panelResize.frame) {
      panelResize.frame = window.requestAnimationFrame(flushPanelResize);
    }
  }

  function beginPanelResize(event) {
    // Manual resizing is a scroll-mode feature; auto panels hide the grip.
    if (!state.panelOpen || state.panelMode !== "scroll" || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    panelResize.active = true;
    panelResize.applied = false;
    panelResize.startX = Number(event.screenX) || 0;
    panelResize.startY = Number(event.screenY) || 0;
    panelResize.startWidth = Math.max(window.innerWidth, PANEL_MIN_WIDTH);
    panelResize.startHeight = Math.max(window.innerHeight, PANEL_MIN_HEIGHT);
    panelResize.targetWidth = panelResize.startWidth;
    panelResize.targetHeight = panelResize.startHeight;
    panelResize.size = {
      width: panelResize.startWidth,
      height: panelResize.startHeight,
    };
    document.body.classList.add("is-resizing-panel");
    panel.classList.add("is-resizing-panel");
  }

  function handlePanelResizeMove(event) {
    if (!panelResize.active) {
      return;
    }
    if (!state.panelOpen || event.buttons === 0) {
      endPanelResize();
      return;
    }
    var x = Number(event.screenX) || 0;
    var y = Number(event.screenY) || 0;
    queuePanelResize(
      panelResize.startWidth + (x - panelResize.startX),
      panelResize.startHeight + (y - panelResize.startY)
    );
  }

  function endPanelResize() {
    if (!panelResize.active) {
      return;
    }
    flushPanelResize();
    panelResize.active = false;
    if (panelResize.frame) {
      window.cancelAnimationFrame(panelResize.frame);
      panelResize.frame = 0;
    }
    if (panelResize.applied && panelResize.size) {
      savePanelSize(panelResize.size);
    }
    document.body.classList.remove("is-resizing-panel");
    panel.classList.remove("is-resizing-panel");
  }

  /* Double-clicking the grip forgets the remembered size and goes back to the
   * default panel size (still drag-resizable in scroll mode). */
  function resetPanelSize(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    panelResize.active = false;
    panelResize.applied = false;
    if (panelResize.frame) {
      window.cancelAnimationFrame(panelResize.frame);
      panelResize.frame = 0;
    }
    state.panelManualSize = null;
    clearPanelSize();
    document.body.classList.remove("is-resizing-panel");
    panel.classList.remove("is-resizing-panel");
    if (state.panelMode === "scroll") {
      state.panelAutoResize = false;
      panel.classList.add("is-manual-size");
      if (state.panelOpen) {
        API.resize(DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT);
      }
      return;
    }
    state.panelAutoResize = true;
    panel.classList.remove("is-manual-size");
    if (state.panelOpen) {
      API.resize(AUTO_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT);
      resizePanelForContent();
    }
  }

  /* ---- Toolbar --------------------------------------------------------- */

  /* Label + icon + kind for one toolbar skill. Built-in ids come from
   * LP.SKILL_MAP (icon keys like "languages"); custom ids from
   * `config.customSkills`; unknown ids fall back to text + sparkles icon. */
  function skillMeta(skill) {
    if (isBuiltinSkill(skill)) {
      return builtinSkillMeta(skill);
    }
    if (hasOwn(state.customSkills, skill)) {
      return state.customSkills[skill];
    }
    return { id: skill, label: skill, icon: defaultCustomIcon(), kind: "text" };
  }

  function skillButton(skill) {
    var meta = skillMeta(skill);
    var button = el("button", "tool-btn");
    button.type = "button";
    button.setAttribute("data-skill", skill);
    button.setAttribute("data-kind", meta.kind === "image" ? "image" : "text");
    if (meta.kind === "image") {
      button.classList.add("is-image-skill");
    }
    button.title = meta.label;
    button.setAttribute("aria-label", meta.label);
    button.innerHTML = skillIconSvg(meta.icon);
    button.appendChild(el("span", "label", meta.label));
    button.addEventListener("click", function () {
      runSkill(skill);
    });
    return button;
  }

  function renderToolbar() {
    toolbar.innerHTML = "";
    toolbar.classList.toggle("compact", state.compact);
    var buttons = state.skills.map(function (skill) {
      return skillButton(skill);
    });
    var divider = el("span", "divider");
    var more = el("button", "tool-btn more-btn");
    more.type = "button";
    more.title = "更多";
    more.setAttribute("aria-label", "更多");
    more.innerHTML = ICONS.more;
    more.addEventListener("click", function (event) {
      event.stopPropagation();
      toggleMenu();
    });

    // Measure unconstrained: max-content width with no viewport cap. The window
    // is typically still at its previous (narrower) size here, so a capped
    // measurement would under-estimate widths and clip the trailing "more".
    toolbar.style.visibility = "hidden";
    toolbar.style.maxWidth = "none";
    buttons.forEach(function (button) {
      toolbar.appendChild(button);
    });
    toolbar.appendChild(divider);
    toolbar.appendChild(more);

    // Keep the first skills that fit in toolbar order; everything after the
    // first overflow moves to the "more" menu as a contiguous block. All widths
    // (buttons, divider, more, toolbar chrome, window padding) are part of the
    // budget so the "more" button itself can never be clipped.
    var style = window.getComputedStyle(toolbar);
    var chrome =
      4 +
      (parseFloat(style.paddingLeft) || 0) +
      (parseFloat(style.paddingRight) || 0) +
      (parseFloat(style.borderLeftWidth) || 0) +
      (parseFloat(style.borderRightWidth) || 0);
    var dividerWidth = divider.getBoundingClientRect().width;
    var moreWidth = more.getBoundingClientRect().width;
    var fixed = TOOLBAR_BUTTON_GAP + dividerWidth + TOOLBAR_BUTTON_GAP + moreWidth + chrome;
    var max = maxToolbarWidth() - (state.overflowBias || 0);
    var used = 0;
    var cutoff = buttons.length;
    for (var index = 0; index < buttons.length; index += 1) {
      var buttonWidth = buttons[index].getBoundingClientRect().width;
      var next = used + (index ? TOOLBAR_BUTTON_GAP : 0) + buttonWidth;
      if (next + fixed > max) {
        cutoff = index;
        break;
      }
      used = next;
    }
    state.overflowSkills = state.skills.slice(cutoff);
    for (var overflowIndex = cutoff; overflowIndex < buttons.length; overflowIndex += 1) {
      toolbar.removeChild(buttons[overflowIndex]);
    }
    toolbar.style.maxWidth = "";
    toolbar.style.visibility = "";
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

  /* Skill entry in the overflow part of the "more" menu. Icons come from the
   * shared icon table (same as the toolbar); the label is written through
   * textContent so a custom skill name can never inject markup. */
  function menuSkillItem(skill) {
    var meta = skillMeta(skill);
    var item = el("button", "menu-item menu-skill-item");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.setAttribute("data-skill", skill);
    item.setAttribute("data-kind", meta.kind === "image" ? "image" : "text");
    if (meta.kind === "image") {
      item.classList.add("is-image-skill");
    }
    var icon = el("span", "menu-item-icon");
    icon.innerHTML = skillIconSvg(meta.icon);
    var text = el("span", "menu-item-text");
    text.appendChild(el("span", "menu-item-label", meta.label));
    item.appendChild(icon);
    item.appendChild(text);
    item.addEventListener("click", function () {
      closeMenu();
      runSkill(skill);
    });
    return item;
  }

  function menuDivider() {
    var divider = el("div", "menu-divider");
    divider.setAttribute("role", "separator");
    return divider;
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
    // Overflowed skills first (toolbar order), then a separator, then the
    // picker configuration items. No overflow = the menu is unchanged.
    if (state.overflowSkills.length) {
      state.overflowSkills.forEach(function (skill) {
        menu.appendChild(menuSkillItem(skill));
      });
      menu.appendChild(menuDivider());
    }
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

  /* Sticky-panel / keyboard-activation notifications for the shell. Both are
   * no-ops when the running shell predates them (plain browser mock). */
  function notifyPanelState(open) {
    if (API && typeof API.panelState === "function") {
      API.panelState(!!open);
    }
  }

  function setInputActivated(active) {
    if (API && typeof API.activate === "function") {
      API.activate(!!active);
    }
  }

  function setPanelPinned(pinned, silent, remember) {
    var next = !!pinned;
    if (state.panelPinned === next) {
      syncPanelPin();
      return;
    }
    state.panelPinned = next;
    syncPanelPin();
    API.pin(next, remember === true).then(function (result) {
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
      if (remember === true) {
        // Keep the local preference in sync so switching skills does not push
        // the old preference back.
        state.panelPinnedPreference = state.panelPinned;
      }
      if (!silent) {
        showToast(next ? "面板已固定到桌面" : "已取消固定");
      }
    });
  }

  function togglePanelPinned() {
    // Explicit user action: persist the preference (remember=true).
    setPanelPinned(!state.panelPinned, false, true);
  }

  /* Apply the configured panel mode to the card:
   *   auto   - natural height, window follows the content, no grip.
   *   scroll - fixed window size, body scrolls, grip is drag-resizable. */
  function applyPanelMode() {
    var scroll = state.panelMode === "scroll";
    panel.classList.toggle("is-scroll-mode", scroll);
    panel.classList.toggle("is-auto-mode", !scroll);
    if (panelResizeGrip) {
      panelResizeGrip.hidden = !scroll;
    }
    state.panelAutoResize = !scroll;
    state.lastAutoPanelSize = null;
    if (!scroll) {
      panel.classList.remove("is-manual-size");
    }
  }

  function openPanel(title) {
    closeMenu();
    abortActiveRequest();
    stopSpeech();
    resetFollowup();
    if (autoPanelResizeTimer) {
      window.clearTimeout(autoPanelResizeTimer);
      autoPanelResizeTimer = 0;
    }
    state.autoPanelFollow = true;
    // Switching skills (or opening a fresh screenshot panel) drops the image
    // context: the next picker-image event records it again.
    state.image = null;
    // A new/switched panel starts with keyboard capture off until the user
    // focuses the follow-up field.
    setInputActivated(false);
    state.panelOpen = true;
    state.panelRetry = null;
    state.panelSpeakText = "";
    panel.hidden = false;
    setPanelCopyText("");
    panelTitle.textContent = title;
    setPanelLanguage("");
    if (panelTargetSelect) {
      // Every panel starts with an editable language selector; the screenshot
      // translation panel additionally hides the "auto" option / inserts the
      // "识别中…" placeholder (see beginImageRequest).
      panelTargetSelect.disabled = false;
      panelTargetSelect.removeAttribute("title");
      clearPendingImageTarget();
      setAutoTargetOptionHidden(false);
    }
    pickerEl.classList.add("panel-mode");
    syncPanelPin();
    syncPanelFoot();
    // Sticky panel: the shell keeps the picker visible while a result is open
    // (keyboard/scroll/right click do not hide it; outside clicks still do
    // when the panel is not pinned).
    notifyPanelState(true);
    if (state.panelPinnedPreference) {
      // Remembered preference: pin silently and do not persist again.
      setPanelPinned(true, true, false);
    }
    applyPanelMode();
    if (state.panelMode === "scroll") {
      // Fixed window: remembered size (or the default), never below 360x240.
      var savedSize =
        validPanelSize(
          state.panelManualSize ? state.panelManualSize.width : DEFAULT_PANEL_WIDTH,
          state.panelManualSize ? state.panelManualSize.height : DEFAULT_PANEL_HEIGHT
        ) || { width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT };
      state.panelManualSize = { width: savedSize.width, height: savedSize.height };
      state.panelAutoResize = false;
      // Fill the whole window with the card so no transparent strip remains
      // below it; the body scrolls inside.
      panel.classList.add("is-manual-size");
      API.resize(savedSize.width, savedSize.height);
    } else {
      // Auto window: seed a sensible size, then follow the visible content.
      state.panelAutoResize = true;
      state.lastAutoPanelSize = null;
      panel.classList.remove("is-manual-size");
      API.resize(AUTO_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT);
      resizePanelForContent();
    }
  }

  function closePanel() {
    if (!state.panelOpen) {
      return;
    }
    if (state.panelPinned) {
      // Closing is not a preference change: cancel the pin without remembering.
      setPanelPinned(false, true, false);
    }
    setInputActivated(false);
    abortActiveRequest();
    stopSpeech();
    resetFollowup();
    state.image = null;
    panel.hidden = true;
    state.panelOpen = false;
    state.panelRetry = null;
    state.panelSpeakText = "";
    setPanelCopyText("");
    pickerEl.classList.remove("panel-mode");
    notifyPanelState(false);
    // Closing a tool panel dismisses the whole picker instead of falling back to
    // the toolbar capsule: the user explicitly asked to get it out of the way.
    if (API && typeof API.close === "function") {
      API.close();
    } else {
      scheduleToolbarResize();
    }
  }

  function setBody(node) {
    panelBody.innerHTML = "";
    panelBody.appendChild(node);
    panelBody.scrollTop = 0;
    state.autoPanelFollow = true;
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

  /* Writes the streamed answer into the result node. OCR panels are literal
   * text (no Markdown); every other action reuses the Markdown renderer. */
  function renderRequestResult(request) {
    if (!request || !request.result) {
      return;
    }
    if (request.plain) {
      request.result.textContent = String(request.raw || "");
      return;
    }
    renderMarkdownInto(request.result, request.raw);
  }

  /* Plain text for the speech/copy footer: OCR keeps its literal text (a
   * Markdown flattener would eat characters), Markdown panels are flattened. */
  function requestOutputText(request) {
    if (!request) {
      return "";
    }
    return request.plain ? String(request.raw || "") : plainFromMarkdown(request.raw);
  }

  /* Lightweight replacement for the text source block on screenshot panels. */
  function imageNoteNode(text) {
    return el("p", "panel-note", text);
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
    if (kind === "custom") {
      return "自定义技能与翻译使用同一服务，请检查 API/本地模型状态后重试。";
    }
    if (kind === "polish") {
      return "润色与翻译使用相同的服务，请检查在线 API 或本地模型状态后重试。";
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

  /* ---- Follow-up conversation ----------------------------------------- */

  /* Follow-up context belongs to the current panel: closing the panel or
   * switching skills resets it so a new answer never inherits old history. */
  /* Keeps the floating follow-up overlay from covering the last lines of the
   * result: the panel body gets bottom padding equal to the overlay height.
   * `alsoResize` re-runs the auto height after the padding change. */
  function syncFollowupOverlay(alsoResize) {
    if (!panelFollowup || !panelBody) {
      return;
    }
    if (panelFollowup.hidden) {
      panelBody.style.paddingBottom = "";
    } else {
      var height = panelFollowup.offsetHeight || 0;
      panelBody.style.paddingBottom = Math.ceil(height + 14) + "px";
    }
    if (alsoResize && state.panelOpen && state.panelMode === "auto") {
      resizePanelForContent();
    }
  }

  function resetFollowup() {
    state.followupHistory = [];
    state.followupAnswer = "";
    state.followupBusy = false;
    if (panelFollowupInput) {
      panelFollowupInput.value = "";
      panelFollowupInput.disabled = false;
    }
    if (panelFollowupSend) {
      panelFollowupSend.disabled = false;
    }
    if (panelFollowup) {
      panelFollowup.hidden = true;
      panelFollowup.classList.remove("is-busy");
    }
    setFollowupSuggestions([]);
    window.requestAnimationFrame(function () {
      syncFollowupOverlay(true);
    });
  }

  function singleEnglishWord(text) {
    var word = String(text == null ? "" : text).trim();
    return /^[A-Za-z][A-Za-z'-]{0,39}$/.test(word) ? word : "";
  }

  function wordSuggestions(word) {
    return [
      "用「" + word + "」造几个句子。",
      "「" + word + "」和近义词有什么区别？",
      "「" + word + "」有哪些常见搭配？",
    ];
  }

  function setFollowupSuggestions(list) {
    if (!panelSuggestions) {
      return;
    }
    panelSuggestions.innerHTML = "";
    if (!list || !list.length) {
      panelSuggestions.hidden = true;
      return;
    }
    list.forEach(function (text) {
      var chip = el("button", "panel-suggestion", text);
      chip.type = "button";
      chip.addEventListener("click", function () {
        submitFollowup(text);
      });
      panelSuggestions.appendChild(chip);
    });
    panelSuggestions.hidden = false;
  }

  /* Called when an AI panel (translate/summarize/explain/polish/custom) renders
   * its first successful answer. Error panels and non-AI skills never call it. */
  function enableFollowup(request) {
    var answer = String(request.raw || "").trim();
    if (!answer) {
      return;
    }
    state.followupAnswer = request.raw;
    state.followupBusy = false;
    panelFollowup.hidden = false;
    panelFollowup.classList.remove("is-busy");
    panelFollowupInput.disabled = false;
    panelFollowupSend.disabled = false;
    var word = "";
    if (request.kind === "translate" || (request.kind === "assist" && request.action === "explain")) {
      word = singleEnglishWord(state.text);
    }
    setFollowupSuggestions(word ? wordSuggestions(word) : []);
    window.requestAnimationFrame(function () {
      syncFollowupOverlay(true);
    });
  }

  function setFollowupBusy(busy) {
    state.followupBusy = !!busy;
    if (!panelFollowup) {
      return;
    }
    panelFollowup.classList.toggle("is-busy", state.followupBusy);
    panelFollowupInput.disabled = state.followupBusy;
    panelFollowupSend.disabled = state.followupBusy;
    if (!state.followupBusy && state.panelOpen) {
      panelFollowupInput.focus();
    }
  }

  function appendFollowupBlock(question) {
    var block = el("div", "followup-block");
    block.appendChild(el("p", "followup-question", "追问：" + question));
    var loadingRow = loadingNode("正在回答…");
    block.appendChild(loadingRow);
    var answer = el("div", "result-text markdown followup-answer");
    block.appendChild(answer);
    panelBody.appendChild(block);
    panelBody.scrollTop = panelBody.scrollHeight;
    resizePanelForContent();
    return { block: block, loading: loadingRow, answer: answer };
  }

  function submitFollowup(questionOverride) {
    if (!state.panelOpen || !panelFollowup || panelFollowup.hidden) {
      return;
    }
    if (state.followupBusy || (activeRequest && activeRequest.active)) {
      return;
    }
    var question = String(questionOverride == null ? panelFollowupInput.value : questionOverride)
      .replace(/\s+/g, " ")
      .trim();
    if (!question) {
      return;
    }
    // Screenshot panels keep the image/OCR context in the shell, so their
    // follow-up goes through `capture_followup` (same translate-event stream).
    var imageMode = !!state.image;
    if (imageMode) {
      if (!API || typeof API.captureFollowup !== "function") {
        showToast("当前版本不支持继续提问");
        return;
      }
    } else if (!API || typeof API.followup !== "function") {
      showToast("当前版本不支持继续提问");
      return;
    }
    var previousAnswer = state.followupAnswer;
    var history = state.followupHistory.slice();
    var block = appendFollowupBlock(question);
    panelFollowupInput.value = "";
    setFollowupBusy(true);

    var request = {
      id: makeRequestId(),
      kind: "followup",
      question: question,
      block: block.block,
      target: block.block,
      result: block.answer,
      raw: "",
      renderPending: false,
      loading: block.loading,
      active: true,
      failed: false,
      sawContent: false,
    };
    activeRequest = request;
    state.translating = true;
    var stream = imageMode
      ? API.captureFollowup(request.id, question, previousAnswer, history)
      : API.followup(request.id, state.text, previousAnswer, question, history);
    Promise.resolve(stream).then(
      function (response) {
        if (!request.active) {
          return;
        }
        if (!response || !response.ok) {
          failFollowup(
            request,
            (response && response.error) || "回答失败",
            (response && response.hint) || ""
          );
        }
      },
      function (error) {
        failFollowup(request, String(error));
      }
    );
  }

  function finishFollowup(request) {
    if (!request || !request.active) {
      return;
    }
    request.active = false;
    if (activeRequest === request) {
      activeRequest = null;
    }
    state.translating = false;
    removeLoadingRow(request);
    var answer = String(request.raw || "").trim();
    if (!answer) {
      failFollowup(request, "没有返回内容，请重试。");
      return;
    }
    renderMarkdownInto(request.result, request.raw);
    state.followupAnswer = request.raw;
    state.followupHistory.push({ question: request.question, answer: request.raw });
    setFollowupBusy(false);
    setPanelSpeakText(plainFromMarkdown(request.raw));
    setPanelCopyText(plainFromMarkdown(request.raw));
    panelBody.scrollTop = panelBody.scrollHeight;
    resizePanelForContent();
  }

  /* A follow-up failure stays inside its block: the initial result and the
   * rest of the conversation are never replaced. */
  function failFollowup(request, message, hint) {
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
    var text = friendlyError(message || "回答失败");
    if (String(request.raw || "").trim()) {
      renderMarkdownInto(request.result, request.raw);
    } else if (request.result && request.result.parentNode) {
      request.result.parentNode.removeChild(request.result);
    }
    var error = el("div", "followup-error");
    error.appendChild(el("p", "followup-error-text", text));
    if (hint) {
      error.appendChild(el("p", "followup-error-hint", hint));
    }
    var retryButton = el("button", "followup-retry", "重试");
    retryButton.type = "button";
    retryButton.addEventListener("click", function () {
      if (request.block && request.block.parentNode) {
        request.block.parentNode.removeChild(request.block);
      }
      submitFollowup(request.question);
    });
    error.appendChild(retryButton);
    request.block.appendChild(error);
    setFollowupBusy(false);
    panelBody.scrollTop = panelBody.scrollHeight;
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

  /* Per-kind wording shared by the streaming panel (translate / polish /
   * custom skill / screenshot skill). */
  function requestFailureTitle(request) {
    if (request.kind === "image") {
      return imageFailureTitle(request.imageAction, request.label);
    }
    if (request.kind === "custom") {
      return (request.label || "自定义技能") + "失败";
    }
    if (request.kind === "polish") {
      return "润色失败";
    }
    if (request.kind === "assist") {
      return (request.label || "处理") + "失败";
    }
    return "翻译失败";
  }

  function emptyResultMessage(request) {
    if (request.kind === "image") {
      return imageEmptyMessage(request.imageAction, request.label);
    }
    if (request.kind === "custom") {
      return "自定义技能没有返回结果（可能正在启动或服务不可用）。";
    }
    if (request.kind === "polish") {
      return "润色服务没有返回结果（可能正在启动或引擎不可用）。";
    }
    if (request.kind === "assist") {
      return (request.label || "处理") + "服务没有返回结果（可能正在启动或引擎不可用）。";
    }
    return "翻译服务没有返回结果（可能正在启动或引擎不可用）。";
  }

  function retryRequest(request) {
    if (!request) {
      return;
    }
    if (request.kind === "image") {
      // Re-runs the stored screenshot with `capture_retry` (see retryImageRequest).
      retryImageRequest();
      return;
    }
    if (request.kind === "custom" && request.skillId) {
      startCustomSkill(request.skillId);
      return;
    }
    if (request.kind === "polish") {
      startPolish();
      return;
    }
    if (request.kind === "assist") {
      assistSkill(request.action);
      return;
    }
    translateSkill(panelTargetSelect.value);
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
      failTranslation(request, emptyResultMessage(request));
      return;
    }
    renderRequestResult(request);
    var output = requestOutputText(request);
    setPanelSpeakText(output);
    setPanelCopyText(output);
    enableFollowup(request);
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
    var text = friendlyError(message || requestFailureTitle(request));
    if (String(request.raw || "").trim()) {
      appendErrorNote(request.target, text);
      renderRequestResult(request);
      var output = requestOutputText(request);
      setPanelSpeakText(output);
      setPanelCopyText(output);
      resizePanelForContent();
      return;
    }
    renderErrorPanel(
      requestFailureTitle(request),
      text,
      hint ||
        (request.kind === "image"
          ? imageErrorHint(request, text)
          : hintForError(
              text,
              request.kind === "custom"
                ? "custom"
                : request.kind === "polish"
                  ? "polish"
                  : request.kind === "assist"
                    ? "assist"
                    : "translate"
            )),
      function () {
        retryRequest(request);
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
      var stickToBottom =
        state.panelMode === "auto" ? state.autoPanelFollow : isNearBottom(panelBody);
      renderRequestResult(request);
      if (stickToBottom) {
        scrollAutoPanelToEnd();
        followAutoPanelContent();
      }
      var output = requestOutputText(request);
      setPanelSpeakText(output);
      setPanelCopyText(output);
      // Streaming text also grows the auto window.
      resizePanelForContent();
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
    if (event.type === "target") {
      // Screenshot translation: the shell resolved the real target language
      // from the recognized text. Update the header only, never re-run.
      if (request.kind !== "image" || request.imageAction !== "translate") {
        return;
      }
      var resolvedTarget = imageTargetLanguageCode(event.targetLang);
      if (!resolvedTarget) {
        return;
      }
      request.targetLang = resolvedTarget;
      if (state.image) {
        state.image.targetLang = resolvedTarget;
      }
      clearPendingImageTarget();
      setPanelLanguage(resolvedTarget);
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
      if (request.kind === "followup") {
        finishFollowup(request);
      } else {
        finishTranslation(request);
      }
      return;
    }
    if (event.type === "error") {
      if (request.kind === "followup") {
        failFollowup(request, event.message || "回答失败", event.hint || "");
      } else {
        failTranslation(request, event.message || requestFailureTitle(request), event.hint || "");
      }
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
      kind: "translate",
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

  /* ---- Screenshot result panels (picker-image) ------------------------- */

  /* Screenshot skills reuse the text result panel (contracts §10.5): same head,
   * footer, follow-up overlay and resize grip; only the source row (clipboard
   * note instead of the selected text), the loading wording and the renderer
   * differ (OCR is literal text, the others stream Markdown). */

  function imageFailureTitle(action, label) {
    if (action === "ocr") {
      return "提取文字失败";
    }
    if (action === "translate") {
      return "翻译失败";
    }
    if (action === "explain") {
      return "解释失败";
    }
    return (label || IMAGE_ACTION_LABELS.custom) + "失败";
  }

  function imageEmptyMessage(action, label) {
    if (action === "ocr") {
      return "没有识别到文字，请重新截图并框选包含文字的区域。";
    }
    if (action === "translate") {
      return "截图翻译没有返回结果（可能正在启动或服务不可用）。";
    }
    if (action === "explain") {
      return "图片解释没有返回结果（可能正在启动或视觉模型不可用）。";
    }
    return (label || IMAGE_ACTION_LABELS.custom) + "没有返回结果（可能正在启动或视觉模型不可用）。";
  }

  /* Hint shown with a failed screenshot skill (the event hint wins when set). */
  function imageErrorHint(request, message) {
    var text = String(message || "");
    if (/API Key|apiKey|401|403|429|Unauthorized|认证|服务地址|baseUrl|超时|timeout|未安装|未配置|模型|视觉/i.test(text)) {
      return "请检查「设置 → 翻译服务」中的在线 API 或本地视觉模型（Qwen2.5-VL 3B）后重试。";
    }
    if (request.imageAction === "ocr") {
      return "可重新截图并框选包含文字的清晰区域后重试。";
    }
    return "可点「重试」重新识别这张截图，或检查设置中的在线 API / 本地视觉模型。";
  }

  /* Builds the result panel for one screenshot request. Returns the active
   * request object; the answer arrives through handleTranslateEvent
   * (chunk/error/done) exactly like a text skill. */
  function beginImageRequest(image, requestId) {
    var action = image.action;
    var label = image.label || IMAGE_ACTION_LABELS[action] || "截图结果";
    openPanel(label);
    // openPanel resets the image context, then the new one is recorded here.
    state.image = image;
    state.text = "";
    if (action === "translate") {
      // The language control stays editable: picking another target re-runs the
      // stored screenshot with capture_retry (switchImageTargetLanguage). Until
      // the shell resolves the real target from the recognized text we show a
      // "识别中…" placeholder instead of a misleading language.
      setAutoTargetOptionHidden(true);
      image.targetLang = applyImageTargetLanguage(
        image.targetLang || state.defaultTargetLang || "auto"
      );
    } else {
      clearPendingImageTarget();
      setPanelLanguage("");
    }
    setPanelRetry(retryImageRequest);

    var target = el("div");
    if (image.hint || image.clipboard) {
      var note = imageNoteNode(image.hint || IMAGE_CLIPBOARD_HINT);
      // The shell still streams when the clipboard write failed; the note keeps
      // the failure visible without blocking the result panel.
      if (image.clipboard === false) {
        note.classList.add("is-warn");
      }
      target.appendChild(note);
    }
    var loadingRow = loadingNode(action === "ocr" ? "正在识别文字…" : "正在处理…");
    target.appendChild(loadingRow);
    var result =
      action === "ocr" ? el("pre", "result-text plain") : el("div", "result-text markdown");
    target.appendChild(result);
    setBody(target);

    var request = {
      id: requestId,
      kind: "image",
      imageAction: action,
      skillId: image.skillId || "",
      label: label,
      plain: action === "ocr",
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
    return request;
  }

  /* Re-runs the stored screenshot with `capture_retry`. `targetOverride` is set
   * when the user picks another language in a screenshot translation panel;
   * footer/error retry keeps the current target language (ocr/explain/custom
   * never send one). */
  function retryImageRequest(targetOverride) {
    var image = state.image;
    if (!image || !state.panelOpen) {
      return;
    }
    var targetLang = "";
    if (image.action === "translate") {
      var requested = targetOverride == null ? image.targetLang : targetOverride;
      // An unresolved ("auto") target keeps the placeholder and lets the shell
      // resolve it again from the recognized text.
      targetLang = imageTargetLanguageCode(requested);
      image.targetLang = targetLang;
    }
    var requestId = makeCaptureRequestId();
    var request = beginImageRequest(image, requestId);
    if (!API || typeof API.captureRetry !== "function") {
      failTranslation(request, "当前版本不支持重试截图结果", "请更新应用后再试。");
      return;
    }
    var response;
    try {
      response = API.captureRetry(requestId, targetLang);
    } catch (error) {
      failTranslation(request, String(error));
      return;
    }
    // A synchronous error result (no promise) still gets the error panel.
    if (!response || typeof response.then !== "function") {
      if (!response || response.ok === false) {
        failTranslation(
          request,
          (response && response.error) || "重试失败",
          (response && response.hint) || ""
        );
      }
      return;
    }
    response.then(
      function (result) {
        if (!request.active) {
          return;
        }
        if (!result || !result.ok) {
          failTranslation(
            request,
            (result && result.error) || "重试失败",
            (result && result.hint) || ""
          );
        }
      },
      function (error) {
        if (request.active) {
          failTranslation(request, String(error));
        }
      }
    );
  }

  /* The user picked another target language in a screenshot translation panel:
   * re-run the stored screenshot through capture_retry with that language. The
   * shell re-extracts the text and translates into it (no new screenshot). */
  function switchImageTargetLanguage(targetLang) {
    var image = state.image;
    if (!image || image.action !== "translate" || !state.panelOpen) {
      return;
    }
    var code = imageTargetLanguageCode(targetLang);
    if (!code) {
      // The placeholder option (and a stale "auto") cannot be chosen directly;
      // restore the language that is actually being used.
      applyImageTargetLanguage(image.targetLang);
      return;
    }
    if (code === imageTargetLanguageCode(image.targetLang)) {
      return;
    }
    image.targetLang = code;
    retryImageRequest(code);
  }

  /* picker-image: the screenshot overlay finished and the shell copied the crop
   * to the clipboard; open the shared result panel and let the request id
   * correlate the translate-event stream. */
  function handleImageEvent(payload) {
    var event = payload && typeof payload === "object" ? payload : {};
    var requestId = String(event.requestId || "").trim();
    if (!requestId) {
      return;
    }
    var action = String(event.action || "").trim().toLowerCase();
    if (!hasOwn(IMAGE_ACTION_LABELS, action)) {
      action = "explain";
    }
    closeMenu();
    abortActiveRequest();
    stopSpeech();
    // The image skill panel never renders the previous selection: picker-data
    // sends text="" for captures and nothing here may depend on old text.
    state.text = "";
    state.targetLang = "";
    var image = {
      requestId: requestId,
      action: action,
      skillId: String(event.skillId || ""),
      label:
        String(event.label || "").trim() || IMAGE_ACTION_LABELS[action] || "截图结果",
      targetLang: String(event.targetLang || ""),
      clipboard: event.clipboard === true,
      hint: String(event.hint || "").trim(),
    };
    beginImageRequest(image, requestId);
  }

  /* ---- Polish ---------------------------------------------------------- */

  /* Streams the built-in polish skill through `picker_polish`. Events use the
   * same translate-event channel as translation (chunk/error/done), so
   * Markdown rendering, retry, copy/speak and the error panel are reused. */
  function startPolish() {
    openPanel("润色");
    setPanelRetry(function () {
      startPolish();
    });

    var target = el("div");
    target.appendChild(sourceNode());
    var loadingRow = loadingNode("正在润色…");
    target.appendChild(loadingRow);
    var result = el("div", "result-text markdown");
    target.appendChild(result);
    setBody(target);

    var request = {
      id: makeRequestId(),
      kind: "polish",
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

    if (!API || typeof API.polish !== "function") {
      failTranslation(request, "当前版本不支持润色", "请更新应用后再试。");
      return;
    }

    API.polish(request.id, state.text).then(
      function (response) {
        if (!request.active) {
          return;
        }
        if (!response || !response.ok) {
          failTranslation(
            request,
            (response && response.error) || "润色服务没有响应",
            (response && response.hint) || ""
          );
        }
      },
      function (error) {
        failTranslation(request, String(error));
      }
    );
  }

  /* ---- Custom skills --------------------------------------------------- */

  /* Streams a user-defined skill through `picker_custom_skill`. The event
   * pipeline is the same as translation (translate-event: chunk/error/done), so
   * Markdown rendering, copy/speak, abort, retry and the error panel are
   * reused. Only the panel title, loading text and error wording differ. */
  function startCustomSkill(skillId) {
    var id = String(skillId || "");
    var meta = hasOwn(state.customSkills, id) ? state.customSkills[id] : null;
    var label = meta && meta.label ? meta.label : id;
    openPanel(label);
    setPanelRetry(function () {
      startCustomSkill(id);
    });

    var target = el("div");
    target.appendChild(sourceNode());
    var loadingRow = loadingNode("正在处理…");
    target.appendChild(loadingRow);
    var result = el("div", "result-text markdown");
    target.appendChild(result);
    setBody(target);

    var request = {
      id: makeRequestId(),
      kind: "custom",
      skillId: id,
      label: label,
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

    if (!API || typeof API.customSkill !== "function") {
      failTranslation(request, "当前版本不支持自定义技能", "请更新应用后再试。");
      return;
    }

    API.customSkill(request.id, id, state.text, state.programName).then(
      function (response) {
        if (!request.active) {
          return;
        }
        if (!response || !response.ok) {
          failTranslation(
            request,
            (response && response.error) || "自定义技能没有响应",
            (response && response.hint) || ""
          );
        }
      },
      function (error) {
        failTranslation(request, String(error));
      }
    );
  }

  /* ---- Search ---------------------------------------------------------- */

  /* Opens the selected text in the configured search engine. The URL prefix
   * comes from the shared LP.SEARCH_ENGINE_MAP table; the engine value itself
   * is a picker setting delivered through picker-data. */
  function searchSkill() {
    var text = String(state.text || "").trim();
    if (!text) {
      showToast("没有可搜索的文本");
      return;
    }
    var engines = LP.SEARCH_ENGINE_MAP || {};
    var engine = hasOwn(engines, state.searchEngine) ? engines[state.searchEngine] : null;
    var prefix = engine && engine.url ? String(engine.url) : "";
    if (!/^https?:\/\//i.test(prefix)) {
      showToast("搜索失败：未配置搜索引擎");
      return;
    }
    if (!API || typeof API.openExternal !== "function") {
      showToast("搜索失败：当前版本不支持打开链接");
      return;
    }
    API.openExternal(prefix + encodeURIComponent(text)).then(
      function (response) {
        if (response && response.ok === false) {
          showToast("打开搜索失败：" + friendlyError(response.error || "未知错误"));
          return;
        }
        API.close();
      },
      function (error) {
        showToast("打开搜索失败：" + friendlyError(String(error)));
      }
    );
  }

  /* ---- Summarize / explain -------------------------------------------- */

  /* Streams the built-in summarize/explain skills through `picker_assist`.
   * Same translate-event channel as translation/polish → Markdown, retry,
   * copy/speak and the error panel are shared. */
  function assistSkill(action) {
    var label = action === "summarize" ? "总结" : "解释";
    var loadingText = action === "summarize" ? "正在总结…" : "正在解释…";
    openPanel(label);
    setPanelLanguage("");
    setPanelRetry(function () {
      assistSkill(action);
    });

    var target = el("div");
    target.appendChild(sourceNode());
    var loadingRow = loadingNode(loadingText);
    target.appendChild(loadingRow);
    var result = el("div", "result-text markdown");
    target.appendChild(result);
    setBody(target);

    var request = {
      id: makeRequestId(),
      kind: "assist",
      action: action,
      label: label,
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

    if (!API || typeof API.assist !== "function") {
      failTranslation(request, "当前版本不支持" + label, "请更新应用后再试。");
      return;
    }

    API.assist(request.id, action, state.text).then(
      function (response) {
        if (!request.active) {
          return;
        }
        if (!response || !response.ok) {
          failTranslation(
            request,
            (response && response.error) || label + "服务没有响应",
            (response && response.hint) || ""
          );
        }
      },
      function (error) {
        failTranslation(request, String(error));
      }
    );
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

  /* Image skills (built-in screenshot / custom kind=image) hand off to the
   * screenshot overlay: no text result panel is opened, the shell creates the
   * capture window and the picker hides itself. The built-in screenshot skill
   * also closes the picker window right away (like the copy skill); custom image
   * skills keep it so their result panel can open when the capture finishes. */
  function startImageCapture(presetSkillId, hidePicker) {
    var captureAPI = window.captureAPI;
    if (!captureAPI || typeof captureAPI.start !== "function") {
      showToast("当前版本不支持截图");
      return;
    }
    var result;
    try {
      result = captureAPI.start(String(presetSkillId || ""));
    } catch (error) {
      showToast("截图失败：" + friendlyError(String(error)));
      return;
    }
    /* Keep the picker window open while the capture overlay is active: the
     * shell excludes it from the screenshot and suppresses blur/dismiss while
     * capturing, so it reappears untouched when the capture ends (§10.1). Only
     * the transient menu/stream/speech are stopped. */
    function stopPickerWorkForCapture() {
      closeMenu();
      abortActiveRequest();
      stopSpeech();
      scheduleToolbarResize();
      if (hidePicker && API && typeof API.close === "function") {
        API.close();
      }
    }
    if (!result || typeof result.then !== "function") {
      stopPickerWorkForCapture();
      return;
    }
    result.then(
      function (response) {
        if (response && response.ok === false) {
          showToast("截图失败：" + friendlyError(response.error || "未知错误"));
          return;
        }
        stopPickerWorkForCapture();
      },
      function (error) {
        showToast("截图失败：" + friendlyError(String(error)));
      }
    );
  }

  function skillOpensPanel(skill) {
    if (skill === "translate" || skill === "summarize" || skill === "explain" || skill === "polish") {
      return true;
    }
    if (skill === "read" || skill === "copy" || skill === "search" || skill === "screenshot") {
      return false;
    }
    var meta = skillMeta(skill);
    return meta.kind !== "image";
  }

  function runSkill(skill) {
    if (PICKER_SURFACE === "toolbar" && skillOpensPanel(skill)) {
      API.runToolbarSkill(skill).then(
        function (result) {
          if (result && result.ok === false) {
            showToast("无法打开工具面板：" + friendlyError(result.error || "未知错误"));
          }
        },
        function (error) {
          showToast("无法打开工具面板：" + friendlyError(String(error)));
        }
      );
      return;
    }
    if (skill === "translate") {
      translateSkill();
    } else if (skill === "summarize" || skill === "explain") {
      assistSkill(skill);
    } else if (skill === "polish") {
      startPolish();
    } else if (skill === "read") {
      speak(state.text);
    } else if (skill === "copy") {
      copyToClipboard(state.text, "已复制选中文本", true);
    } else if (skill === "search") {
      searchSkill();
    } else if (skill === "screenshot") {
      // Built-in screenshot skill: capture and hide the picker toolbar.
      startImageCapture("", true);
    } else if (skill) {
      var meta = skillMeta(skill);
      if (meta.kind === "image") {
        // Custom image skill: capture with that skill preselected.
        startImageCapture(skill);
        return;
      }
      // Text skill (or an unknown id from config.skills): the shell reports a
      // disabled/missing skill through the stream error event.
      startCustomSkill(skill);
    }
  }

  /* ---- Reset / data ---------------------------------------------------- */

  function resetForHidden() {
    abortActiveRequest();
    stopSpeech();
    setInputActivated(false);
    // Hidden picker: no screenshot context may survive into the next payload.
    state.image = null;
    if (PICKER_SURFACE !== "toolbar") {
      if (state.panelPinned) {
        // The shell hid the panel; cancel the transient pin (preference stays).
        setPanelPinned(false, true, false);
      } else {
        state.panelPinned = false;
        syncPanelPin();
      }
      notifyPanelState(false);
    }
    state.panelSpeakText = "";
    state.panelRetry = null;
    panel.hidden = true;
    state.panelOpen = false;
    pickerEl.classList.remove("panel-mode");
    closeMenu();
    scheduleToolbarResize();
  }

  /* ---- Events ---------------------------------------------------------- */

  panelTargetSelect.addEventListener("change", function () {
    if (!state.panelOpen) {
      return;
    }
    if (state.image) {
      // Screenshot translation: picking a target re-runs capture_retry instead
      // of routing the value through the text picker_translate pipeline.
      if (state.image.action === "translate") {
        switchImageTargetLanguage(panelTargetSelect.value);
      }
      return;
    }
    translateSkill(panelTargetSelect.value);
  });
  panelHead.addEventListener("mousedown", beginPanelDrag);
  document.addEventListener("mousemove", handlePanelDragMove);
  document.addEventListener("mouseup", endPanelDrag);
  window.addEventListener("blur", endPanelDrag);
  panelResizeGrip.addEventListener("mousedown", beginPanelResize);
  panelResizeGrip.addEventListener("dblclick", resetPanelSize);
  document.addEventListener("mousemove", handlePanelResizeMove);
  document.addEventListener("mouseup", endPanelResize);
  window.addEventListener("blur", endPanelResize);
  window.addEventListener("resize", function () {
    if (state.panelOpen) {
      syncFollowupOverlay();
    }
  });
  panelFollowupSend.addEventListener("click", function () {
    submitFollowup();
  });
  panelFollowupInput.addEventListener("mousedown", function () {
    // Keyboard input inside the picker is captured by the shell; allow it while
    // the follow-up field is being used.
    setInputActivated(true);
  });
  panelFollowupInput.addEventListener("focus", function () {
    setInputActivated(true);
  });
  panelFollowupInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitFollowup();
    }
  });
  panelPin.addEventListener("click", togglePanelPinned);
  document.getElementById("panel-close").addEventListener("click", closePanel);
  panelSpeak.innerHTML = skillIconSvg(builtinSkillMeta("read").icon) + "<span>朗读</span>";
  panelCopy.innerHTML = skillIconSvg(builtinSkillMeta("copy").icon) + "<span>复制</span>";
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
  if (API && typeof API.onRunSkill === "function") {
    API.onRunSkill(function (payload) {
      if (PICKER_SURFACE === "panel" && payload && payload.skill) {
        runSkill(String(payload.skill));
      }
    });
  }

  panelBody.addEventListener(
    "wheel",
    function (event) {
      if (!state.panelOpen || state.panelMode !== "auto") {
        return;
      }
      if (event.deltaY < 0) {
        state.autoPanelFollow = false;
        return;
      }
      window.requestAnimationFrame(function () {
        if (isNearBottom(panelBody)) {
          state.autoPanelFollow = true;
        }
      });
    },
    { passive: true }
  );
  panelBody.addEventListener("keydown", function (event) {
    if (!state.panelOpen || state.panelMode !== "auto") {
      return;
    }
    if (event.key === "PageUp" || event.key === "Home" || event.key === "ArrowUp") {
      state.autoPanelFollow = false;
    } else if (event.key === "End") {
      state.autoPanelFollow = true;
      followAutoPanelContent();
    } else if (
      (event.key === "PageDown" || event.key === "ArrowDown") &&
      isNearBottom(panelBody)
    ) {
      state.autoPanelFollow = true;
    }
  });
  new MutationObserver(function () {
    scrollAutoPanelToEnd();
    followAutoPanelContent();
  }).observe(panelBody, { childList: true, subtree: true, characterData: true });

  /* Screenshot skills hand their result panel to the picker (picker-image,
   * contracts §10.5); the streaming chunks then arrive on translate-event. */
  if (API && typeof API.onImage === "function") {
    API.onImage(handleImageEvent);
  }

  API.onData(function (payload) {
    var data = payload || {};
    var config = data.config || {};
    state.text = String(data.text || "");
    state.programName = String(data.programName || "");
    state.defaultTargetLang = String(config.defaultTargetLang || "auto");
    state.searchEngine = normalizeSearchEngine(config.searchEngine);
    state.panelMode = normalizePanelMode(config.panelMode);
    state.panelPinnedPreference = config.panelPinned === true;
    state.targetLang = "";
    // Rebuild the custom-skill metadata every time: a disabled/removed skill
    // must never keep its old button or label around.
    state.customSkills = {};
    (Array.isArray(config.customSkills) ? config.customSkills : []).forEach(function (entry) {
      if (!entry || typeof entry !== "object") {
        return;
      }
      var id = String(entry.id || "").trim();
      if (!id || hasOwn(state.customSkills, id)) {
        return;
      }
      state.customSkills[id] = {
        id: id,
        label: String(entry.label || "").trim() || id,
        icon: String(entry.icon || "").trim() || defaultCustomIcon(),
        // Custom skills default to text; "image" skills open the capture overlay.
        kind: String(entry.kind || "").trim().toLowerCase() === "image" ? "image" : "text",
      };
    });
    var seen = {};
    var skills = [];
    (Array.isArray(config.skills) ? config.skills : []).forEach(function (skill) {
      var id = typeof skill === "string" ? skill.trim() : "";
      if (!id || hasOwn(seen, id)) {
        return;
      }
      seen[id] = true;
      skills.push(id);
    });
    state.skills = skills.length ? skills : DEFAULT_SKILLS.slice();
    state.compact = config.compact === true;
    state.overflowBias = 0;
    resetForHidden();
    renderToolbar();
  });

  API.onHidden(function () {
    resetForHidden();
  });

  /* ---- Boot ------------------------------------------------------------ */

  /* Browser-preview test hook (mock mode only, never in the Tauri shell):
   * exposes the live screenshot panel state so CDP checks can push
   * translate-events (target/chunk/done) at the running request with
   * window.__mockTranslateEvent({requestId, ...}). */
  if (API && API.live === false) {
    window.__pickerImageState = function () {
      return {
        panelOpen: state.panelOpen,
        panelMode: state.panelMode,
        autoPanelFollow: state.autoPanelFollow,
        panelTitle: panelTitle ? panelTitle.textContent : "",
        image: state.image
          ? {
              requestId: state.image.requestId,
              action: state.image.action,
              targetLang: state.image.targetLang,
              skillId: state.image.skillId,
            }
          : null,
        activeRequestId: activeRequest ? activeRequest.id : null,
        activeKind: activeRequest ? activeRequest.kind : null,
        targetSelectValue: panelTargetSelect ? panelTargetSelect.value : "",
        targetSelectDisabled: panelTargetSelect ? panelTargetSelect.disabled : null,
        pendingTarget: !!(
          panelTargetSelect &&
          panelTargetSelect.querySelector('option[data-pending-target="1"]')
        ),
        targetOptionValues: panelTargetSelect
          ? Array.prototype.map.call(panelTargetSelect.options, function (option) {
              return option.value;
            })
          : [],
      };
    };
  }

  state.panelManualSize = loadPanelSize();
  state.panelAutoResize = state.panelMode === "auto";
  syncPanelPin();
  syncPanelFoot();
  populateTargetLanguages();
  renderToolbar();
  // DOM is ready: tell the shell the renderer can receive picker-data now.
  API.ready();
})();
