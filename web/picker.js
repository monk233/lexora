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
  /* Shared LP.DEFAULT_SKILLS is the source of truth (seven built-ins); the
   * local list only keeps the toolbar usable if the shared script failed. */
  var FALLBACK_SKILLS = ["translate", "summarize", "explain", "polish", "read", "copy", "search"];
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

  /* Label fallback only: LP.SKILL_MAP is the primary source for built-in
   * labels/icons (see builtinSkillMeta). */
  var SKILL_LABELS = {
    translate: "翻译",
    summarize: "总结",
    explain: "解释",
    polish: "润色",
    read: "朗读",
    copy: "复制",
    search: "搜索",
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
   * example translate -> "languages"), never the skill id. */
  function builtinSkillMeta(skill) {
    var map = LP.SKILL_MAP || {};
    var entry = hasOwn(map, skill) ? map[skill] : null;
    return {
      id: skill,
      label: (entry && entry.label) || SKILL_LABELS[skill] || skill,
      icon: (entry && entry.icon) || defaultCustomIcon(),
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

  /* Label + icon for one toolbar skill. Built-in ids come from LP.SKILL_MAP
   * (icon keys like "languages"); custom ids from `config.customSkills`;
   * unknown ids fall back to the id itself and the default sparkles icon. */
  function skillMeta(skill) {
    if (isBuiltinSkill(skill)) {
      return builtinSkillMeta(skill);
    }
    if (hasOwn(state.customSkills, skill)) {
      return state.customSkills[skill];
    }
    return { id: skill, label: skill, icon: defaultCustomIcon() };
  }

  function skillButton(skill) {
    var meta = skillMeta(skill);
    var button = el("button", "tool-btn");
    button.type = "button";
    button.setAttribute("data-skill", skill);
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
    if (kind === "custom") {
      return "自定义技能与翻译使用相同的服务，请检查在线 API 或本地模型状态后重试。";
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
   * custom skill). */
  function requestFailureTitle(request) {
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
    var text = friendlyError(message || requestFailureTitle(request));
    if (String(request.raw || "").trim()) {
      appendErrorNote(request.target, text);
      renderMarkdownInto(request.result, request.raw);
      setPanelSpeakText(plainFromMarkdown(request.raw));
      setPanelCopyText(plainFromMarkdown(request.raw));
      resizePanelForContent();
      return;
    }
    renderErrorPanel(
      requestFailureTitle(request),
      text,
      hint ||
        hintForError(
          text,
          request.kind === "custom"
            ? "custom"
            : request.kind === "polish"
              ? "polish"
              : request.kind === "assist"
                ? "assist"
                : "translate"
        ),
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
      failTranslation(request, event.message || requestFailureTitle(request));
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

  function runSkill(skill) {
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
    } else if (skill) {
      // User-defined skill (or an unknown id from config.skills): the shell
      // reports a disabled/missing skill through the stream error event.
      startCustomSkill(skill);
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

  API.onData(function (payload) {
    var data = payload || {};
    var config = data.config || {};
    state.text = String(data.text || "");
    state.programName = String(data.programName || "");
    state.defaultTargetLang = String(config.defaultTargetLang || "auto");
    state.searchEngine = normalizeSearchEngine(config.searchEngine);
    state.targetLang = "";
    state.panelPinned = false;
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

  syncPanelPin();
  syncPanelFoot();
  populateTargetLanguages();
  renderToolbar();
  // DOM is ready: tell the shell the renderer can receive picker-data now.
  API.ready();
})();
