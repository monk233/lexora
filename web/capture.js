/* Lexora screenshot overlay renderer.
 *
 * One instance runs per monitor (`capture.html?monitor=N`). The page waits for
 * the shared capture backend to expose the frozen screenshot, paints it as a
 * full-window image, and lets the user pick a region with a dimming mask. The
 * floating action bar then copies the region, extracts its text (OCR) or sends
 * it to the online vision model (translate / explain / custom image skill).
 *
 * Coordinate systems:
 *   - CSS pixels: selection state (`state.rect`) relative to the overlay window.
 *   - Physical pixels: `captureAPI` rects, derived from naturalWidth/clientWidth
 *     so HiDPI monitors with a scaled webview still map 1:1 to the screenshot.
 */
(function () {
  "use strict";

  var API = window.captureAPI;
  var LP = window.LP || {};

  var MIN_SIZE = 8;
  var POLL_INTERVAL = 120;
  var POLL_ATTEMPTS = 60;
  var PANEL_WIDTH = 430;
  var EDGE_PAD = 10;
  var BAR_GAP = 10;
  var PANEL_GAP = 12;

  var state = {
    monitor: readMonitorIndex(),
    shot: null,
    shotReady: false,
    preset: null,
    imageWidth: 0,
    imageHeight: 0,
    rect: null,
    viewWidth: 0,
    viewHeight: 0,
    drag: null,
    busy: false,
    finished: false,
    panel: null,
    panelPlacement: "",
    panelRenderQueued: false,
    barHeight: 42,
    targetLang: "auto",
    hintTimer: null,
    toastTimer: null
  };

  var dom = {};
  var handles = [];

  /* ---- Small helpers --------------------------------------------------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function each(list, callback) {
    Array.prototype.slice.call(list || []).forEach(callback);
  }

  function setHidden(node, hidden) {
    if (node) {
      node.hidden = !!hidden;
    }
  }

  function clearNode(node) {
    if (!node) {
      return;
    }
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function round(value) {
    return Math.round(Number(value) || 0);
  }

  function readMonitorIndex() {
    var match = /[?&]monitor=(\d+)/.exec(window.location.search || "");
    return match ? Math.max(0, parseInt(match[1], 10) || 0) : 0;
  }

  function viewportWidth() {
    return Math.max(
      1,
      document.documentElement.clientWidth || window.innerWidth || 1
    );
  }

  function viewportHeight() {
    return Math.max(
      1,
      document.documentElement.clientHeight || window.innerHeight || 1
    );
  }

  function viewportSize() {
    return { width: viewportWidth(), height: viewportHeight() };
  }

  function cloneRect(rect) {
    if (!rect) {
      return null;
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function errorText(error) {
    if (!error) {
      return "未知错误";
    }
    if (typeof error === "string") {
      return error;
    }
    if (typeof error.message === "string" && error.message) {
      return error.message;
    }
    return String(error);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  function renderMarkdown(text) {
    if (typeof LP.renderMarkdown === "function") {
      return LP.renderMarkdown(text);
    }
    return escapeHtml(text);
  }

  function markdownToPlain(text) {
    if (typeof LP.markdownToPlain === "function") {
      return LP.markdownToPlain(text);
    }
    return String(text == null ? "" : text);
  }

  function makeRequestId() {
    if (typeof LP.makeId === "function") {
      return LP.makeId("capture");
    }
    return "capture-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function languageLabel() {
    var lang = String(state.targetLang || "auto");
    if (lang === "auto") {
      return "自动识别";
    }
    if (LP.LANG_LABELS && LP.LANG_LABELS[lang]) {
      return LP.LANG_LABELS[lang];
    }
    return lang;
  }

  /* ---- DOM cache + boot ------------------------------------------------ */

  function cacheDom() {
    dom.shot = byId("capture-shot");
    dom.mask = byId("capture-mask");
    dom.maskTop = byId("mask-top");
    dom.maskLeft = byId("mask-left");
    dom.maskRight = byId("mask-right");
    dom.maskBottom = byId("mask-bottom");
    dom.selection = byId("capture-selection");
    dom.size = byId("selection-size");
    dom.hint = byId("capture-hint");
    dom.bar = byId("capture-bar");
    dom.preset = byId("capture-preset");
    dom.presetSep = byId("capture-preset-sep");
    dom.presetLabel = byId("capture-preset-label");
    dom.panel = byId("capture-panel");
    dom.panelTitle = byId("capture-panel-title");
    dom.panelBadge = byId("capture-panel-badge");
    dom.panelCopy = byId("capture-panel-copy");
    dom.panelClose = byId("capture-panel-close");
    dom.panelBody = byId("capture-panel-body");
    dom.panelFoot = byId("capture-panel-foot");
    dom.panelStatus = byId("capture-panel-status");
    dom.panelRetry = byId("capture-panel-retry");
    dom.status = byId("capture-status");
    dom.statusSpinner = byId("capture-status-spinner");
    dom.statusText = byId("capture-status-text");
    dom.statusActions = byId("capture-status-actions");
    dom.statusRetry = byId("capture-status-retry");
    dom.statusClose = byId("capture-status-close");
    dom.toast = byId("capture-toast");
    handles = Array.prototype.slice.call(
      document.querySelectorAll(".selection-handle")
    );
  }

  function boot() {
    cacheDom();
    if (!dom.shot || !dom.selection) {
      return;
    }
    bindEvents();
    loadTargetLanguage();
    if (!API || typeof API.monitor !== "function") {
      showStatusError("截图服务不可用，请重启 Lexora 后再试。", false);
      return;
    }
    if (typeof API.onEvent === "function") {
      API.onEvent(handleCaptureEvent);
    }
    beginLoading();
  }

  function bindEvents() {
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onWindowBlur);

    each(handles, function (handle) {
      handle.addEventListener("mousedown", onHandleMouseDown);
    });

    if (dom.bar) {
      dom.bar.addEventListener("click", function (event) {
        var button = event.target.closest && event.target.closest("[data-action]");
        if (!button) {
          return;
        }
        handleAction(button.getAttribute("data-action"));
      });
    }
    if (dom.preset) {
      dom.preset.addEventListener("click", function () {
        if (!state.preset || state.busy) {
          return;
        }
        runAi("custom", state.preset.skillId, state.preset.label || "识别图片");
      });
    }
    if (dom.panelCopy) {
      dom.panelCopy.addEventListener("click", copyPanelResult);
    }
    if (dom.panelClose) {
      dom.panelClose.addEventListener("click", closePanel);
    }
    if (dom.panelRetry) {
      dom.panelRetry.addEventListener("click", retryPanel);
    }
    if (dom.statusRetry) {
      dom.statusRetry.addEventListener("click", retryMonitor);
    }
    if (dom.statusClose) {
      dom.statusClose.addEventListener("click", cancelCapture);
    }
  }

  function loadTargetLanguage() {
    var api = window.settingsAPI;
    if (!api || typeof api.getState !== "function") {
      return;
    }
    api.getState().then(
      function (result) {
        if (
          result &&
          result.ok &&
          result.state &&
          result.state.settings &&
          result.state.settings.picker &&
          result.state.settings.picker.defaultTargetLang
        ) {
          state.targetLang = String(result.state.settings.picker.defaultTargetLang);
        }
      },
      function () {
        /* keep "auto" */
      }
    );
  }

  /* ---- Loading the screenshot ----------------------------------------- */

  function beginLoading() {
    state.finished = false;
    state.busy = false;
    state.panel = null;
    state.drag = null;
    state.rect = null;
    state.panelPlacement = "";
    setHidden(dom.panel, true);
    setHidden(dom.shot, true);
    setHidden(dom.mask, true);
    setHidden(dom.selection, true);
    setHidden(dom.size, true);
    setHidden(dom.bar, true);
    hideHint();
    setStatus("正在截取屏幕…", true);
    pollMonitor(0);
  }

  function pollMonitor(attempt) {
    API.monitor(state.monitor).then(
      function (result) {
        if (state.finished) {
          return;
        }
        if (result && result.ok && result.dataUrl) {
          showShot(result);
          return;
        }
        if (attempt + 1 >= POLL_ATTEMPTS) {
          var message = (result && result.error) || "截图尚未准备好";
          var hint = (result && result.hint) || "";
          showStatusError(hint ? message + "\n" + hint : message, true);
          return;
        }
        window.setTimeout(function () {
          pollMonitor(attempt + 1);
        }, POLL_INTERVAL);
      },
      function (error) {
        if (state.finished) {
          return;
        }
        if (attempt + 1 >= POLL_ATTEMPTS) {
          showStatusError("无法获取截图：" + errorText(error), true);
          return;
        }
        window.setTimeout(function () {
          pollMonitor(attempt + 1);
        }, POLL_INTERVAL);
      }
    );
  }

  function showShot(result) {
    state.shot = result;
    state.preset = result.preset && result.preset.skillId ? result.preset : null;
    state.shotReady = false;
    dom.shot.onload = onShotLoaded;
    dom.shot.onerror = function () {
      showStatusError("截图加载失败，请重试。", true);
    };
    dom.shot.src = result.dataUrl;
    if (dom.shot.complete && dom.shot.naturalWidth > 0) {
      onShotLoaded();
    }
  }

  function onShotLoaded() {
    if (state.shotReady) {
      return;
    }
    state.shotReady = true;
    var size = viewportSize();
    state.imageWidth =
      dom.shot.naturalWidth || Number(state.shot && state.shot.width) || size.width;
    state.imageHeight =
      dom.shot.naturalHeight || Number(state.shot && state.shot.height) || size.height;
    state.rect = { x: 0, y: 0, width: size.width, height: size.height };
    state.viewWidth = size.width;
    state.viewHeight = size.height;
    state.drag = null;
    state.busy = false;
    state.finished = false;
    hideStatus();
    setHidden(dom.shot, false);
    setHidden(dom.mask, false);
    setHidden(dom.selection, false);
    setHidden(dom.size, false);
    setHidden(dom.bar, false);
    renderPresetButton();
    updateBarState();
    render();
    showHint();
  }

  function renderPresetButton() {
    var preset = state.preset;
    var visible = !!(preset && preset.label && preset.skillId);
    setHidden(dom.preset, !visible);
    setHidden(dom.presetSep, !visible);
    if (visible) {
      dom.presetLabel.textContent = String(preset.label);
    }
  }

  /* ---- Status overlay -------------------------------------------------- */

  function setStatus(text, spinner) {
    if (!dom.status) {
      return;
    }
    dom.status.hidden = false;
    dom.statusText.textContent = String(text || "");
    setHidden(dom.statusSpinner, !spinner);
    setHidden(dom.statusActions, true);
    setHidden(dom.statusRetry, true);
  }

  function showStatusError(message, retryable) {
    if (!dom.status) {
      return;
    }
    dom.status.hidden = false;
    dom.statusText.textContent = String(message || "截图失败");
    setHidden(dom.statusSpinner, true);
    setHidden(dom.statusActions, false);
    setHidden(dom.statusRetry, !retryable);
  }

  function hideStatus() {
    setHidden(dom.status, true);
  }

  function retryMonitor() {
    setStatus("正在截取屏幕…", true);
    pollMonitor(0);
  }

  /* ---- Geometry -------------------------------------------------------- */

  function pointFromEvent(event) {
    var size = viewportSize();
    return {
      x: clamp(event.clientX, 0, size.width),
      y: clamp(event.clientY, 0, size.height)
    };
  }

  function rectFromPoints(start, end) {
    var left = Math.min(start.x, end.x);
    var top = Math.min(start.y, end.y);
    var right = Math.max(start.x, end.x);
    var bottom = Math.max(start.y, end.y);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function resizeRectFromDrag(drag, point) {
    var origin = drag.origin;
    var deltaX = point.x - drag.start.x;
    var deltaY = point.y - drag.start.y;
    var size = viewportSize();
    var left = origin.x;
    var top = origin.y;
    var right = origin.x + origin.width;
    var bottom = origin.y + origin.height;
    var dir = drag.dir;

    if (dir.indexOf("w") >= 0) {
      left = clamp(origin.x + deltaX, 0, right - MIN_SIZE);
    }
    if (dir.indexOf("e") >= 0) {
      right = clamp(origin.x + origin.width + deltaX, left + MIN_SIZE, size.width);
    }
    if (dir.indexOf("n") >= 0) {
      top = clamp(origin.y + deltaY, 0, bottom - MIN_SIZE);
    }
    if (dir.indexOf("s") >= 0) {
      bottom = clamp(origin.y + origin.height + deltaY, top + MIN_SIZE, size.height);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function physicalRect() {
    var size = viewportSize();
    var imageWidth = state.imageWidth || size.width;
    var imageHeight = state.imageHeight || size.height;
    var scaleX = imageWidth / size.width;
    var scaleY = imageHeight / size.height;
    var rect = state.rect || { x: 0, y: 0, width: size.width, height: size.height };
    var x = clamp(round(rect.x * scaleX), 0, Math.max(0, imageWidth - 1));
    var y = clamp(round(rect.y * scaleY), 0, Math.max(0, imageHeight - 1));
    var width = clamp(round(rect.width * scaleX), 1, Math.max(1, imageWidth - x));
    var height = clamp(round(rect.height * scaleY), 1, Math.max(1, imageHeight - y));
    return { x: x, y: y, width: width, height: height };
  }

  /* ---- Rendering ------------------------------------------------------- */

  function render() {
    if (!state.rect) {
      return;
    }
    updateMask();
    updateSelection();
    updateSizeLabel();
    layoutBarAndPanel();
  }

  function setBox(node, left, top, width, height) {
    if (!node) {
      return;
    }
    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";
    node.style.width = Math.max(0, Math.round(width)) + "px";
    node.style.height = Math.max(0, Math.round(height)) + "px";
  }

  function updateMask() {
    var rect = state.rect;
    var size = viewportSize();
    setBox(dom.maskTop, 0, 0, size.width, rect.y);
    setBox(dom.maskLeft, 0, rect.y, rect.x, rect.height);
    setBox(
      dom.maskRight,
      rect.x + rect.width,
      rect.y,
      size.width - (rect.x + rect.width),
      rect.height
    );
    setBox(
      dom.maskBottom,
      0,
      rect.y + rect.height,
      size.width,
      size.height - (rect.y + rect.height)
    );
  }

  function updateSelection() {
    var rect = state.rect;
    if (dom.selection) {
      dom.selection.style.left = Math.round(rect.x) + "px";
      dom.selection.style.top = Math.round(rect.y) + "px";
      dom.selection.style.width = Math.round(rect.width) + "px";
      dom.selection.style.height = Math.round(rect.height) + "px";
    }
    var centerX = rect.width / 2;
    var centerY = rect.height / 2;
    setHandle("nw", 0, 0);
    setHandle("n", centerX, 0);
    setHandle("ne", rect.width, 0);
    setHandle("e", rect.width, centerY);
    setHandle("se", rect.width, rect.height);
    setHandle("s", centerX, rect.height);
    setHandle("sw", 0, rect.height);
    setHandle("w", 0, centerY);
  }

  function setHandle(dir, localLeft, localTop) {
    var size = viewportSize();
    var left =
      clamp(state.rect.x + localLeft, 6, Math.max(6, size.width - 6)) - state.rect.x;
    var top =
      clamp(state.rect.y + localTop, 6, Math.max(6, size.height - 6)) - state.rect.y;
    for (var index = 0; index < handles.length; index += 1) {
      var handle = handles[index];
      if (handle.getAttribute("data-dir") === dir) {
        handle.style.left = Math.round(left) + "px";
        handle.style.top = Math.round(top) + "px";
        return;
      }
    }
  }

  function updateSizeLabel() {
    if (!dom.size) {
      return;
    }
    var physical = physicalRect();
    dom.size.textContent = physical.width + " × " + physical.height;
    var size = viewportSize();
    var labelWidth = dom.size.offsetWidth || 88;
    var labelHeight = dom.size.offsetHeight || 22;
    var left = clamp(state.rect.x, 4, Math.max(4, size.width - labelWidth - 4));
    var top = state.rect.y - labelHeight - 8;
    if (top < 4) {
      top = state.rect.y + 8;
    }
    if (top + labelHeight > size.height - 4) {
      top = clamp(
        state.rect.y - labelHeight - 8,
        4,
        Math.max(4, size.height - labelHeight - 4)
      );
    }
    dom.size.style.left = Math.round(left) + "px";
    dom.size.style.top = Math.round(top) + "px";
  }

  function decidePanelPlacement(size) {
    var rect = state.rect;
    var spaceBelow = size.height - (rect.y + rect.height) - PANEL_GAP;
    var spaceAbove = rect.y - PANEL_GAP;
    if (spaceBelow >= 180) {
      return "below";
    }
    if (spaceAbove >= 180) {
      return "above";
    }
    if (spaceBelow >= 120 && spaceBelow >= spaceAbove) {
      return "below";
    }
    if (spaceAbove >= 120) {
      return "above";
    }
    return "cramped";
  }

  function computeBarPosition(placement, size) {
    var rect = state.rect;
    var barWidth = dom.bar.offsetWidth || 380;
    var barHeight = dom.bar.offsetHeight || state.barHeight || 42;
    var roomAbove = rect.y >= barHeight + BAR_GAP + EDGE_PAD;
    var roomBelow =
      size.height - (rect.y + rect.height) >= barHeight + BAR_GAP + EDGE_PAD;
    var place;
    if (placement === "above") {
      place = roomBelow ? "below" : "inside-bottom";
    } else if (placement === "cramped") {
      place = "viewport-bottom";
    } else if (placement === "below") {
      place = roomAbove ? "above" : "inside-bottom";
    } else if (roomBelow) {
      place = "below";
    } else if (roomAbove) {
      place = "above";
    } else {
      place = "inside-bottom";
    }

    var top;
    if (place === "below") {
      top = rect.y + rect.height + BAR_GAP;
    } else if (place === "above") {
      top = rect.y - barHeight - BAR_GAP;
    } else if (place === "inside-bottom") {
      top = rect.y + rect.height - barHeight - BAR_GAP;
    } else {
      top = size.height - barHeight - EDGE_PAD;
    }
    top = clamp(top, EDGE_PAD, Math.max(EDGE_PAD, size.height - barHeight - EDGE_PAD));
    var left = clamp(
      rect.x + rect.width - barWidth,
      EDGE_PAD,
      Math.max(EDGE_PAD, size.width - barWidth - EDGE_PAD)
    );
    return { left: left, top: top, width: barWidth, height: barHeight };
  }

  function positionPanel(placement, size) {
    if (!dom.panel) {
      return;
    }
    var rect = state.rect;
    var panelWidth = Math.min(
      PANEL_WIDTH,
      Math.max(260, size.width - 2 * PANEL_GAP)
    );
    dom.panel.style.width = Math.round(panelWidth) + "px";
    var left = clamp(
      rect.x + rect.width - panelWidth,
      PANEL_GAP,
      Math.max(PANEL_GAP, size.width - panelWidth - PANEL_GAP)
    );
    dom.panel.style.left = Math.round(left) + "px";
    dom.panel.style.top = "";
    dom.panel.style.bottom = "";
    dom.panel.style.maxHeight = "";

    if (placement === "below") {
      var top = rect.y + rect.height + PANEL_GAP;
      dom.panel.style.top = Math.round(top) + "px";
      dom.panel.style.maxHeight =
        Math.max(120, Math.round(size.height - top - PANEL_GAP)) + "px";
    } else if (placement === "above") {
      var bottom = Math.round(size.height - (rect.y - PANEL_GAP));
      dom.panel.style.bottom = Math.max(PANEL_GAP, bottom) + "px";
      dom.panel.style.maxHeight =
        Math.max(120, Math.round(rect.y - 2 * PANEL_GAP)) + "px";
    } else {
      var barHeight = state.barHeight || 42;
      dom.panel.style.top = PANEL_GAP + "px";
      dom.panel.style.maxHeight =
        Math.max(120, Math.round(size.height - barHeight - 40 - PANEL_GAP)) + "px";
    }
  }

  function layoutBarAndPanel() {
    if (!dom.bar || dom.bar.hidden || !state.rect) {
      return;
    }
    var size = viewportSize();
    var barHeight = dom.bar.offsetHeight || 42;
    state.barHeight = barHeight;
    var placement = state.panel ? decidePanelPlacement(size) : "";
    state.panelPlacement = placement;
    var position = computeBarPosition(placement, size);
    dom.bar.style.left = Math.round(position.left) + "px";
    dom.bar.style.top = Math.round(position.top) + "px";
    if (state.panel) {
      positionPanel(placement, size);
    }
  }

  /* ---- Hint / toast ---------------------------------------------------- */

  function showHint() {
    if (!dom.hint) {
      return;
    }
    dom.hint.hidden = false;
    dom.hint.classList.remove("is-fading");
    window.clearTimeout(state.hintTimer);
    state.hintTimer = window.setTimeout(hideHint, 3200);
  }

  function hideHint() {
    if (!dom.hint || dom.hint.hidden) {
      return;
    }
    window.clearTimeout(state.hintTimer);
    dom.hint.classList.add("is-fading");
    window.setTimeout(function () {
      if (dom.hint) {
        dom.hint.hidden = true;
        dom.hint.classList.remove("is-fading");
      }
    }, 420);
  }

  function toast(message, tone, duration) {
    if (!dom.toast) {
      return;
    }
    dom.toast.textContent = String(message || "");
    dom.toast.setAttribute("data-tone", tone || "info");
    dom.toast.hidden = false;
    window.clearTimeout(state.toastTimer);
    if (duration !== 0) {
      state.toastTimer = window.setTimeout(function () {
        if (dom.toast) {
          dom.toast.hidden = true;
        }
      }, duration || 2600);
    }
  }

  /* ---- Drag / resize interactions -------------------------------------- */

  function isUiTarget(target) {
    if (!target || !target.closest) {
      return false;
    }
    return !!target.closest(
      ".capture-bar, .capture-panel, .capture-status, .selection-handle"
    );
  }

  function onMouseDown(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    if (state.finished || !state.rect || !dom.status.hidden) {
      return;
    }
    if (isUiTarget(event.target)) {
      return;
    }
    event.preventDefault();
    if (state.panel) {
      closePanel();
    }
    var point = pointFromEvent(event);
    state.drag = {
      mode: "draw",
      start: point,
      previous: cloneRect(state.rect)
    };
    document.body.classList.add("is-dragging");
    setHidden(dom.bar, true);
    hideHint();
    state.rect = { x: point.x, y: point.y, width: 0, height: 0 };
    render();
  }

  function onHandleMouseDown(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    if (state.finished || !state.rect || !dom.status.hidden) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (state.panel) {
      closePanel();
    }
    state.drag = {
      mode: "resize",
      dir: this.getAttribute("data-dir") || "se",
      start: pointFromEvent(event),
      origin: cloneRect(state.rect)
    };
    document.body.classList.add("is-dragging");
    setHidden(dom.bar, true);
    hideHint();
  }

  function onMouseMove(event) {
    if (!state.drag || !state.rect) {
      return;
    }
    var point = pointFromEvent(event);
    if (state.drag.mode === "draw") {
      state.rect = rectFromPoints(state.drag.start, point);
    } else {
      state.rect = resizeRectFromDrag(state.drag, point);
    }
    render();
  }

  function onMouseUp() {
    if (!state.drag) {
      return;
    }
    var drag = state.drag;
    state.drag = null;
    document.body.classList.remove("is-dragging");
    if (drag.mode === "draw") {
      if (
        !state.rect ||
        state.rect.width < MIN_SIZE ||
        state.rect.height < MIN_SIZE
      ) {
        state.rect = drag.previous;
      }
    }
    setHidden(dom.bar, false);
    updateBarState();
    render();
  }

  function onWindowResize() {
    if (!state.rect) {
      return;
    }
    var size = viewportSize();
    if (state.viewWidth > 0 && state.viewHeight > 0) {
      var scaleX = size.width / state.viewWidth;
      var scaleY = size.height / state.viewHeight;
      state.rect = {
        x: state.rect.x * scaleX,
        y: state.rect.y * scaleY,
        width: state.rect.width * scaleX,
        height: state.rect.height * scaleY
      };
    }
    state.viewWidth = size.width;
    state.viewHeight = size.height;
    state.rect.x = clamp(state.rect.x, 0, Math.max(0, size.width - MIN_SIZE));
    state.rect.y = clamp(state.rect.y, 0, Math.max(0, size.height - MIN_SIZE));
    state.rect.width = clamp(state.rect.width, MIN_SIZE, size.width - state.rect.x);
    state.rect.height = clamp(state.rect.height, MIN_SIZE, size.height - state.rect.y);
    render();
  }

  function onWindowBlur() {
    if (state.drag) {
      onMouseUp();
    }
  }

  function onKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    cancelCapture();
  }

  function onContextMenu(event) {
    event.preventDefault();
  }

  /* ---- Actions --------------------------------------------------------- */

  function handleAction(action) {
    if (action === "copy") {
      copyImage();
    } else if (action === "ocr") {
      runOcr();
    } else if (action === "translate") {
      runAi("translate", "", "翻译");
    } else if (action === "explain") {
      runAi("explain", "", "解释图片");
    } else if (action === "cancel") {
      cancelCapture();
    }
  }

  function updateBarState() {
    if (!dom.bar) {
      return;
    }
    each(dom.bar.querySelectorAll("[data-action]"), function (button) {
      var action = button.getAttribute("data-action");
      button.disabled = state.busy && action !== "cancel";
    });
    if (dom.preset) {
      dom.preset.disabled = state.busy;
    }
  }

  function cancelCapture() {
    if (state.finished) {
      return;
    }
    if (state.drag) {
      state.drag = null;
      document.body.classList.remove("is-dragging");
      setHidden(dom.bar, false);
    }
    closePanel();
    if (API && typeof API.close === "function") {
      API.close();
    }
  }

  function finishCapture(message) {
    state.finished = true;
    state.busy = false;
    closePanel();
    setHidden(dom.mask, true);
    setHidden(dom.selection, true);
    setHidden(dom.size, true);
    setHidden(dom.bar, true);
    hideHint();
    toast(message || "已完成", "success", 0);
    if (API && typeof API.close === "function") {
      API.close();
    }
  }

  function copyImage() {
    if (state.busy || state.finished || !state.rect) {
      return;
    }
    state.busy = true;
    updateBarState();
    API.copy(state.monitor, physicalRect()).then(function (result) {
      if (result && result.ok) {
        finishCapture("已复制到剪贴板");
        return;
      }
      state.busy = false;
      updateBarState();
      var message = (result && (result.error || result.hint)) || "未知错误";
      toast("复制失败：" + message, "error", 4200);
    });
  }

  function runOcr() {
    if (state.busy || state.finished || !state.rect) {
      return;
    }
    closePanel();
    var panel = openPanel({
      kind: "ocr",
      title: "提取文字",
      action: "ocr"
    });
    state.busy = true;
    updateBarState();
    var rect = physicalRect();
    API.ocr(state.monitor, rect).then(function (result) {
      if (state.panel !== panel) {
        return;
      }
      state.busy = false;
      updateBarState();
      if (result && result.ok) {
        var text = String(result.text == null ? "" : result.text);
        if (!text.trim()) {
          panel.status = "error";
          panel.error = "没有识别到文字";
          panel.hint =
            (result && result.hint) || "换一个区域，或直接使用「翻译」/「解释图片」。";
        } else {
          panel.status = "done";
          panel.text = text;
        }
      } else {
        panel.status = "error";
        panel.error = (result && result.error) || "文字识别失败";
        panel.hint = (result && result.hint) || "";
      }
      renderPanel();
    });
  }

  function runAi(action, skillId, title) {
    if (state.busy || state.finished || !state.rect) {
      return;
    }
    closePanel();
    var badge = action === "translate" ? "→ " + languageLabel() : "";
    var panel = openPanel({
      kind: "ai",
      title: title || "AI 处理",
      action: action,
      skillId: skillId || "",
      badge: badge
    });
    panel.requestId = makeRequestId();
    state.busy = true;
    updateBarState();
    var rect = physicalRect();
    API.ai(
      panel.requestId,
      state.monitor,
      rect,
      panel.action,
      panel.skillId,
      state.targetLang
    ).then(function (result) {
      if (state.panel !== panel) {
        return;
      }
      if (result && result.ok) {
        return;
      }
      panel.status = "error";
      panel.error = (result && result.error) || "请求失败";
      panel.hint = (result && result.hint) || "";
      state.busy = false;
      updateBarState();
      renderPanel();
    });
  }

  function retryPanel() {
    var panel = state.panel;
    if (!panel) {
      return;
    }
    if (panel.kind === "ocr") {
      runOcr();
    } else {
      runAi(panel.action, panel.skillId, panel.title);
    }
  }

  /* ---- Result panel ---------------------------------------------------- */

  function openPanel(options) {
    var panel = {
      kind: options.kind || "ai",
      title: options.title || "结果",
      badge: options.badge || "",
      action: options.action || "",
      skillId: options.skillId || "",
      requestId: "",
      text: "",
      error: "",
      hint: "",
      status: "loading"
    };
    state.panel = panel;
    dom.panelTitle.textContent = panel.title;
    dom.panelBadge.textContent = panel.badge;
    setHidden(dom.panelBadge, !panel.badge);
    dom.panelCopy.disabled = true;
    setHidden(dom.panelRetry, true);
    setHidden(dom.panelFoot, true);
    clearNode(dom.panelBody);
    renderPanel();
    setHidden(dom.panel, false);
    render();
    return panel;
  }

  function closePanel() {
    if (!state.panel) {
      return;
    }
    state.panel = null;
    state.panelPlacement = "";
    setHidden(dom.panel, true);
    clearNode(dom.panelBody);
    state.busy = false;
    updateBarState();
    render();
  }

  function loadingNode(text) {
    var wrap = el("div", "capture-loading");
    wrap.appendChild(el("span", "capture-spinner"));
    wrap.appendChild(el("span", null, text));
    return wrap;
  }

  function errorNode(message, hint) {
    var wrap = el("div", "capture-error", message || "处理失败");
    if (hint) {
      wrap.appendChild(el("p", "capture-error-hint", hint));
    }
    return wrap;
  }

  function renderPanel() {
    var panel = state.panel;
    if (!panel) {
      return;
    }
    clearNode(dom.panelBody);

    if (panel.status === "loading") {
      dom.panelBody.appendChild(
        loadingNode(panel.kind === "ocr" ? "正在识别文字…" : "正在处理…")
      );
    } else {
      if (panel.kind === "ai" && panel.text) {
        var markdown = el(
          "div",
          "capture-markdown" + (panel.status === "streaming" ? " is-streaming" : "")
        );
        markdown.innerHTML = renderMarkdown(panel.text);
        dom.panelBody.appendChild(markdown);
      } else if (panel.kind !== "ai" && panel.text) {
        dom.panelBody.appendChild(el("pre", "capture-text", panel.text));
      }
      if (panel.status === "error") {
        dom.panelBody.appendChild(errorNode(panel.error, panel.hint));
      }
    }

    var hasText = !!(panel.text && panel.text.trim());
    dom.panelCopy.disabled = panel.status !== "done" || !hasText;

    if (panel.status === "loading") {
      setHidden(dom.panelFoot, true);
      setHidden(dom.panelRetry, true);
    } else if (panel.status === "streaming") {
      setHidden(dom.panelFoot, false);
      setHidden(dom.panelRetry, true);
      dom.panelStatus.textContent = "生成中…";
    } else if (panel.status === "error") {
      setHidden(dom.panelFoot, false);
      setHidden(dom.panelRetry, false);
      dom.panelStatus.textContent = "处理失败";
    } else {
      setHidden(dom.panelFoot, true);
      setHidden(dom.panelRetry, true);
    }

    if (panel.status === "loading" || panel.status === "streaming") {
      dom.panelBody.scrollTop = dom.panelBody.scrollHeight;
    }
  }

  function schedulePanelRender() {
    if (state.panelRenderQueued) {
      return;
    }
    state.panelRenderQueued = true;
    var run = function () {
      state.panelRenderQueued = false;
      renderPanel();
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 16);
    }
  }

  function handleCaptureEvent(payload) {
    if (!payload) {
      return;
    }
    var panel = state.panel;
    if (!panel || !panel.requestId || payload.requestId !== panel.requestId) {
      return;
    }
    var type = payload.type;
    if (type === "chunk") {
      panel.text += String(payload.text == null ? "" : payload.text);
      if (panel.status === "loading") {
        panel.status = "streaming";
      }
      schedulePanelRender();
    } else if (type === "error") {
      panel.status = "error";
      panel.error = payload.message || "处理失败";
      panel.hint = payload.hint || "";
      state.busy = false;
      updateBarState();
      renderPanel();
    } else if (type === "done") {
      if (panel.status !== "error") {
        panel.status = "done";
      }
      state.busy = false;
      updateBarState();
      renderPanel();
    }
  }

  function panelResultText() {
    var panel = state.panel;
    if (!panel || !panel.text) {
      return "";
    }
    return panel.kind === "ai" ? markdownToPlain(panel.text) : panel.text;
  }

  function copyPanelResult() {
    var text = panelResultText();
    if (!text) {
      return;
    }
    copyText(text).then(function (copied) {
      if (copied) {
        toast("已复制到剪贴板", "success", 2200);
      } else {
        toast("复制失败，请手动选中文本复制", "error", 3600);
      }
    });
  }

  function copyText(text) {
    var value = String(text == null ? "" : text);
    if (!value) {
      return Promise.resolve(false);
    }
    if (window.pickerAPI && typeof window.pickerAPI.copy === "function") {
      return window.pickerAPI.copy(value).then(
        function (result) {
          return !result || result.ok !== false;
        },
        function () {
          return fallbackCopy(value);
        }
      );
    }
    return fallbackCopy(value);
  }

  function fallbackCopy(value) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(value).then(
        function () {
          return true;
        },
        function () {
          return execCopy(value);
        }
      );
    }
    return Promise.resolve(execCopy(value));
  }

  function execCopy(value) {
    var textarea = el("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.top = "-1000px";
    document.body.appendChild(textarea);
    textarea.select();
    var copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(textarea);
    return copied;
  }

  /* ---- Boot ------------------------------------------------------------ */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
