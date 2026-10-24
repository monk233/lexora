/* LingoPick settings renderer.
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

  var SKILL_IDS = ["translate", "summarize", "explain", "read", "copy"];
  var DEFAULT_SKILLS = SKILL_IDS.slice();

  var state = null;
  var saveQueue = null;
  var saving = false;
  var saveStatusTimer = null;
  var textTimers = {};
  var textFields = [];
  var catalogOpen = false;
  var recording = null;
  var localBusy = false;
  var loginBusy = false;

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
    if (saving || !saveQueue) {
      return;
    }
    var patch = saveQueue;
    saveQueue = null;
    saving = true;
    setSaveStatus("saving");
    API.updateSettings(patch).then(function (result) {
      saving = false;
      if (!result.ok) {
        setSaveStatus("error", "保存失败");
        toast("保存失败：" + (result.error || "未知错误"), "error");
        refreshState();
      } else {
        if (!saveQueue) {
          setSaveStatus("saved");
        }
        applyState(result.state);
      }
      flushSaveQueue();
    });
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
    setInputValue(byId("online-model"), online.model || "");
  }

  function emptyOption(label) {
    var option = document.createElement("option");
    option.value = "";
    option.textContent = label;
    return option;
  }

  function renderLocal() {
    var engine = state.engine || {};
    var settings = state.settings.provider.local || {};
    var download = state.download;
    var engineDownload =
      download && download.kind === "engine" ? download : null;
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

    var models = state.models || [];
    var modelSelect = byId("local-model");
    if (modelSelect) {
      var signature = models
        .map(function (model) {
          return model.file;
        })
        .join("|");
      if (modelSelect.getAttribute("data-signature") !== signature) {
        modelSelect.setAttribute("data-signature", signature);
        modelSelect.innerHTML = "";
        if (!models.length) {
          modelSelect.appendChild(emptyOption("未安装本地模型"));
        } else {
          modelSelect.appendChild(emptyOption("未选择模型"));
          models.forEach(function (model) {
            var option = document.createElement("option");
            option.value = model.file;
            option.textContent =
              model.name + "（" + LP.formatBytes(model.sizeBytes) + "）";
            modelSelect.appendChild(option);
          });
        }
      }
      setSelectValue(modelSelect, settings.modelFile || "");
    }

    var modelHint = byId("local-model-hint");
    if (modelHint) {
      if (!models.length) {
        modelHint.hidden = false;
        modelHint.textContent =
          "还没有本地模型：展开「模型目录」下载，或点击「导入 GGUF」选择本机文件。";
      } else {
        modelHint.hidden = true;
      }
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

  function renderLocalState() {
    var engine = state.engine || {};
    var localState = engine.localState || "stopped";
    var badge = byId("local-state-badge");
    var startButton = byId("start-local");
    var stopButton = byId("stop-local");

    var tone = "muted";
    var label = "未启动";
    if (localState === "starting") {
      tone = "warn";
      label = "启动中…";
    } else if (localState === "ready") {
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

    var running = localState === "ready" || localState === "starting";
    setHidden(startButton, running);
    setHidden(stopButton, !running);
    if (startButton) {
      startButton.disabled = localBusy;
      startButton.textContent = localState === "starting" ? "启动中…" : "启动";
    }
    if (stopButton) {
      stopButton.disabled = localBusy;
    }

    var errorNode = byId("local-error");
    if (errorNode && engine.localError) {
      showInlineError(errorNode, engine.localError);
    }
  }

  function catalogRow(entry) {
    var row = el("li", "catalog-item");
    row.setAttribute("data-catalog-id", entry.id);
    row.setAttribute("data-installed", entry.installed ? "1" : "0");

    var main = el("div", "catalog-main");
    var name = el("div", "catalog-name");
    name.appendChild(el("span", null, entry.name || entry.id));
    if (entry.recommended) {
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
    var download = state.download;
    var activeId =
      download &&
      download.kind === "model" &&
      (download.status === "downloading" || download.status === "verifying")
        ? download.id
        : "";
    var signature =
      catalog
        .map(function (entry) {
          return entry.id + ":" + (entry.installed ? 1 : 0);
        })
        .join("|") +
      "#" +
      activeId;
    if (signature !== list.getAttribute("data-signature")) {
      list.setAttribute("data-signature", signature);
      list.innerHTML = "";
      catalog.forEach(function (entry) {
        list.appendChild(catalogRow(entry));
      });
    }
    updateCatalogProgress(download);
  }

  function updateCatalogProgress(progress) {
    each(byId("catalog-list").querySelectorAll(".catalog-item"), function (row) {
      var id = row.getAttribute("data-catalog-id");
      var installed = row.getAttribute("data-installed") === "1";
      var progressWrap = row.querySelector(".catalog-progress");
      var fill = row.querySelector(".catalog-progress .progress-fill");
      var text = row.querySelector(".catalog-progress-text");
      var downloadButton = row.querySelector("[data-catalog-download]");
      var cancelButton = row.querySelector("[data-catalog-cancel]");
      var installedBadge = row.querySelector("[data-catalog-installed]");
      var active =
        !!progress &&
        progress.kind === "model" &&
        progress.id === id &&
        (progress.status === "downloading" || progress.status === "verifying");
      if (active) {
        var percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
        if (progressWrap) {
          progressWrap.hidden = false;
        }
        if (fill) {
          fill.style.width = percent + "%";
        }
        if (text) {
          text.textContent =
            progress.status === "verifying" ? "校验中…" : Math.round(percent) + "%";
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
    if (!recording) {
      var shortcut = picker.shortcut || "Ctrl+Shift+D";
      var valueNode = byId("shortcut-value");
      if (valueNode && valueNode.textContent !== shortcut) {
        valueNode.textContent = shortcut;
      }
    }
    setSelectValue(byId("default-target-lang"), picker.defaultTargetLang || "auto");
    renderSkills();
    renderBlacklist();
  }

  function renderSkills(force) {
    var list = byId("skill-list");
    if (!list) {
      return;
    }
    var enabled = Array.isArray(state.settings.picker.skills)
      ? state.settings.picker.skills.slice()
      : DEFAULT_SKILLS.slice();
    var order = enabled.concat(
      SKILL_IDS.filter(function (id) {
        return enabled.indexOf(id) < 0;
      })
    );
    var signature = order
      .map(function (id) {
        return id + ":" + (enabled.indexOf(id) >= 0 ? 1 : 0);
      })
      .join(",");
    if (!force && signature === list.getAttribute("data-signature")) {
      return;
    }
    list.setAttribute("data-signature", signature);
    list.innerHTML = "";
    order.forEach(function (id) {
      list.appendChild(skillRow(id, enabled.indexOf(id) >= 0, enabled.length));
    });
  }

  function skillRow(id, enabled, enabledCount) {
    var meta = (LP.SKILL_MAP && LP.SKILL_MAP[id]) || { label: id, description: "" };
    var row = el("li", "skill-item" + (enabled ? "" : " is-disabled"));
    row.setAttribute("data-skill", id);

    var main = el("div", "skill-main");
    main.appendChild(el("span", "skill-name", meta.label));
    if (meta.description) {
      main.appendChild(el("span", "skill-desc", meta.description));
    }
    row.appendChild(main);

    var order = el("div", "skill-order");
    var up = el("button", "order-btn");
    up.type = "button";
    up.setAttribute("data-move", "-1");
    up.setAttribute("aria-label", "上移" + meta.label);
    up.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"></path></svg>';
    var down = el("button", "order-btn");
    down.type = "button";
    down.setAttribute("data-move", "1");
    down.setAttribute("aria-label", "下移" + meta.label);
    down.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 10 6 6 6-6"></path></svg>';
    var enabledIndex = enabled
      ? Array.prototype.indexOf.call(
          (state.settings.picker.skills || DEFAULT_SKILLS),
          id
        )
      : -1;
    up.disabled = enabledIndex <= 0;
    down.disabled = enabledIndex < 0 || enabledIndex >= enabledCount - 1;
    order.appendChild(up);
    order.appendChild(down);
    row.appendChild(order);

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
    row.appendChild(toggle);

    return row;
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
          "便携版不写入开机启动项，避免在系统里留下注册表记录。如需开机自启，可创建 LingoPick.exe 的快捷方式并放入 shell:startup 目录。";
      }
    } else {
      if (hint) {
        hint.textContent = "登录 Windows 后在托盘中静默启动";
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
    var preset = LP.presetFor(presetId);
    if (!preset || preset.id === "custom") {
      save({ provider: { online: { preset: presetId || "custom" } } });
      return;
    }
    hideInlineError(byId("test-error"));
    var badge = byId("test-badge");
    if (badge) {
      badge.hidden = true;
    }
    save({
      provider: {
        online: {
          preset: preset.id,
          baseUrl: preset.baseUrl,
          model: preset.model,
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
    var model = byId("online-model").value.trim();
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
                "」。可用模型：" +
                result.models.slice(0, 6).join("、")
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

  function cancelDownload() {
    API.cancelDownload().then(function () {
      refreshState();
    });
  }

  function downloadCatalogModel(id, button) {
    if (state && state.download) {
      toast("当前已有下载任务在进行，请等待完成或取消", "info");
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

  function startLocal() {
    if (localBusy) {
      return;
    }
    localBusy = true;
    hideInlineError(byId("local-error"));
    renderLocalState();
    API.startLocal().then(function (result) {
      localBusy = false;
      if (!result.ok) {
        showInlineError(
          byId("local-error"),
          result.error || "启动本地引擎失败",
          result.hint || ""
        );
        refreshState();
        return;
      }
      refreshState();
    });
  }

  function stopLocal() {
    if (localBusy) {
      return;
    }
    localBusy = true;
    renderLocalState();
    API.stopLocal().then(function (result) {
      localBusy = false;
      if (!result.ok) {
        showInlineError(byId("local-error"), result.error || "停止本地引擎失败");
        return;
      }
      hideInlineError(byId("local-error"));
      refreshState();
    });
  }

  function toggleSkill(id, enabled) {
    var skills = Array.isArray(state.settings.picker.skills)
      ? state.settings.picker.skills.slice()
      : DEFAULT_SKILLS.slice();
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

  function moveSkill(id, delta) {
    var skills = Array.isArray(state.settings.picker.skills)
      ? state.settings.picker.skills.slice()
      : DEFAULT_SKILLS.slice();
    var index = skills.indexOf(id);
    if (index < 0) {
      return;
    }
    var next = index + delta;
    if (next < 0 || next >= skills.length) {
      return;
    }
    var moved = skills.splice(index, 1)[0];
    skills.splice(next, 0, moved);
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

  /* ---- Shortcut recorder ----------------------------------------------- */

  function shortcutModifiers(event) {
    var parts = [];
    if (event.ctrlKey) {
      parts.push("Ctrl");
    }
    if (event.altKey) {
      parts.push("Alt");
    }
    if (event.shiftKey) {
      parts.push("Shift");
    }
    return parts;
  }

  function shortcutKey(event) {
    var code = String(event.code || "");
    var match = /^Key([A-Z])$/.exec(code);
    if (match) {
      return match[1];
    }
    match = /^Digit([0-9])$/.exec(code);
    if (match) {
      return match[1];
    }
    match = /^F([1-9]|1[0-2])$/.exec(code);
    if (match) {
      return "F" + match[1];
    }
    return "";
  }

  function startRecording() {
    if (recording) {
      return;
    }
    recording = { previous: state.settings.picker.shortcut || "Ctrl+Shift+D" };
    byId("shortcut-input").classList.add("is-recording");
    byId("shortcut-value").textContent = "请按下组合键…";
    byId("shortcut-edit").textContent = "Esc 取消";
    hideInlineError(byId("shortcut-hint"));
    document.addEventListener("keydown", onRecordingKeydown, true);
  }

  function stopRecording(cancelled) {
    if (!recording) {
      return;
    }
    var previous = recording.previous;
    recording = null;
    document.removeEventListener("keydown", onRecordingKeydown, true);
    byId("shortcut-input").classList.remove("is-recording");
    byId("shortcut-edit").textContent = "点击修改";
    if (cancelled) {
      byId("shortcut-value").textContent = previous;
    }
  }

  function onRecordingKeydown(event) {
    if (!recording) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording(true);
      return;
    }
    var modifiers = shortcutModifiers(event);
    var key = shortcutKey(event);
    if (!key) {
      var preview = modifiers.length
        ? modifiers.join("+") + " + …"
        : "请按下组合键…";
      byId("shortcut-value").textContent = preview;
      if (modifiers.length) {
        hideInlineError(byId("shortcut-hint"));
      }
      return;
    }
    if (!modifiers.length) {
      showInlineError(
        byId("shortcut-hint"),
        "快捷键至少需要 Ctrl、Alt 或 Shift 中的一个"
      );
      return;
    }
    var value = modifiers.concat([key]).join("+");
    stopRecording(false);
    byId("shortcut-value").textContent = value;
    hideInlineError(byId("shortcut-hint"));
    save({ picker: { shortcut: value } });
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
      return onlinePatch({ baseUrl: byId("online-base-url").value.trim() });
    });
    bindTextField(byId("online-api-key"), function () {
      return onlinePatch({ apiKey: byId("online-api-key").value });
    });
    bindTextField(byId("online-model"), function () {
      return onlinePatch({ model: byId("online-model").value.trim() });
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
    byId("cancel-engine-download").addEventListener("click", cancelDownload);
    byId("toggle-catalog").addEventListener("click", function () {
      catalogOpen = !catalogOpen;
      renderCatalog();
    });
    byId("import-model").addEventListener("click", importModel);
    byId("start-local").addEventListener("click", startLocal);
    byId("stop-local").addEventListener("click", stopLocal);
    byId("local-model").addEventListener("change", function (event) {
      hideInlineError(byId("local-error"));
      save({ provider: { local: { modelFile: event.target.value } } });
    });
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
        cancelDownload();
      }
    });

    byId("picker-enabled").addEventListener("change", function (event) {
      save({ picker: { enabled: event.target.checked } });
    });
    byId("picker-compact").addEventListener("change", function (event) {
      save({ picker: { compact: event.target.checked } });
    });
    byId("default-target-lang").addEventListener("change", function (event) {
      save({ picker: { defaultTargetLang: event.target.value } });
    });
    byId("shortcut-input").addEventListener("click", function () {
      if (recording) {
        stopRecording(true);
      } else {
        startRecording();
      }
    });
    document.addEventListener(
      "mousedown",
      function (event) {
        if (!recording) {
          return;
        }
        var box = byId("shortcut-input");
        if (box && box.contains(event.target)) {
          return;
        }
        stopRecording(true);
      },
      true
    );
    byId("skill-list").addEventListener("change", function (event) {
      var input = event.target;
      var id = input && input.getAttribute("data-skill-toggle");
      if (id) {
        toggleSkill(id, input.checked);
      }
    });
    byId("skill-list").addEventListener("click", function (event) {
      var button =
        event.target.closest && event.target.closest("[data-move]");
      if (!button) {
        return;
      }
      var row = button.closest("[data-skill]");
      if (!row) {
        return;
      }
      moveSkill(row.getAttribute("data-skill"), Number(button.getAttribute("data-move")));
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
    if (!progress) {
      return;
    }
    var active =
      progress.status === "downloading" || progress.status === "verifying";
    if (state) {
      state.download = active ? progress : null;
    }
    if (progress.kind === "engine") {
      renderEngineProgress(active ? progress : null);
      setHidden(byId("download-engine"), active);
      setHidden(byId("cancel-engine-download"), !active);
      var title = byId("engine-title");
      if (title && active) {
        title.textContent = "正在下载 llama.cpp 引擎…";
        byId("engine-sub").textContent = progress.filename || "";
      }
      if (!active && progress.status === "failed") {
        showInlineError(
          byId("local-error"),
          progress.error || "引擎下载失败"
        );
      }
    } else {
      renderCatalog();
    }
    if (!active) {
      if (progress.status === "failed") {
        if (progress.kind === "model") {
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

    API.getState().then(function (result) {
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
