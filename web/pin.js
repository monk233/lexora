/* Lexora pinned-to-desktop window renderer (contract §11.5).
 *
 * Each pin is its own frameless transparent always-on-top window
 * (`pin.html?id=<pinId>`). The renderer asks the shell for the image, then:
 *   - drag anywhere on the image to move the window (`pin_drag` deltas, one IPC
 *     call per animation frame),
 *   - double click / Esc / the hover "关闭" button -> `pin_close`,
 *   - the hover "复制" button and the right-click menu -> `pin_copy`,
 *   - `pin-close {id}` events from the shell collapse the window.
 *
 * Browser preview: `pinAPI.ready` falls back to a placeholder preview image, so
 * `pin.html?id=1` is directly previewable.
 */
(function () {
  "use strict";

  var API = window.pinAPI;
  var PREVIEW = !(window.__TAURI__ && window.__TAURI__.core);
  var TOAST_MS = 2600;
  var CLOSE_ANIMATION_MS = 140;
  /* Mouse-wheel zoom: one notch = 10%, hard floor 15% (user requirement). */
  var ZOOM_STEP = 1.1;
  var ZOOM_HINT_MS = 900;
  /* Generic icon for custom image skills without a known icon key. */
  var FALLBACK_SKILL_ICON =
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"></path>' +
    "</svg>";

  var state = {
    id: readPinId(),
    loaded: false,
    closed: false,
    previewFallback: false,
    error: "",
    imageWidth: 0,
    imageHeight: 0,
    scrollable: false,
    expectedScrollable: null,
    dragging: false,
    readyCalls: 0,
    dragCalls: 0,
    dragTotal: { x: 0, y: 0 },
    lastDrag: { dx: 0, dy: 0 },
    copyCalls: 0,
    closeCalls: 0,
    /* Mouse-wheel zoom (1 = one image pixel per physical pixel). */
    zoom: 1,
    minZoom: 0.15,
    maxZoom: 1,
    zoomCalls: 0,
    /* Edit mode: annotation canvas + image-skill toolbar (Esc leaves it). */
    editing: false,
    editBusy: false,
    /* Shape used by the 形状 tool (chosen from the shape picker). */
    editShape: "rect",
    /* picker.compact: edit toolbar shows icons only (like the screenshot bar). */
    compact: false,
    /* The shell grew the window so the toolbar floats outside the image. */
    editOutside: false,
    editTopPad: 0,
    editLeftPad: 0,
    /* Image CSS size captured before the edit window is widened: the image keeps
     * it while editing (the shell only adds transparent space around it). */
    editImageWidth: 0,
    /* Structural fallback: icons-only bar when the work area is too narrow for
     * the labelled bar (the picture toolbar never wraps either). */
    editForceCompact: false,
    editSkillCalls: 0,
    editExportCalls: 0
  };

  /* Test/debug hook used by the CDP checks in tests/ and manual QA. */
  window.__pinState = state;

  var dom = {};
  var drag = null;
  var toastTimer = 0;
  var pendingZoom = null;
  var zoomFrame = 0;
  var zoomSeq = 0;
  var zoomHintTimer = 0;
  var editor = null;

  /* ---- Small helpers --------------------------------------------------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function readPinId() {
    var match = /[?&]id=(\d+)/.exec(window.location.search || "");
    return match ? Math.max(0, parseInt(match[1], 10) || 0) : 0;
  }

  function positiveNumber(value) {
    var number = Number(value);
    return isFinite(number) && number > 0 ? number : 0;
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

  function failureText(result, fallback) {
    var message = (result && result.error) || fallback;
    var hint = (result && result.hint) || "";
    return hint ? message + "：" + hint : message;
  }

  function isUiTarget(target) {
    if (!target || !target.closest) {
      return false;
    }
    return !!target.closest(
      ".pin-toolbar, .pin-menu, .pin-error, .pin-toast, .pin-edit-bar"
    );
  }

  /* ---- DOM cache + boot ------------------------------------------------ */

  function cacheDom() {
    dom.root = byId("pin-root");
    dom.image = byId("pin-image");
    dom.toolbar = byId("pin-toolbar");
    dom.copyBtn = byId("pin-copy");
    dom.closeBtn = byId("pin-close");
    dom.toast = byId("pin-toast");
    dom.zoom = byId("pin-zoom");
    dom.error = byId("pin-error");
    dom.errorText = byId("pin-error-text");
    dom.errorClose = byId("pin-error-close");
    dom.menu = byId("pin-context-menu");
    /* ---- Edit mode ---- */
    dom.editBtn = byId("pin-edit");
    dom.editBar = byId("pin-edit-bar");
    dom.editCanvas = byId("pin-edit-canvas");
    dom.editUndo = byId("pin-edit-undo");
    dom.editRedo = byId("pin-edit-redo");
    dom.editShapeButton = document.querySelector(".pin-edit-shape");
    dom.shapeMenu = byId("pin-shape-menu");
    dom.shapeButtons = Array.prototype.slice.call(
      dom.shapeMenu ? dom.shapeMenu.querySelectorAll("[data-edit-shape]") : []
    );
    dom.customSkills = byId("pin-edit-custom-skills");
    dom.editToolButtons = Array.prototype.slice.call(
      document.querySelectorAll("[data-edit-tool]")
    );
  }

  function boot() {
    cacheDom();
    if (!dom.root || !dom.image) {
      return;
    }
    bindEvents();
    subscribeClose();
    window.addEventListener("resize", syncScrollable);
    load();
    loadEditSkills();
  }

  function bindEvents() {
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);
    /* The wheel zooms the pinned image; passive:false so the page can stop the
     * browser scroll (long screenshots scroll via their scrollbar instead). */
    window.addEventListener("wheel", onWheel, { passive: false });

    if (dom.copyBtn) {
      dom.copyBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        copyImage();
      });
    }
    if (dom.closeBtn) {
      dom.closeBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        closePin();
      });
    }
    if (dom.errorClose) {
      dom.errorClose.addEventListener("click", closePin);
    }
    if (dom.menu) {
      dom.menu.addEventListener("click", onMenuClick);
    }
    if (dom.root) {
      dom.root.addEventListener("dblclick", onDoubleClick);
    }
    /* Edit mode entry + toolbar. */
    if (dom.editBtn) {
      dom.editBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        enterEdit();
      });
    }
    if (dom.editBar) {
      dom.editBar.addEventListener("click", onEditBarClick);
    }
    if (dom.shapeMenu) {
      dom.shapeMenu.addEventListener("click", onShapeMenuClick);
    }
    /* Any press outside the edit toolbar/shape menu closes the shape picker. */
    document.addEventListener("mousedown", function (event) {
      if (dom.shapeMenu && !dom.shapeMenu.hidden) {
        var target = event.target;
        if (
          !target ||
          !target.closest ||
          (!target.closest(".pin-shape-menu") && !target.closest(".pin-edit-shape"))
        ) {
          closeShapeMenu();
        }
      }
    });
    /* Undo/redo are handled by the delegated click listener on the edit bar
     * (onEditBarClick); binding them here too would run them twice. */
  }

  function subscribeClose() {
    if (!API || typeof API.onClose !== "function") {
      return;
    }
    try {
      API.onClose(function (payload) {
        var id = payload && Number(payload.id);
        if (isFinite(id) && id > 0 && id !== state.id) {
          return;
        }
        collapseWindow();
      });
    } catch (error) {
      /* keep the window usable without the event */
    }
  }

  /* ---- Image loading --------------------------------------------------- */

  function previewPlaceholder() {
    var width = 640;
    var height = 480;
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      width +
      '" height="' +
      height +
      '"><rect width="100%" height="100%" fill="#e2e8f0"/>' +
      '<text x="50%" y="44%" text-anchor="middle" fill="#475569" ' +
      'font-family="Segoe UI, sans-serif" font-size="26">Lexora pin preview</text>' +
      '<text x="50%" y="54%" text-anchor="middle" fill="#94a3b8" ' +
      'font-family="Segoe UI, sans-serif" font-size="16">钉图预览（浏览器模式）</text></svg>';
    return {
      ok: true,
      width: width,
      height: height,
      dataUrl: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)
    };
  }

  function load() {
    state.readyCalls += 1;
    if (!API || typeof API.ready !== "function") {
      showError("钉图服务不可用，请重启 Lexora 后再试。");
      return;
    }
    var request;
    try {
      request = API.ready(state.id);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (state.closed) {
          return;
        }
        if (result && result.ok && result.dataUrl) {
          showImage(result);
          return;
        }
        /* Browser preview: the mock has no registry entry for this page
         * context, so fall back to a placeholder instead of an empty window. */
        if (PREVIEW) {
          state.previewFallback = true;
          showImage(previewPlaceholder());
          return;
        }
        showError(failureText(result, "钉图加载失败"));
      },
      function (error) {
        if (state.closed) {
          return;
        }
        if (PREVIEW) {
          state.previewFallback = true;
          showImage(previewPlaceholder());
          return;
        }
        showError("钉图加载失败：" + errorText(error));
      }
    );
  }

  function showImage(payload) {
    state.imageWidth = positiveNumber(payload && payload.width);
    state.imageHeight = positiveNumber(payload && payload.height);
    /* The shell knows the display size, so it tells us whether the image is
     * taller than its window (long screenshot). Fall back to measuring in the
     * browser preview, where there is no shell. */
    state.expectedScrollable =
      payload && typeof payload.scrollable === "boolean" ? payload.scrollable : null;
    if (payload && isFinite(Number(payload.zoom)) && Number(payload.zoom) > 0) {
      state.zoom = Number(payload.zoom);
    }
    if (payload && Number(payload.minZoom) > 0) {
      state.minZoom = Number(payload.minZoom);
    }
    if (payload && Number(payload.maxZoom) > 0) {
      state.maxZoom = Number(payload.maxZoom);
    }
    state.error = "";
    hideError();

    dom.image.onload = onImageLoaded;
    dom.image.onerror = function () {
      if (state.loaded) {
        return;
      }
      showError("钉图加载失败");
    };
    dom.image.removeAttribute("src");
    dom.image.src = String(payload.dataUrl);
    if (dom.image.complete && dom.image.naturalWidth > 0) {
      onImageLoaded();
    }
  }

  function onImageLoaded() {
    if (state.closed) {
      return;
    }
    state.loaded = true;
    state.imageWidth = positiveNumber(dom.image.naturalWidth) || state.imageWidth;
    state.imageHeight = positiveNumber(dom.image.naturalHeight) || state.imageHeight;
    dom.image.hidden = false;
    if (dom.toolbar) {
      dom.toolbar.hidden = false;
    }
    syncScrollable();
  }

  /* A normal pin shows the whole image (window sized to the image): no
   * scrollbar. A long screenshot is taller than the window and scrolls inside
   * it. Only then is `is-scrollable` added; the scrollbar uses the project
   * styling from pin.css. */
  function syncScrollable() {
    var scrollable = false;
    if (state.loaded) {
      if (state.expectedScrollable === true || state.expectedScrollable === false) {
        scrollable = state.expectedScrollable;
      } else if (dom.image && dom.image.naturalHeight > 0) {
        var rect = dom.image.getBoundingClientRect();
        scrollable = rect.height > window.innerHeight + 1;
      }
    }
    state.scrollable = scrollable;
    document.body.classList.toggle("is-scrollable", scrollable);
  }

  function showError(message) {
    state.loaded = false;
    state.error = String(message || "钉图加载失败");
    state.scrollable = false;
    document.body.classList.remove("is-scrollable");
    if (dom.image) {
      dom.image.hidden = true;
    }
    if (dom.toolbar) {
      dom.toolbar.hidden = true;
    }
    if (dom.errorText) {
      dom.errorText.textContent = state.error;
    }
    if (dom.error) {
      dom.error.hidden = false;
    }
  }

  function hideError() {
    if (dom.error) {
      dom.error.hidden = true;
    }
  }

  /* ---- Toast ----------------------------------------------------------- */

  function toast(message, tone) {
    if (!dom.toast) {
      return;
    }
    dom.toast.textContent = String(message || "");
    dom.toast.setAttribute("data-tone", tone || "info");
    dom.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      if (dom.toast) {
        dom.toast.hidden = true;
      }
    }, TOAST_MS);
  }

  /* ---- Mouse-wheel zoom -------------------------------------------------- */

  /* Wheel zooms the pinned image: the shell resizes the window (the image is
   * rendered at the window width) keeping its centre. The floor is 15% (user
   * requirement); the ceiling is the zoom the pin started with, so a small
   * snippet can always grow back. Long screenshots keep scrolling via their
   * scrollbar because the wheel is reserved for zooming. */
  function onWheel(event) {
    if (state.closed || state.error || !state.loaded || state.dragging || state.editing) {
      return;
    }
    if (isUiTarget(event.target)) {
      return;
    }
    event.preventDefault();
    var direction = event.deltaY < 0 ? 1 : -1;
    var factor = Math.pow(ZOOM_STEP, direction);
    var minimum = state.minZoom > 0 ? state.minZoom : 0.15;
    var maximum = state.maxZoom > 0 ? state.maxZoom : 1;
    var next = (state.zoom || 1) * factor;
    next = Math.min(maximum, Math.max(minimum, next));
    if (Math.abs(next - state.zoom) < 0.001) {
      return;
    }
    queueZoom(next);
  }

  function queueZoom(next) {
    pendingZoom = next;
    if (zoomFrame) {
      return;
    }
    zoomFrame = window.requestAnimationFrame(flushZoom);
  }

  function flushZoom() {
    zoomFrame = 0;
    var next = pendingZoom;
    pendingZoom = null;
    if (!next || state.closed || !API || typeof API.zoom !== "function") {
      return;
    }
    state.zoomCalls += 1;
    var seq = zoomSeq + 1;
    zoomSeq = seq;
    var request;
    try {
      request = API.zoom(state.id, next);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (seq !== zoomSeq || state.closed) {
          return;
        }
        if (result && result.ok === false) {
          return;
        }
        state.zoom = positiveNumber(result && result.zoom) || next;
        if (result && typeof result.scrollable === "boolean") {
          state.expectedScrollable = result.scrollable;
        }
        syncScrollable();
        showZoomHint();
      },
      function () {
        /* Keep the previous zoom; the next wheel event retries. */
      }
    );
  }

  function showZoomHint() {
    if (!dom.zoom) {
      return;
    }
    dom.zoom.textContent = Math.round((state.zoom || 1) * 100) + "%";
    dom.zoom.hidden = false;
    window.clearTimeout(zoomHintTimer);
    zoomHintTimer = window.setTimeout(function () {
      if (dom.zoom) {
        dom.zoom.hidden = true;
      }
    }, ZOOM_HINT_MS);
  }

  /* ---- Edit mode (annotations + image skills) --------------------------- */

  /* The edit button opens the annotation surface + image-skill toolbar on top
   * of the pinned image (contract §11.5). Window dragging, wheel zoom and the
   * right-click menu are disabled while editing; Esc leaves the mode and
   * discards the annotations, "完成" applies them to the pin and copies it. */
  function enterEdit() {
    if (state.editing || state.closed || !state.loaded) {
      return;
    }
    hideMenu();
    closeShapeMenu();
    state.editing = true;
    state.editBusy = false;
    state.editForceCompact = false;
    /* The shell widens the window for the single-row toolbar; pin the image to
     * the size it had before that so only transparent space is added around. */
    state.editImageWidth = dom.image ? dom.image.clientWidth || 0 : 0;
    if (state.editImageWidth > 0) {
      document.body.style.setProperty(
        "--pin-image-width",
        state.editImageWidth + "px"
      );
    }
    if (dom.toolbar) {
      dom.toolbar.hidden = true;
    }
    if (dom.editBar) {
      dom.editBar.hidden = false;
    }
    if (dom.editCanvas) {
      dom.editCanvas.hidden = false;
    }
    document.body.classList.add("is-editing");
    initEditor();
    layoutEditCanvas();
    if (editor) {
      editor.reset();
      editor.setSourceSize(state.imageWidth, state.imageHeight);
      editor.setTool(null);
    }
    selectEditTool(null, null);
    applyCompactToEditBar();
    updateEditBar();
    /* Let the shell grow the window so the toolbar floats outside the image
     * (like the screenshot toolbar). Long screenshots keep the overlay bar: the
     * window is a scroll viewport and has no outside strip. */
    requestEditWindow(true);
  }

  function exitEdit() {
    if (!state.editing) {
      return;
    }
    state.editing = false;
    state.editBusy = false;
    closeShapeMenu();
    if (editor) {
      editor.setTool(null);
      editor.reset();
    }
    if (dom.editBar) {
      dom.editBar.hidden = true;
    }
    if (dom.editCanvas) {
      dom.editCanvas.hidden = true;
    }
    updateEditBar();
    /* Restore the window geometry first, then drop the fixed image width and the
     * paddings: the image never stretches while the window shrinks back. */
    var finish = function () {
      resetEditWindowLayout();
      document.body.classList.remove("is-editing");
      if (dom.toolbar) {
        dom.toolbar.hidden = false;
      }
    };
    var restore = requestEditWindow(false);
    if (restore && typeof restore.then === "function") {
      restore.then(finish, finish);
    } else {
      finish();
    }
  }

  /* ---- Edit toolbar placement (outside the image) ----------------------- */

  function applyCompactToEditBar() {
    if (dom.editBar) {
      var compact = state.compact === true || state.editForceCompact === true;
      dom.editBar.classList.toggle("compact", compact);
    }
  }

  /* Work-area width available to the shell (the bar must fit in one row). */
  function screenWidth() {
    var screen = window.screen || {};
    var width = Number(screen.availWidth);
    if (!isFinite(width) || width <= 0) {
      width = window.innerWidth || 0;
    }
    return width;
  }

  function measureEditBar() {
    if (!dom.editBar || dom.editBar.hidden) {
      return null;
    }
    var width = Math.ceil(dom.editBar.offsetWidth || 0);
    var height = Math.ceil(dom.editBar.offsetHeight || 0);
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width: width, height: height };
  }

  /* Asks the shell to grow the window so the bar floats outside the image and
   * fits in ONE row, anchored to the left edge (exactly like the screenshot
   * toolbar). The strip is added below the image, or above it when the screen
   * has no room below (the shell reports `topPadding`/`leftPadding` then and the
   * image is pushed inside the window so it stays where it was). */
  function requestEditWindow(editing, retried) {
    if (!API || typeof API.editWindow !== "function" || !dom.editBar) {
      resetEditWindowLayout();
      return null;
    }
    if (!editing) {
      var restore;
      try {
        restore = API.editWindow(state.id, false, 0, 0);
      } catch (error) {
        restore = Promise.reject(error);
      }
      return Promise.resolve(restore).then(
        function () {
          /* the caller resets the layout once the geometry is back */
        },
        function () {
          /* the window keeps its current size */
        }
      );
    }
    var size = measureEditBar();
    if (!size) {
      resetEditWindowLayout();
      return null;
    }
    /* A narrow work area cannot fit the labelled bar: fall back to the
     * icons-only layout (the screenshot toolbar's compact mode) so the bar can
     * never wrap. */
    if (
      !state.compact &&
      !state.editForceCompact &&
      size.width + 16 > screenWidth() - 16
    ) {
      state.editForceCompact = true;
      applyCompactToEditBar();
      size = measureEditBar();
      if (!size) {
        resetEditWindowLayout();
        return null;
      }
    }
    var toolbarWidth = size.width + 16;
    /* Long screenshots fill the window vertically, so there is no outside strip:
     * the bar stays overlaid on the image, but it is still widened to one row. */
    var toolbarHeight = state.scrollable ? 0 : size.height + 12;
    var request;
    try {
      request = API.editWindow(state.id, true, toolbarHeight, toolbarWidth);
    } catch (error) {
      request = Promise.reject(error);
    }
    return Promise.resolve(request).then(
      function (result) {
        if (!state.editing || !result || result.ok === false) {
          resetEditWindowLayout();
          return;
        }
        applyEditWindowLayout(result);
        if (result.clamped && !retried && !state.editForceCompact) {
          /* The work area limited the width: shrink to icons and retry once. */
          state.editForceCompact = true;
          applyCompactToEditBar();
          requestEditWindow(true, true);
        }
      },
      function () {
        resetEditWindowLayout();
      }
    );
  }

  function applyEditWindowLayout(result) {
    var topPadding = positiveNumber(result.topPadding);
    var leftPadding = positiveNumber(result.leftPadding);
    state.editOutside = true;
    state.editTopPad = topPadding;
    state.editLeftPad = leftPadding;
    document.body.style.paddingTop = topPadding > 0 ? topPadding + "px" : "";
    document.body.style.paddingLeft = leftPadding > 0 ? leftPadding + "px" : "";
    if (dom.editBar) {
      dom.editBar.classList.toggle("is-above", topPadding > 0);
      /* Anchored to the image's left edge, like the screenshot toolbar hugs the
       * selection; `leftPadding` is the transparent part added on the left. */
      dom.editBar.style.left = Math.round(leftPadding + 8) + "px";
    }
    /* The window grew: keep the annotation surface matched to the image. */
    layoutEditCanvas();
  }

  function resetEditWindowLayout() {
    state.editOutside = false;
    state.editTopPad = 0;
    state.editLeftPad = 0;
    document.body.style.paddingTop = "";
    document.body.style.paddingLeft = "";
    document.body.style.removeProperty("--pin-image-width");
    if (dom.editBar) {
      dom.editBar.classList.remove("is-above");
      dom.editBar.style.left = "";
    }
  }

  function initEditor() {
    if (editor) {
      return editor;
    }
    if (!dom.editCanvas || !dom.image) {
      return null;
    }
    if (!window.CaptureAnnotate || typeof window.CaptureAnnotate.create !== "function") {
      return null;
    }
    try {
      editor = window.CaptureAnnotate.create({
        canvas: dom.editCanvas,
        image: dom.image,
        getSelection: editSelection,
        onHistoryChange: onEditHistoryChange
      });
    } catch (error) {
      editor = null;
    }
    window.__pinEditor = editor;
    return editor;
  }

  /* The pin renders the image at the window width, so the annotation surface is
   * exactly the rendered image box. */
  function editSelection() {
    if (!dom.image) {
      return null;
    }
    var width = dom.image.clientWidth || 0;
    var height = dom.image.clientHeight || 0;
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { x: 0, y: 0, width: width, height: height };
  }

  function layoutEditCanvas() {
    if (!dom.editCanvas || !dom.image) {
      return;
    }
    var width = dom.image.clientWidth || 0;
    var height = dom.image.clientHeight || 0;
    if (width <= 0 || height <= 0) {
      return;
    }
    dom.editCanvas.style.width = width + "px";
    dom.editCanvas.style.height = height + "px";
  }

  function onEditHistoryChange() {
    updateEditBar();
  }

  function onEditBarClick(event) {
    var button =
      event.target && event.target.closest ? event.target.closest("button") : null;
    if (!button || button.disabled) {
      return;
    }
    event.stopPropagation();
    var tool = button.getAttribute("data-edit-tool");
    if (tool) {
      /* Same interaction as the screenshot toolbar: clicking a tool activates it,
       * clicking the active tool again leaves annotation mode. The shape button
       * also opens the sub-mode picker (the screenshot bar has a palette for
       * this; the pin has no palette, so its floating menu takes that role). */
      var activeTool = button.classList.contains("is-active");
      if (activeTool) {
        closeShapeMenu();
        selectEditTool(null, null);
        return;
      }
      if (tool === "shape") {
        selectEditTool(dom.editShapeButton, "shape", state.editShape || "rect");
        toggleShapeMenu(button);
        return;
      }
      closeShapeMenu();
      selectEditTool(button, tool);
      return;
    }
    var skill = button.getAttribute("data-edit-skill");
    if (skill) {
      closeShapeMenu();
      runEditSkill(skill, button.getAttribute("data-skill-id") || "");
      return;
    }
    var action = button.getAttribute("data-edit-action");
    if (action === "undo") {
      if (editor) {
        editor.undo();
      }
    } else if (action === "redo") {
      if (editor) {
        editor.redo();
      }
    } else if (action === "cancel") {
      exitEdit();
    } else if (action === "exit") {
      exportEditAnnotations(true);
    }
  }

  /* Activates an annotation tool; `shape` is only used by the shape picker. */
  function selectEditTool(button, tool, shape) {
    if (!editor) {
      return;
    }
    if (tool) {
      editor.setTool(tool);
      if (tool === "shape") {
        if (shape) {
          state.editShape = shape;
        }
        editor.setOption("shapeMode", state.editShape || "rect");
      }
    } else {
      editor.setTool(null);
    }
    var active = tool === "shape" ? dom.editShapeButton : button;
    dom.editToolButtons.forEach(function (item) {
      item.classList.toggle("is-active", item === active);
      item.setAttribute("aria-pressed", item === active ? "true" : "false");
    });
    if (shape) {
      dom.shapeButtons.forEach(function (item) {
        item.classList.toggle(
          "is-active",
          item.getAttribute("data-edit-shape") === shape
        );
      });
    }
  }

  function applyEditShape(shape) {
    var value = String(shape || "")
      .trim()
      .toLowerCase();
    if (!value) {
      return;
    }
    closeShapeMenu();
    selectEditTool(dom.editShapeButton, "shape", value);
  }

  /* Shape picker floating above the 形状 button. */
  function toggleShapeMenu(button) {
    if (!dom.shapeMenu) {
      return;
    }
    if (!dom.shapeMenu.hidden) {
      closeShapeMenu();
      return;
    }
    var anchor = button || dom.editShapeButton;
    dom.shapeMenu.hidden = false;
    var rect = anchor ? anchor.getBoundingClientRect() : null;
    var width = dom.shapeMenu.offsetWidth || 148;
    var height = dom.shapeMenu.offsetHeight || 36;
    var left = rect ? rect.left + rect.width / 2 - width / 2 : 8;
    var top = rect ? rect.top - height - 6 : 8;
    left = Math.max(4, Math.min(left, window.innerWidth - width - 4));
    if (top < 4) {
      top = rect ? rect.bottom + 6 : 8;
    }
    dom.shapeMenu.style.left = Math.round(left) + "px";
    dom.shapeMenu.style.top = Math.round(top) + "px";
    dom.shapeButtons.forEach(function (item) {
      item.classList.toggle(
        "is-active",
        item.getAttribute("data-edit-shape") === state.editShape
      );
    });
  }

  function closeShapeMenu() {
    if (dom.shapeMenu) {
      dom.shapeMenu.hidden = true;
    }
  }

  function onShapeMenuClick(event) {
    var button =
      event.target && event.target.closest
        ? event.target.closest("[data-edit-shape]")
        : null;
    if (!button) {
      return;
    }
    event.stopPropagation();
    applyEditShape(button.getAttribute("data-edit-shape"));
  }

  function updateEditBar() {
    var busy = state.editBusy === true;
    if (dom.editUndo) {
      dom.editUndo.disabled = busy || !editor || !editor.canUndo();
    }
    if (dom.editRedo) {
      dom.editRedo.disabled = busy || !editor || !editor.canRedo();
    }
    var skillButtons = document.querySelectorAll(
      "#pin-edit-bar [data-edit-skill]"
    );
    Array.prototype.forEach.call(skillButtons, function (button) {
      button.disabled = busy;
    });
    var actionButtons = document.querySelectorAll(
      "#pin-edit-bar [data-edit-action]"
    );
    Array.prototype.forEach.call(actionButtons, function (button) {
      if (button === dom.editUndo || button === dom.editRedo) {
        return;
      }
      button.disabled = busy;
    });
  }

  /* ---- Custom image skills in the edit toolbar -------------------------- */

  /* Reads the picker settings and renders one toolbar button per enabled
   * `kind: "image"` custom skill (same order as the screenshot toolbar). */
  function loadEditSkills() {
    var api = window.settingsAPI;
    if (!api || typeof api.getState !== "function" || !dom.customSkills) {
      return;
    }
    Promise.resolve(api.getState()).then(
      function (result) {
        if (state.closed) {
          return;
        }
        var payload = result && (result.state || result);
        var picker = payload && payload.settings && payload.settings.picker;
        if (!picker) {
          return;
        }
        state.compact = picker.compact === true;
        applyCompactToEditBar();
        renderCustomSkillButtons(picker.captureSkills, picker.customSkills);
        /* Compact mode changes the toolbar height: re-measure the outside strip
         * when the editor is already open. */
        if (state.editing) {
          requestEditWindow(true);
        }
      },
      function () {
        /* No custom buttons in this environment (browser preview). */
      }
    );
  }

  function renderCustomSkillButtons(rawSkills, rawCustom) {
    if (!dom.customSkills) {
      return;
    }
    dom.customSkills.textContent = "";
    var skills = Object.create(null);
    (Array.isArray(rawCustom) ? rawCustom : []).forEach(function (entry) {
      if (!entry || typeof entry !== "object") {
        return;
      }
      var id = String(entry.id == null ? "" : entry.id).trim();
      var kind = String(entry.kind == null ? "" : entry.kind)
        .trim()
        .toLowerCase();
      if (!id || kind !== "image") {
        return;
      }
      skills[id] = entry;
    });
    var order = Array.isArray(rawSkills) ? rawSkills : [];
    order.forEach(function (rawId) {
      var id = String(rawId == null ? "" : rawId).trim();
      var skill = skills[id];
      if (!skill) {
        return;
      }
      var button = document.createElement("button");
      button.type = "button";
      button.className = "tool-btn pin-edit-custom";
      button.setAttribute("data-edit-skill", "custom");
      button.setAttribute("data-skill-id", id);
      button.title = String(skill.label || "");
      button.setAttribute("aria-label", String(skill.label || ""));
      button.innerHTML =
        customSkillIconMarkup(skill.icon) + '<span class="label"></span>';
      var icon = button.querySelector("svg");
      if (icon) {
        icon.setAttribute("class", "icon");
        icon.setAttribute("aria-hidden", "true");
      }
      var label = button.querySelector(".label");
      if (label) {
        label.textContent = String(skill.label || "");
      }
      dom.customSkills.appendChild(button);
    });
    updateEditBar();
  }

  function customSkillIconMarkup(key) {
    if (window.LP && typeof window.LP.customSkillIconSvg === "function") {
      try {
        var svg = String(window.LP.customSkillIconSvg(key) || "");
        if (svg) {
          return svg;
        }
      } catch (error) {
        /* fall through to the generic icon */
      }
    }
    return FALLBACK_SKILL_ICON;
  }

  function editAnnotationsPng() {
    if (!editor) {
      return "";
    }
    try {
      return editor.renderToPng(editSelection()) || "";
    } catch (error) {
      return "";
    }
  }

  function makePinRequestId() {
    return (
      "pin-" +
      Date.now().toString(36) +
      "-" +
      Math.floor(Math.random() * 1e6).toString(36)
    );
  }

  function runEditSkill(action, skillId) {
    if (!state.editing || state.editBusy) {
      return;
    }
    if (!API || typeof API.skill !== "function") {
      toast("图片技能不可用，请重启 Lexora 后再试", "error");
      return;
    }
    state.editBusy = true;
    state.editSkillCalls += 1;
    updateEditBar();
    var request;
    try {
      request = API.skill(
        state.id,
        makePinRequestId(),
        action,
        skillId || "",
        "auto",
        editAnnotationsPng()
      );
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        state.editBusy = false;
        updateEditBar();
        if (result && result.ok === false) {
          toast("操作失败：" + failureText(result, "未知错误"), "error");
          return;
        }
        toast("结果已发送到面板", "info");
      },
      function (error) {
        state.editBusy = false;
        updateEditBar();
        toast("操作失败：" + errorText(error), "error");
      }
    );
  }

  /* `apply` = the "完成" button: replace the pinned image with the annotated
   * one (and copy it); otherwise only copy. */
  function exportEditAnnotations(apply) {
    if (!state.editing || state.editBusy) {
      return;
    }
    if (!API || typeof API.exportAnnotations !== "function") {
      toast("图片编辑服务不可用，请重启 Lexora 后再试", "error");
      return;
    }
    state.editBusy = true;
    state.editExportCalls += 1;
    updateEditBar();
    var request;
    try {
      request = API.exportAnnotations(state.id, editAnnotationsPng(), apply === true);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        state.editBusy = false;
        updateEditBar();
        if (result && result.ok === false) {
          toast("操作失败：" + failureText(result, "未知错误"), "error");
          return;
        }
        var copied = !result || result.clipboard !== false;
        if (apply) {
          if (result && result.dataUrl && dom.image) {
            dom.image.removeAttribute("src");
            dom.image.src = String(result.dataUrl);
          }
          exitEdit();
          toast(copied ? "已保存并复制" : "已保存（复制失败）", copied ? "success" : "error");
          return;
        }
        toast(copied ? "已复制到剪贴板" : "复制失败", copied ? "success" : "error");
      },
      function (error) {
        state.editBusy = false;
        updateEditBar();
        toast("操作失败：" + errorText(error), "error");
      }
    );
  }

  /* ---- Actions --------------------------------------------------------- */

  function copyImage() {
    if (state.closed) {
      return;
    }
    state.copyCalls += 1;
    if (!API || typeof API.copy !== "function") {
      toast("钉图服务不可用，请重启 Lexora 后再试", "error");
      return;
    }
    var request;
    try {
      request = API.copy(state.id);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then(
      function (result) {
        if (result && result.ok) {
          toast("已复制到剪贴板", "success");
          return;
        }
        toast("复制失败：" + failureText(result, "未知错误"), "error");
      },
      function (error) {
        toast("复制失败：" + errorText(error), "error");
      }
    );
  }

  function closePin() {
    if (state.closed) {
      return;
    }
    state.closed = true;
    state.closeCalls += 1;
    drag = null;
    state.dragging = false;
    document.body.classList.remove("is-dragging");
    hideMenu();
    if (dom.toolbar) {
      dom.toolbar.hidden = true;
    }
    if (API && typeof API.close === "function") {
      try {
        Promise.resolve(API.close(state.id)).catch(function () {
          /* the window is going away; nothing to report */
        });
      } catch (error) {
        /* the window is going away; nothing to report */
      }
    }
    collapseWindow();
  }

  function collapseWindow() {
    if (!dom.root) {
      return;
    }
    dom.root.classList.add("is-closing");
    window.setTimeout(function () {
      if (dom.root) {
        dom.root.hidden = true;
      }
    }, CLOSE_ANIMATION_MS);
  }

  /* ---- Right-click menu ------------------------------------------------ */

  function onContextMenu(event) {
    event.preventDefault();
    if (state.closed || state.editing || !dom.menu) {
      hideMenu();
      return;
    }
    showMenu(event.clientX, event.clientY);
  }

  function showMenu(x, y) {
    if (!dom.menu) {
      return;
    }
    dom.menu.hidden = false;
    var width = dom.menu.offsetWidth || 108;
    var height = dom.menu.offsetHeight || 68;
    var left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    var top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    dom.menu.style.left = Math.round(left) + "px";
    dom.menu.style.top = Math.round(top) + "px";
  }

  function hideMenu() {
    if (dom.menu) {
      dom.menu.hidden = true;
    }
  }

  function onMenuClick(event) {
    var item =
      event.target && event.target.closest
        ? event.target.closest("[data-pin-action]")
        : null;
    if (!item) {
      return;
    }
    hideMenu();
    var action = item.getAttribute("data-pin-action");
    if (action === "copy") {
      copyImage();
    } else if (action === "close") {
      closePin();
    }
  }

  /* ---- Window dragging ------------------------------------------------- */

  /* Screen coordinates are used for the deltas: the window moves under the
   * cursor while dragging, so viewport (client) coordinates would stop changing
   * and the window would freeze after the first frame. */
  function pointOf(event) {
    var screenX = Number(event.screenX);
    var screenY = Number(event.screenY);
    if (screenX === 0 && screenY === 0) {
      screenX = Number(event.clientX) || 0;
      screenY = Number(event.clientY) || 0;
    }
    return { x: screenX, y: screenY };
  }

  function onMouseDown(event) {
    if (event.button !== 0 || state.closed || state.dragging || state.editing) {
      return;
    }
    if (isUiTarget(event.target)) {
      return;
    }
    event.preventDefault();
    hideMenu();
    drag = { last: pointOf(event), pendingX: 0, pendingY: 0, frame: 0 };
    state.dragging = true;
    document.body.classList.add("is-dragging");
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(event) {
    if (!drag) {
      return;
    }
    event.preventDefault();
    var point = pointOf(event);
    var deltaX = point.x - drag.last.x;
    var deltaY = point.y - drag.last.y;
    if (!deltaX && !deltaY) {
      return;
    }
    drag.last = point;
    drag.pendingX += deltaX;
    drag.pendingY += deltaY;
    if (!drag.frame && typeof window.requestAnimationFrame === "function") {
      drag.frame = window.requestAnimationFrame(flushDrag);
    } else if (!drag.frame) {
      flushDrag();
    }
  }

  function flushDrag() {
    if (!drag) {
      return;
    }
    drag.frame = 0;
    flushDragDelta();
  }

  function flushDragDelta() {
    if (!drag) {
      return;
    }
    var deltaX = drag.pendingX;
    var deltaY = drag.pendingY;
    drag.pendingX = 0;
    drag.pendingY = 0;
    if (!deltaX && !deltaY) {
      return;
    }
    state.dragCalls += 1;
    state.lastDrag = { dx: deltaX, dy: deltaY };
    state.dragTotal.x += deltaX;
    state.dragTotal.y += deltaY;
    if (!API || typeof API.drag !== "function") {
      return;
    }
    try {
      Promise.resolve(API.drag(state.id, deltaX, deltaY)).catch(function () {
        /* dragging is best effort; the next frame sends the new delta */
      });
    } catch (error) {
      /* dragging is best effort */
    }
  }

  function onMouseUp() {
    if (!drag) {
      return;
    }
    if (drag.frame) {
      window.cancelAnimationFrame(drag.frame);
      drag.frame = 0;
    }
    flushDragDelta();
    drag = null;
    state.dragging = false;
    document.body.classList.remove("is-dragging");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  function onDoubleClick(event) {
    if (state.editing || isUiTarget(event.target)) {
      return;
    }
    event.preventDefault();
    closePin();
  }

  function onKeyDown(event) {
    /* Same shortcuts as the screenshot overlay while editing. */
    if (state.editing && (event.ctrlKey || event.metaKey) && !event.altKey) {
      var key = String(event.key || "").toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        if (editor) {
          editor.undo();
        }
        return;
      }
      if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        if (editor) {
          editor.redo();
        }
        return;
      }
    }
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    /* Esc leaves the edit mode (annotations are discarded) before it closes
     * the pin (contract §11.5); an open shape picker closes first. */
    if (state.editing) {
      if (dom.shapeMenu && !dom.shapeMenu.hidden) {
        closeShapeMenu();
        return;
      }
      exitEdit();
      return;
    }
    if (dom.menu && !dom.menu.hidden) {
      hideMenu();
      return;
    }
    closePin();
  }

  /* ---- Boot ------------------------------------------------------------ */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
