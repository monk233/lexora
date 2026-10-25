/* Lexora screenshot overlay renderer.
 *
 * One instance runs per monitor (`capture.html?monitor=N`). The overlay window
 * is created once and then reused: `capture-armed {index}` asks this page to
 * reload the frozen screenshot, and the window stays hidden until
 * `capture_ready` is reported (contract §10.1). Nothing paints before the
 * screenshot is decoded, so there is no full-screen loading state and no
 * black/white flash - the page background is fully transparent.
 *
 * Coordinate systems:
 *   - CSS pixels: selection state (`state.rect`) relative to the overlay window.
 *   - Physical pixels: `captureAPI` rects, mapped through the session's
 *     `width`/`height` (the original screenshot bitmap) so HiDPI monitors with
 *     a scaled webview still map 1:1. `naturalWidth` is only a fallback.
 */
(function () {
  "use strict";

  var API = window.captureAPI;
  var LP = window.LP || {};

  var MIN_SIZE = 8;
  /* Built-in screenshot toolbar actions. The toolbar order and the enabled set
   * come from `settings.picker.captureSkills` (contract §7.2 / §10.2); that
   * list may also reference enabled custom `kind=image` skills (ids starting
   * with `custom-`), which are rendered as buttons created at runtime. */
  var CAPTURE_ACTIONS = ["copy", "ocr", "translate", "explain"];
  var DEFAULT_CAPTURE_SKILLS = CAPTURE_ACTIONS.slice();
  var CUSTOM_SKILL_PREFIX = "custom-";
  var DEFAULT_CUSTOM_SKILL_LABEL = "图片技能";
  /* Fallback glyph for custom skills whose icon key is unknown. */
  var FALLBACK_TOOL_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"></path>' +
    "</svg>";
  /* The shell captures/encodes while the reused overlay window is being armed,
   * so the session is not necessarily ready on the first poll. Keep polling
   * with an attempt budget (~9 s at 120 ms) instead of a fixed retry count;
   * every attempt keeps its own timeout so slow IPC cannot extend it. */
  var MONITOR_POLL_INTERVAL = 120;
  var MONITOR_POLL_ATTEMPTS = 75;
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
    /* Diagnostics for tests/QA: how often the shell armed/showed this page. */
    readyCount: 0,
    armedCount: 0,
    captureGeneration: 0,
    pollAttempt: 0,
    preset: null,
    /* Effective `captureSkills` order and the custom image skill definitions
     * available to the toolbar (ids referenced by `captureSkills`). */
    captureSkills: DEFAULT_CAPTURE_SKILLS.slice(),
    customSkills: Object.create(null),
    compact: false,
    imageWidth: 0,
    imageHeight: 0,
    rect: null,
    viewWidth: 0,
    viewHeight: 0,
    drag: null,
    busy: false,
    closed: false,
    /* Annotation mode (contract §11): active drawing tool, or null when the
     * selection interactions are live again. */
    tool: null,
    longshotActive: false,
    targetLang: "auto",
    hintTimer: 0,
    hintFadeTimer: 0,
    toastTimer: 0,
    pollTimer: 0
  };

  var dom = {};
  var handles = [];
  var barButtons = {};
  /* Annotation engine instance (contract §11.3) and the tool button list. */
  var editor = null;
  var toolButtons = [];
  var longshotTimer = 0;
  var LONGSHOT_TIMEOUT_MS = 90000;

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

  /* The initial selection covers the whole viewport, so there is no room to
   * pan it. While it is full-screen, dragging inside it must start a new
   * rectangle instead ("draw"), and the `move` cursor is hidden
   * (contract §10.2: 全屏选区例外). */
  function selectionCoversViewport() {
    if (!state.rect) {
      return false;
    }
    var size = viewportSize();
    return (
      state.rect.width >= size.width - 1 && state.rect.height >= size.height - 1
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
    var called = false;
    function once() {
      if (called) {
        return;
      }
      called = true;
      callback();
    }
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(once);
      });
    }
    /* A hidden (not yet shown) window can throttle animation frames; the timer
     * guarantees `capture_ready` is still reported so the shell can show it. */
    window.setTimeout(once, 300);
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
    /* ---- Annotation layer / toolbar (contract §11.2) ---- */
    dom.canvas = byId("capture-annotations");
    dom.palette = byId("capture-palette");
    dom.toolButtons = Array.prototype.slice.call(
      document.querySelectorAll("[data-tool]")
    );
    toolButtons = dom.toolButtons;
    dom.shapeMode = byId("capture-shape-mode");
    dom.undo = byId("capture-undo");
    dom.redo = byId("capture-redo");
    dom.pin = byId("capture-pin");
    dom.longshot = byId("capture-longshot");
    dom.longshotProgress = byId("capture-longshot-progress");
    dom.longshotFrame = byId("capture-longshot-frame");
    handles = Array.prototype.slice.call(
      document.querySelectorAll(".selection-handle")
    );
    if (dom.bar) {
      barButtons = {};
      each(dom.bar.querySelectorAll("[data-action]"), function (button) {
        var action = button.getAttribute("data-action");
        if (CAPTURE_ACTIONS.indexOf(action) >= 0) {
          barButtons[action] = button;
        }
      });
      dom.barCancel = dom.bar.querySelector('[data-action="cancel"]');
      dom.barConfirm = dom.bar.querySelector('[data-action="confirm"]');
      /* The last separator sits between the configurable actions and the
       * confirm/cancel pair; it is hidden when every action is disabled. */
      var separators = dom.bar.querySelectorAll(".bar-sep");
      dom.barTailSep = separators.length
        ? separators[separators.length - 1]
        : null;
      renderCaptureBar();
    }
  }

  function boot() {
    cacheDom();
    if (!dom.shot || !dom.selection) {
      return;
    }
    initAnnotator();
    bindEvents();
    subscribeArmed();
    subscribeLongshotEvents();
    /* The arm event of the very first capture can fire before this page starts
     * listening (the shell creates the window and captures right away), so the
     * initial load must poll the session on its own. `beginCapture` also loads
     * the picker settings (target language + toolbar order). */
    beginCapture(state.monitor);
  }

  function subscribeArmed() {
    if (!API || typeof API.onArmed !== "function") {
      return;
    }
    try {
      API.onArmed(onArmed);
    } catch (error) {
      /* The page still works for the first capture without arm events. */
    }
  }

  /* The reused overlay window was armed for another capture: restart the whole
   * flow (contract §10.1). `index` identifies the monitor the shell captured. */
  function onArmed(payload) {
    if (!dom.shot) {
      return;
    }
    state.armedCount += 1;
    var index = payload && Number(payload.index);
    beginCapture(isFinite(index) && index >= 0 ? Math.floor(index) : state.monitor);
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
      dom.errorRetry.addEventListener("click", function () {
        beginCapture(state.monitor);
      });
    }
    if (dom.errorClose) {
      dom.errorClose.addEventListener("click", cancelCapture);
    }
    bindAnnotationUi();
  }

  /* Load the picker settings the overlay needs: translation target language,
   * the toolbar order/visibility (`picker.captureSkills` plus the custom image
   * skill definitions) and compact mode. Called on boot and on every capture, so
   * a changed setting reaches the reused window; a stale response from a
   * previous capture generation is ignored. */
  function loadPickerSettings(generation) {
    var api = window.settingsAPI;
    if (!api || typeof api.getState !== "function") {
      return;
    }
    api.getState().then(
      function (result) {
        if (
          typeof generation === "number" &&
          generation !== state.captureGeneration
        ) {
          return;
        }
        var payload = result && (result.state || result);
        var picker = payload && payload.settings && payload.settings.picker;
        if (!picker) {
          return;
        }
        state.compact = picker.compact === true;
        if (picker.defaultTargetLang) {
          state.targetLang = String(picker.defaultTargetLang);
        }
        applyToolbarSettings(picker.captureSkills, picker.customSkills);
      },
      function () {
        /* keep "auto", the default toolbar order and the previous compact mode */
      }
    );
  }

  /* Enabled custom image skills (`kind: "image"`) keyed by id. Only those may
   * appear in the screenshot toolbar; the text toolbar ignores them. */
  function collectCustomImageSkills(rawList) {
    var result = Object.create(null);
    each(rawList, function (entry) {
      if (!entry || typeof entry !== "object") {
        return;
      }
      var id = String(entry.id == null ? "" : entry.id)
        .trim()
        .toLowerCase();
      if (!id || id.indexOf(CUSTOM_SKILL_PREFIX) !== 0) {
        return;
      }
      if (
        String(entry.kind == null ? "" : entry.kind)
          .trim()
          .toLowerCase() !== "image"
      ) {
        return;
      }
      var label = String(entry.label == null ? "" : entry.label).trim();
      result[id] = {
        id: id,
        label: label.slice(0, 20) || DEFAULT_CUSTOM_SKILL_LABEL,
        icon: String(entry.icon == null ? "" : entry.icon).trim()
      };
    });
    return result;
  }

  /* Validate the configured toolbar list: built-in ids always pass, custom ids
   * only when the skill definition exists. Unknown values are dropped, repeats
   * are ignored and the configuration order is preserved. A missing/invalid
   * value falls back to the four default actions; an explicit empty list means
   * "no action buttons" (取消/确认 only). */
  function normalizeCaptureSkills(raw, customSkills) {
    if (!Array.isArray(raw)) {
      return DEFAULT_CAPTURE_SKILLS.slice();
    }
    var result = [];
    each(raw, function (item) {
      var value = String(item == null ? "" : item)
        .trim()
        .toLowerCase();
      if (!value || result.indexOf(value) >= 0) {
        return;
      }
      if (
        CAPTURE_ACTIONS.indexOf(value) >= 0 ||
        (customSkills && customSkills[value])
      ) {
        result.push(value);
      }
    });
    return result;
  }

  function applyToolbarSettings(rawSkills, rawCustomSkills) {
    state.customSkills = collectCustomImageSkills(rawCustomSkills);
    state.captureSkills = normalizeCaptureSkills(rawSkills, state.customSkills);
    renderCaptureBar();
  }

  /* Back to the built-in toolbar while the next capture's settings load. */
  function setToolbarSkillsDefault() {
    state.captureSkills = DEFAULT_CAPTURE_SKILLS.slice();
    state.customSkills = Object.create(null);
  }

  function skillIconMarkup(key) {
    if (LP && typeof LP.skillIconSvg === "function") {
      try {
        var svg = String(LP.skillIconSvg(key) || "");
        if (svg) {
          return svg;
        }
      } catch (error) {
        /* fall through to the generic icon */
      }
    }
    return FALLBACK_TOOL_ICON;
  }

  /* Runtime button for an enabled custom image skill. Clicks are handled by the
   * bar's delegated listener (`data-action="custom"` + `data-skill-id`). */
  function createCustomToolButton(skill) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "tool-btn tool-btn-custom";
    button.setAttribute("data-action", "custom");
    button.setAttribute("data-skill-id", skill.id);
    button.title = skill.label;
    button.setAttribute("aria-label", skill.label);
    button.innerHTML = skillIconMarkup(skill.icon) + '<span class="label"></span>';
    var icon = button.querySelector("svg");
    if (icon) {
      icon.setAttribute("class", "icon");
      icon.setAttribute("aria-hidden", "true");
    }
    var label = button.querySelector(".label");
    if (label) {
      label.textContent = skill.label;
    }
    return button;
  }

  /* Rebuild the toolbar from `state.captureSkills`/`state.customSkills`. Static
   * built-in buttons are moved, runtime custom buttons are removed and created
   * fresh (so an expired custom id never lingers), the preset button keeps the
   * leading slot (suppressing a duplicate entry for the same skill) and the tail
   * is always [separator?] [取消] [确认]. Idempotent: no re-binding, clicks are
   * delegated. */
  /* The annotation toolbar (§11.2) adds static groups around the configurable
   * actions, so the action buttons are inserted before the longshot/undo block
   * instead of being appended to the end of `#capture-bar`. */
  function usesAnnotationBar() {
    return !!(
      dom.longshot ||
      dom.canvas ||
      toolButtons.length ||
      document.querySelector("[data-tool]")
    );
  }

  function findBarActionAnchor() {
    var marker = dom.longshot || dom.undo || dom.redo;
    if (marker) {
      var node = marker;
      while (node && node.parentNode !== dom.bar) {
        node = node.parentNode;
      }
      if (node) {
        return node;
      }
    }
    if (dom.barTailSep && dom.barTailSep.parentNode === dom.bar) {
      return dom.barTailSep;
    }
    if (dom.barCancel && dom.barCancel.parentNode === dom.bar) {
      return dom.barCancel;
    }
    return null;
  }

  function renderCaptureBar() {
    if (!dom.bar) {
      return;
    }
    dom.bar.classList.toggle("compact", state.compact === true);
    /* Drop the previous runtime buttons before rebuilding. */
    each(dom.bar.querySelectorAll('[data-action="custom"]'), function (button) {
      dom.bar.removeChild(button);
    });

    var skills = Array.isArray(state.captureSkills)
      ? state.captureSkills
      : DEFAULT_CAPTURE_SKILLS;
    var presetId =
      state.preset && state.preset.skillId
        ? String(state.preset.skillId).trim().toLowerCase()
        : "";
    var customSkills = state.customSkills || Object.create(null);
    var entries = [];
    each(skills, function (id) {
      var value = String(id == null ? "" : id)
        .trim()
        .toLowerCase();
      if (!value || value === presetId) {
        /* Already rendered by the preset button at the front. */
        return;
      }
      if (CAPTURE_ACTIONS.indexOf(value) >= 0 || customSkills[value]) {
        entries.push(value);
      }
    });
    each(CAPTURE_ACTIONS, function (action) {
      setHidden(barButtons[action], entries.indexOf(action) < 0);
    });

    var annotationBar = usesAnnotationBar();
    var anchor = annotationBar ? findBarActionAnchor() : null;
    each(entries, function (id) {
      var button = barButtons[id];
      if (!button) {
        button = createCustomToolButton(customSkills[id]);
      }
      if (!button) {
        return;
      }
      setHidden(button, false);
      if (annotationBar) {
        if (anchor && anchor.parentNode === dom.bar) {
          dom.bar.insertBefore(button, anchor);
        } else {
          dom.bar.appendChild(button);
        }
        return;
      }
      dom.bar.appendChild(button);
    });

    if (!annotationBar) {
      /* Legacy toolbar (before §11.2): [preset?] actions [sep] [取消] [确认]. */
      if (dom.barTailSep) {
        setHidden(dom.barTailSep, entries.length === 0);
        dom.bar.appendChild(dom.barTailSep);
      }
      if (dom.barCancel) {
        setHidden(dom.barCancel, false);
        dom.bar.appendChild(dom.barCancel);
      }
      if (dom.barConfirm) {
        setHidden(dom.barConfirm, false);
        dom.bar.appendChild(dom.barConfirm);
      }
    }
    updateBarState();
    layoutPalette();
  }

  /* ---- Screenshot loading (no visible loading UI, §10.1) --------------- */

  /* Restart the overlay for `index`. Called on boot and for every
   * `capture-armed` event, so nothing may leak from the previous capture. */
  function beginCapture(index) {
    if (!dom.shot) {
      return;
    }
    var parsedIndex = Number(index);
    state.monitor =
      isFinite(parsedIndex) && parsedIndex >= 0
        ? Math.floor(parsedIndex)
        : state.monitor;
    state.captureGeneration += 1;
    var generation = state.captureGeneration;

    window.clearTimeout(state.pollTimer);
    state.pollTimer = 0;
    state.pollAttempt = 0;
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
    window.clearTimeout(state.hintTimer);
    window.clearTimeout(state.hintFadeTimer);
    hideSelectionUi();
    hideErrorBar();
    hideToast();
    resetShotImage();
    resetAnnotations();
    document.body.classList.remove("is-dragging", "is-over-selection");
    /* Render the default toolbar first; the (async) settings response reorders
     * it a few milliseconds later, while the window is still hidden. */
    setToolbarSkillsDefault();
    renderCaptureBar();
    /* The overlay window lives for the whole session, so refresh the picker
     * settings (target language, toolbar entries, compact mode) on every
     * capture. */
    loadPickerSettings(generation);

    if (!API || typeof API.monitor !== "function") {
      showLoadError(generation, { error: "截图服务不可用，请重启 Lexora 后再试。" });
      return;
    }
    pollMonitor(generation, 0);
  }

  function resetShotImage() {
    if (!dom.shot) {
      return;
    }
    dom.shot.onload = null;
    dom.shot.onerror = null;
    dom.shot.hidden = true;
    dom.shot.removeAttribute("src");
  }

  /* Poll the shell until the new session is ready. Encoding runs in parallel
   * with window arming, so one retry count is not enough; the attempt budget
   * bounds the wait (~9 s) and keeps a single slow IPC call from resetting it. */
  function pollMonitor(generation, attempt) {
    if (generation !== state.captureGeneration || state.closed) {
      return;
    }
    state.pollAttempt = attempt;
    var request;
    try {
      request = API.monitor(state.monitor);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (generation !== state.captureGeneration || state.closed) {
          return;
        }
        if (result && result.ok && result.dataUrl) {
          paintShot(generation, result);
          return;
        }
        scheduleMonitorPoll(generation, attempt + 1, result || {});
      },
      function (error) {
        if (generation !== state.captureGeneration || state.closed) {
          return;
        }
        scheduleMonitorPoll(generation, attempt + 1, { error: errorText(error) });
      }
    );
  }

  function scheduleMonitorPoll(generation, attempt, lastResult) {
    if (generation !== state.captureGeneration || state.closed) {
      return;
    }
    if (attempt >= MONITOR_POLL_ATTEMPTS) {
      var detail = lastResult && (lastResult.error || lastResult.hint);
      showLoadError(generation, detail ? lastResult : { error: "等待截图超时" });
      return;
    }
    state.pollTimer = window.setTimeout(function () {
      state.pollTimer = 0;
      pollMonitor(generation, attempt);
    }, MONITOR_POLL_INTERVAL);
  }

  function paintShot(generation, result) {
    if (generation !== state.captureGeneration || state.closed) {
      return;
    }
    state.shot = result || {};
    state.preset = normalizePreset(result);
    /* §10.3: width/height are the physical pixels of the original screenshot;
     * keep them as the mapping source (naturalWidth is only a fallback). */
    state.imageWidth = positiveNumber(result && result.width);
    state.imageHeight = positiveNumber(result && result.height);
    state.shotReady = false;

    dom.shot.onload = function () {
      onShotLoaded(generation);
    };
    dom.shot.onerror = function () {
      if (generation !== state.captureGeneration || state.shotReady || state.closed) {
        return;
      }
      showLoadError(generation, { error: "截图加载失败" });
    };
    dom.shot.removeAttribute("src");
    dom.shot.src = String(result.dataUrl);
    if (dom.shot.complete && dom.shot.naturalWidth > 0) {
      onShotLoaded(generation);
    }
  }

  function normalizePreset(result) {
    var preset = result && result.preset;
    if (preset && preset.skillId) {
      return { skillId: String(preset.skillId), label: String(preset.label || "") };
    }
    return null;
  }

  function onShotLoaded(generation) {
    if (generation !== state.captureGeneration || state.shotReady || state.closed) {
      return;
    }
    state.shotReady = true;
    var size = viewportSize();
    /* Physical sizes come from the session; decode sizes are only a fallback. */
    if (!state.imageWidth) {
      state.imageWidth = dom.shot.naturalWidth || size.width;
    }
    if (!state.imageHeight) {
      state.imageHeight = dom.shot.naturalHeight || size.height;
    }
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
    initAnnotator();
    if (editor) {
      editor.setSourceSize(state.imageWidth, state.imageHeight);
    }
    updateCanvasVisibility();
    renderPresetButton();
    /* The preset id arrives with the screenshot, so rebuild once more to drop a
     * duplicate entry for it from the configured toolbar. */
    renderCaptureBar();
    render();
    showHint();
    afterPaint(function () {
      signalReady(generation);
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
  function signalReady(generation) {
    if (
      generation !== state.captureGeneration ||
      state.closed ||
      state.readySignaled
    ) {
      return;
    }
    requestReady(generation, 0, null);
  }

  function requestReady(generation, attempt, onDone) {
    if (generation !== state.captureGeneration || state.closed) {
      return;
    }
    if (!API || typeof API.ready !== "function") {
      state.readySignaled = true;
      if (typeof onDone === "function") {
        onDone();
      }
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
        if (generation !== state.captureGeneration || state.closed) {
          return;
        }
        if (result && result.ok) {
          state.readySignaled = true;
          state.readyCount += 1;
          if (typeof onDone === "function") {
            onDone();
          }
          return;
        }
        retryReady(generation, attempt, onDone);
      },
      function () {
        if (generation !== state.captureGeneration || state.closed) {
          return;
        }
        retryReady(generation, attempt, onDone);
      }
    );
  }

  function retryReady(generation, attempt, onDone) {
    if (generation !== state.captureGeneration || state.closed) {
      return;
    }
    if (attempt < READY_RETRIES) {
      window.setTimeout(function () {
        requestReady(generation, attempt + 1, onDone);
      }, READY_RETRY_DELAY);
      return;
    }
    state.readySignaled = true;
    if (typeof onDone === "function") {
      onDone();
    }
  }

  function showLoadError(generation, result) {
    if (generation !== state.captureGeneration || state.closed) {
      return;
    }
    hideSelectionUi();
    resetShotImage();
    if (state.tool) {
      setTool(null);
    }
    state.rect = null;
    state.shotReady = false;
    state.drag = null;
    state.busy = false;
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
    requestReady(generation, 0, function () {
      if (generation !== state.captureGeneration || state.closed) {
        return;
      }
      setHidden(dom.error, false);
    });
  }

  function hideSelectionUi() {
    setHidden(dom.shot, true);
    setHidden(dom.mask, true);
    setHidden(dom.selection, true);
    setHidden(dom.size, true);
    setHidden(dom.bar, true);
    setHidden(dom.palette, true);
    if (dom.canvas) {
      dom.canvas.hidden = true;
    }
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
    layoutPalette();
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
    /* While a drawing tool is active the canvas owns the pointer; while a long
     * screenshot runs the overlay must not react to selection gestures. */
    if (state.tool || state.longshotActive) {
      return;
    }
    if (isUiTarget(event.target)) {
      return;
    }
    event.preventDefault();
    hideHint();
    setHidden(dom.bar, true);

    var point = pointFromEvent(event);
    /* Inside the selection = pan, except while it fills the viewport: there is
     * nothing to pan, so the drag starts a fresh rectangle at the press point
     * (contract §10.2 全屏选区例外). */
    var moving = pointInRect(point, state.rect) && !selectionCoversViewport();
    state.drag = moving
      ? { mode: "move", start: point, origin: cloneRect(state.rect) }
      : { mode: "draw", start: point, previous: cloneRect(state.rect) };
    document.body.classList.add("is-dragging");
    document.body.classList.toggle("is-over-selection", moving);
    if (!moving) {
      state.rect = { x: point.x, y: point.y, width: 0, height: 0 };
    }
    render();
  }

  function onHandleMouseDown(event) {
    if (event.button !== 0 || !canInteract() || state.drag) {
      return;
    }
    if (state.tool || state.longshotActive) {
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
    if (state.tool || state.longshotActive) {
      document.body.classList.remove("is-over-selection");
      return;
    }
    document.body.classList.toggle(
      "is-over-selection",
      pointInRect(point, state.rect) && !selectionCoversViewport()
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
        pointInRect(pointFromEvent(event), state.rect) &&
          !selectionCoversViewport()
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
    } else {
      /* The page booted with a degenerate viewport (the shell may set the
       * window size after creating it): the initial full-screen selection has
       * to follow the settled size. */
      state.rect = { x: 0, y: 0, width: size.width, height: size.height };
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
    var key = String(event.key || "");
    var target = event.target;
    var tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
    var typing =
      tag === "textarea" ||
      tag === "input" ||
      tag === "select" ||
      !!(target && target.isContentEditable);

    /* Undo/redo (§11.7) - never intercept while text is being typed. */
    if ((event.ctrlKey || event.metaKey) && !typing && editor) {
      var lower = key.toLowerCase();
      if (lower === "z" && !event.shiftKey) {
        event.preventDefault();
        editor.undo();
        return;
      }
      if (lower === "y" || (lower === "z" && event.shiftKey)) {
        event.preventDefault();
        editor.redo();
        return;
      }
    }

    if (key !== "Escape") {
      return;
    }
    event.preventDefault();
    if (state.longshotActive) {
      return;
    }
    /* Escape priority: the annotation engine already cancelled an in-progress
     * stroke or text input during its capture-phase listener. Then leave the
     * tool, and only then cancel the screenshot. */
    if (editor && state.tool) {
      setTool(null);
      editor.setTool(null);
      return;
    }
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
    handleAction(
      button.getAttribute("data-action"),
      button.getAttribute("data-skill-id") || ""
    );
  }

  function onPresetClick() {
    if (!state.preset || !canInteract() || state.busy) {
      return;
    }
    runSkill("custom", state.preset.skillId);
  }

  function handleAction(action, skillId) {
    /* "确认" accepts the crop: same flow as "复制" (the shell copies the image
     * to the clipboard and hides the overlay). */
    if (action === "copy" || action === "confirm") {
      copyImage();
    } else if (action === "ocr" || action === "translate" || action === "explain") {
      runSkill(action, "");
    } else if (action === "custom") {
      /* Runtime button of an enabled custom image skill. */
      runSkill("custom", String(skillId || ""));
    } else if (action === "pin") {
      pinImage();
    } else if (action === "longshot") {
      startLongshot();
    } else if (action === "undo") {
      if (editor) {
        editor.undo();
      }
    } else if (action === "redo") {
      if (editor) {
        editor.redo();
      }
    } else if (action === "cancel") {
      cancelCapture();
    }
  }

  function syncHistoryButtons() {
    var canAct = !state.busy && !state.longshotActive && !state.closed;
    if (dom.undo) {
      dom.undo.disabled = !canAct || !(editor && editor.canUndo());
    }
    if (dom.redo) {
      dom.redo.disabled = !canAct || !(editor && editor.canRedo());
    }
  }

  function updateBarState() {
    if (dom.bar) {
      /* Every action button (including 确认) is disabled while a command is in
       * flight; 取消 stays available so the user can always bail out. */
      each(dom.bar.querySelectorAll("[data-action]"), function (button) {
        var action = button.getAttribute("data-action");
        button.disabled = state.busy && action !== "cancel";
      });
    }
    each(toolButtons, function (button) {
      button.disabled = state.busy || state.longshotActive;
    });
    if (dom.preset) {
      dom.preset.disabled = state.busy || state.longshotActive;
    }
    syncHistoryButtons();
  }

  function closeOverlay() {
    if (state.closed) {
      return;
    }
    state.closed = true;
    state.drag = null;
    window.clearTimeout(state.pollTimer);
    state.pollTimer = 0;
    window.clearTimeout(longshotTimer);
    longshotTimer = 0;
    document.body.classList.remove(
      "is-dragging",
      "is-over-selection",
      "annotating",
      "is-longshot"
    );
    if (API && typeof API.close === "function") {
      try {
        API.close();
      } catch (error) {
        /* the window is going away; nothing to report */
      }
    }
  }

  function cancelCapture() {
    if (state.closed) {
      return;
    }
    if (state.tool) {
      setTool(null);
    }
    closeOverlay();
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
    var generation = state.captureGeneration;
    var annotations = exportAnnotations();
    var request;
    try {
      request = API.copy(state.monitor, physicalRect(), annotations);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (state.closed || generation !== state.captureGeneration) {
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
        if (state.closed || generation !== state.captureGeneration) {
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
    var generation = state.captureGeneration;
    var annotations = exportAnnotations();
    var request;
    try {
      request = API.skill(
        makeRequestId(),
        state.monitor,
        physicalRect(),
        action,
        skillId || "",
        state.targetLang || "auto",
        annotations
      );
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (state.closed || generation !== state.captureGeneration) {
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
        if (state.closed || generation !== state.captureGeneration) {
          return;
        }
        state.busy = false;
        updateBarState();
        toast("处理失败：" + errorText(error), "error", TOAST_MS);
      }
    );
  }

  /* ---- Annotation engine / palette (contract §11) ---------------------- */

  /* Which palette groups belong to which tool. Used as a fallback when the
   * palette markup does not carry `data-tools` attributes. */
  var PALETTE_ID_TOOLS = {
    "palette-colors": ["shape", "arrow", "pen", "text", "number"],
    "palette-color-input": ["shape", "arrow", "pen", "text", "number"],
    "palette-color-value": ["shape", "arrow", "pen", "text", "number"],
    "palette-width": ["shape", "arrow", "pen"],
    "palette-width-value": ["shape", "arrow", "pen"],
    "palette-fill": ["shape"],
    "palette-font-size": ["text", "number"],
    "palette-font-size-value": ["text", "number"],
    "palette-bold": ["text", "number"],
    "palette-text-bg": ["text"],
    "palette-mosaic-size": ["mosaic"],
    "palette-mosaic-size-value": ["mosaic"],
    "palette-clear": ["shape", "arrow", "pen", "text", "number", "mosaic"]
  };

  function initAnnotator() {
    if (editor) {
      return editor;
    }
    if (!dom.canvas || !dom.shot) {
      return null;
    }
    if (!window.CaptureAnnotate || typeof window.CaptureAnnotate.create !== "function") {
      return null;
    }
    try {
      editor = window.CaptureAnnotate.create({
        canvas: dom.canvas,
        image: dom.shot,
        getSelection: function () {
          return state.rect ? cloneRect(state.rect) : null;
        },
        onHistoryChange: onAnnotationHistoryChange
      });
    } catch (error) {
      editor = null;
    }
    /* Test/debug hook for the CDP checks. */
    window.__captureEditor = editor;
    return editor;
  }

  function onAnnotationHistoryChange() {
    syncHistoryButtons();
    updateCanvasVisibility();
  }

  function updateCanvasVisibility() {
    if (!dom.canvas) {
      return;
    }
    var visible =
      !!editor &&
      state.shotReady &&
      !state.closed &&
      (state.tool !== null || editor.hasAnnotations());
    dom.canvas.hidden = !visible;
  }

  /* Reset annotations and leave annotation mode when the overlay is re-armed
   * for a new capture. */
  function resetAnnotations() {
    state.tool = null;
    state.longshotActive = false;
    if (editor) {
      editor.reset();
      editor.setTool(null);
    }
    each(toolButtons, function (button) {
      button.classList.remove("is-active");
      button.setAttribute("aria-pressed", "false");
      button.disabled = false;
    });
    document.body.classList.remove("annotating", "is-longshot");
    if (dom.canvas) {
      dom.canvas.hidden = true;
    }
    setHidden(dom.palette, true);
    hideLongshotProgress();
    window.clearTimeout(longshotTimer);
    longshotTimer = 0;
    syncShapeModeControl();
  }

  function setTool(id) {
    var next = id ? String(id).trim().toLowerCase() : null;
    if (next && next === state.tool) {
      /* Clicking the active tool leaves annotation mode. */
      next = null;
    }
    state.tool = next;
    if (editor) {
      editor.setTool(next);
    }
    each(toolButtons, function (button) {
      var active = button.getAttribute("data-tool") === next;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    document.body.classList.toggle("annotating", !!next);
    document.body.classList.remove("is-over-selection");
    if (next) {
      hideHint();
    }
    updateCanvasVisibility();
    syncPalette();
  }

  function bindShapeModeNode(node) {
    var tag = node.tagName ? node.tagName.toLowerCase() : "";
    if (tag === "select") {
      node.addEventListener("change", function () {
        applyShapeMode(node.value);
      });
      return;
    }
    if (tag === "option") {
      return;
    }
    node.addEventListener("click", function (event) {
      event.preventDefault();
      applyShapeMode(
        node.getAttribute("data-shape-mode") ||
          node.getAttribute("data-value") ||
          ""
      );
    });
  }

  function bindAnnotationUi() {
    each(toolButtons, function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        setTool(button.getAttribute("data-tool"));
      });
    });
    var shapeNodes = Array.prototype.slice.call(
      document.querySelectorAll("[data-shape-mode], #capture-shape-mode")
    );
    each(shapeNodes, bindShapeModeNode);
    bindPaletteControls();
    syncShapeModeControl();
  }

  function applyShapeMode(mode) {
    if (editor) {
      editor.setShapeMode(mode);
    }
    syncShapeModeControl();
    syncPalette();
  }

  function syncShapeModeControl() {
    var node = dom.shapeMode;
    if (!node && document.querySelector) {
      node = document.querySelector("select[data-shape-mode]");
    }
    if (!node || node.value === undefined) {
      return;
    }
    var mode = editor ? editor.getOptions().shapeMode : "rect";
    node.value = mode;
  }

  function bindPaletteControls() {
    if (dom.palette) {
      dom.palette.addEventListener("click", onPaletteClick);
    }
    var colorInput = byId("palette-color-input");
    if (colorInput) {
      colorInput.addEventListener("input", function () {
        setEditorOption("color", colorInput.value);
      });
    }
    bindRange("palette-width", "width");
    bindRange("palette-font-size", "fontSize");
    bindRange("palette-mosaic-size", "mosaicSize");
  }

  function bindRange(id, optionKey) {
    var range = byId(id);
    if (!range) {
      return;
    }
    range.addEventListener("input", function () {
      setEditorOption(optionKey, range.value);
    });
  }

  function onPaletteClick(event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    if (target.closest("#palette-clear")) {
      event.preventDefault();
      clearAnnotations();
      return;
    }
    var colorNode = target.closest("[data-color]");
    if (colorNode) {
      event.preventDefault();
      setEditorOption("color", colorNode.getAttribute("data-color"));
      return;
    }
    var fillNode = target.closest("[data-fill]");
    if (fillNode) {
      event.preventDefault();
      setEditorOption("fill", fillNode.getAttribute("data-fill"));
      return;
    }
    var bgNode = target.closest("[data-bg-color]");
    if (bgNode) {
      event.preventDefault();
      setEditorOption("textBg", bgNode.getAttribute("data-bg-color") || "");
      return;
    }
    var boldNode = target.closest("#palette-bold, [data-bold]");
    if (boldNode && editor) {
      event.preventDefault();
      setEditorOption("bold", !editor.getOptions().bold);
    }
  }

  function setEditorOption(key, value) {
    if (!editor) {
      return;
    }
    editor.setOption(key, value);
    syncPalette();
  }

  function syncPalette() {
    if (!dom.palette) {
      return;
    }
    if (!state.tool || !editor) {
      setHidden(dom.palette, true);
      return;
    }
    setHidden(dom.palette, false);
    if (dom.palette.querySelector("[data-tools]")) {
      applyPaletteGroupVisibility(state.tool);
    } else {
      applyPaletteIdVisibility(state.tool);
    }
    syncFillVisibility();
    syncMosaicColorVisibility();
    syncPaletteSwatches();
    syncPaletteValues();
    layoutPalette();
  }

  function applyPaletteGroupVisibility(tool) {
    each(dom.palette.querySelectorAll("[data-tools]"), function (group) {
      var tools = String(group.getAttribute("data-tools") || "").split(/\s+/);
      setHidden(group, tools.indexOf(tool) < 0);
    });
  }

  function applyPaletteIdVisibility(tool) {
    Object.keys(PALETTE_ID_TOOLS).forEach(function (id) {
      var node = byId(id);
      if (!node) {
        return;
      }
      setHidden(node, PALETTE_ID_TOOLS[id].indexOf(tool) < 0);
    });
  }

  /* The straight-line shape has no fill, so its segmented control is hidden. */
  function syncFillVisibility() {
    var node = byId("palette-fill");
    if (!node) {
      return;
    }
    var hideLine =
      state.tool === "shape" &&
      editor &&
      editor.getOptions().shapeMode === "line";
    if (hideLine) {
      var wrapper = node.closest("[data-tools]") || node;
      setHidden(wrapper, true);
    }
  }

  /* Mosaic has no colour property (contract §11.1), so the colour group is
   * hidden for that tool even though its markup lists every tool. */
  function syncMosaicColorVisibility() {
    var group = byId("palette-colors");
    if (!group) {
      return;
    }
    if (state.tool === "mosaic") {
      setHidden(group, true);
    }
  }

  function syncPaletteSwatches() {
    if (!dom.palette || !editor) {
      return;
    }
    var color = String(editor.getOptions().color || "").toLowerCase();
    each(dom.palette.querySelectorAll("[data-color]"), function (swatch) {
      var value = String(swatch.getAttribute("data-color") || "").toLowerCase();
      swatch.classList.toggle("is-active", value === color);
    });
    var input = byId("palette-color-input");
    if (input && /^#[0-9a-f]{6}$/i.test(color)) {
      input.value = color;
    }
    var valueNode = byId("palette-color-value");
    if (valueNode) {
      valueNode.textContent = color;
    }
  }

  function setRangeValue(rangeId, labelId, value) {
    var range = byId(rangeId);
    if (range) {
      range.value = String(value);
    }
    var label = byId(labelId);
    if (label) {
      label.textContent = String(value) + " px";
    }
  }

  function syncPaletteValues() {
    if (!editor) {
      return;
    }
    var options = editor.getOptions();
    setRangeValue("palette-width", "palette-width-value", options.width);
    setRangeValue("palette-font-size", "palette-font-size-value", options.fontSize);
    setRangeValue(
      "palette-mosaic-size",
      "palette-mosaic-size-value",
      options.mosaicSize
    );
    var bold = byId("palette-bold");
    if (bold) {
      bold.classList.toggle("is-active", options.bold === true);
      bold.setAttribute("aria-pressed", options.bold ? "true" : "false");
    }
    each(dom.palette.querySelectorAll("[data-fill]"), function (node) {
      node.classList.toggle("is-active", node.getAttribute("data-fill") === options.fill);
    });
    each(dom.palette.querySelectorAll("[data-bg-color]"), function (node) {
      var value = node.getAttribute("data-bg-color") || "";
      node.classList.toggle("is-active", value === (options.textBg || ""));
    });
    syncShapeModeControl();
  }

  /* The palette floats above the toolbar; when there is no room it is placed
   * below it (§11.2). */
  function layoutPalette() {
    if (!dom.palette || dom.palette.hidden || !dom.bar || dom.bar.hidden) {
      return;
    }
    if (!state.rect) {
      return;
    }
    var paletteWidth = dom.palette.offsetWidth || 0;
    var paletteHeight = dom.palette.offsetHeight || 0;
    if (!paletteWidth || !paletteHeight) {
      return;
    }
    var size = viewportSize();
    var barLeft = dom.bar.offsetLeft || 0;
    var barTop = dom.bar.offsetTop || 0;
    var barHeight = dom.bar.offsetHeight || 40;
    var left = clamp(
      barLeft,
      EDGE_PAD,
      Math.max(EDGE_PAD, size.width - paletteWidth - EDGE_PAD)
    );
    var top = barTop - paletteHeight - 6;
    if (top < EDGE_PAD) {
      top = barTop + barHeight + 6;
    }
    top = clamp(
      top,
      EDGE_PAD,
      Math.max(EDGE_PAD, size.height - paletteHeight - EDGE_PAD)
    );
    dom.palette.style.left = Math.round(left) + "px";
    dom.palette.style.top = Math.round(top) + "px";
    dom.palette.style.right = "";
    dom.palette.style.bottom = "";
  }

  /* Transparent annotation layer PNG for the current crop. Empty string means
   * "no annotations" (the shell then exports the plain crop). */
  function exportAnnotations() {
    if (!editor || !editor.hasAnnotations()) {
      return "";
    }
    try {
      return editor.renderToPng(state.rect ? cloneRect(state.rect) : null) || "";
    } catch (error) {
      return "";
    }
  }

  function clearAnnotations() {
    if (!editor || !editor.hasAnnotations()) {
      return;
    }
    editor.clear();
    toast("已清除标注，可撤销", "info", 2000);
    updateBarState();
  }

  /* ---- Pin to desktop (§11.5) ----------------------------------------- */

  function pinImage() {
    if (!canInteract() || state.busy || state.longshotActive) {
      return;
    }
    if (!API || typeof API.pin !== "function") {
      toast("截图服务不可用，请重启 Lexora 后再试", "error", TOAST_MS);
      return;
    }
    state.busy = true;
    updateBarState();
    var generation = state.captureGeneration;
    var annotations = exportAnnotations();
    var request;
    try {
      request = API.pin(state.monitor, physicalRect(), annotations);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (state.closed || generation !== state.captureGeneration) {
          return;
        }
        state.busy = false;
        updateBarState();
        if (result && result.ok) {
          toast("已钉在桌面", "success", 1600);
          closeOverlay();
          return;
        }
        toast("钉在桌面失败：" + failureText(result, "未知错误"), "error", TOAST_MS);
      },
      function (error) {
        if (state.closed || generation !== state.captureGeneration) {
          return;
        }
        state.busy = false;
        updateBarState();
        toast("钉在桌面失败：" + errorText(error), "error", TOAST_MS);
      }
    );
  }

  /* ---- Long screenshot (§11.6) ---------------------------------------- */

  function showLongshotProgress(frame) {
    if (dom.longshotProgress) {
      setHidden(dom.longshotProgress, false);
    }
    if (dom.longshotFrame) {
      dom.longshotFrame.textContent = frame
        ? "第 " + frame + " 帧"
        : "正在拼接…";
    }
  }

  function hideLongshotProgress() {
    if (dom.longshotProgress) {
      setHidden(dom.longshotProgress, true);
    }
  }

  function subscribeLongshotEvents() {
    if (!API) {
      return;
    }
    try {
      if (typeof API.onLongshotProgress === "function") {
        API.onLongshotProgress(handleLongshotProgress);
      }
      if (typeof API.onLongshotDone === "function") {
        API.onLongshotDone(handleLongshotDone);
      }
    } catch (error) {
      /* progress UI is optional; the command result still settles the UI */
    }
  }

  function startLongshot() {
    if (!canInteract() || state.busy || state.longshotActive) {
      return;
    }
    if (!API || typeof API.longshot !== "function") {
      toast("截图服务不可用，请重启 Lexora 后再试", "error", TOAST_MS);
      return;
    }
    if (state.tool) {
      setTool(null);
    }
    state.longshotActive = true;
    state.busy = true;
    document.body.classList.add("is-longshot");
    setHidden(dom.bar, true);
    setHidden(dom.palette, true);
    showLongshotProgress(0);
    updateBarState();
    var generation = state.captureGeneration;
    var request;
    try {
      request = API.longshot(state.monitor, physicalRect());
    } catch (error) {
      request = Promise.reject(error);
    }
    window.clearTimeout(longshotTimer);
    longshotTimer = window.setTimeout(function () {
      longshotTimer = 0;
      if (!state.longshotActive || generation !== state.captureGeneration) {
        return;
      }
      failLongshot({ error: "长截图超时" });
    }, LONGSHOT_TIMEOUT_MS);
    Promise.resolve(request).then(
      function (result) {
        if (generation !== state.captureGeneration) {
          return;
        }
        if (result && result.ok === false) {
          failLongshot(result);
        }
        /* On success the shell finishes with `capture-longshot-done`. */
      },
      function (error) {
        if (generation !== state.captureGeneration) {
          return;
        }
        failLongshot({ error: errorText(error) });
      }
    );
  }

  function failLongshot(result) {
    if (state.closed || !state.longshotActive) {
      /* The shell may report the failure both through the command result and
       * the `capture-longshot-done` event; settle the UI only once. */
      return;
    }
    state.longshotActive = false;
    state.busy = false;
    window.clearTimeout(longshotTimer);
    longshotTimer = 0;
    hideLongshotProgress();
    document.body.classList.remove("is-longshot");
    setHidden(dom.bar, false);
    updateBarState();
    render();
    toast(
      "长截图失败：" + failureText(result || {}, "未知错误"),
      "error",
      TOAST_MS
    );
  }

  function handleLongshotProgress(payload) {
    if (!state.longshotActive) {
      return;
    }
    showLongshotProgress(payload && payload.frame);
  }

  function handleLongshotDone(payload) {
    if (!state.longshotActive || state.closed) {
      return;
    }
    state.longshotActive = false;
    state.busy = false;
    window.clearTimeout(longshotTimer);
    longshotTimer = 0;
    hideLongshotProgress();
    document.body.classList.remove("is-longshot");
    if (payload && payload.ok) {
      toast("长截图完成，已复制并钉在桌面", "success", 2000);
      closeOverlay();
      return;
    }
    setHidden(dom.bar, false);
    updateBarState();
    render();
    toast(
      "长截图失败：" + failureText(payload || {}, "未知错误"),
      "error",
      TOAST_MS
    );
  }

  /* ---- Boot ------------------------------------------------------------ */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
