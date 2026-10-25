/* Lexora screenshot overlay renderer.
 *
 * One instance runs per monitor (`capture.html?monitor=N`). The overlay window
 * stays hidden until `capture_ready` is reported (contract §10.1), so this page
 * must decode the frozen screenshot, lay out the selection UI and only then ask
 * the shell to show the window - there is no full-screen loading state.
 *
 * Coordinate systems:
 *   - CSS pixels: selection state (`state.rect`) relative to the overlay window.
 *   - Physical pixels: `captureAPI` rects, mapped through naturalWidth/clientWidth
 *     on both axes so HiDPI monitors with a scaled webview still map 1:1 to the
 *     screenshot bitmap.
 */
(function () {
  "use strict";

  var API = window.captureAPI;
  var LP = window.LP || {};

  var MIN_SIZE = 8;
  var MONITOR_RETRIES = 3;
  var MONITOR_RETRY_DELAY = 120;
  var READY_RETRIES = 3;
  var READY_RETRY_DELAY = 150;
  var EDGE_PAD = 10;
  var BAR_GAP = 8;
  var HINT_VISIBLE_MS = 3200;
  var HINT_FADE_MS = 420;
  var TOAST_MS = 4200;

  var state = {
    monitor: readMonitorIndex(),
    shot: null,
    shotReady: false,
    readySignaled: false,
    preset: null,
    imageWidth: 0,
    imageHeight: 0,
    rect: null,
    viewWidth: 0,
    viewHeight: 0,
    drag: null,
    busy: false,
    closed: false,
    targetLang: "auto",
    hintTimer: 0,
    hintFadeTimer: 0,
    toastTimer: 0
  };

  var dom = {};
  var handles = [];

  /* Test/debug hook used by the CDP checks in tests/ and manual QA. */
  window.__captureState = state;

  /* ---- Small helpers --------------------------------------------------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function each(list, callback) {
    Array.prototype.slice.call(list || []).forEach(callback);
  }

  function setHidden(node, hidden) {
    if (node) {
      node.hidden = !!hidden;
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function round(value) {
    return Math.round(Number(value) || 0);
  }

  function positiveNumber(value) {
    var number = Number(value);
    return isFinite(number) && number > 0 ? number : 0;
  }

  function cloneRect(rect) {
    if (!rect) {
      return null;
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
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

  function makeRequestId() {
    if (typeof LP.makeId === "function") {
      return LP.makeId("capture");
    }
    return (
      "capture-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
    );
  }

  function pointFromEvent(event) {
    var size = viewportSize();
    return {
      x: clamp(Number(event.clientX) || 0, 0, size.width),
      y: clamp(Number(event.clientY) || 0, 0, size.height)
    };
  }

  function pointInRect(point, rect) {
    if (!rect) {
      return false;
    }
    return (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    );
  }

  function rectFromPoints(start, end) {
    var left = Math.min(start.x, end.x);
    var top = Math.min(start.y, end.y);
    var right = Math.max(start.x, end.x);
    var bottom = Math.max(start.y, end.y);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function movedRect(origin, deltaX, deltaY) {
    var size = viewportSize();
    return {
      x: clamp(origin.x + deltaX, 0, Math.max(0, size.width - origin.width)),
      y: clamp(origin.y + deltaY, 0, Math.max(0, size.height - origin.height)),
      width: origin.width,
      height: origin.height
    };
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

  function afterPaint(callback) {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(callback);
      });
      return;
    }
    window.setTimeout(callback, 16);
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
    dom.error = byId("capture-error");
    dom.errorText = byId("capture-error-text");
    dom.errorRetry = byId("capture-error-retry");
    dom.errorClose = byId("capture-error-close");
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
    beginCapture();
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
      dom.bar.addEventListener("click", onBarClick);
    }
    if (dom.preset) {
      dom.preset.addEventListener("click", onPresetClick);
    }
    if (dom.errorRetry) {
      dom.errorRetry.addEventListener("click", beginCapture);
    }
    if (dom.errorClose) {
      dom.errorClose.addEventListener("click", cancelCapture);
    }
  }

  function loadTargetLanguage() {
    var api = window.settingsAPI;
    if (!api || typeof api.getState !== "function") {
      return;
    }
    api.getState().then(
      function (result) {
        var payload = result && (result.state || result);
        var picker = payload && payload.settings && payload.settings.picker;
        if (picker && picker.defaultTargetLang) {
          state.targetLang = String(picker.defaultTargetLang);
        }
      },
      function () {
        /* keep "auto" */
      }
    );
  }

  /* ---- Screenshot loading (no visible loading UI, §10.1) --------------- */

  function beginCapture() {
    state.closed = false;
    state.shot = null;
    state.shotReady = false;
    state.readySignaled = false;
    state.preset = null;
    state.imageWidth = 0;
    state.imageHeight = 0;
    state.rect = null;
    state.drag = null;
    state.busy = false;
    state.viewWidth = 0;
    state.viewHeight = 0;
    hideSelectionUi();
    hideErrorBar();
    hideToast();
    if (!API || typeof API.monitor !== "function") {
      showLoadError({ error: "截图服务不可用，请重启 Lexora 后再试。" });
      return;
    }
    requestMonitor(0);
  }

  function requestMonitor(attempt) {
    if (state.closed) {
      return;
    }
    var request;
    try {
      request = API.monitor(state.monitor);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (state.closed) {
          return;
        }
        if (result && result.ok && result.dataUrl) {
          paintShot(result);
          return;
        }
        if (attempt < MONITOR_RETRIES) {
          retryMonitor(attempt + 1);
          return;
        }
        showLoadError(result);
      },
      function (error) {
        if (state.closed) {
          return;
        }
        if (attempt < MONITOR_RETRIES) {
          retryMonitor(attempt + 1);
          return;
        }
        showLoadError({ error: errorText(error) });
      }
    );
  }

  function retryMonitor(attempt) {
    window.setTimeout(function () {
      requestMonitor(attempt);
    }, MONITOR_RETRY_DELAY);
  }

  function paintShot(result) {
    state.shot = result || {};
    state.preset = normalizePreset(result);
    state.imageWidth = positiveNumber(result && result.width);
    state.imageHeight = positiveNumber(result && result.height);
    state.shotReady = false;

    dom.shot.onload = onShotLoaded;
    dom.shot.onerror = function () {
      if (state.shotReady || state.closed) {
        return;
      }
      showLoadError({ error: "截图加载失败" });
    };
    dom.shot.removeAttribute("src");
    dom.shot.src = String(result.dataUrl);
    if (dom.shot.complete && dom.shot.naturalWidth > 0) {
      onShotLoaded();
    }
  }

  function normalizePreset(result) {
    var preset = result && result.preset;
    if (preset && preset.skillId) {
      return { skillId: String(preset.skillId), label: String(preset.label || "") };
    }
    return null;
  }

  function onShotLoaded() {
    if (state.shotReady || state.closed) {
      return;
    }
    state.shotReady = true;
    var size = viewportSize();
    state.imageWidth =
      dom.shot.naturalWidth || state.imageWidth || size.width;
    state.imageHeight =
      dom.shot.naturalHeight || state.imageHeight || size.height;
    state.rect = { x: 0, y: 0, width: size.width, height: size.height };
    state.viewWidth = size.width;
    state.viewHeight = size.height;
    state.drag = null;

    hideErrorBar();
    setHidden(dom.shot, false);
    setHidden(dom.mask, false);
    setHidden(dom.selection, false);
    setHidden(dom.size, false);
    setHidden(dom.bar, false);
    renderPresetButton();
    updateBarState();
    render();
    showHint();
    afterPaint(function () {
      signalReady();
    });
  }

  function renderPresetButton() {
    var preset = state.preset;
    var visible = !!(preset && preset.skillId);
    setHidden(dom.preset, !visible);
    setHidden(dom.presetSep, !visible);
    if (visible && dom.presetLabel) {
      dom.presetLabel.textContent = String(preset.label || "图片技能");
    }
  }

  /* Ask the shell to show this overlay window. Retried a few times because the
   * window must only become visible with the screenshot already painted. */
  function signalReady() {
    if (state.closed) {
      return;
    }
    requestReady(0);
  }

  function requestReady(attempt) {
    if (state.closed) {
      return;
    }
    if (!API || typeof API.ready !== "function") {
      state.readySignaled = true;
      return;
    }
    var request;
    try {
      request = API.ready(state.monitor);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (result && result.ok) {
          state.readySignaled = true;
          return;
        }
        if (attempt < READY_RETRIES) {
          window.setTimeout(function () {
            requestReady(attempt + 1);
          }, READY_RETRY_DELAY);
          return;
        }
        state.readySignaled = true;
      },
      function () {
        if (attempt < READY_RETRIES) {
          window.setTimeout(function () {
            requestReady(attempt + 1);
          }, READY_RETRY_DELAY);
          return;
        }
        state.readySignaled = true;
      }
    );
  }

  function showLoadError(result) {
    if (state.closed) {
      return;
    }
    hideSelectionUi();
    state.rect = null;
    state.shotReady = false;
    state.drag = null;
    document.body.classList.remove("is-dragging", "is-over-selection");

    var detail = result && (result.error || result.hint);
    if (detail && String(detail) !== "截图加载失败") {
      dom.errorText.textContent = "截图加载失败：" + String(detail);
    } else {
      dom.errorText.textContent = "截图加载失败";
    }

    if (!API || typeof API.ready !== "function") {
      setHidden(dom.error, false);
      return;
    }
    requestReadyThen(0, function () {
      setHidden(dom.error, false);
    });
  }

  function requestReadyThen(attempt, callback) {
    if (state.closed) {
      return;
    }
    var request;
    try {
      request = API.ready(state.monitor);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (result && result.ok) {
          state.readySignaled = true;
          callback();
          return;
        }
        retryReadyThen(attempt, callback);
      },
      function () {
        retryReadyThen(attempt, callback);
      }
    );
  }

  function retryReadyThen(attempt, callback) {
    if (attempt < READY_RETRIES) {
      window.setTimeout(function () {
        requestReadyThen(attempt + 1, callback);
      }, READY_RETRY_DELAY);
      return;
    }
    state.readySignaled = true;
    callback();
  }

  function hideSelectionUi() {
    setHidden(dom.shot, true);
    setHidden(dom.mask, true);
    setHidden(dom.selection, true);
    setHidden(dom.size, true);
    setHidden(dom.bar, true);
    hideHint();
  }

  function hideErrorBar() {
    setHidden(dom.error, true);
  }

  /* ---- Rendering ------------------------------------------------------- */

  function render() {
    if (!state.rect) {
      return;
    }
    updateMask();
    updateSelection();
    updateSizeLabel();
    layoutBar();
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

  function layoutBar() {
    if (!dom.bar || dom.bar.hidden || !state.rect) {
      return;
    }
    var size = viewportSize();
    var rect = state.rect;
    var barWidth = dom.bar.offsetWidth || 380;
    var barHeight = dom.bar.offsetHeight || 40;
    var maxLeft = Math.max(EDGE_PAD, size.width - barWidth - EDGE_PAD);
    var left = clamp(rect.x + rect.width - barWidth, EDGE_PAD, maxLeft);

    var below = rect.y + rect.height + BAR_GAP;
    var above = rect.y - barHeight - BAR_GAP;
    var top;
    if (below + barHeight <= size.height - EDGE_PAD) {
      top = below;
    } else if (above >= EDGE_PAD) {
      top = above;
    } else {
      top = clamp(
        rect.y + rect.height - barHeight - BAR_GAP,
        EDGE_PAD,
        Math.max(EDGE_PAD, size.height - barHeight - EDGE_PAD)
      );
    }
    dom.bar.style.left = Math.round(left) + "px";
    dom.bar.style.top = Math.round(top) + "px";
  }

  /* ---- Hint / toast ---------------------------------------------------- */

  function showHint() {
    if (!dom.hint) {
      return;
    }
    window.clearTimeout(state.hintTimer);
    window.clearTimeout(state.hintFadeTimer);
    dom.hint.hidden = false;
    dom.hint.classList.remove("is-fading");
    state.hintTimer = window.setTimeout(function () {
      if (!dom.hint) {
        return;
      }
      dom.hint.classList.add("is-fading");
      state.hintFadeTimer = window.setTimeout(function () {
        if (dom.hint) {
          dom.hint.hidden = true;
          dom.hint.classList.remove("is-fading");
        }
      }, HINT_FADE_MS);
    }, HINT_VISIBLE_MS);
  }

  function hideHint() {
    if (!dom.hint || dom.hint.hidden) {
      return;
    }
    window.clearTimeout(state.hintTimer);
    window.clearTimeout(state.hintFadeTimer);
    dom.hint.hidden = true;
    dom.hint.classList.remove("is-fading");
  }

  function toast(message, tone, duration) {
    if (!dom.toast) {
      return;
    }
    dom.toast.textContent = String(message || "");
    dom.toast.setAttribute("data-tone", tone || "info");
    dom.toast.hidden = false;
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () {
      if (dom.toast) {
        dom.toast.hidden = true;
      }
    }, duration || TOAST_MS);
  }

  function hideToast() {
    if (!dom.toast) {
      return;
    }
    window.clearTimeout(state.toastTimer);
    dom.toast.hidden = true;
  }

  /* ---- Interactions ---------------------------------------------------- */

  function isUiTarget(target) {
    if (!target || !target.closest) {
      return false;
    }
    return !!target.closest(
      ".capture-bar, .capture-error-bar, .selection-handle"
    );
  }

  function canInteract() {
    return !state.closed && state.shotReady && !!state.rect;
  }

  function onMouseDown(event) {
    if (event.button !== 0 || !canInteract() || state.drag) {
      return;
    }
    if (isUiTarget(event.target)) {
      return;
    }
    event.preventDefault();
    hideHint();
    setHidden(dom.bar, true);

    var point = pointFromEvent(event);
    var inside = pointInRect(point, state.rect);
    state.drag = inside
      ? { mode: "move", start: point, origin: cloneRect(state.rect) }
      : { mode: "draw", start: point, previous: cloneRect(state.rect) };
    document.body.classList.add("is-dragging");
    document.body.classList.toggle("is-over-selection", inside);
    if (!inside) {
      state.rect = { x: point.x, y: point.y, width: 0, height: 0 };
    }
    render();
  }

  function onHandleMouseDown(event) {
    if (event.button !== 0 || !canInteract() || state.drag) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hideHint();
    setHidden(dom.bar, true);
    document.body.classList.remove("is-over-selection");
    document.body.classList.add("is-dragging");
    state.drag = {
      mode: "resize",
      dir: this.getAttribute("data-dir") || "se",
      start: pointFromEvent(event),
      origin: cloneRect(state.rect)
    };
  }

  function onMouseMove(event) {
    var point = pointFromEvent(event);
    if (state.drag) {
      if (state.drag.mode === "move") {
        state.rect = movedRect(
          state.drag.origin,
          point.x - state.drag.start.x,
          point.y - state.drag.start.y
        );
      } else if (state.drag.mode === "draw") {
        state.rect = rectFromPoints(state.drag.start, point);
      } else {
        state.rect = resizeRectFromDrag(state.drag, point);
      }
      render();
      return;
    }
    if (!canInteract()) {
      document.body.classList.remove("is-over-selection");
      return;
    }
    document.body.classList.toggle(
      "is-over-selection",
      pointInRect(point, state.rect)
    );
  }

  function onMouseUp(event) {
    if (!state.drag) {
      return;
    }
    var drag = state.drag;
    state.drag = null;
    document.body.classList.remove("is-dragging");
    if (
      drag.mode === "draw" &&
      (!state.rect || state.rect.width < MIN_SIZE || state.rect.height < MIN_SIZE)
    ) {
      state.rect = drag.previous;
    }
    setHidden(dom.bar, false);
    updateBarState();
    render();
    if (event && typeof event.clientX === "number") {
      document.body.classList.toggle(
        "is-over-selection",
        pointInRect(pointFromEvent(event), state.rect)
      );
    }
  }

  function onWindowResize() {
    if (!state.rect) {
      return;
    }
    var size = viewportSize();
    /* Ignore transient degenerate viewports (window restore, headless
     * screenshot emulation): scaling the selection from a 1x1 frame would
     * blow it back up to the whole screen. */
    if (size.width < 32 || size.height < 32) {
      return;
    }
    if (state.viewWidth >= 32 && state.viewHeight >= 32) {
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
      onMouseUp(null);
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
    return false;
  }

  /* ---- Actions --------------------------------------------------------- */

  function onBarClick(event) {
    var button =
      event.target && event.target.closest
        ? event.target.closest("[data-action]")
        : null;
    if (!button || button.disabled) {
      return;
    }
    handleAction(button.getAttribute("data-action"));
  }

  function onPresetClick() {
    if (!state.preset || !canInteract() || state.busy) {
      return;
    }
    runSkill("custom", state.preset.skillId);
  }

  function handleAction(action) {
    if (action === "copy") {
      copyImage();
    } else if (action === "ocr" || action === "translate" || action === "explain") {
      runSkill(action, "");
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
    if (state.closed) {
      return;
    }
    state.closed = true;
    state.drag = null;
    document.body.classList.remove("is-dragging", "is-over-selection");
    if (API && typeof API.close === "function") {
      try {
        API.close();
      } catch (error) {
        /* the window is going away; nothing to report */
      }
    }
  }

  function failureText(result, fallback) {
    var message = (result && result.error) || fallback;
    var hint = (result && result.hint) || "";
    return hint ? message + "：" + hint : message;
  }

  function copyImage() {
    if (!canInteract() || state.busy) {
      return;
    }
    if (!API || typeof API.copy !== "function") {
      toast("截图服务不可用，请重启 Lexora 后再试", "error", TOAST_MS);
      return;
    }
    state.busy = true;
    updateBarState();
    var request;
    try {
      request = API.copy(state.monitor, physicalRect());
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (state.closed) {
          return;
        }
        state.busy = false;
        updateBarState();
        if (result && result.ok) {
          /* The shell copies the crop and closes every overlay; no toast. */
          return;
        }
        toast("复制失败：" + failureText(result, "未知错误"), "error", TOAST_MS);
      },
      function (error) {
        if (state.closed) {
          return;
        }
        state.busy = false;
        updateBarState();
        toast("复制失败：" + errorText(error), "error", TOAST_MS);
      }
    );
  }

  function runSkill(action, skillId) {
    if (!canInteract() || state.busy) {
      return;
    }
    if (!API || typeof API.skill !== "function") {
      toast("截图服务不可用，请重启 Lexora 后再试", "error", TOAST_MS);
      return;
    }
    state.busy = true;
    updateBarState();
    var request;
    try {
      request = API.skill(
        makeRequestId(),
        state.monitor,
        physicalRect(),
        action,
        skillId || "",
        state.targetLang || "auto"
      );
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (state.closed) {
          return;
        }
        state.busy = false;
        updateBarState();
        if (result && result.ok) {
          /* The shell closed the overlay and opened the picker result panel. */
          return;
        }
        toast("处理失败：" + failureText(result, "请求失败"), "error", TOAST_MS);
      },
      function (error) {
        if (state.closed) {
          return;
        }
        state.busy = false;
        updateBarState();
        toast("处理失败：" + errorText(error), "error", TOAST_MS);
      }
    );
  }

  /* ---- Boot ------------------------------------------------------------ */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
