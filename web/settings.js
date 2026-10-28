/* Lexora settings renderer.
 *
 * Single-page settings window backed by `window.settingsAPI` (contract §5.1).
 * All changes save automatically: switches/selects immediately, text fields
 * after a 500ms debounce (or on blur/Enter). The window is passive most of the
 * time: `state-changed` events from Rust refresh the UI, downloads stream
 * through `download-progress`, and field values are only written back when the
 * field is not focused (so state refreshes never interrupt typing).
 */
(function () {
  "use strict";

  var API = window.settingsAPI;
  var LP = window.LP || {};

  /* Built-in skill ids come from shared metadata so newly added built-ins
   * (polish/search) need no frontend change. Fallbacks keep the page usable
   * when the cached shared script is stale. */
  var SKILL_IDS = (
    LP.DEFAULT_SKILLS && LP.DEFAULT_SKILLS.length
      ? LP.DEFAULT_SKILLS
      : ["translate", "summarize", "explain", "polish", "read", "copy", "search"]
  ).slice();
  var DEFAULT_SKILLS = SKILL_IDS.slice();
  /* Built-in skills that expose an editable prompt (read/copy/search have no
   * model call). */
  var PROMPT_SKILLS = (
    LP.PROMPT_SKILLS && LP.PROMPT_SKILLS.length
      ? LP.PROMPT_SKILLS
      : ["translate", "summarize", "explain", "polish"]
  ).slice();
  var SEARCH_ENGINES = LP.SEARCH_ENGINES || [
    { value: "google", label: "Google" },
    { value: "baidu", label: "百度" },
    { value: "bing", label: "Bing" },
  ];
  var CUSTOM_MODEL_VALUE = "__custom__";

  var state = null;
  var initialStateSettled = false;
  var saveQueue = null;
  var saving = false;
  var savePending = null;
  var saveStatusTimer = null;
  var textTimers = {};
  var textFields = [];
  var catalogOpen = false;
  var localBusy = false;
  var localAction = "";
  var removingModels = Object.create(null);
  var loginBusy = false;

  /* Region-screenshot shortcut recorder (contract §10.4): while recording the
   * global keydown handler owns the keyboard, while saving the display is
   * locked so a `state-changed` refresh cannot flash the old value. */
  var hotkeyRecording = false;
  var hotkeySaving = false;

  /* Online models fetched from /models, cached per baseUrl + apiKey. */
  var onlineModelCache = {};
  var customModelMode = false;
  var onlineModelHint = "";
  var onlineModelError = "";
  var fetchModelsBusy = false;

  /* Skill prompt editors: expansion, pending drafts and debounce timers. */
  var promptExpanded = {};
  var promptTimers = {};
  var promptDrafts = {};

  /* Screenshot-toolbar prompt editors (built-in translate / explain rows). */
  var capturePromptExpanded = {};
  var capturePromptTimers = {};
  var capturePromptDrafts = {};

  /* Skill id currently being dragged in the toolbar-order list. */
  var dragSkillId = "";

  /* Screenshot-toolbar action id currently being dragged (independent from
   * `dragSkillId`; capture actions are not picker skills). */
  var dragCaptureAction = "";

  /* Active toolbar-skill category tab: "text" | "image". Not persisted; every
   * settings window starts on the text tab (contract §7.2). */
  var skillTab = "text";

  /* Search-engine config panel (search skill) open state. */
  var searchPanelOpen = false;

  /* Icon picker search query (filters LP.CUSTOM_SKILL_ICON_KEYS by key). */
  var iconSearchQuery = "";

  /* Whether the compact icon picker panel is expanded inside the editor. */
  var iconPickerOpen = false;

  /* Custom skill editor: open flag, edited id ("" means a new skill) and the
   * in-progress draft. The draft survives `state-changed` refreshes so a
   * background update never wipes what the user is typing. */
  var customEditorOpen = false;
  var customEditingId = "";
  var customDraft = null;

  /* About-page updater: idle|checking|latest|available|downloading|ready|error. */
  var updateState = "idle";
  var updateInfo = null;
  var updateErrorTitle = "";
  var updateErrorText = "";
  var updateErrorHint = "";
  var updateProgressPercent = 0;
  var updateNotesExpanded = false;
  var updateChecking = false;
  var updateInstalling = false;

  /* Friendly names for the legacy/common icon keys (unknown keys show as-is). */
  var CUSTOM_ICON_LABELS = {
    sparkles: "灵感",
    "wand-sparkles": "润色",
    languages: "语言",
    "pen-line": "书写",
    "book-open": "阅读",
    earth: "全球",
    code: "代码",
    list: "列表",
    "message-circle": "对话",
    lightbulb: "点子",
    quote: "引用",
    briefcase: "工作",
    star: "收藏",
    search: "搜索",
    "circle-help": "帮助",
    "volume-2": "朗读",
    copy: "复制",
  };

  var CUSTOM_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

  /* Custom skill types: "text" processes the selected text, "image" is used
   * in the screenshot overlay (capture first, then run the prompt on the
   * cropped image with a vision model). */
  var CUSTOM_KIND_HINTS = {
    text: "文本技能处理选中文字：点击后直接执行提示词。",
    image:
      "选中文字后进入截图，对框选区域执行提示词（需视觉模型）。",
  };

  var CUSTOM_VARS_HINTS = {
    text:
      '变量：<code>{text}</code> 选中文本、<code>{target}</code>/<code>{language}</code> 目标语言、<code>{program}</code>/<code>{app}</code> 当前应用',
    image:
      '变量：<code>{target}</code>/<code>{language}</code> 目标语言、<code>{program}</code>/<code>{app}</code> 当前应用（图片内容由截图提供）',
  };

  /* Screenshot toolbar skills (contract §7.2/§11.2, tenth review round). Stored
   * in `picker.captureSkills`: one ordered list that mixes the built-in capture
   * tools/actions and custom `kind=image` skills. A missing id means the row is
   * hidden; an empty list means the toolbar only keeps undo/redo/cancel/confirm.
   * The built-in screenshot entry skill stays in `picker.skills` (text tab);
   * `copy` is no longer a toolbar entry (confirm = copy and exit). */
  var CAPTURE_ACTION_ORDER = [
    "pin",
    "shape",
    "arrow",
    "pen",
    "text",
    "number",
    "mosaic",
    "ocr",
    "translate",
    "explain",
    "longshot",
  ];
  /* Built-in actions whose system prompt can be overridden in the settings
   * page (`picker.capturePrompts`). */
  var CAPTURE_PROMPT_ACTIONS = ["translate", "explain"];
  var CAPTURE_ACTION_META = {
    pin: {
      label: "钉在桌面",
      description: "把框选区域钉成置顶窗口",
      icon: "pin",
    },
    shape: {
      label: "形状",
      description: "添加矩形、椭圆或直线",
      icon: "square",
    },
    arrow: {
      label: "箭头",
      description: "添加箭头",
      icon: "arrow-up-right",
    },
    pen: {
      label: "画笔",
      description: "自由绘制笔迹",
      icon: "pen",
    },
    text: {
      label: "文字",
      description: "添加文字",
      icon: "type",
    },
    number: {
      label: "序号",
      description: "添加自动递增序号",
      icon: "hash",
    },
    mosaic: {
      label: "马赛克",
      description: "涂抹打码",
      icon: "layout-grid",
    },
    ocr: {
      label: "提取文字",
      description: "用视觉模型提取框选区域文字",
      icon: "scan-text",
    },
    translate: {
      label: "翻译",
      description: "识别并翻译框选区域文字",
      icon: "languages",
    },
    explain: {
      label: "解释图片",
      description: "用视觉模型解释图片内容",
      icon: "lightbulb",
    },
    longshot: {
      label: "长截图",
      description: "自动滚动并拼接长图",
      icon: "scroll",
    },
  };

  /* Inline SVG markup shared by the skill rows (pencil / trash). */
  var SKILL_PENCIL_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
  var SKILL_TRASH_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';

  /* ---- DOM helpers ----------------------------------------------------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function each(list, callback) {
    Array.prototype.slice.call(list || []).forEach(callback);
  }

  function isFocused(node) {
    return !!node && document.activeElement === node;
  }

  function setInputValue(input, value) {
    if (!input || isFocused(input)) {
      return;
    }
    var text = value === null || value === undefined ? "" : String(value);
    if (input.value !== text) {
      input.value = text;
    }
  }

  function setSelectValue(select, value) {
    if (!select || isFocused(select)) {
      return;
    }
    var text = value === null || value === undefined ? "" : String(value);
    if (select.value !== text) {
      select.value = text;
    }
  }

  function setChecked(input, checked) {
    if (!input) {
      return;
    }
    var next = !!checked;
    if (input.checked !== next) {
      input.checked = next;
    }
  }

  function setHidden(node, hidden) {
    if (node) {
      node.hidden = !!hidden;
    }
  }

  function setTone(node, tone) {
    if (node) {
      node.setAttribute("data-tone", tone || "muted");
    }
  }

  function showInlineError(node, message, hint) {
    if (!node) {
      return;
    }
    var text = String(message || "").trim();
    if (hint) {
      text += (text ? "\n" : "") + String(hint);
    }
    node.textContent = text;
    node.hidden = !text;
  }

  function hideInlineError(node) {
    if (node) {
      node.textContent = "";
      node.hidden = true;
    }
  }

  function fillSelect(select, options) {
    if (!select) {
      return;
    }
    select.innerHTML = "";
    (options || []).forEach(function (option) {
      var node = document.createElement("option");
      node.value = String(option.value);
      node.textContent = String(option.label);
      select.appendChild(node);
    });
  }

  /* ---- Toasts / save status -------------------------------------------- */

  function toast(message, tone) {
    var stack = byId("toast-stack");
    if (!stack) {
      return;
    }
    var node = el("div", "toast", String(message || ""));
    node.setAttribute("data-tone", tone || "info");
    stack.appendChild(node);
    while (stack.children.length > 4) {
      stack.removeChild(stack.firstChild);
    }
    window.setTimeout(function () {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }, 3600);
  }

  function setSaveStatus(kind, message) {
    var pill = byId("save-status");
    var text = byId("save-status-text");
    if (!pill || !text) {
      return;
    }
    pill.setAttribute("data-state", kind || "idle");
    if (message) {
      text.textContent = message;
    } else if (kind === "saving") {
      text.textContent = "保存中…";
    } else if (kind === "saved") {
      text.textContent = "已保存";
    } else if (kind === "error") {
      text.textContent = "保存失败";
    } else {
      text.textContent = "所有更改自动保存";
    }
    window.clearTimeout(saveStatusTimer);
    if (kind === "saved") {
      saveStatusTimer = window.setTimeout(function () {
        setSaveStatus("idle");
      }, 2200);
    }
  }

  /* ---- Saving ---------------------------------------------------------- */

  function optimisticApply(patch) {
    if (!state || !state.settings) {
      return;
    }
    state.settings = LP.deepMerge(state.settings, patch);
  }

  function enqueuePatch(patch) {
    saveQueue = saveQueue ? LP.deepMerge(saveQueue, patch) : patch;
    flushSaveQueue();
  }

  function flushSaveQueue() {
    if (saving) return savePending;
    if (!saveQueue) return Promise.resolve({ ok: true });
    var patch = saveQueue;
    saveQueue = null;
    saving = true;
    setSaveStatus("saving");
    savePending = Promise.resolve().then(function () {
      return API.updateSettings(patch);
    }).catch(function (error) {
      return { ok: false, error: error.message || "未知错误" };
    }).then(function (result) {
      var refreshed = Promise.resolve();
      if (!result.ok) {
        setSaveStatus("error", "保存失败");
        toast("保存失败：" + (result.error || "未知错误"), "error");
        refreshed = refreshState();
      } else {
        if (!saveQueue) {
          setSaveStatus("saved");
        }
        applyState(result.state);
      }
      return refreshed.catch(function () {
        // A failed refresh must not leave the save queue locked.
      }).then(function () {
        saving = false;
        return flushSaveQueue();
      }).then(function (nextResult) {
        return result.ok ? nextResult : result;
      });
    });
    return savePending;
  }

  /* Optimistic update + save. `patch` is a settings fragment. */
  function save(patch) {
    optimisticApply(patch);
    renderAll();
    enqueuePatch(patch);
  }

  /* Text inputs: 500ms debounce, flush on blur / Enter / window blur. */
  function bindTextField(input, buildPatch) {
    if (!input) {
      return;
    }
    textFields.push({ input: input, buildPatch: buildPatch });
    input.addEventListener("input", function () {
      if (textTimers[input.id]) {
        window.clearTimeout(textTimers[input.id]);
      }
      textTimers[input.id] = window.setTimeout(function () {
        textTimers[input.id] = null;
        save(buildPatch());
      }, 500);
    });
    input.addEventListener("blur", function () {
      flushTextField(input, buildPatch);
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        flushTextField(input, buildPatch);
        input.blur();
      }
    });
  }

  function flushTextField(input, buildPatch) {
    if (!textTimers[input.id]) {
      return;
    }
    window.clearTimeout(textTimers[input.id]);
    textTimers[input.id] = null;
    save(buildPatch());
  }

  function flushAllTextFields() {
    textFields.forEach(function (field) {
      if (textTimers[field.input.id]) {
        window.clearTimeout(textTimers[field.input.id]);
        textTimers[field.input.id] = null;
        save(field.buildPatch());
      }
    });
    Object.keys(promptDrafts).forEach(function (id) {
      flushPromptDraft(id);
    });
  }

  /* ---- State loading --------------------------------------------------- */

  function refreshState() {
    return API.getState().then(function (result) {
      if (result.ok) {
        applyState(result.state);
      }
      return result;
    });
  }

  function applyState(payload) {
    if (!payload || !payload.settings) {
      return;
    }
    initialStateSettled = true;
    state = payload;
    renderAll();
  }

  /* ---- Rendering ------------------------------------------------------- */

  function renderAll() {
    if (!state) {
      return;
    }
    renderMode();
    renderProviderBadge();
    renderOnline();
    renderLocal();
    renderPicker();
    renderApp();
    renderAbout();
  }

  function setSegmentSelected(button, selected) {
    if (!button) {
      return;
    }
    button.setAttribute("aria-selected", selected ? "true" : "false");
  }

  function renderMode() {
    var mode = state.settings.provider.mode === "local" ? "local" : "online";
    setSegmentSelected(byId("mode-online"), mode === "online");
    setSegmentSelected(byId("mode-local"), mode === "local");
    setHidden(byId("provider-online"), mode !== "online");
    setHidden(byId("provider-local"), mode !== "local");
  }

  function renderProviderBadge() {
    var engine = state.engine || {};
    var badge = byId("provider-badge");
    var tone = "muted";
    var text = "未配置";
    if (engine.mode === "local") {
      if (engine.localState === "ready") {
        tone = "ok";
        text = "本地模型 · 运行中";
      } else if (engine.localState === "starting") {
        tone = "warn";
        text = "本地模型 · 启动中";
      } else if (engine.localState === "error") {
        tone = "error";
        text = "本地模型 · 异常";
      } else if (engine.engineAvailable) {
        tone = "muted";
        text = "本地模型 · 未启动";
      } else {
        tone = "warn";
        text = "本地模型 · 缺少引擎";
      }
    } else if (engine.ready) {
      tone = "ok";
      text = "在线 API · 就绪";
    } else if (engine.onlineConfigured) {
      tone = "warn";
      text = "在线 API · 待验证";
    } else {
      tone = "warn";
      text = "在线 API · 未配置";
    }
    if (badge) {
      badge.textContent = text;
      setTone(badge, tone);
    }
  }

  function renderOnline() {
    var online = state.settings.provider.online || {};
    var preset = LP.presetFor(online.preset);
    var presetSelect = byId("online-preset");
    if (presetSelect) {
      setSelectValue(presetSelect, preset ? preset.id : "custom");
    }
    var hint = byId("online-preset-hint");
    if (hint) {
      hint.textContent = preset && preset.hint ? preset.hint : "任意 OpenAI 兼容服务地址";
    }
    setInputValue(byId("online-base-url"), online.baseUrl || "");
    setInputValue(byId("online-api-key"), online.apiKey || "");
    renderOnlineModelOptions(online);
  }

  /* ---- Online model list ---------------------------------------------- */

  function onlineModelCacheKey(baseUrl, apiKey) {
    return String(baseUrl || "") + "\u0000" + String(apiKey || "");
  }

  function cachedOnlineModels(online) {
    return onlineModelCache[onlineModelCacheKey(online.baseUrl, online.apiKey)] || [];
  }

  function cacheOnlineModels(online, models) {
    var seen = {};
    var cleaned = [];
    (models || []).forEach(function (model) {
      var text = typeof model === "string" ? model.trim() : "";
      if (text && !seen[text]) {
        seen[text] = true;
        cleaned.push(text);
      }
    });
    onlineModelCache[onlineModelCacheKey(online.baseUrl, online.apiKey)] = cleaned;
    return cleaned;
  }

  /* Currently selected model: plain option value or the custom input. */
  function getSelectedModel() {
    var select = byId("online-model");
    var value = select ? String(select.value || "") : "";
    if (value === CUSTOM_MODEL_VALUE) {
      var custom = byId("online-model-custom");
      return custom ? String(custom.value || "").trim() : "";
    }
    return value;
  }

  function onlineModelOptions(online) {
    var models = cachedOnlineModels(online);
    var saved = String(online.model || "");
    var seen = {};
    var options = [];
    if (!saved && !customModelMode) {
      options.push({ value: "", label: "（未选择模型）" });
    }
    models.forEach(function (model) {
      seen[model] = true;
      options.push({ value: model, label: model });
    });
    if (!customModelMode && saved && !seen[saved]) {
      options.push({ value: saved, label: saved + "（当前）" });
    }
    options.push({ value: CUSTOM_MODEL_VALUE, label: "自定义模型…" });
    return options;
  }

  function renderOnlineModelOptions(online) {
    var select = byId("online-model");
    if (!select) {
      return;
    }
    var options = onlineModelOptions(online);
    var signature = options
      .map(function (option) {
        return option.value + "\u0002" + option.label;
      })
      .join("\u0001");
    var desired = customModelMode ? CUSTOM_MODEL_VALUE : String(online.model || "");
    if (select.getAttribute("data-signature") !== signature) {
      select.setAttribute("data-signature", signature);
      fillSelect(select, options);
      select.value = desired;
    } else {
      setSelectValue(select, desired);
    }
    var custom = byId("online-model-custom");
    if (custom) {
      setHidden(custom, !customModelMode);
      if (customModelMode) {
        setInputValue(custom, online.model || "");
      }
    }
    renderOnlineModelFeedback();
  }

  function renderOnlineModelFeedback() {
    var hint = byId("online-model-hint");
    var error = byId("online-model-error");
    if (hint) {
      hint.textContent = onlineModelHint;
      hint.hidden = !onlineModelHint;
    }
    if (error) {
      error.textContent = onlineModelError;
      error.hidden = !onlineModelError;
    }
  }

  function showOnlineModelError(message) {
    onlineModelHint = "";
    onlineModelError = String(message || "");
    renderOnlineModelFeedback();
  }

  function chooseCustomModel() {
    var online = state.settings.provider.online || {};
    var custom = byId("online-model-custom");
    customModelMode = true;
    onlineModelError = "";
    if (custom) {
      custom.value = String(online.model || "");
      setHidden(custom, false);
      custom.focus();
      custom.select();
    }
    renderOnlineModelOptions(online);
  }

  function selectOnlineModel(value) {
    if (value === CUSTOM_MODEL_VALUE) {
      chooseCustomModel();
      return;
    }
    customModelMode = false;
    onlineModelError = "";
    renderOnline();
    save(onlinePatch({ model: value }));
  }

  function fetchOnlineModels() {
    if (fetchModelsBusy) {
      return;
    }
    var button = byId("fetch-online-models");
    var baseUrl = byId("online-base-url").value.trim();
    var apiKey = byId("online-api-key").value;
    if (!baseUrl) {
      showOnlineModelError("请先填写服务地址");
      return;
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      showOnlineModelError("服务地址必须以 http:// 或 https:// 开头");
      return;
    }
    fetchModelsBusy = true;
    onlineModelHint = "";
    onlineModelError = "";
    renderOnlineModelFeedback();
    if (button) {
      button.disabled = true;
      button.textContent = "拉取中…";
    }
    API.listOnlineModels({ baseUrl: baseUrl, apiKey: apiKey }).then(function (result) {
      fetchModelsBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent = "拉取模型";
      }
      var online = (state && state.settings.provider.online) || {};
      if (result && result.ok) {
        var models = cacheOnlineModels(online, result.models);
        onlineModelError = "";
        if (models.length) {
          onlineModelHint = "已加载 " + models.length + " 个模型";
        } else {
          onlineModelHint = "服务端未返回模型，可选「自定义模型…」";
        }
      } else {
        onlineModelError = (result && result.error) || "拉取模型失败";
        onlineModelHint =
          (result && result.hint) || "可改用「自定义模型…」手动填写模型名";
      }
      renderOnlineModelOptions(online);
    });
  }

  function isQwen35(id) {
    return /^qwen3\.5-(?:0\.8b|2b|4b)-q[34]-k-m$/.test(String(id || ""));
  }

  function selectedLocalModel() {
    return state.settings.provider.local.selectedModel;
  }

  function recommendedModelId() {
    return (state.hardwareRecommendation || {}).recommendedModelId || "";
  }

  function modelRole(catalogId) {
    if (isQwen35(catalogId)) {
      return { label: "翻译 / 通用 / 视觉", builtin: true };
    }
    return { label: "其他本地模型", builtin: false };
  }

  function localModelRow(model) {
    var role = modelRole(model.catalogId);
    var entry = (state.catalog || []).filter(function (item) {
      return item.id === model.catalogId;
    })[0];
    var selectable = isQwen35(model.catalogId) && !!entry && entry.installed === true;
    var selected = selectable && selectedLocalModel() === model.catalogId;
    var row = el("div", "model-card" + (selected ? " is-selected" : ""));
    row.setAttribute("data-file", model.file || "");
    var main = el("div", "model-card-main");
    main.appendChild(el("span", "model-card-name", model.name || model.file || "未命名模型"));
    var meta = el("div", "model-card-meta");
    meta.appendChild(el("span", "meta-pill" + (role.builtin ? " is-accent" : ""), role.label));
    meta.appendChild(el("span", "meta-pill", LP.formatBytes(model.sizeBytes)));
    if (model.catalogId === recommendedModelId()) {
      meta.appendChild(el("span", "meta-pill is-accent", "推荐"));
    }
    main.appendChild(meta);
    row.appendChild(main);
    if (isQwen35(model.catalogId)) {
      var button = el("button", "btn" + (selected ? " btn-primary" : ""),
        selected ? "已选择" : selectable ? "选择" : "请补全下载");
      button.type = "button";
      button.disabled = !selectable;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.setAttribute("aria-label", (selected ? "当前模型：" : "选择模型：") + (model.name || model.file));
      button.addEventListener("click", function () {
        if (selectedLocalModel() === model.catalogId) {
          return;
        }
        var engine = state.engine || {};
        var running = engine.localState === "ready" || engine.localState === "starting" || engine.localState === "running";
        save({ provider: { local: { selectedModel: model.catalogId } } });
        if (running) {
          toast("已切换模型，正在重启本地引擎…", "info");
        }
      });
      row.appendChild(button);
    }
    if (model.catalogId === "") {
      var deleteButton = el("button", "btn btn-danger", "删除");
      deleteButton.type = "button";
      deleteButton.disabled = !!removingModels[model.file];
      deleteButton.setAttribute("aria-label", "删除模型：" + (model.name || model.file));
      deleteButton.addEventListener("click", function () {
        if (removingModels[model.file]) return;
        armDanger(deleteButton, "确认删除", function () {
          removingModels[model.file] = true;
          deleteButton.disabled = true;
          hideInlineError(byId("local-error"));
          API.removeModel(model.file).then(function (result) {
            return refreshState().then(function () {
              if (result.ok) toast("模型已删除", "success");
              else showInlineError(byId("local-error"), result.error || "删除模型失败", result.hint || "");
            });
          }).catch(function (error) {
            showInlineError(byId("local-error"), error.message || "删除模型失败");
          }).finally(function () {
            delete removingModels[model.file];
            var list = byId("local-models");
            if (list) Array.prototype.forEach.call(list.children, function (item) {
              if (item.getAttribute("data-file") === model.file) {
                var button = item.querySelector(".btn-danger");
                if (button) button.disabled = false;
              }
            });
          });
        });
      });
      row.appendChild(deleteButton);
    }
    return row;
  }

  function renderHardwareRecommendation() {
    var hardware = state.hardwareRecommendation || {};
    var summary = byId("local-hardware-summary");
    if (summary) {
      var parts = [];
      if (hardware.totalMemoryBytes) {
        parts.push("内存 " + LP.formatBytes(hardware.totalMemoryBytes));
      }
      if (hardware.cpuThreads) {
        parts.push("CPU " + hardware.cpuThreads + " 线程");
      }
      if (hardware.gpuName) {
        parts.push(String(hardware.gpuName));
      }
      if (hardware.gpuVramBytes) {
        parts.push("显存 " + LP.formatBytes(hardware.gpuVramBytes));
      }
      summary.textContent = parts.length ? parts.join(" · ") : "暂未获取硬件信息";
    }
    var reason = byId("local-hardware-reason");
    if (reason) {
      reason.textContent = hardware.reason ? "推荐参考：" + hardware.reason : "硬件推荐仅供参考，请手动选择模型。";
    }
  }

  /* ---- Downloads (concurrent: engine + several models) ----------------- */

  function currentDownloads() {
    var result = [];
    if (state && Array.isArray(state.downloads)) {
      state.downloads.forEach(function (item) {
        if (item && typeof item === "object") {
          result.push(item);
        }
      });
    }
    /* Legacy single-task payload fallback for older backends. */
    if (!result.length && state && state.download) {
      result.push(state.download);
    }
    return result;
  }

  function isActiveDownload(progress) {
    return (
      !!progress &&
      (progress.status === "downloading" || progress.status === "verifying")
    );
  }

  /* Find the active task for `kind` ("engine"/"model") and optional id. */
  function activeDownload(kind, id) {
    var downloads = currentDownloads();
    for (var index = 0; index < downloads.length; index += 1) {
      var item = downloads[index];
      if (!item || item.kind !== kind || !isActiveDownload(item)) {
        continue;
      }
      if (id !== undefined && String(item.id || "") !== String(id)) {
        continue;
      }
      return item;
    }
    return null;
  }

  function activeModelDownloadIds() {
    var ids = [];
    currentDownloads().forEach(function (item) {
      if (item && item.kind === "model" && isActiveDownload(item)) {
        ids.push(String(item.id || ""));
      }
    });
    return ids;
  }

  function mergeProgressIntoDownloads(progress) {
    if (!state) {
      return;
    }
    var kind = String(progress.kind || "model");
    var key = kind + ":" + String(progress.id || "");
    var downloads = Array.isArray(state.downloads) ? state.downloads.slice() : [];
    var next = [];
    var replaced = false;
    downloads.forEach(function (item) {
      if (!item) {
        return;
      }
      var itemKey =
        String(item.kind || "model") + ":" + String(item.id || "");
      if (itemKey !== key) {
        next.push(item);
        return;
      }
      replaced = true;
      if (isActiveDownload(progress)) {
        next.push(progress);
      }
    });
    if (!replaced && isActiveDownload(progress)) {
      next.push(progress);
    }
    state.downloads = next;
    state.download = null;
  }

  function renderLocal() {
    var engine = state.engine || {};
    var engineDownload = activeDownload("engine");
    var engineAvailable = engine.engineAvailable === true;

    var dot = byId("engine-dot");
    var title = byId("engine-title");
    var sub = byId("engine-sub");
    setTone(dot, engineAvailable ? "ok" : "warn");
    if (engineDownload) {
      title.textContent = "正在下载 llama.cpp 引擎…";
      sub.textContent = engineDownload.filename || "";
    } else if (engineAvailable) {
      title.textContent = "llama.cpp 引擎已安装";
      sub.textContent = "无需安装 Python，可直接运行本地 GGUF 模型";
    } else {
      title.textContent = "未安装 llama.cpp 引擎";
      sub.textContent = "本地翻译需要先下载引擎（约 23 MB，解压到数据目录）";
    }
    setHidden(byId("download-engine"), engineAvailable || !!engineDownload);
    setHidden(byId("cancel-engine-download"), !engineDownload);

    renderEngineProgress(engineDownload);

    renderHardwareRecommendation();
    var models = Array.isArray(state.models) ? state.models : [];
    var list = byId("local-models");
    if (list) {
      var signature = models
        .map(function (model) {
          return [
            model.file,
            model.name,
            model.catalogId,
            model.sizeBytes,
          ].join("\u0001");
        })
        .join("\u0002") + "#" + selectedLocalModel() + "#" + recommendedModelId() + "#" +
        (state.catalog || []).map(function (entry) { return entry.id + ":" + entry.installed; }).join("|");
      if (list.getAttribute("data-signature") !== signature) {
        list.setAttribute("data-signature", signature);
        list.innerHTML = "";
        models.forEach(function (model) {
          list.appendChild(localModelRow(model));
        });
      }
    }

    var modelHint = byId("local-models-hint");
    if (modelHint) {
      var selected = selectedLocalModel();
      var installedSelection = (state.catalog || []).some(function (entry) {
        return entry.id === selected && isQwen35(entry.id) && entry.installed === true;
      });
      modelHint.hidden = false;
      modelHint.textContent = installedSelection
        ? "所有本地 AI 任务共用手动选择的 Qwen3.5，包括翻译、通用文本与截图理解。切换模型后，运行中的引擎会自动重启。"
        : "请先下载完整的 Qwen3.5 模型（含视觉投影器），再手动选择翻译 / 通用 / 视觉模型。未选择时所有本地 AI 任务不可用。";
    }

    renderCatalog();
    renderLocalState();
  }

  function renderEngineProgress(progress) {
    var wrap = byId("engine-progress");
    var fill = byId("engine-progress-fill");
    var text = byId("engine-progress-text");
    if (!wrap || !fill || !text) {
      return;
    }
    if (!progress) {
      wrap.hidden = true;
      fill.style.width = "0%";
      text.textContent = "";
      return;
    }
    wrap.hidden = false;
    var percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    fill.style.width = percent + "%";
    if (progress.status === "verifying") {
      text.textContent = "校验中…";
    } else {
      text.textContent =
        LP.formatBytes(progress.received) +
        " / " +
        LP.formatBytes(progress.total) +
        " · " +
        Math.round(percent) +
        "%";
    }
  }

  function renderLocalState(preserveError) {
    var engine = state.engine || {};
    var localState = engine.localState || "stopped";
    var localSettings =
      (state.settings && state.settings.provider && state.settings.provider.local) || {};
    var badge = byId("local-state-badge");
    var startButton = byId("start-local");
    var stopButton = byId("stop-local");
    var restartButton = byId("restart-local");

    var tone = "muted";
    var label = "未启动";
    if (localState === "starting") {
      tone = "warn";
      label = "启动中…";
    } else if (localState === "ready" || localState === "running") {
      tone = "ok";
      label = "运行中";
    } else if (localState === "error") {
      tone = "error";
      label = "启动失败";
    }
    if (badge) {
      badge.textContent = label;
      setTone(badge, tone);
    }

    var running = localState === "ready" || localState === "starting" || localState === "running";
    setHidden(startButton, running || localAction === "restart");
    setHidden(restartButton, !running && localAction !== "restart");
    if (restartButton) {
      restartButton.disabled = localBusy || localState === "starting";
      restartButton.textContent = localAction === "restart" ? "重启中…" : "重启";
    }
    setHidden(stopButton, !running);
    if (startButton) {
      startButton.disabled = localBusy;
      startButton.textContent = localState === "starting" ? "启动中…" : "启动";
    }
    if (stopButton) {
      stopButton.disabled = localBusy;
    }

    var hintNode = byId("local-state-hint");
    if (hintNode) {
      if (localState === "ready" || localState === "running") {
        hintNode.textContent = "模型已加载；切换模型后会自动重启本地引擎。";
      } else if (localState === "starting") {
        hintNode.textContent = "正在加载模型…";
      } else if (localSettings.keepRunning === true) {
        hintNode.textContent =
          "已因空闲自动停止以释放内存；下次请求或点「启动」会重新加载。";
      } else {
        hintNode.textContent =
          "本地模型未启动时翻译/总结不会自动启动，请点击「启动」";
      }
      hintNode.hidden = false;
    }


    var errorNode = byId("local-error");
    if (errorNode && !preserveError) {
      if (engine.localError) {
        showInlineError(errorNode, engine.localError);
      } else {
        hideInlineError(errorNode);
      }
    }
  }

  /* Idle auto-stop is fixed at 10 minutes in the backend; there is no setting. */

  function catalogRow(entry) {
    var row = el("li", "catalog-item");
    row.setAttribute("data-catalog-id", entry.id);
    row.setAttribute("data-installed", entry.installed ? "1" : "0");

    var main = el("div", "catalog-main");
    var name = el("div", "catalog-name");
    name.appendChild(el("span", null, entry.name || entry.id));
    if (entry.vision === true) {
      name.appendChild(el("span", "badge-vision", "翻译 / 通用 / 视觉"));
    }
    if (entry.id === recommendedModelId()) {
      name.appendChild(el("span", "meta-pill is-accent", "推荐"));
    }
    main.appendChild(name);
    if (entry.description) {
      main.appendChild(el("div", "catalog-desc", entry.description));
    }
    var meta = el("div", "catalog-meta");
    var quant = LP.quantLabel(entry.filename);
    meta.appendChild(el("span", "meta-pill", LP.formatBytes(entry.sizeBytes)));
    if (quant) {
      meta.appendChild(el("span", "meta-pill", quant));
    }
    if (entry.license) {
      meta.appendChild(el("span", "meta-pill", entry.license));
    }
    if (entry.languages) {
      meta.appendChild(el("span", "meta-pill", entry.languages));
    }
    main.appendChild(meta);
    row.appendChild(main);

    var action = el("div", "catalog-action");

    var progress = el("div", "catalog-progress");
    progress.hidden = true;
    var track = el("div", "progress-track");
    var fill = el("div", "progress-fill");
    track.appendChild(fill);
    var progressText = el("span", "catalog-progress-text", "");
    progress.appendChild(track);
    progress.appendChild(progressText);
    action.appendChild(progress);

    var downloadButton = el("button", "btn", "下载");
    downloadButton.type = "button";
    downloadButton.setAttribute("data-catalog-download", entry.id);
    downloadButton.hidden = !!entry.installed;
    action.appendChild(downloadButton);

    var cancelButton = el("button", "btn btn-ghost", "取消");
    cancelButton.type = "button";
    cancelButton.setAttribute("data-catalog-cancel", entry.id);
    cancelButton.hidden = true;
    action.appendChild(cancelButton);

    var installedBadge = el("span", "badge", "已安装");
    installedBadge.setAttribute("data-tone", "ok");
    installedBadge.setAttribute("data-catalog-installed", entry.id);
    installedBadge.hidden = !entry.installed;
    action.appendChild(installedBadge);

    row.appendChild(action);
    return row;
  }

  function renderCatalog() {
    var section = byId("catalog");
    var list = byId("catalog-list");
    var toggle = byId("toggle-catalog");
    if (!section || !list || !toggle) {
      return;
    }
    section.hidden = !catalogOpen;
    toggle.setAttribute("aria-expanded", catalogOpen ? "true" : "false");
    toggle.textContent = catalogOpen ? "收起目录" : "下载模型";
    if (!catalogOpen) {
      return;
    }
    var catalog = state.catalog || [];
    var activeIds = activeModelDownloadIds();
    var signature =
      catalog
        .map(function (entry) {
          return entry.id + ":" + (entry.installed ? 1 : 0);
        })
        .join("|") +
      "#" +
      activeIds.join(",") + "#" + recommendedModelId();
    if (signature !== list.getAttribute("data-signature")) {
      list.setAttribute("data-signature", signature);
      list.innerHTML = "";
      catalog.forEach(function (entry) {
        list.appendChild(catalogRow(entry));
      });
    }
    updateCatalogProgress();
  }

  /* Progress text for one catalog row. Qwen3.5 downloads fetch the main GGUF
   * first and then the mmproj projector; the stage label makes that switch
   * visible instead of showing a percentage that appears to restart (§10.6). */
  function catalogProgressText(progress) {
    if (!progress) {
      return "";
    }
    if (progress.status === "verifying") {
      return "校验中…";
    }
    var percent = Math.round(Math.max(0, Math.min(100, Number(progress.percent) || 0)));
    if (/^mmproj-/i.test(String(progress.filename || ""))) {
      return "视觉投影器 · " + percent + "%";
    }
    return percent + "%";
  }

  function updateCatalogProgress() {
    each(byId("catalog-list").querySelectorAll(".catalog-item"), function (row) {
      var id = row.getAttribute("data-catalog-id");
      var installed = row.getAttribute("data-installed") === "1";
      var progress = activeDownload("model", id);
      var progressWrap = row.querySelector(".catalog-progress");
      var fill = row.querySelector(".catalog-progress .progress-fill");
      var text = row.querySelector(".catalog-progress-text");
      var downloadButton = row.querySelector("[data-catalog-download]");
      var cancelButton = row.querySelector("[data-catalog-cancel]");
      var installedBadge = row.querySelector("[data-catalog-installed]");
      if (progress) {
        var percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
        if (progressWrap) {
          progressWrap.hidden = false;
        }
        if (fill) {
          fill.style.width = percent + "%";
        }
        if (text) {
          text.textContent = catalogProgressText(progress);
          text.title = String(progress.filename || "");
        }
        if (downloadButton) {
          downloadButton.hidden = true;
        }
        if (cancelButton) {
          cancelButton.hidden = progress.status !== "downloading";
        }
        if (installedBadge) {
          installedBadge.hidden = true;
        }
      } else {
        if (progressWrap) {
          progressWrap.hidden = true;
        }
        if (fill) {
          fill.style.width = "0%";
        }
        if (downloadButton) {
          downloadButton.hidden = installed;
        }
        if (cancelButton) {
          cancelButton.hidden = true;
        }
        if (installedBadge) {
          installedBadge.hidden = !installed;
        }
      }
    });
  }

  function renderPicker() {
    var picker = state.settings.picker || {};
    setChecked(byId("picker-enabled"), picker.enabled !== false);
    setChecked(byId("picker-compact"), picker.compact === true);
    renderPanelMode();
    renderHotkey();
    setSelectValue(byId("default-target-lang"), picker.defaultTargetLang || "auto");
    renderSkills();
    renderCustomSkillEditor(false);
    renderBlacklist();
  }

  /* Panel layout mode for the picker result panel: "auto" grows the window to
   * fit the content, "scroll" keeps a fixed height with an inner scrollbar. */
  function panelModeValue() {
    var picker = (state && state.settings && state.settings.picker) || {};
    return picker.panelMode === "scroll" ? "scroll" : "auto";
  }

  function renderPanelMode() {
    var current = panelModeValue();
    each(document.querySelectorAll("[data-panel-mode]"), function (button) {
      var selected = button.getAttribute("data-panel-mode") === current;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function selectPanelMode(mode) {
    var next = mode === "scroll" ? "scroll" : "auto";
    if (next === panelModeValue()) {
      return;
    }
    /* Patch only this field; save() re-renders optimistically and the generic
     * save-error handler refreshes state, which rolls the selection back. */
    save({ picker: { panelMode: next } });
  }

  /* ---- Screenshot shortcut recorder (contract §10.4) -------------------- */

  /* Fixed modifier order Win → Ctrl → Alt → Shift mirrors
   * `settings::normalize_shortcut`; the main-key list matches the contract. */
  var HOTKEY_NAMED_KEYS = {
    " ": "Space",
    space: "Space",
    spacebar: "Space",
    tab: "Tab",
    enter: "Enter",
    return: "Enter",
    backspace: "Backspace",
    insert: "Insert",
    ins: "Insert",
    delete: "Delete",
    del: "Delete",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pgup: "PageUp",
    pagedown: "PageDown",
    pgdn: "PageDown",
    up: "Up",
    arrowup: "Up",
    down: "Down",
    arrowdown: "Down",
    left: "Left",
    arrowleft: "Left",
    right: "Right",
    arrowright: "Right",
    printscreen: "PrintScreen",
    print: "PrintScreen",
    prtsc: "PrintScreen",
  };

  /* Bare modifier keys never finish a recording; they are swallowed too. */
  var HOTKEY_MODIFIER_KEYS = {
    Control: true,
    Shift: true,
    Alt: true,
    Meta: true,
    OS: true,
    AltGraph: true,
  };

  function captureShortcut() {
    var capture = (state && state.settings && state.settings.capture) || {};
    return String(capture.regionShortcut || "").trim() || "Win+Shift+X";
  }

  /* "Ctrl+Alt+P" → "Ctrl + Alt + P" for display only. */
  function formatShortcut(shortcut) {
    return String(shortcut || "")
      .split("+")
      .map(function (token) {
        return token.trim();
      })
      .filter(function (token) {
        return !!token;
      })
      .join(" + ");
  }

  /* Main key from a KeyboardEvent; "" when the key is not allowed. */
  function hotkeyKeyFromEvent(event) {
    if (!event) {
      return "";
    }
    var key = String(event.key || "");
    if (/^[a-zA-Z]$/.test(key)) {
      return key.toUpperCase();
    }
    if (/^[0-9]$/.test(key)) {
      return key;
    }
    var fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(key);
    if (fn) {
      return "F" + fn[1];
    }
    var named = HOTKEY_NAMED_KEYS[key.toLowerCase()];
    if (named) {
      return named;
    }
    /* Synthetic/IME events can carry an empty key: fall back to a physical code. */
    var code = String(event.code || "");
    if (/^Key[A-Z]$/.test(code)) {
      return code.slice(3);
    }
    if (/^Digit[0-9]$/.test(code)) {
      return code.slice(5);
    }
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
      return code;
    }
    return "";
  }

  function hotkeyComboFromEvent(event) {
    var modifiers = [];
    if (event.metaKey) {
      modifiers.push("Win");
    }
    if (event.ctrlKey) {
      modifiers.push("Ctrl");
    }
    if (event.altKey) {
      modifiers.push("Alt");
    }
    if (event.shiftKey) {
      modifiers.push("Shift");
    }
    var key = hotkeyKeyFromEvent(event);
    if (!key || !modifiers.length) {
      return "";
    }
    return modifiers.concat(key).join("+");
  }

  function renderHotkey() {
    var button = byId("capture-hotkey");
    var restore = byId("capture-hotkey-restore");
    if (!button) {
      return;
    }
    button.classList.toggle("is-recording", hotkeyRecording);
    button.disabled = hotkeySaving;
    if (hotkeyRecording) {
      button.textContent = "请按下新的快捷键…（Esc 取消）";
      button.title = "按下组合键后立即保存，Esc 取消";
      button.setAttribute("aria-label", "正在录制截图快捷键，按 Esc 取消");
    } else if (hotkeySaving) {
      button.textContent = "保存中…";
      button.title = "";
      button.setAttribute("aria-label", "正在保存截图快捷键");
    } else {
      var text = formatShortcut(captureShortcut());
      button.textContent = text;
      button.title = "点击后录制新的组合键";
      button.setAttribute("aria-label", "截图快捷键：" + text + "，点击录制新的组合键");
    }
    if (restore) {
      restore.disabled = hotkeyRecording || hotkeySaving;
    }
  }

  function startHotkeyRecording() {
    if (hotkeyRecording || hotkeySaving) {
      return;
    }
    hotkeyRecording = true;
    hideInlineError(byId("capture-hotkey-error"));
    renderHotkey();
  }

  function cancelHotkeyRecording() {
    if (!hotkeyRecording) {
      return;
    }
    hotkeyRecording = false;
    hideInlineError(byId("capture-hotkey-error"));
    renderHotkey();
  }

  function submitHotkey(combo) {
    if (hotkeySaving) {
      return;
    }
    var previous = captureShortcut();
    hotkeyRecording = false;
    hotkeySaving = true;
    hideInlineError(byId("capture-hotkey-error"));
    renderHotkey();
    API.setCaptureHotkey(combo).then(function (result) {
      hotkeySaving = false;
      if (result && result.ok) {
        var saved = String(result.shortcut || combo).trim() || combo;
        /* The backend broadcasts `state-changed` as well, but applying the
         * returned value here keeps the display deterministic. */
        if (state && state.settings) {
          state.settings.capture = LP.deepMerge(state.settings.capture || {}, {
            regionShortcut: saved,
          });
        }
        hideInlineError(byId("capture-hotkey-error"));
        toast("已保存", "success");
      } else {
        /* Keep the saved settings untouched and restore the old display. */
        if (state && state.settings) {
          state.settings.capture = LP.deepMerge(state.settings.capture || {}, {
            regionShortcut: previous,
          });
        }
        showInlineError(
          byId("capture-hotkey-error"),
          (result && result.error) || "保存快捷键失败",
          (result && result.hint) || ""
        );
      }
      renderHotkey();
    });
  }

  /* Capture-phase listener on window: while recording, the combo must not reach
   * buttons, text fields or the other page shortcuts. */
  function handleHotkeyKeydown(event) {
    if (!hotkeyRecording || !event) {
      return;
    }
    if (event.isComposing) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) {
      return;
    }
    var key = String(event.key || "");
    if (key === "Escape" || key === "Esc") {
      cancelHotkeyRecording();
      return;
    }
    if (HOTKEY_MODIFIER_KEYS[key]) {
      /* Only modifiers so far: keep waiting. */
      return;
    }
    var combo = hotkeyComboFromEvent(event);
    if (!combo) {
      if (!hotkeyKeyFromEvent(event)) {
        showInlineError(
          byId("capture-hotkey-error"),
          "不支持这个主键。",
          "请使用字母、数字、F1–F24、PrintScreen、空格、Tab 或方向键等。"
        );
      } else {
        showInlineError(
          byId("capture-hotkey-error"),
          "需要至少一个修饰键。",
          "请按住 Ctrl / Alt / Shift / Win 中的至少一个，再按主键。"
        );
      }
      return;
    }
    submitHotkey(combo);
  }

  /* ---- Custom skills ----------------------------------------------------- */

  /* Custom skills are stored as {id,label,icon,prompt,kind}. Return copies so
   * a patch never mutates the state object in place. */
  function customSkillsList() {
    var picker = state && state.settings && state.settings.picker;
    var stored = picker && Array.isArray(picker.customSkills) ? picker.customSkills : [];
    var seen = {};
    var result = [];
    stored.forEach(function (entry) {
      if (!entry || !entry.id) {
        return;
      }
      var id = String(entry.id);
      if (seen[id]) {
        return;
      }
      seen[id] = true;
      result.push({
        id: id,
        label: String(entry.label || "").trim() || "自定义技能",
        icon: validCustomIcon(entry.icon),
        prompt: String(entry.prompt || ""),
        kind: customSkillKind(entry),
      });
    });
    return result;
  }

  function customSkillKind(skill) {
    return skill && skill.kind === "image" ? "image" : "text";
  }

  function findCustomSkill(id) {
    var skills = customSkillsList();
    for (var index = 0; index < skills.length; index += 1) {
      if (skills[index].id === id) {
        return skills[index];
      }
    }
    return null;
  }

  /* Map legacy 12-icon keys through the shared alias table, then verify the
   * key exists in the 200-icon gallery. Unknown keys fall back to sparkles. */
  function validCustomIcon(icon) {
    var key = String(icon || "");
    var aliases = LP.LEGACY_SKILL_ICON_ALIASES || {};
    if (Object.prototype.hasOwnProperty.call(aliases, key)) {
      key = String(aliases[key] || "");
    }
    var keys = LP.CUSTOM_SKILL_ICON_KEYS || [];
    if (!key || (keys.length && keys.indexOf(key) < 0)) {
      return LP.CUSTOM_SKILL_DEFAULT_ICON || "sparkles";
    }
    return key;
  }

  function builtinSkillIconKey(id) {
    var meta = LP.SKILL_MAP && LP.SKILL_MAP[id];
    return (meta && meta.icon) || id;
  }

  function currentSearchEngine() {
    var picker = state && state.settings && state.settings.picker;
    var value = String((picker && picker.searchEngine) || "");
    for (var index = 0; index < SEARCH_ENGINES.length; index += 1) {
      if (SEARCH_ENGINES[index].value === value) {
        return value;
      }
    }
    return LP.DEFAULT_SEARCH_ENGINE || "google";
  }

  function searchEnginePanel() {
    var panel = el("div", "skill-prompt search-engine-panel");
    panel.id = "search-engine-panel";
    var current = currentSearchEngine();
    var group = el("div", "search-engine-list");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "搜索引擎");
    SEARCH_ENGINES.forEach(function (engine) {
      var selected = engine.value === current;
      var button = el(
        "button",
        "search-engine-option" + (selected ? " is-selected" : "")
      );
      button.type = "button";
      button.setAttribute("data-search-engine", engine.value);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", selected ? "true" : "false");
      button.setAttribute("aria-label", "使用" + engine.label + "搜索");
      button.appendChild(el("span", "search-engine-name", engine.label));
      if (engine.url) {
        var host = String(engine.url)
          .replace(/^https?:\/\//, "")
          .split("/")[0];
        button.appendChild(el("span", "search-engine-url", host));
      }
      group.appendChild(button);
    });
    panel.appendChild(group);
    panel.appendChild(
      el(
        "p",
        "skill-prompt-hint",
        "搜索技能会在所选搜索引擎中打开选中的文本；选择后立即保存"
      )
    );
    return panel;
  }

  function toggleSearchPanel() {
    searchPanelOpen = !searchPanelOpen;
    renderSkills(true);
  }

  function selectSearchEngine(value) {
    var next = String(value || "");
    var valid = false;
    SEARCH_ENGINES.forEach(function (engine) {
      if (engine.value === next) {
        valid = true;
      }
    });
    if (!valid) {
      next = LP.DEFAULT_SEARCH_ENGINE || "google";
    }
    save({ picker: { searchEngine: next } });
  }

  function knownSkillIds() {
    return SKILL_IDS.concat(
      customSkillsList().map(function (skill) {
        return skill.id;
      })
    );
  }

  /* Enabled ids in saved toolbar order, ignoring stale/unknown entries. */
  function enabledSkills() {
    var picker = state && state.settings && state.settings.picker;
    var stored =
      picker && Array.isArray(picker.skills) ? picker.skills : DEFAULT_SKILLS;
    var known = knownSkillIds();
    var result = [];
    stored.forEach(function (value) {
      var id = String(value || "");
      if (id && known.indexOf(id) >= 0 && result.indexOf(id) < 0) {
        result.push(id);
      }
    });
    return result;
  }

  /* ---- Skill categories (文字技能 / 图片技能 tabs) ----------------------- */

  /* Built-in skills all live in the text-skill tab, including the screenshot
   * entry skill (fourth review round); the image tab lists the screenshot
   * toolbar actions instead. Custom skills follow their own kind; unknown ids
   * return "" so a stale saved id is never mistaken for either category. */
  function skillCategory(id, customMap) {
    var custom = customMap && customMap[id];
    if (custom) {
      return customSkillKind(custom) === "image" ? "image" : "text";
    }
    return SKILL_IDS.indexOf(id) >= 0 ? "text" : "";
  }

  function customSkillMap() {
    var map = {};
    customSkillsList().forEach(function (skill) {
      map[skill.id] = skill;
    });
    return map;
  }

  /* Raw saved toolbar order, including ids the UI filters out. Never mutate
   * the stored array: reordering builds a new one. */
  function storedSkillOrder() {
    var picker = state && state.settings && state.settings.picker;
    var stored =
      picker && Array.isArray(picker.skills) ? picker.skills : DEFAULT_SKILLS;
    return stored
      .map(function (value) {
        return String(value || "");
      })
      .filter(function (id) {
        return !!id;
      });
  }

  function enabledCategorySkills(category) {
    var customMap = customSkillMap();
    return enabledSkills().filter(function (id) {
      return skillCategory(id, customMap) === category;
    });
  }

  /* Reorder one category without moving the other: walk the saved global order
   * and replace that category's ids with the new category order; every other
   * id keeps its slot and relative position (contract §7.2). */
  function mergeCategoryOrder(globalOrder, category, categoryNext, customMap) {
    var queue = categoryNext.slice();
    var merged = [];
    globalOrder.forEach(function (id) {
      if (skillCategory(id, customMap) !== category) {
        merged.push(id);
        return;
      }
      if (queue.length) {
        merged.push(queue.shift());
      }
    });
    while (queue.length) {
      merged.push(queue.shift());
    }
    return merged;
  }

  function selectSkillTab(tab) {
    var next = tab === "image" ? "image" : "text";
    if (next === skillTab) {
      return;
    }
    skillTab = next;
    renderSkills(true);
  }

  function renderSkills(force) {
    var list = byId("skill-list");
    if (!list) {
      return;
    }
    /* The image-tab list lives outside #skill-list, so refresh it before the
     * text-list signature short-circuit. */
    renderCaptureSkills();
    var customs = customSkillsList();
    var customMap = {};
    customs.forEach(function (skill) {
      customMap[skill.id] = skill;
    });
    var enabled = enabledSkills();
    var order = enabled.slice();
    SKILL_IDS.forEach(function (id) {
      if (enabled.indexOf(id) < 0) {
        order.push(id);
      }
    });
    customs.forEach(function (skill) {
      if (enabled.indexOf(skill.id) < 0) {
        order.push(skill.id);
      }
    });
    /* The text tab lists text-category rows only: built-in skills (screenshot
     * included) and custom text skills. Custom image skills live in the
     * screenshot toolbar instead (sixth review round). */
    var textOrder = order.filter(function (id) {
      return skillCategory(id, customMap) === "text";
    });
    var signature = textOrder
      .map(function (id) {
        var custom = customMap[id];
        var detail = custom
          ? custom.label +
            "\u0003" +
            custom.icon +
            "\u0003" +
            custom.prompt +
            "\u0003" +
            custom.kind
          : id === "search"
            ? "search:" + currentSearchEngine()
            : "";
        return id + ":" + (enabled.indexOf(id) >= 0 ? 1 : 0) + ":" + detail;
      })
      .join("\u0001");
    /* Tab chrome, counters and section visibility also depend on the
     * screenshot-toolbar actions (not part of this signature), so refresh them
     * before the skill-list short-circuit. */
    renderSkillTabs(textOrder);
    if (
      !force &&
      skillTab === list.getAttribute("data-active-tab") &&
      signature === list.getAttribute("data-signature")
    ) {
      return;
    }
    list.setAttribute("data-active-tab", skillTab);
    list.setAttribute("data-signature", signature);
    list.innerHTML = "";
    textOrder.forEach(function (id) {
      list.appendChild(skillRow(id, enabled.indexOf(id) >= 0, customMap[id]));
    });
  }

  /* Tab chrome: selected state, counts and which list is visible. The text tab
   * shows #skill-list (text skills + screenshot entry); the image tab shows the
   * unified #capture-action-list built from picker.captureSkills. */
  function renderSkillTabs(textOrder) {
    var enabledCaptureCount = enabledCaptureSkills().length;
    var textTab = byId("skill-tab-text");
    if (textTab) {
      textTab.setAttribute(
        "aria-selected",
        skillTab === "text" ? "true" : "false"
      );
    }
    var imageTab = byId("skill-tab-image");
    if (imageTab) {
      imageTab.setAttribute(
        "aria-selected",
        skillTab === "image" ? "true" : "false"
      );
    }
    var textCount = byId("skill-tab-text-count");
    if (textCount) {
      textCount.textContent = "(" + textOrder.length + ")";
    }
    var imageCount = byId("skill-tab-image-count");
    if (imageCount) {
      imageCount.textContent = "(" + enabledCaptureCount + ")";
    }
    var imageTabActive = skillTab === "image";
    setHidden(byId("capture-action-list"), !imageTabActive);
    setHidden(byId("skill-list"), imageTabActive);
    setHidden(
      byId("capture-actions-empty"),
      !imageTabActive || enabledCaptureCount > 0
    );
  }

  /* ---- Screenshot toolbar skills (图片技能 Tab 统一列表) ----------------- */

  /* Custom image skills by id; a row with a `custom-` id renders as a custom
   * skill row instead of a built-in action row. */
  function captureSkillMap() {
    var map = {};
    customSkillsList().forEach(function (skill) {
      if (customSkillKind(skill) === "image") {
        map[skill.id] = skill;
      }
    });
    return map;
  }

  /* Enabled ids in saved toolbar order: built-in actions and custom image
   * skills, freely interleaved. A missing id means the row is hidden. */
  function enabledCaptureSkills() {
    var picker = state && state.settings && state.settings.picker;
    var stored =
      picker && Array.isArray(picker.captureSkills) ? picker.captureSkills : [];
    var customMap = captureSkillMap();
    var result = [];
    stored.forEach(function (value) {
      var id = String(value || "").toLowerCase();
      if (!id || result.indexOf(id) >= 0) {
        return;
      }
      if (CAPTURE_ACTION_META[id] || customMap[id]) {
        result.push(id);
      }
    });
    return result;
  }

  /* Enabled ids first, then hidden built-in actions in default order and hidden
   * custom image skills last, so every row stays reachable from the list. */
  function captureSkillOrder() {
    var order = enabledCaptureSkills();
    CAPTURE_ACTION_ORDER.forEach(function (id) {
      if (order.indexOf(id) < 0) {
        order.push(id);
      }
    });
    customSkillsList().forEach(function (skill) {
      if (customSkillKind(skill) === "image" && order.indexOf(skill.id) < 0) {
        order.push(skill.id);
      }
    });
    return order;
  }

  function toggleCaptureSkill(id, enabled) {
    var custom = CAPTURE_ACTION_META[id] ? null : findCustomSkill(id);
    if (
      !CAPTURE_ACTION_META[id] &&
      !(custom && customSkillKind(custom) === "image")
    ) {
      return;
    }
    var skills = enabledCaptureSkills();
    if (enabled) {
      if (skills.indexOf(id) < 0) {
        skills.push(id);
      }
    } else {
      skills = skills.filter(function (skillId) {
        return skillId !== id;
      });
    }
    /* An empty list is valid: the screenshot toolbar then only shows
     * confirm/cancel (the backend keeps [] as-is). */
    save({ picker: { captureSkills: skills } });
  }

  function renderCaptureSkills(force) {
    var list = byId("capture-action-list");
    if (!list) {
      return;
    }
    var customMap = captureSkillMap();
    var enabled = enabledCaptureSkills();
    var order = captureSkillOrder();
    var signature = order
      .map(function (id) {
        var custom = customMap[id];
        var detail = custom
          ? custom.label + "\u0003" + custom.icon + "\u0003" + custom.prompt
          : CAPTURE_ACTION_META[id]
            ? CAPTURE_ACTION_META[id].description
            : "";
        return id + ":" + (enabled.indexOf(id) >= 0 ? 1 : 0) + ":" + detail;
      })
      .join("\u0001");
    if (!force && signature === list.getAttribute("data-signature")) {
      return;
    }
    list.setAttribute("data-signature", signature);
    list.innerHTML = "";
    order.forEach(function (id) {
      if (CAPTURE_ACTION_META[id]) {
        list.appendChild(captureActionRow(id, enabled.indexOf(id) >= 0));
      } else if (customMap[id]) {
        list.appendChild(
          captureSkillRow(id, enabled.indexOf(id) >= 0, customMap[id])
        );
      }
    });
  }

  /* Row pieces shared by built-in and custom image-skill rows. */
  function skillDragHandle(enabled) {
    var drag = el("span", "skill-drag");
    drag.setAttribute("role", "img");
    drag.setAttribute("aria-label", enabled ? "拖动排序" : "启用后可拖动排序");
    drag.title = enabled ? "拖动排序" : "启用后可拖动排序";
    drag.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<circle cx="9" cy="6" r="1.5"></circle><circle cx="15" cy="6" r="1.5"></circle>' +
      '<circle cx="9" cy="12" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle>' +
      '<circle cx="9" cy="18" r="1.5"></circle><circle cx="15" cy="18" r="1.5"></circle>' +
      "</svg>";
    return drag;
  }

  function skillSwitchNode(attribute, id, enabled, label) {
    var toggle = el("label", "switch");
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.setAttribute(attribute, id);
    input.setAttribute("aria-label", "启用" + label);
    var track = el("span", "switch-track");
    var thumb = el("span", "switch-thumb");
    track.appendChild(thumb);
    toggle.appendChild(input);
    toggle.appendChild(track);
    return toggle;
  }

  function captureActionRow(id, enabled) {
    var meta = CAPTURE_ACTION_META[id];
    var row = el("li", "skill-item" + (enabled ? "" : " is-disabled"));
    row.setAttribute("data-capture-skill", id);

    var line = el("div", "skill-row");
    if (enabled) {
      line.setAttribute("draggable", "true");
    }
    line.appendChild(skillDragHandle(enabled));

    var icon = el("span", "skill-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = LP.skillIconSvg(meta.icon);
    line.appendChild(icon);

    var main = el("div", "skill-main");
    var nameRow = el("div", "skill-name-row");
    nameRow.appendChild(el("span", "skill-name", meta.label));
    main.appendChild(nameRow);
    main.appendChild(el("span", "skill-desc", meta.description));
    line.appendChild(main);

    if (isCapturePromptSkill(id)) {
      var editButton = el("button", "skill-edit");
      editButton.type = "button";
      editButton.setAttribute("data-capture-prompt-toggle", id);
      editButton.setAttribute("aria-label", "编辑提示词");
      editButton.setAttribute(
        "aria-expanded",
        capturePromptExpanded[id] ? "true" : "false"
      );
      editButton.title = "编辑提示词";
      editButton.innerHTML = SKILL_PENCIL_SVG;
      line.appendChild(editButton);
    }

    line.appendChild(
      skillSwitchNode("data-capture-toggle", id, enabled, meta.label)
    );
    row.appendChild(line);
    if (isCapturePromptSkill(id) && capturePromptExpanded[id]) {
      row.appendChild(capturePromptPanel(id, meta));
    }
    return row;
  }

  /* Custom image skill row: editable / deletable, same toggle and drag
   * behaviour as the built-in action rows. */
  function captureSkillRow(id, enabled, custom) {
    var row = el("li", "skill-item" + (enabled ? "" : " is-disabled"));
    row.setAttribute("data-capture-skill", id);

    var line = el("div", "skill-row");
    if (enabled) {
      line.setAttribute("draggable", "true");
    }
    line.appendChild(skillDragHandle(enabled));

    var icon = el("span", "skill-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = LP.skillIconSvg(custom.icon);
    line.appendChild(icon);

    var main = el("div", "skill-main");
    var nameRow = el("div", "skill-name-row");
    nameRow.appendChild(el("span", "skill-name", custom.label));
    var badge = el("span", "skill-kind-badge", "图片");
    badge.title = "图片技能：点击后进入截图";
    nameRow.appendChild(badge);
    main.appendChild(nameRow);
    var description = String(custom.prompt || "")
      .replace(/\s+/g, " ")
      .trim();
    if (description) {
      main.appendChild(el("span", "skill-desc", description));
    }
    line.appendChild(main);

    var customEdit = el("button", "skill-edit");
    customEdit.type = "button";
    customEdit.setAttribute("data-custom-edit", id);
    customEdit.setAttribute(
      "aria-expanded",
      customEditorOpen && customEditingId === id ? "true" : "false"
    );
    customEdit.setAttribute("aria-label", "编辑技能");
    customEdit.title = "编辑技能";
    customEdit.innerHTML = SKILL_PENCIL_SVG;
    line.appendChild(customEdit);

    var customDelete = el("button", "skill-delete");
    customDelete.type = "button";
    customDelete.setAttribute("data-custom-delete", id);
    customDelete.setAttribute("aria-label", "删除技能" + custom.label);
    customDelete.title = "删除技能";
    customDelete.innerHTML = SKILL_TRASH_SVG;
    line.appendChild(customDelete);

    line.appendChild(
      skillSwitchNode("data-capture-toggle", id, enabled, custom.label)
    );
    row.appendChild(line);
    return row;
  }

  /* ---- Screenshot-toolbar prompts (built-in translate / explain) -------- */

  function isCapturePromptSkill(id) {
    return CAPTURE_PROMPT_ACTIONS.indexOf(id) >= 0;
  }

  function capturePromptDefaultKey(id) {
    if (id === "translate") {
      return "captureTranslate";
    }
    if (id === "wordLookup") {
      return "captureWordLookup";
    }
    if (id === "explain") {
      return "captureExplain";
    }
    return "";
  }

  function capturePromptCustomValue(id) {
    var picker = state && state.settings && state.settings.picker;
    var prompts = (picker && picker.capturePrompts) || {};
    var value = prompts[id];
    return typeof value === "string" ? value : "";
  }

  function capturePromptDefault(id) {
    var defaults = (state && state.promptDefaults) || {};
    var key = capturePromptDefaultKey(id);
    var value = key ? defaults[key] : "";
    return typeof value === "string" ? value : "";
  }

  /* Textarea value: pending draft wins, then custom prompt, then the default. */
  function capturePromptEditorValue(id) {
    if (Object.prototype.hasOwnProperty.call(capturePromptDrafts, id)) {
      return capturePromptDrafts[id];
    }
    return capturePromptCustomValue(id) || capturePromptDefault(id);
  }

  function capturePromptBlock(id, label, hint) {
    var panel = el("div", "skill-prompt");
    panel.appendChild(el("p", "skill-prompt-label", label));
    var textarea = document.createElement("textarea");
    textarea.className = "textarea";
    textarea.rows = 5;
    textarea.spellcheck = false;
    textarea.setAttribute("data-capture-prompt-input", id);
    textarea.setAttribute("aria-label", label);
    textarea.value = capturePromptEditorValue(id);
    textarea.addEventListener("input", function () {
      capturePromptDrafts[id] = textarea.value;
      if (capturePromptTimers[id]) {
        window.clearTimeout(capturePromptTimers[id]);
      }
      capturePromptTimers[id] = window.setTimeout(function () {
        capturePromptTimers[id] = null;
        saveCapturePromptDraft(id);
      }, 500);
    });
    textarea.addEventListener("blur", function () {
      flushCapturePromptDraft(id);
    });
    textarea.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        textarea.blur();
      }
    });
    panel.appendChild(textarea);

    var foot = el("div", "skill-prompt-foot");
    foot.appendChild(el("p", "skill-prompt-hint", hint));
    var reset = el("button", "btn btn-ghost skill-prompt-reset", "重置为默认");
    reset.type = "button";
    reset.setAttribute("data-capture-prompt-reset", id);
    foot.appendChild(reset);
    panel.appendChild(foot);
    return panel;
  }

  /* The screenshot translate action owns two prompts, mirroring text
   * translation: ordinary translation plus the dictionary prompt used when
   * the OCR text is classified as a single word or short term. */
  function capturePromptPanel(id, meta) {
    if (id === "translate") {
      var group = el("div", "skill-prompt-group");
      group.appendChild(
        capturePromptBlock(
          "translate",
          "翻译提示词",
          "整句、段落等普通翻译使用；支持 {target} 占位符"
        )
      );
      group.appendChild(
        capturePromptBlock(
          "wordLookup",
          "单词查询提示词",
          "识别结果为单个单词或短语时使用；支持 {target}，可要求模型输出音标或拼音"
        )
      );
      return group;
    }
    return capturePromptBlock(
      id,
      meta.label + "提示词",
      "留空或重置后使用系统默认提示词"
    );
  }

  function saveCapturePromptDraft(id) {
    if (!Object.prototype.hasOwnProperty.call(capturePromptDrafts, id)) {
      return;
    }
    var value = capturePromptDrafts[id];
    delete capturePromptDrafts[id];
    saveCapturePromptValue(id, value);
  }

  function flushCapturePromptDraft(id) {
    if (capturePromptTimers[id]) {
      window.clearTimeout(capturePromptTimers[id]);
      capturePromptTimers[id] = null;
    }
    saveCapturePromptDraft(id);
  }

  function saveCapturePromptValue(id, rawValue) {
    var text = String(rawValue === null || rawValue === undefined ? "" : rawValue);
    var trimmed = text.trim();
    var stored = "";
    if (trimmed && trimmed !== capturePromptDefault(id).trim()) {
      stored = trimmed;
    }
    var patch = { picker: { capturePrompts: {} } };
    patch.picker.capturePrompts[id] = stored;
    save(patch);
  }

  function toggleCapturePromptPanel(id) {
    if (capturePromptExpanded[id]) {
      flushCapturePromptDraft(id);
      delete capturePromptExpanded[id];
    } else {
      capturePromptExpanded[id] = true;
    }
    renderCaptureSkills(true);
  }

  function resetCapturePromptValue(id) {
    flushCapturePromptDraft(id);
    saveCapturePromptValue(id, "");
    var textarea = document.querySelector(
      '[data-capture-prompt-input="' + id + '"]'
    );
    if (textarea) {
      textarea.value = capturePromptDefault(id);
    }
    toast("已重置为默认提示词", "success");
  }

  /* Click handler for the unified image-skill list: prompt editors plus custom
   * skill edit / delete. */
  function handleCaptureListClick(event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var promptToggle = target.closest("[data-capture-prompt-toggle]");
    if (promptToggle) {
      toggleCapturePromptPanel(
        promptToggle.getAttribute("data-capture-prompt-toggle")
      );
      return;
    }
    var promptReset = target.closest("[data-capture-prompt-reset]");
    if (promptReset) {
      resetCapturePromptValue(
        promptReset.getAttribute("data-capture-prompt-reset")
      );
      return;
    }
    var customEdit = target.closest("[data-custom-edit]");
    if (customEdit) {
      openCustomEditor(customEdit.getAttribute("data-custom-edit"));
      return;
    }
    var customDelete = target.closest("[data-custom-delete]");
    if (customDelete) {
      var deletedId = customDelete.getAttribute("data-custom-delete");
      armSkillDelete(customDelete, function () {
        deleteCustomSkill(deletedId);
      });
    }
  }

  /* Drag ordering for the screenshot-toolbar actions. Kept separate from the
   * picker-skill drag state so the two lists never mix. */
  function captureActionItemFromEvent(event) {
    var target = event.target;
    if (!target || !target.closest) {
      return null;
    }
    return target.closest(".skill-item[data-capture-skill]");
  }

  function clearCaptureDropMarks() {
    var list = byId("capture-action-list");
    if (!list) {
      return;
    }
    each(list.querySelectorAll(".drop-before, .drop-after"), function (node) {
      node.classList.remove("drop-before", "drop-after");
    });
  }

  function clearCaptureDragMarks() {
    var list = byId("capture-action-list");
    dragCaptureAction = "";
    if (!list) {
      return;
    }
    clearCaptureDropMarks();
    each(list.querySelectorAll(".is-dragging"), function (node) {
      node.classList.remove("is-dragging");
    });
  }

  function startCaptureActionDrag(event) {
    var row = captureActionItemFromEvent(event);
    var target = event.target;
    if (!row || row.classList.contains("is-disabled") || !target.closest) {
      return;
    }
    if (target.closest("button, input, label, textarea, .switch, .skill-prompt")) {
      event.preventDefault();
      return;
    }
    var id = row.getAttribute("data-capture-skill");
    if (!id) {
      event.preventDefault();
      return;
    }
    dragCaptureAction = id;
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", id);
      } catch (ignored) {
        /* IE-style dataTransfer quirks - order is tracked in memory */
      }
    }
  }

  function overCaptureActionDrop(event) {
    if (!dragCaptureAction) {
      return;
    }
    var row = captureActionItemFromEvent(event);
    if (!row || row.classList.contains("is-disabled")) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    clearCaptureDropMarks();
    if (row.getAttribute("data-capture-skill") === dragCaptureAction) {
      return;
    }
    var rect = row.getBoundingClientRect();
    var after = event.clientY > rect.top + rect.height / 2;
    row.classList.add(after ? "drop-after" : "drop-before");
  }

  function dropCaptureAction(event) {
    var row = captureActionItemFromEvent(event);
    if (!dragCaptureAction || !row || row.classList.contains("is-disabled")) {
      clearCaptureDragMarks();
      return;
    }
    event.preventDefault();
    var targetId = row.getAttribute("data-capture-skill");
    var after = row.classList.contains("drop-after");
    var movedId = dragCaptureAction;
    clearCaptureDragMarks();
    if (!targetId || targetId === movedId) {
      return;
    }
    var original = enabledCaptureSkills();
    var from = original.indexOf(movedId);
    if (from < 0) {
      return;
    }
    var next = original.slice();
    next.splice(from, 1);
    var to = next.indexOf(targetId);
    if (to < 0) {
      return;
    }
    next.splice(after ? to + 1 : to, 0, movedId);
    if (next.join("|") === original.join("|")) {
      return;
    }
    save({ picker: { captureSkills: next } });
  }

  function skillRow(id, enabled, custom) {
    var meta = custom
      ? {
          label: custom.label,
          description: String(custom.prompt || "")
            .replace(/\s+/g, " ")
            .trim(),
        }
      : (LP.SKILL_MAP && LP.SKILL_MAP[id]) || { label: id, description: "" };
    var row = el("li", "skill-item" + (enabled ? "" : " is-disabled"));
    row.setAttribute("data-skill", id);

    var line = el("div", "skill-row");
    if (enabled) {
      line.setAttribute("draggable", "true");
    }

    var drag = el("span", "skill-drag");
    drag.setAttribute("role", "img");
    drag.setAttribute("aria-label", enabled ? "拖动排序" : "启用后可拖动排序");
    drag.title = enabled ? "拖动排序" : "启用后可拖动排序";
    drag.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<circle cx="9" cy="6" r="1.5"></circle><circle cx="15" cy="6" r="1.5"></circle>' +
      '<circle cx="9" cy="12" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle>' +
      '<circle cx="9" cy="18" r="1.5"></circle><circle cx="15" cy="18" r="1.5"></circle>' +
      "</svg>";
    line.appendChild(drag);

    var icon = el("span", "skill-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = LP.skillIconSvg(
      custom ? custom.icon : builtinSkillIconKey(id)
    );
    line.appendChild(icon);

    var main = el("div", "skill-main");
    var nameRow = el("div", "skill-name-row");
    nameRow.appendChild(el("span", "skill-name", meta.label));
    main.appendChild(nameRow);
    if (meta.description) {
      main.appendChild(el("span", "skill-desc", meta.description));
    }
    line.appendChild(main);

    if (custom) {
      var customEdit = el("button", "skill-edit");
      customEdit.type = "button";
      customEdit.setAttribute("data-custom-edit", id);
      customEdit.setAttribute(
        "aria-expanded",
        customEditorOpen && customEditingId === id ? "true" : "false"
      );
      customEdit.setAttribute("aria-label", "编辑技能");
      customEdit.title = "编辑技能";
      customEdit.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
      line.appendChild(customEdit);

      var removeButton = el("button", "skill-delete");
      removeButton.type = "button";
      removeButton.setAttribute("data-custom-delete", id);
      removeButton.setAttribute("aria-label", "删除技能" + meta.label);
      removeButton.title = "删除技能";
      removeButton.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';
      line.appendChild(removeButton);
    } else if (PROMPT_SKILLS.indexOf(id) >= 0) {
      var editButton = el("button", "skill-edit");
      editButton.type = "button";
      editButton.setAttribute("data-prompt-toggle", id);
      editButton.setAttribute("aria-label", "编辑提示词");
      editButton.setAttribute(
        "aria-expanded",
        promptExpanded[id] ? "true" : "false"
      );
      editButton.title = "编辑提示词";
      editButton.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
      line.appendChild(editButton);
    } else if (id === "search") {
      var configButton = el("button", "skill-edit");
      configButton.type = "button";
      configButton.setAttribute("data-search-config", "1");
      configButton.setAttribute("aria-label", "配置搜索");
      configButton.setAttribute(
        "aria-expanded",
        searchPanelOpen ? "true" : "false"
      );
      configButton.title = "配置搜索";
      configButton.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h10"></path><path d="M4 17h6"></path><path d="M18 7v10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="12" cy="17" r="2"></circle></svg>';
      line.appendChild(configButton);
    }

    var toggle = el("label", "switch");
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.setAttribute("data-skill-toggle", id);
    input.setAttribute("aria-label", "启用" + meta.label);
    var track = el("span", "switch-track");
    var thumb = el("span", "switch-thumb");
    track.appendChild(thumb);
    toggle.appendChild(input);
    toggle.appendChild(track);
    line.appendChild(toggle);

    row.appendChild(line);

    if (!custom && PROMPT_SKILLS.indexOf(id) >= 0 && promptExpanded[id]) {
      row.appendChild(skillPromptPanel(id, meta));
    } else if (!custom && id === "search" && searchPanelOpen) {
      row.appendChild(searchEnginePanel());
    }
    return row;
  }

  /* ---- Skill prompts --------------------------------------------------- */

  function promptCustomValue(id) {
    var prompts =
      (state && state.settings && state.settings.picker && state.settings.picker.prompts) ||
      {};
    var value = prompts[id];
    return typeof value === "string" ? value : "";
  }

  function promptDefault(id) {
    var defaults = (state && state.promptDefaults) || {};
    var value = defaults[id];
    return typeof value === "string" ? value : "";
  }

  /* Textarea value: pending draft wins, then custom prompt, then the default. */
  function promptEditorValue(id) {
    if (Object.prototype.hasOwnProperty.call(promptDrafts, id)) {
      return promptDrafts[id];
    }
    return promptCustomValue(id) || promptDefault(id);
  }

  function promptBlock(id, label, hint) {
    var panel = el("div", "skill-prompt");
    panel.appendChild(el("p", "skill-prompt-label", label));
    var textarea = document.createElement("textarea");
    textarea.className = "textarea";
    textarea.rows = 5;
    textarea.spellcheck = false;
    textarea.setAttribute("data-prompt-input", id);
    textarea.setAttribute("aria-label", label);
    textarea.value = promptEditorValue(id);
    textarea.addEventListener("input", function () {
      promptDrafts[id] = textarea.value;
      if (promptTimers[id]) {
        window.clearTimeout(promptTimers[id]);
      }
      promptTimers[id] = window.setTimeout(function () {
        promptTimers[id] = null;
        savePromptDraft(id);
      }, 500);
    });
    textarea.addEventListener("blur", function () {
      flushPromptDraft(id);
    });
    textarea.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        textarea.blur();
      }
    });
    panel.appendChild(textarea);

    var foot = el("div", "skill-prompt-foot");
    foot.appendChild(el("p", "skill-prompt-hint", hint));
    var reset = el("button", "btn btn-ghost skill-prompt-reset", "重置为默认");
    reset.type = "button";
    reset.setAttribute("data-prompt-reset", id);
    foot.appendChild(reset);
    panel.appendChild(foot);
    return panel;
  }

  /* The translate skill owns two prompts: ordinary translation and the
   * dictionary prompt used when the input is automatically classified as a
   * single word or short term. Every other skill has one prompt. */
  function skillPromptPanel(id, meta) {
    if (id === "translate") {
      var group = el("div", "skill-prompt-group");
      group.appendChild(
        promptBlock(
          "translate",
          "翻译提示词",
          "整句、段落等普通翻译使用；支持 {target} 占位符"
        )
      );
      group.appendChild(
        promptBlock(
          "wordLookup",
          "单词查询提示词",
          "自动识别到单个单词或短语时使用；支持 {target}，可要求模型输出音标或拼音"
        )
      );
      return group;
    }
    return promptBlock(
      id,
      meta.label + "提示词",
      "留空或重置后使用系统默认提示词；支持 {target} 占位符"
    );
  }

  function savePromptDraft(id) {
    if (!Object.prototype.hasOwnProperty.call(promptDrafts, id)) {
      return;
    }
    var value = promptDrafts[id];
    delete promptDrafts[id];
    savePromptValue(id, value);
  }

  function flushPromptDraft(id) {
    if (promptTimers[id]) {
      window.clearTimeout(promptTimers[id]);
      promptTimers[id] = null;
    }
    savePromptDraft(id);
  }

  function savePromptValue(id, rawValue) {
    var text = String(rawValue === null || rawValue === undefined ? "" : rawValue);
    var trimmed = text.trim();
    var stored = "";
    if (trimmed && trimmed !== promptDefault(id).trim()) {
      stored = trimmed;
    }
    var patch = { picker: { prompts: {} } };
    patch.picker.prompts[id] = stored;
    save(patch);
  }

  function togglePromptPanel(id) {
    if (promptExpanded[id]) {
      flushPromptDraft(id);
      delete promptExpanded[id];
    } else {
      promptExpanded[id] = true;
    }
    renderSkills(true);
  }

  function resetPromptValue(id) {
    flushPromptDraft(id);
    savePromptValue(id, "");
    var textarea = document.querySelector('[data-prompt-input="' + id + '"]');
    if (textarea) {
      textarea.value = promptDefault(id);
    }
    toast("已重置为默认提示词", "success");
  }

  /* ---- Custom skill editor --------------------------------------------- */

  function assignFieldValue(input, value) {
    if (!input) {
      return;
    }
    var text = value === null || value === undefined ? "" : String(value);
    if (input.value !== text) {
      input.value = text;
    }
  }

  function armSkillDelete(button, action, armedLabel) {
    if (!button) {
      return;
    }
    if (button.getAttribute("data-armed") === "1") {
      disarmSkillDelete(button);
      action();
      return;
    }
    button.setAttribute("data-armed", "1");
    button.classList.add("is-armed");
    button.setAttribute("data-saved-title", button.title || "");
    button.setAttribute("data-saved-label", button.getAttribute("aria-label") || "");
    button.title = "再次点击确认删除";
    button.setAttribute("aria-label", "再次点击确认删除");
    if (armedLabel) {
      button.setAttribute("data-saved-text", button.textContent || "");
      button.textContent = armedLabel;
    }
    window.clearTimeout(button.disarmTimer);
    button.disarmTimer = window.setTimeout(function () {
      disarmSkillDelete(button);
    }, 4000);
  }

  function disarmSkillDelete(button) {
    if (!button) {
      return;
    }
    window.clearTimeout(button.disarmTimer);
    button.removeAttribute("data-armed");
    button.classList.remove("is-armed");
    var title = button.getAttribute("data-saved-title");
    if (title !== null) {
      button.title = title;
      button.removeAttribute("data-saved-title");
    }
    var ariaLabel = button.getAttribute("data-saved-label");
    if (ariaLabel !== null) {
      button.setAttribute("aria-label", ariaLabel);
      button.removeAttribute("data-saved-label");
    }
    var savedText = button.getAttribute("data-saved-text");
    if (savedText !== null) {
      button.textContent = savedText;
      button.removeAttribute("data-saved-text");
    }
  }

  function filteredIconKeys() {
    var keys = LP.CUSTOM_SKILL_ICON_KEYS || [];
    var query = String(iconSearchQuery || "")
      .trim()
      .toLowerCase();
    if (!query) {
      return keys.slice();
    }
    return keys.filter(function (key) {
      return String(key).toLowerCase().indexOf(query) >= 0;
    });
  }

  /* Keep the highlighted icon inside the scrollable gallery viewport. */
  function scrollSelectedIconIntoView(grid) {
    var node = grid && grid.querySelector(".icon-option.is-selected");
    if (!node || !grid.clientHeight) {
      return;
    }
    grid.scrollTop = Math.max(
      0,
      node.offsetTop - grid.clientHeight / 2 + node.offsetHeight / 2
    );
  }

  function renderIconPreview() {
    var key = validCustomIcon(customDraft ? customDraft.icon : "");
    var preview = byId("custom-skill-icon-preview");
    if (preview) {
      preview.innerHTML = LP.skillIconSvg(key);
    }
    var current = byId("custom-skill-icon-current");
    if (current) {
      var friendly = CUSTOM_ICON_LABELS[key] || "";
      current.textContent = key;
      current.title = friendly ? key + "（" + friendly + "）" : key;
    }
  }

  /* Expand/collapse the compact icon gallery. Search state is reset on every
   * open so it always starts from the full 200-icon list. */
  function setIconPickerOpen(open) {
    iconPickerOpen = !!open;
    var panel = byId("custom-skill-icon-panel");
    setHidden(panel, !customEditorOpen || !iconPickerOpen);
    var toggle = byId("toggle-icon-picker");
    if (toggle) {
      toggle.setAttribute("aria-expanded", iconPickerOpen ? "true" : "false");
      toggle.textContent = iconPickerOpen ? "收起图标" : "更换图标";
    }
    if (!iconPickerOpen) {
      return;
    }
    iconSearchQuery = "";
    assignFieldValue(byId("custom-skill-icon-search"), "");
    renderCustomIconGrid(true);
    var searchInput = byId("custom-skill-icon-search");
    if (searchInput && searchInput.focus) {
      searchInput.focus();
    }
  }

  function toggleIconPicker() {
    setIconPickerOpen(!iconPickerOpen);
  }

  /* Skill type (text/image) segmented control in the custom skill editor. */
  function currentCustomKind() {
    return customDraft ? customSkillKind(customDraft) : "text";
  }

  function renderCustomSkillKind() {
    var kind = currentCustomKind();
    each(document.querySelectorAll("[data-skill-kind]"), function (button) {
      var selected = button.getAttribute("data-skill-kind") === kind;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    var hint = byId("custom-skill-kind-hint");
    if (hint) {
      hint.textContent = CUSTOM_KIND_HINTS[kind] || CUSTOM_KIND_HINTS.text;
    }
    var varsHint = byId("custom-skill-vars-hint");
    if (varsHint) {
      varsHint.innerHTML = CUSTOM_VARS_HINTS[kind] || CUSTOM_VARS_HINTS.text;
    }
  }

  function selectCustomSkillKind(kind) {
    if (!customEditorOpen || !customDraft) {
      return;
    }
    customDraft.kind = kind === "image" ? "image" : "text";
    renderCustomSkillKind();
  }

  function renderCustomIconGrid(ensureSelectedVisible) {
    var grid = byId("custom-skill-icons");
    if (!grid) {
      return;
    }
    var keys = filteredIconKeys();
    var selected = validCustomIcon(customDraft ? customDraft.icon : "");
    var empty = byId("custom-skill-icon-empty");
    if (empty) {
      setHidden(empty, keys.length > 0);
    }
    var signature = keys.join("\u0001") + "\u0002" + selected;
    if (grid.getAttribute("data-signature") !== signature) {
      grid.setAttribute("data-signature", signature);
      grid.innerHTML = "";
      keys.forEach(function (key) {
        var button = el(
          "button",
          "icon-option" + (key === selected ? " is-selected" : "")
        );
        button.type = "button";
        button.setAttribute("data-icon-key", key);
        button.setAttribute("role", "radio");
        button.setAttribute("aria-checked", key === selected ? "true" : "false");
        var label = CUSTOM_ICON_LABELS[key] || key;
        button.setAttribute("aria-label", "图标：" + label);
        button.title = key;
        button.innerHTML = LP.skillIconSvg(key);
        grid.appendChild(button);
      });
    }
    if (ensureSelectedVisible) {
      scrollSelectedIconIntoView(grid);
    }
  }

  /* `syncFields` is only true while opening the editor: state refreshes must
   * not overwrite what the user is currently typing. */
  function renderCustomSkillEditor(syncFields) {
    var editor = byId("custom-skill-editor");
    if (!editor) {
      return;
    }
    if (!customEditorOpen) {
      setHidden(editor, true);
      return;
    }
    if (customEditingId && !findCustomSkill(customEditingId)) {
      closeCustomEditor();
      return;
    }
    setHidden(editor, false);
    var title = byId("custom-skill-editor-title");
    if (title) {
      title.textContent = customEditingId ? "编辑技能" : "新增技能";
    }
    setHidden(byId("delete-custom-skill"), !customEditingId);
    renderIconPreview();
    renderCustomSkillKind();
    setHidden(byId("custom-skill-icon-panel"), !iconPickerOpen);
    var iconToggle = byId("toggle-icon-picker");
    if (iconToggle) {
      iconToggle.setAttribute(
        "aria-expanded",
        iconPickerOpen ? "true" : "false"
      );
      iconToggle.textContent = iconPickerOpen ? "收起图标" : "更换图标";
    }
    if (syncFields) {
      assignFieldValue(
        byId("custom-skill-name"),
        customDraft ? customDraft.label : ""
      );
      assignFieldValue(
        byId("custom-skill-prompt"),
        customDraft ? customDraft.prompt : ""
      );
      if (iconPickerOpen) {
        renderCustomIconGrid(true);
      }
    }
  }

  function openCustomEditor(id) {
    var targetId = String(id || "");
    var custom = targetId ? findCustomSkill(targetId) : null;
    if (targetId && !custom) {
      toast("技能不存在，可能已被删除", "error");
      refreshState();
      return;
    }
    customEditorOpen = true;
    customEditingId = custom ? custom.id : "";
    customDraft = {
      icon: custom ? custom.icon : validCustomIcon(LP.CUSTOM_SKILL_DEFAULT_ICON),
      label: custom ? custom.label : "",
      prompt: custom ? custom.prompt : "",
      kind: custom ? customSkillKind(custom) : skillTab,
    };
    iconSearchQuery = "";
    assignFieldValue(byId("custom-skill-icon-search"), "");
    iconPickerOpen = false;
    hideInlineError(byId("custom-skill-error"));
    disarmSkillDelete(byId("delete-custom-skill"));
    renderCustomSkillEditor(true);
    renderCaptureSkills(true);
    renderSkills(true);
    var editor = byId("custom-skill-editor");
    if (editor && editor.scrollIntoView) {
      editor.scrollIntoView({ block: "nearest" });
    }
    var nameInput = byId("custom-skill-name");
    if (nameInput && nameInput.focus) {
      nameInput.focus();
    }
  }

  function closeCustomEditor() {
    customEditorOpen = false;
    customEditingId = "";
    customDraft = null;
    iconPickerOpen = false;
    setHidden(byId("custom-skill-icon-panel"), true);
    disarmSkillDelete(byId("delete-custom-skill"));
    hideInlineError(byId("custom-skill-error"));
    renderCustomSkillEditor(false);
    renderCaptureSkills(true);
    renderSkills(true);
  }

  function chooseCustomIcon(key) {
    if (!customEditorOpen || !customDraft) {
      return;
    }
    customDraft.icon = validCustomIcon(key);
    renderIconPreview();
    setIconPickerOpen(false);
  }

  function generateCustomSkillId(existing) {
    var taken = {};
    existing.forEach(function (skill) {
      taken[skill.id] = true;
    });
    var id = "";
    do {
      var suffix = "";
      for (var index = 0; index < 4; index += 1) {
        suffix += CUSTOM_ID_ALPHABET.charAt(
          Math.floor(Math.random() * CUSTOM_ID_ALPHABET.length)
        );
      }
      id = "custom-" + Date.now().toString(36) + suffix;
    } while (taken[id]);
    return id;
  }

  function saveCustomSkill() {
    if (!customEditorOpen || !customDraft) {
      return;
    }
    var nameInput = byId("custom-skill-name");
    var promptInput = byId("custom-skill-prompt");
    var errorNode = byId("custom-skill-error");
    var label = String(nameInput ? nameInput.value : customDraft.label)
      .replace(/\s+/g, " ")
      .trim();
    var prompt = String(promptInput ? promptInput.value : customDraft.prompt).trim();
    if (!label) {
      showInlineError(errorNode, "请填写技能名称（最多 20 个字符）");
      if (nameInput && nameInput.focus) {
        nameInput.focus();
      }
      return;
    }
    if (label.length > 20) {
      showInlineError(errorNode, "技能名称最多 20 个字符");
      if (nameInput && nameInput.focus) {
        nameInput.focus();
      }
      return;
    }
    if (!prompt) {
      showInlineError(
        errorNode,
        customDraft.kind === "image"
          ? "请填写提示词，可使用 {target}、{language}、{program}、{app} 变量"
          : "请填写提示词，可使用 {text}、{target}、{language}、{program}、{app} 变量"
      );
      if (promptInput && promptInput.focus) {
        promptInput.focus();
      }
      return;
    }
    if (prompt.length > 4000) {
      showInlineError(errorNode, "提示词最多 4000 个字符");
      if (promptInput && promptInput.focus) {
        promptInput.focus();
      }
      return;
    }
    var icon = validCustomIcon(customDraft.icon);
    var kind = customDraft.kind === "image" ? "image" : "text";
    var customs = customSkillsList();
    var editingId = customEditingId;
    var id;
    var labelText;
    if (editingId) {
      var index = -1;
      customs.forEach(function (skill, position) {
        if (skill.id === editingId) {
          index = position;
        }
      });
      if (index < 0) {
        showInlineError(errorNode, "技能不存在，可能已被删除");
        refreshState();
        return;
      }
      customs[index] = {
        id: editingId,
        label: label,
        icon: icon,
        prompt: prompt,
        kind: kind,
      };
      id = editingId;
      labelText = "已保存技能「" + label + "」";
    } else {
      id = generateCustomSkillId(customs);
      customs.push({
        id: id,
        label: label,
        icon: icon,
        prompt: prompt,
        kind: kind,
      });
      labelText = "已添加技能「" + label + "」";
    }
    /* Keep picker.skills (text toolbar) and picker.captureSkills (screenshot
     * toolbar) in sync with the skill kind. An id already in its container
     * keeps its position, so edits never reorder the list. */
    var skills = enabledSkills();
    var captureSkills = enabledCaptureSkills();
    if (kind === "image") {
      skills = skills.filter(function (skillId) {
        return skillId !== id;
      });
      if (captureSkills.indexOf(id) < 0) {
        captureSkills.push(id);
      }
    } else {
      captureSkills = captureSkills.filter(function (skillId) {
        return skillId !== id;
      });
      if (skills.indexOf(id) < 0) {
        skills.push(id);
      }
    }
    /* Land on the tab that holds the saved skill so a new or re-typed row is
     * visible immediately (contract §7.2). */
    skillTab = kind;
    closeCustomEditor();
    save({
      picker: {
        customSkills: customs,
        skills: skills,
        captureSkills: captureSkills,
      },
    });
    toast(labelText, "success");
  }

  function deleteCustomSkill(id) {
    var custom = findCustomSkill(id);
    if (!custom) {
      toast("技能不存在，可能已被删除", "error");
      refreshState();
      return;
    }
    var remaining = customSkillsList().filter(function (skill) {
      return skill.id !== id;
    });
    var skills = enabledSkills().filter(function (skillId) {
      return skillId !== id;
    });
    if (!skills.length) {
      skills = DEFAULT_SKILLS.slice();
    }
    /* Custom image skills live in picker.captureSkills; remove the id from both
     * toolbars so a delete never leaves a dangling toolbar action. */
    var captureSkills = enabledCaptureSkills().filter(function (skillId) {
      return skillId !== id;
    });
    if (customEditingId === id) {
      closeCustomEditor();
    }
    save({
      picker: {
        customSkills: remaining,
        skills: skills,
        captureSkills: captureSkills,
      },
    });
    toast("已删除技能「" + custom.label + "」", "success");
  }

  /* ---- Skill drag ordering -------------------------------------------- */

  function skillItemFromEvent(event) {
    var target = event.target;
    if (!target || !target.closest) {
      return null;
    }
    return target.closest(".skill-item");
  }

  function clearDropMarks() {
    var list = byId("skill-list");
    if (!list) {
      return;
    }
    each(list.querySelectorAll(".drop-before, .drop-after"), function (node) {
      node.classList.remove("drop-before", "drop-after");
    });
  }

  function clearDragMarks() {
    var list = byId("skill-list");
    dragSkillId = "";
    if (!list) {
      return;
    }
    clearDropMarks();
    each(list.querySelectorAll(".is-dragging"), function (node) {
      node.classList.remove("is-dragging");
    });
  }

  function startSkillDrag(event) {
    var row = skillItemFromEvent(event);
    var target = event.target;
    if (!row || row.classList.contains("is-disabled") || !target.closest) {
      return;
    }
    if (target.closest("button, input, label, textarea, .switch, .skill-prompt")) {
      event.preventDefault();
      return;
    }
    var id = row.getAttribute("data-skill");
    if (!id) {
      event.preventDefault();
      return;
    }
    dragSkillId = id;
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", id);
      } catch (ignored) {
        /* IE-style dataTransfer quirks - order is tracked in memory */
      }
    }
  }

  function overSkillDrop(event) {
    if (!dragSkillId) {
      return;
    }
    var row = skillItemFromEvent(event);
    if (!row || row.classList.contains("is-disabled")) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    clearDropMarks();
    if (row.getAttribute("data-skill") === dragSkillId) {
      return;
    }
    var rect = row.getBoundingClientRect();
    var after = event.clientY > rect.top + rect.height / 2;
    row.classList.add(after ? "drop-after" : "drop-before");
  }

  function dropSkill(event) {
    var row = skillItemFromEvent(event);
    if (!dragSkillId || !row || row.classList.contains("is-disabled")) {
      clearDragMarks();
      return;
    }
    event.preventDefault();
    var targetId = row.getAttribute("data-skill");
    var after = row.classList.contains("drop-after");
    var movedId = dragSkillId;
    clearDragMarks();
    if (!targetId || targetId === movedId) {
      return;
    }
    /* Reorder inside the active category only, then merge back into the saved
     * global order so the other category keeps its slots (contract §7.2). */
    var original = enabledCategorySkills(skillTab);
    var from = original.indexOf(movedId);
    if (from < 0) {
      return;
    }
    var next = original.slice();
    next.splice(from, 1);
    var to = next.indexOf(targetId);
    if (to < 0) {
      return;
    }
    next.splice(after ? to + 1 : to, 0, movedId);
    if (next.join("|") === original.join("|")) {
      return;
    }
    var merged = mergeCategoryOrder(
      storedSkillOrder(),
      skillTab,
      next,
      customSkillMap()
    );
    save({ picker: { skills: merged } });
  }

  function renderBlacklist() {
    var wrap = byId("blacklist-chips");
    if (!wrap) {
      return;
    }
    var list = Array.isArray(state.settings.picker.blacklist)
      ? state.settings.picker.blacklist
      : [];
    var signature = list.join("\u0001");
    if (signature === wrap.getAttribute("data-signature")) {
      return;
    }
    wrap.setAttribute("data-signature", signature);
    wrap.innerHTML = "";
    list.forEach(function (entry) {
      var chip = el("span", "chip");
      chip.appendChild(el("span", null, entry));
      var remove = el("button", "chip-remove", "×");
      remove.type = "button";
      remove.setAttribute("data-blacklist-entry", entry);
      remove.setAttribute("aria-label", "移除 " + entry);
      chip.appendChild(remove);
      wrap.appendChild(chip);
    });
  }

  function renderApp() {
    var app = state.settings.app || {};
    setChecked(byId("close-to-tray"), app.closeToTray !== false);
    renderStartAtLogin();
  }

  function renderStartAtLogin() {
    var info = state.loginItem || { supported: false, enabled: false };
    var input = byId("start-at-login");
    var note = byId("start-at-login-note");
    var hint = byId("start-at-login-hint");
    if (!input) {
      return;
    }
    input.disabled = !info.supported || loginBusy;
    setChecked(input, info.enabled);
    if (!info.supported) {
      if (hint) {
        hint.textContent = "当前为便携版，此项不可用";
      }
      if (note) {
        note.hidden = false;
        note.textContent =
          "便携版不写入开机启动项。如需自启，把 Lexora.exe 快捷方式放入 shell:startup。";
      }
    } else {
      if (hint) {
        hint.textContent = "登录后启动到托盘";
      }
      if (note) {
        note.hidden = true;
        note.textContent = "";
      }
    }
  }

  function renderAbout() {
    var app = state.app || {};
    var engine = state.engine || {};
    var models = state.models || [];
    byId("about-version").textContent = app.version ? "v" + app.version : "—";
    byId("about-platform").textContent = LP.platformLabel
      ? LP.platformLabel(app)
      : app.platform || "—";
    byId("about-license").textContent = app.license || "MIT";
    byId("about-data-dir").textContent = app.dataDir || "—";
    byId("about-data-dir").title = app.dataDir || "";

    var engineParts = [];
    engineParts.push(engine.engineAvailable ? "llama.cpp 已安装" : "llama.cpp 未安装");
    if (engine.mode === "local") {
      engineParts.push(
        engine.localState === "ready"
          ? "本地模型运行中"
          : engine.localState === "starting"
            ? "本地模型启动中"
            : "本地模型未启动"
      );
    } else {
      engineParts.push(engine.ready ? "在线 API 就绪" : "在线 API 未就绪");
    }
    byId("about-engine").textContent = engineParts.join(" · ");
    byId("about-models").textContent = models.length
      ? models.length + " 个本地模型 · " + (engine.localModelName || models[0].name)
      : "未安装本地模型";
    renderUpdateVersionHint();
  }

  /* ---- Update checker -------------------------------------------------- */

  function updateCurrentVersion() {
    return (state && state.app && state.app.version) || "";
  }

  function renderUpdateVersionHint() {
    var hint = byId("update-current-hint");
    if (!hint) {
      return;
    }
    var version = updateCurrentVersion();
    hint.textContent =
      (version ? "当前版本 v" + version : "当前版本 —") +
      " · 启动时自动检查，下载后替换当前 exe 并重启";
  }

  function formatUpdateTime(value) {
    if (!value) {
      return "";
    }
    var date = new Date(value);
    if (isNaN(date.getTime())) {
      return String(value);
    }
    function pad(number) {
      return number < 10 ? "0" + number : String(number);
    }
    return (
      date.getFullYear() +
      "-" +
      pad(date.getMonth() + 1) +
      "-" +
      pad(date.getDate()) +
      " " +
      pad(date.getHours()) +
      ":" +
      pad(date.getMinutes())
    );
  }

  function updateNotesText() {
    var info = updateInfo || {};
    var notes = typeof info.notes === "string" ? info.notes : "";
    notes = notes.replace(/\r\n/g, "\n");
    /* Some release payloads (and the browser-preview mock) double-encode line
     * breaks as literal "\n"; decode them only when the text has no real
     * newlines so normal multi-line notes stay untouched. */
    if (notes.indexOf("\n") < 0 && notes.indexOf("\\n") >= 0) {
      notes = notes.replace(/\\r\\n|\\n|\\r/g, "\n");
    }
    return notes.trim();
  }

  /* Release notes are Markdown from the GitHub release body. The shared
   * renderer escapes raw HTML, so provider-controlled markup cannot execute. */
  function renderUpdateNotes() {
    var wrap = byId("update-notes");
    var textNode = byId("update-notes-text");
    var toggle = byId("toggle-update-notes");
    if (!wrap || !textNode) {
      return;
    }
    var notes = updateNotesText();
    if (!notes) {
      setHidden(wrap, true);
      return;
    }
    setHidden(wrap, false);
    textNode.classList.add("markdown");
    if (LP && typeof LP.renderMarkdown === "function") {
      textNode.innerHTML = LP.renderMarkdown(notes);
    } else {
      textNode.textContent = notes;
    }
    textNode.classList.toggle("is-clamped", !updateNotesExpanded);
    if (toggle) {
      toggle.textContent = updateNotesExpanded ? "收起" : "展开全部";
      toggle.setAttribute("aria-expanded", updateNotesExpanded ? "true" : "false");
      setHidden(toggle, !(updateNotesExpanded || notes.length > 240));
    }
  }

  function renderUpdateProgress() {
    var fill = byId("update-progress-fill");
    var text = byId("update-progress-text");
    var percent = Number(updateProgressPercent);
    if (!isFinite(percent) || percent < 0) {
      percent = 0;
    }
    if (percent > 100) {
      percent = 100;
    }
    percent = Math.round(percent);
    if (fill) {
      fill.style.width = percent + "%";
    }
    if (text) {
      text.textContent = percent + "%";
    }
  }

  function renderUpdate() {
    var status = byId("update-status");
    if (!status) {
      return;
    }
    var stateName = updateState || "idle";
    status.setAttribute("data-state", stateName);
    setHidden(status, stateName === "idle");

    var message = byId("update-message");
    var checkButton = byId("check-update");
    setHidden(message, stateName === "idle");
    setHidden(byId("update-notes"), true);
    setHidden(byId("update-meta"), true);
    setHidden(byId("update-actions"), true);
    setHidden(byId("update-progress"), true);
    hideInlineError(byId("update-error"));
    if (checkButton) {
      checkButton.disabled = false;
      checkButton.textContent = "检查更新";
    }
    if (stateName === "idle") {
      return;
    }

    if (stateName === "checking") {
      message.textContent = "正在检查更新…";
      if (checkButton) {
        checkButton.disabled = true;
        checkButton.textContent = "检查中…";
      }
      return;
    }
    if (stateName === "latest") {
      var latest = (updateInfo && updateInfo.latestVersion) || updateCurrentVersion();
      message.textContent = latest ? "已是最新版本 v" + latest : "已是最新版本";
      if (checkButton) {
        checkButton.textContent = "重新检查";
      }
      return;
    }
    if (stateName === "available") {
      var info = updateInfo || {};
      var targetVersion = info.latestVersion || "";
      var currentVersion = info.currentVersion || updateCurrentVersion();
      message.textContent =
        "发现新版本" +
        (targetVersion ? " v" + targetVersion : "") +
        (currentVersion ? "（当前 v" + currentVersion + "）" : "");
      renderUpdateNotes();
      var timeNode = byId("update-time");
      var sizeNode = byId("update-size");
      var meta = byId("update-meta");
      var timeText = formatUpdateTime(info.publishedAt);
      var sizeText = info.sizeBytes ? LP.formatBytes(info.sizeBytes) : "";
      if (timeNode) {
        timeNode.textContent = timeText;
        setHidden(timeNode, !timeText);
      }
      if (sizeNode) {
        sizeNode.textContent = sizeText;
        setHidden(sizeNode, !sizeText);
      }
      if (meta) {
        meta.title = info.assetName || "";
        setHidden(meta, !timeText && !sizeText);
      }
      setHidden(byId("update-actions"), false);
      if (checkButton) {
        checkButton.textContent = "重新检查";
      }
      return;
    }
    if (stateName === "downloading") {
      message.textContent = "正在下载更新…";
      setHidden(byId("update-progress"), false);
      renderUpdateProgress();
      if (checkButton) {
        checkButton.disabled = true;
        checkButton.textContent = "更新中…";
      }
      return;
    }
    if (stateName === "ready") {
      message.textContent = "更新已就绪，应用即将重启…";
      setHidden(byId("update-progress"), false);
      renderUpdateProgress();
      if (checkButton) {
        checkButton.disabled = true;
        checkButton.textContent = "即将重启…";
      }
      return;
    }

    /* error */
    message.textContent = updateErrorTitle || "检查更新失败";
    showInlineError(
      byId("update-error"),
      updateErrorText || "未知错误",
      updateErrorHint || ""
    );
    if (checkButton) {
      checkButton.textContent = "重新检查";
    }
  }

  function handleUpdateProgress(progress) {
    if (!progress || typeof progress !== "object") {
      return;
    }
    if (
      updateState !== "downloading" &&
      updateState !== "ready" &&
      !updateInstalling
    ) {
      return;
    }
    var percent = Number(progress.percent);
    if (!isFinite(percent) && Number(progress.total) > 0) {
      percent = (Number(progress.received) / Number(progress.total)) * 100;
    }
    if (isFinite(percent)) {
      updateProgressPercent = percent;
    }
    if (progress.status === "ready") {
      updateState = "ready";
      updateProgressPercent = 100;
    } else if (progress.status === "downloading") {
      updateState = "downloading";
    } else {
      return;
    }
    renderUpdate();
  }

  function notifyUpdateAvailable(result) {
    if (
      !result ||
      !result.hasUpdate ||
      !result.latestVersion ||
      !API ||
      typeof API.notifyUpdateAvailable !== "function"
    ) {
      return;
    }
    API.notifyUpdateAvailable(String(result.latestVersion)).then(
      function () {},
      function () {
        /* The update card remains available if a native notification fails. */
      }
    );
  }
  function checkForUpdates(options) {
    var opts = options && typeof options === "object" ? options : {};
    var automatic = opts.automatic === true;
    if (!API || typeof API.checkUpdate !== "function") {
      if (!automatic) {
        toast("当前版本不支持检查更新", "error");
      }
      return;
    }
    if (updateChecking || updateInstalling) {
      return;
    }
    if (updateState === "downloading" || updateState === "ready") {
      return;
    }
    if (automatic && updateState === "available" && updateInfo && updateInfo.hasUpdate) {
      return;
    }
    updateChecking = true;
    updateInfo = null;
    updateErrorTitle = "";
    updateErrorText = "";
    updateErrorHint = "";
    updateNotesExpanded = false;
    updateState = "checking";
    renderUpdate();
    API.checkUpdate().then(
      function (result) {
        updateChecking = false;
        if (!result || result.ok === false) {
          if (automatic) {
            updateState = "idle";
          } else {
            updateState = "error";
            updateErrorTitle = "检查更新失败";
            updateErrorText = (result && result.error) || "未知错误";
            updateErrorHint = (result && result.hint) || "";
          }
          renderUpdate();
          return;
        }
        updateInfo = result;
        updateNotesExpanded = false;
        updateState = result.hasUpdate ? "available" : "latest";
        notifyUpdateAvailable(result);
        renderUpdate();
      },
      function (error) {
        updateChecking = false;
        if (automatic) {
          updateState = "idle";
        } else {
          updateState = "error";
          updateErrorTitle = "检查更新失败";
          updateErrorText = String(error || "未知错误");
          updateErrorHint = "";
        }
        renderUpdate();
      }
    );
  }

  function installAppUpdate() {
    if (!API || typeof API.installUpdate !== "function") {
      toast("当前版本不支持安装更新", "error");
      return;
    }
    if (updateInstalling || updateState === "downloading" || updateState === "ready") {
      return;
    }
    updateInstalling = true;
    updateProgressPercent = 0;
    updateErrorTitle = "";
    updateErrorText = "";
    updateErrorHint = "";
    updateState = "downloading";
    renderUpdate();
    API.installUpdate().then(
      function (result) {
        updateInstalling = false;
        if (!result || result.ok === false) {
          updateState = "error";
          updateErrorTitle = "下载更新失败";
          updateErrorText = (result && result.error) || "未知错误";
          updateErrorHint = (result && result.hint) || "";
          renderUpdate();
          return;
        }
        updateProgressPercent = 100;
        updateState = "ready";
        renderUpdate();
        toast("更新已就绪，应用即将重启", "success");
      },
      function (error) {
        updateInstalling = false;
        updateState = "error";
        updateErrorTitle = "下载更新失败";
        updateErrorText = String(error || "未知错误");
        updateErrorHint = "";
        renderUpdate();
      }
    );
  }

  function dismissUpdate() {
    if (updateState === "downloading" || updateState === "ready") {
      return;
    }
    updateState = "idle";
    updateInfo = null;
    updateNotesExpanded = false;
    renderUpdate();
  }

  function toggleUpdateNotes() {
    updateNotesExpanded = !updateNotesExpanded;
    renderUpdateNotes();
  }

  /* ---- Actions --------------------------------------------------------- */

  function switchMode(mode) {
    if (state && state.settings.provider.mode === mode) {
      return;
    }
    hideInlineError(byId("test-error"));
    var badge = byId("test-badge");
    if (badge) {
      badge.hidden = true;
    }
    save({ provider: { mode: mode } });
  }

  function applyPreset(presetId) {
    hideInlineError(byId("test-error"));
    var badge = byId("test-badge");
    if (badge) {
      badge.hidden = true;
    }
    var preset = LP.presetFor(presetId);
    var isCustom = !preset || preset.id === "custom";
    // Switching providers must never keep the previous provider's leftovers:
    // clear the API key / model and the cached model list, and do not pre-fill
    // a model name (the user pulls /models and picks one explicitly).
    customModelMode = false;
    onlineModelHint = "";
    onlineModelError = "";
    onlineModelCache = {};
    save({
      provider: {
        online: {
          preset: isCustom ? "custom" : preset.id,
          baseUrl: isCustom ? "" : preset.baseUrl,
          modelsBaseUrl: isCustom || !preset.modelsBaseUrl ? "" : preset.modelsBaseUrl,
          apiKey: "",
          model: "",
        },
      },
    });
  }

  function onlinePatch(partial) {
    return { provider: { online: partial } };
  }

  function testConnection() {
    var baseUrl = byId("online-base-url").value.trim();
    var apiKey = byId("online-api-key").value;
    var model = getSelectedModel();
    var errorNode = byId("test-error");
    var badge = byId("test-badge");
    var button = byId("test-connection");
    if (!baseUrl) {
      if (badge) {
        badge.hidden = true;
      }
      showInlineError(errorNode, "请先填写服务地址");
      return;
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      if (badge) {
        badge.hidden = true;
      }
      showInlineError(errorNode, "服务地址必须以 http:// 或 https:// 开头");
      return;
    }
    button.disabled = true;
    button.textContent = "测试中…";
    if (badge) {
      badge.hidden = true;
    }
    hideInlineError(errorNode);
    var timeoutMs =
      (state && state.settings.provider.online.timeoutMs) || 60000;
    API.testOnline({ baseUrl: baseUrl, apiKey: apiKey, model: model, timeoutMs: timeoutMs }).then(
      function (result) {
        button.disabled = false;
        button.textContent = "测试连接";
        if (result && result.ok) {
          var parts = ["连接成功", LP.formatMs(result.latencyMs)];
          if (result.models && result.models.length) {
            parts.push(result.models.length + " 个模型可用");
          }
          if (badge) {
            badge.hidden = false;
            badge.textContent = parts.join(" · ");
            setTone(badge, "ok");
          }
          if (result.models && result.models.length) {
            var online = (state && state.settings.provider.online) || {};
            var models = cacheOnlineModels(online, result.models);
            onlineModelError = "";
            onlineModelHint = "已加载 " + models.length + " 个模型";
            renderOnlineModelOptions(online);
          }
          if (
            result.models &&
            result.models.length &&
            model &&
            result.models.indexOf(model) < 0
          ) {
            showInlineError(
              errorNode,
              "连接成功，但模型列表中没有「" +
                model +
                "」。可从模型下拉列表选择其他模型，或继续使用自定义模型。"
            );
          }
        } else {
          if (badge) {
            badge.hidden = false;
            badge.textContent = "连接失败";
            setTone(badge, "error");
          }
          showInlineError(
            errorNode,
            (result && result.error) || "测试连接失败",
            (result && result.hint) || ""
          );
        }
      }
    );
  }

  function isCancellation(message) {
    return /取消|cancel/i.test(String(message || ""));
  }

  function downloadEngine() {
    var button = byId("download-engine");
    button.disabled = true;
    hideInlineError(byId("local-error"));
    API.downloadEngine().then(function (result) {
      button.disabled = false;
      if (!result.ok && !isCancellation(result.error)) {
        showInlineError(byId("local-error"), result.error || "引擎下载失败");
      }
      refreshState();
    });
  }

  /* Cancel one task (model id or "engine"); empty id cancels everything. */
  function cancelDownload(id) {
    var target = id === undefined || id === null ? "" : String(id);
    API.cancelDownload(target).then(function () {
      refreshState();
    });
  }

  function downloadCatalogModel(id, button) {
    if (activeDownload("model", id)) {
      toast("该模型已在下载中", "info");
      return;
    }
    button.disabled = true;
    hideInlineError(byId("local-error"));
    API.downloadModel(id).then(function (result) {
      button.disabled = false;
      if (!result.ok && !isCancellation(result.error)) {
        toast("模型下载失败：" + (result.error || "未知错误"), "error");
        showInlineError(byId("local-error"), result.error || "模型下载失败");
      }
      refreshState();
    });
  }

  function importModel() {
    hideInlineError(byId("local-error"));
    API.importModel().then(function (result) {
      if (!result.ok) {
        showInlineError(
          byId("local-error"),
          result.error || "导入模型失败"
        );
        return;
      }
      toast("模型已导入", "success");
      refreshState();
    });
  }

  function runLocalAction(action, invoke, fallback) {
    if (localBusy) return;
    localBusy = true;
    localAction = action;
    hideInlineError(byId("local-error"));
    renderLocalState();
    return Promise.resolve().then(invoke).then(function (result) {
      return refreshState().then(function () {
        if (!result.ok) {
          showInlineError(byId("local-error"), result.error || fallback, result.hint || "");
        }
      });
    }).catch(function (error) {
      showInlineError(byId("local-error"), error.message || fallback);
    }).finally(function () {
      localBusy = false;
      localAction = "";
      renderLocalState(true);
    });
  }

  function startLocal() {
    return runLocalAction("start", API.startLocal, "启动本地引擎失败");
  }

  function stopLocal() {
    return runLocalAction("stop", API.stopLocal, "停止本地引擎失败");
  }

  function restartLocal() {
    return runLocalAction("restart", function () {
      // Model selection saves immediately. Wait for its queued write without
      // flushing unrelated text drafts such as online API credentials.
      return flushSaveQueue().then(function (result) {
        if (!result.ok) return result;
        return API.restartLocal();
      });
    }, "重启本地引擎失败");
  }

  function toggleSkill(id, enabled) {
    var skills = enabledSkills();
    if (enabled) {
      if (skills.indexOf(id) < 0) {
        skills.push(id);
      }
    } else {
      if (skills.length <= 1) {
        toast("至少保留一个工具栏技能", "error");
        renderSkills(true);
        return;
      }
      skills = skills.filter(function (skill) {
        return skill !== id;
      });
    }
    save({ picker: { skills: skills } });
  }

  function addBlacklistEntry(rawValue) {
    var input = byId("blacklist-input");
    var entry = String(rawValue || "").trim();
    if (!entry) {
      return;
    }
    if (entry.length > 120) {
      toast("进程名过长（最多 120 个字符）", "error");
      return;
    }
    var list = Array.isArray(state.settings.picker.blacklist)
      ? state.settings.picker.blacklist.slice()
      : [];
    var normalized = entry.toLowerCase().replace(/\.exe$/, "");
    var duplicate = list.some(function (item) {
      return item.toLowerCase().replace(/\.exe$/, "") === normalized;
    });
    if (duplicate) {
      input.value = "";
      return;
    }
    if (list.length >= 200) {
      toast("黑名单最多 200 个应用", "error");
      return;
    }
    list.push(entry);
    input.value = "";
    save({ picker: { blacklist: list } });
  }

  function removeBlacklistEntry(entry) {
    var list = Array.isArray(state.settings.picker.blacklist)
      ? state.settings.picker.blacklist.filter(function (item) {
          return item !== entry;
        })
      : [];
    save({ picker: { blacklist: list } });
  }

  /* ---- Danger actions -------------------------------------------------- */

  function armDanger(button, armedLabel, action) {
    if (button.getAttribute("data-armed") === "1") {
      disarmDanger(button);
      action();
      return;
    }
    button.setAttribute("data-armed", "1");
    button.setAttribute("data-label", button.textContent);
    button.classList.add("is-armed");
    button.textContent = armedLabel;
    button.disarmTimer = window.setTimeout(function () {
      disarmDanger(button);
    }, 4000);
  }

  function disarmDanger(button) {
    button.removeAttribute("data-armed");
    button.classList.remove("is-armed");
    var label = button.getAttribute("data-label");
    if (label) {
      button.textContent = label;
    }
    window.clearTimeout(button.disarmTimer);
  }

  function resetSettings() {
    API.resetSettings().then(function (result) {
      if (!result.ok) {
        toast("恢复默认失败：" + (result.error || "未知错误"), "error");
        return;
      }
      applyState(result.state);
      toast("已恢复默认设置", "success");
    });
  }

  function quitApp() {
    if (!API.live) {
      toast("浏览器预览模式：不会退出应用", "info");
      return;
    }
    API.quit();
  }

  function openDir(which) {
    if (!API.live) {
      toast("浏览器预览模式：不会打开系统目录", "info");
    }
    API.openDir(which).then(function (result) {
      if (!result.ok) {
        toast(result.error || "无法打开目录", "error");
      }
    });
  }

  function openExternal(url) {
    if (!API.live) {
      toast("浏览器预览模式：不会打开外部链接", "info");
    }
    API.openExternal(url);
  }

  /* ---- Event wiring ---------------------------------------------------- */

  function bindEvents() {
    byId("mode-online").addEventListener("click", function () {
      switchMode("online");
    });
    byId("mode-local").addEventListener("click", function () {
      switchMode("local");
    });
    byId("online-preset").addEventListener("change", function () {
      applyPreset(byId("online-preset").value);
    });

    bindTextField(byId("online-base-url"), function () {
      onlineModelHint = "";
      onlineModelError = "";
      return onlinePatch({ baseUrl: byId("online-base-url").value.trim() });
    });
    bindTextField(byId("online-api-key"), function () {
      onlineModelHint = "";
      onlineModelError = "";
      return onlinePatch({ apiKey: byId("online-api-key").value });
    });
    byId("online-model").addEventListener("change", function () {
      selectOnlineModel(byId("online-model").value);
    });
    byId("fetch-online-models").addEventListener("click", fetchOnlineModels);
    bindTextField(byId("online-model-custom"), function () {
      return onlinePatch({ model: byId("online-model-custom").value.trim() });
    });
    byId("online-model-custom").addEventListener("blur", function () {
      if (!customModelMode) {
        return;
      }
      var online = (state && state.settings.provider.online) || {};
      var value = this.value.trim();
      if (!value || value === String(online.model || "").trim()) {
        customModelMode = false;
        renderOnline();
      }
    });
    byId("api-key-toggle").addEventListener("click", function () {
      var input = byId("online-api-key");
      var shown = input.type === "text";
      input.type = shown ? "password" : "text";
      this.setAttribute("aria-pressed", shown ? "false" : "true");
      this.setAttribute("aria-label", shown ? "显示 API Key" : "隐藏 API Key");
      this.title = shown ? "显示 API Key" : "隐藏 API Key";
      input.focus();
    });
    byId("test-connection").addEventListener("click", testConnection);

    byId("download-engine").addEventListener("click", downloadEngine);
    byId("cancel-engine-download").addEventListener("click", function () {
      cancelDownload("engine");
    });
    byId("toggle-catalog").addEventListener("click", function () {
      catalogOpen = !catalogOpen;
      renderCatalog();
    });
    byId("import-model").addEventListener("click", importModel);
    byId("start-local").addEventListener("click", startLocal);
    byId("stop-local").addEventListener("click", stopLocal);
    byId("restart-local").addEventListener("click", restartLocal);
    byId("catalog-list").addEventListener("click", function (event) {
      var downloadButton =
        event.target.closest && event.target.closest("[data-catalog-download]");
      if (downloadButton) {
        downloadCatalogModel(
          downloadButton.getAttribute("data-catalog-download"),
          downloadButton
        );
        return;
      }
      var cancelButton =
        event.target.closest && event.target.closest("[data-catalog-cancel]");
      if (cancelButton) {
        cancelDownload(cancelButton.getAttribute("data-catalog-cancel"));
      }
    });

    byId("picker-enabled").addEventListener("change", function (event) {
      save({ picker: { enabled: event.target.checked } });
    });
    byId("picker-compact").addEventListener("change", function (event) {
      save({ picker: { compact: event.target.checked } });
    });
    byId("capture-hotkey").addEventListener("click", startHotkeyRecording);
    byId("capture-hotkey-restore").addEventListener("click", function () {
      if (hotkeySaving) {
        return;
      }
      hotkeyRecording = false;
      submitHotkey("Win+Shift+X");
    });
    window.addEventListener("keydown", handleHotkeyKeydown, true);
    window.addEventListener("blur", cancelHotkeyRecording);
    byId("panel-mode-scroll").addEventListener("click", function () {
      selectPanelMode("scroll");
    });
    byId("panel-mode-auto").addEventListener("click", function () {
      selectPanelMode("auto");
    });
    byId("default-target-lang").addEventListener("change", function (event) {
      save({ picker: { defaultTargetLang: event.target.value } });
    });
    byId("skill-list").addEventListener("change", function (event) {
      var input = event.target;
      var id = input && input.getAttribute("data-skill-toggle");
      if (id) {
        toggleSkill(id, input.checked);
      }
    });
    byId("skill-list").addEventListener("click", function (event) {
      var target = event.target;
      if (!target.closest) {
        return;
      }
      var promptToggle = target.closest("[data-prompt-toggle]");
      if (promptToggle) {
        togglePromptPanel(promptToggle.getAttribute("data-prompt-toggle"));
        return;
      }
      var promptReset = target.closest("[data-prompt-reset]");
      if (promptReset) {
        resetPromptValue(promptReset.getAttribute("data-prompt-reset"));
        return;
      }
      var searchConfig = target.closest("[data-search-config]");
      if (searchConfig) {
        toggleSearchPanel();
        return;
      }
      var engineOption = target.closest("[data-search-engine]");
      if (engineOption) {
        selectSearchEngine(engineOption.getAttribute("data-search-engine"));
        return;
      }
      var customEdit = target.closest("[data-custom-edit]");
      if (customEdit) {
        openCustomEditor(customEdit.getAttribute("data-custom-edit"));
        return;
      }
      var customDelete = target.closest("[data-custom-delete]");
      if (customDelete) {
        var deletedId = customDelete.getAttribute("data-custom-delete");
        armSkillDelete(customDelete, function () {
          deleteCustomSkill(deletedId);
        });
      }
    });
    byId("skill-list").addEventListener("dragstart", startSkillDrag);
    byId("skill-list").addEventListener("dragover", overSkillDrop);
    byId("skill-list").addEventListener("drop", dropSkill);
    byId("skill-list").addEventListener("dragend", clearDragMarks);

    byId("skill-tab-text").addEventListener("click", function () {
      selectSkillTab("text");
    });
    byId("skill-tab-image").addEventListener("click", function () {
      selectSkillTab("image");
    });

    byId("capture-action-list").addEventListener("change", function (event) {
      var input = event.target;
      var id = input && input.getAttribute("data-capture-toggle");
      if (id) {
        toggleCaptureSkill(id, input.checked);
      }
    });
    byId("capture-action-list").addEventListener("click", handleCaptureListClick);
    byId("capture-action-list").addEventListener("dragstart", startCaptureActionDrag);
    byId("capture-action-list").addEventListener("dragover", overCaptureActionDrop);
    byId("capture-action-list").addEventListener("drop", dropCaptureAction);
    byId("capture-action-list").addEventListener("dragend", clearCaptureDragMarks);

    byId("add-custom-skill").addEventListener("click", function () {
      openCustomEditor("");
    });
    byId("toggle-icon-picker").addEventListener("click", toggleIconPicker);
    byId("custom-skill-icons").addEventListener("click", function (event) {
      var button = event.target.closest && event.target.closest("[data-icon-key]");
      if (button) {
        chooseCustomIcon(button.getAttribute("data-icon-key"));
      }
    });
    byId("custom-skill-icon-search").addEventListener("input", function () {
      iconSearchQuery = this.value;
      renderCustomIconGrid(true);
    });
    byId("custom-skill-icon-search").addEventListener("keydown", function (event) {
      if (event.key === "Escape" && this.value) {
        event.stopPropagation();
        this.value = "";
        iconSearchQuery = "";
        renderCustomIconGrid(true);
      }
    });
    byId("custom-skill-name").addEventListener("input", function () {
      if (customDraft) {
        customDraft.label = this.value;
      }
      hideInlineError(byId("custom-skill-error"));
    });
    byId("custom-skill-prompt").addEventListener("input", function () {
      if (customDraft) {
        customDraft.prompt = this.value;
      }
      hideInlineError(byId("custom-skill-error"));
    });
    byId("custom-skill-kind-text").addEventListener("click", function () {
      selectCustomSkillKind("text");
    });
    byId("custom-skill-kind-image").addEventListener("click", function () {
      selectCustomSkillKind("image");
    });
    byId("custom-skill-editor").addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (iconPickerOpen) {
          setIconPickerOpen(false);
          return;
        }
        closeCustomEditor();
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveCustomSkill();
      }
    });
    byId("save-custom-skill").addEventListener("click", saveCustomSkill);
    byId("cancel-custom-skill").addEventListener("click", closeCustomEditor);
    byId("delete-custom-skill").addEventListener("click", function () {
      var editingId = customEditingId;
      if (!editingId) {
        return;
      }
      armSkillDelete(
        this,
        function () {
          deleteCustomSkill(editingId);
        },
        "确认删除"
      );
    });
    byId("blacklist-input").addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        addBlacklistEntry(this.value);
        return;
      }
      if (event.key === "Backspace" && !this.value) {
        var list = state.settings.picker.blacklist || [];
        if (list.length) {
          removeBlacklistEntry(list[list.length - 1]);
        }
      }
    });
    byId("blacklist-input").addEventListener("blur", function () {
      if (this.value.trim()) {
        addBlacklistEntry(this.value);
      }
    });
    byId("blacklist-chips").addEventListener("click", function (event) {
      var button =
        event.target.closest && event.target.closest("[data-blacklist-entry]");
      if (button) {
        removeBlacklistEntry(button.getAttribute("data-blacklist-entry"));
      }
    });

    byId("close-to-tray").addEventListener("change", function (event) {
      save({ app: { closeToTray: event.target.checked } });
    });
    byId("start-at-login").addEventListener("change", function (event) {
      var input = event.target;
      var enabled = input.checked;
      loginBusy = true;
      input.disabled = true;
      API.setStartAtLogin(enabled).then(function (result) {
        loginBusy = false;
        input.disabled = false;
        if (!result.ok) {
          input.checked = !enabled;
          toast("设置开机自启失败：" + (result.error || "未知错误"), "error");
          return;
        }
        if (state && state.loginItem) {
          state.loginItem.enabled = enabled;
        }
        refreshState();
      });
    });

    each(document.querySelectorAll("[data-open-dir]"), function (button) {
      button.addEventListener("click", function () {
        openDir(button.getAttribute("data-open-dir"));
      });
    });
    byId("open-data-dir").addEventListener("click", function () {
      openDir("data");
    });
    byId("open-repo").addEventListener("click", function () {
      openExternal((state && state.app && state.app.repoUrl) || LP.REPO_URL);
    });
    byId("check-update").addEventListener("click", function () {
      checkForUpdates({ automatic: false });
    });
    byId("install-update").addEventListener("click", installAppUpdate);
    byId("dismiss-update").addEventListener("click", dismissUpdate);
    byId("toggle-update-notes").addEventListener("click", toggleUpdateNotes);
    byId("update-notes-text").addEventListener("click", function (event) {
      var link = event.target && event.target.closest
        ? event.target.closest("a[data-external]")
        : null;
      if (!link) {
        return;
      }
      event.preventDefault();
      var href = String(link.getAttribute("href") || "");
      if (/^https?:\/\//i.test(href)) {
        openExternal(href);
      }
    });
    byId("reset-settings").addEventListener("click", function () {
      armDanger(byId("reset-settings"), "确认恢复默认", resetSettings);
    });
    byId("quit-app").addEventListener("click", function () {
      armDanger(byId("quit-app"), "确认退出", quitApp);
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        flushAllTextFields();
      }
    });
    window.addEventListener("blur", flushAllTextFields);
  }

  /* ---- Download progress ---------------------------------------------- */

  function handleDownloadProgress(progress) {
    if (!progress || typeof progress !== "object") {
      return;
    }
    var active = isActiveDownload(progress);
    var kind = String(progress.kind || "model");
    mergeProgressIntoDownloads(progress);
    if (kind === "engine") {
      /* Re-render the engine header/progress from the downloads array. */
      renderLocal();
    } else {
      renderCatalog();
    }
    if (!active) {
      if (progress.status === "failed") {
        if (kind === "engine") {
          showInlineError(byId("local-error"), progress.error || "引擎下载失败");
        } else {
          toast("下载失败：" + (progress.error || "未知错误"), "error");
        }
      }
      refreshState();
    }
  }

  function handleStateChanged(payload) {
    applyState(payload);
  }

  function handleToast(payload) {
    if (payload && payload.message) {
      toast(payload.message, payload.type);
    }
  }

  /* ---- Boot ------------------------------------------------------------ */

  // Only retry Tauri's transient startup registration error. Other failures
  // retain the existing error handling and produce a single toast in boot.
  function getInitialState() {
    var delays = [100, 250, 500];
    function attempt(index) {
      if (initialStateSettled) {
        return Promise.resolve(null);
      }
      return API.getState().then(function (result) {
        if (initialStateSettled) {
          return null;
        }
        if (result.ok || !/state not managed/i.test(String(result.error || "")) || index >= delays.length) {
          return result;
        }
        return new Promise(function (resolve) {
          window.setTimeout(resolve, delays[index]);
        }).then(function () {
          return attempt(index + 1);
        });
      });
    }
    return attempt(0);
  }

  function boot() {
    fillSelect(
      byId("online-preset"),
      LP.PRESETS.map(function (preset) {
        return { value: preset.id, label: preset.label };
      })
    );
    fillSelect(byId("default-target-lang"), LP.TARGET_LANGS);

    bindEvents();

    API.onState(handleStateChanged);
    API.onDownloadProgress(handleDownloadProgress);
    API.onToast(handleToast);
    if (typeof API.onUpdateAvailable === "function") {
      API.onUpdateAvailable(function (info) {
        if (!info || info.ok === false) {
          return;
        }
        updateInfo = info;
        updateNotesExpanded = false;
        updateState = info.hasUpdate ? "available" : "latest";
        renderUpdate();
      });
    }
    /* Progress is only emitted while installing; subscribing once is enough
     * for the lifetime of the settings window. */
    if (typeof API.onUpdateProgress === "function") {
      API.onUpdateProgress(handleUpdateProgress);
    }
    renderUpdate();

    getInitialState().then(function (result) {
      if (initialStateSettled || !result) {
        return;
      }
      initialStateSettled = true;
      if (!result.ok) {
        toast("读取设置失败：" + (result.error || "未知错误"), "error");
        return;
      }
      applyState(result.state);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
