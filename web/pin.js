/* Lexora pinned-to-desktop window renderer (contract §11.5).
 *
 * Each pin is its own frameless transparent always-on-top window
 * (`pin.html?id=<pinId>`). The renderer asks the shell for the image, then:
 *   - drag anywhere on the image to move the window (`pin_drag` deltas, one IPC
 *     call per animation frame),
 *   - double click / Esc / the hover "close" button -> `pin_close`,
 *   - the hover "copy" button and the right-click menu -> `pin_copy`,
 *   - `pin-close {id}` events from the shell collapse the window.
 *
 * Browser preview: `pinAPI.ready` falls back to a placeholder preview image, so
 * `pin.html?id=1` is directly previewable.
 */
(function () {
  "use strict";

  var API = window.pinAPI;
  var LP = window.LP || {};
  /* Node-based checks may load this file without the i18n runtime. */
  if (typeof LP.t !== "function") {
    LP.t = function (key) {
      return String(key);
    };
  }
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
  /* Annotation palette geometry (same values as the screenshot overlay). */
  var PALETTE_GAP = 8;
  var FLOATING_PANEL_GAP = 6;
  var EDGE_PAD = 8;

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
    /* Shape used by the shape tool (chosen from the shape picker). */
    editShape: "rect",
    /* picker.compact: edit toolbar shows icons only (like the screenshot bar). */
    compact: false,
    /* The shell grew the window so the toolbar floats outside the image. */
    editOutside: false,
    editTopPad: 0,
    editLeftPad: 0,
    /* Last {width,height} requested from the shell, to avoid redundant resizes. */
    editLayoutRequest: "",
    /* Annotation palette (same interaction as the screenshot overlay). */
    pickingColor: false,
    colorPopoverOpen: false,
    customColorOpen: false,
    /* Image CSS size captured before the edit window is widened: the image keeps
     * it while editing (the shell only adds transparent space around it). */
    editImageWidth: 0,
    editImageHeight: 0,
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
  /* Custom colour picker state (identical to capture.js, contract §11.10.3). */
  var hsvState = { hue: 0, saturation: 1, value: 1 };
  var hsvDragging = false;
  var hueDragging = false;

  /* ---- UI language ----------------------------------------------------- */

  /* Set once the shared runtime has applied its static pass. A later locale
   * read must not run `init` again: the static pass would replace the visible
   * `#pin-error-text` with the generic fallback. */
  var localeInitialized = false;

  /* Applies the UI language and reports whether it changed. The shell appends
   * `lang=` to this window's URL, so the first paint already uses the right
   * locale; `getState().app.locale` stays authoritative because the settings
   * can change while the pin window is open. */
  function applyLocale(locale) {
    if (!LP.i18n || typeof LP.i18n.init !== "function") {
      return false;
    }
    var value = String(locale == null ? "" : locale).trim();
    if (!value) {
      return false;
    }
    var previous =
      typeof LP.i18n.currentLocale === "function" ? LP.i18n.currentLocale() : "";
    if (!localeInitialized) {
      LP.i18n.init(value);
      localeInitialized = true;
    } else if (!LP.i18n.setLocale(value)) {
      /* Same locale: no static pass, so the rendered error text stays. */
      return false;
    }
    var next =
      typeof LP.i18n.currentLocale === "function" ? LP.i18n.currentLocale() : previous;
    if (previous === next) {
      return false;
    }
    refreshLocaleText();
    return true;
  }

  /* Re-applies copy rendered from state after a real language switch (the
   * static pass only knows the generic fallback). */
  function refreshLocaleText() {
    if (!dom.errorText) {
      return;
    }
    dom.errorText.textContent =
      localizedMessage(state.errorMessage) || LP.t("pin.loadFailed");
  }

  /* Language used before the backend responds: the URL query wins, then the
   * `<html lang>` guess made by shared/i18n.js. */
  function initialLocale() {
    var lang = "";
    try {
      lang = new URLSearchParams(window.location.search).get("lang") || "";
    } catch (error) {
      /* Old webviews without URLSearchParams: keep the <html lang> guess. */
    }
    if (lang) {
      return lang;
    }
    return document.documentElement ? document.documentElement.lang : "";
  }

  applyLocale(initialLocale());

  /* ---- Small helpers --------------------------------------------------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function each(list, callback) {
    Array.prototype.forEach.call(list || [], callback);
  }

  function numberOr(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function setHidden(node, hidden) {
    if (node) {
      node.hidden = hidden === true;
    }
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
      return LP.t("common.unknownError");
    }
    if (typeof error === "string") {
      return error;
    }
    if (typeof error.message === "string" && error.message) {
      return error.message;
    }
    return String(error);
  }

  /* Error copy may be a message-key descriptor ({ key, params }) or a raw
   * backend string; localize descriptors only when they are rendered so a
   * language switch never replays the previous language. */
  function localizedMessage(message) {
    if (!message) {
      return "";
    }
    if (typeof message === "string") {
      return message;
    }
    return LP.t(message.key, message.params);
  }

  function failureText(result, fallback) {
    var message = (result && result.error) || fallback;
    var hint = (result && result.hint) || "";
    return hint ? message + LP.t("common.detailSeparator") + hint : message;
  }

  function isUiTarget(target) {
    if (!target || !target.closest) {
      return false;
    }
    return !!target.closest(
      ".pin-toolbar, .pin-menu, .pin-error, .pin-toast, .pin-edit-bar, " +
        ".capture-palette, .palette-color-popover, .palette-custom-color"
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
    dom.customSkills = byId("pin-edit-custom-skills");
    dom.editToolButtons = Array.prototype.slice.call(
      document.querySelectorAll("[data-edit-tool]")
    );
    /* ---- Annotation palette (same component as the screenshot overlay) ---- */
    dom.palette = byId("capture-palette");
    dom.shapeButtons = Array.prototype.slice.call(
      document.querySelectorAll("#capture-palette [data-shape]")
    );
    dom.colorButton = byId("palette-color-button");
    dom.colorSwatch = byId("palette-color-swatch");
    dom.colorPopover = byId("palette-color-popover");
    dom.customColorPanel = byId("palette-custom-color");
    dom.hsv = byId("palette-hsv");
    dom.hsvCursor = byId("palette-hsv-cursor");
    dom.hue = byId("palette-hue");
    dom.hueThumb = byId("palette-hue-thumb");
    dom.rgbR = byId("palette-rgb-r");
    dom.rgbG = byId("palette-rgb-g");
    dom.rgbB = byId("palette-rgb-b");
    dom.customPreview = byId("palette-custom-preview");
  }

  function boot() {
    cacheDom();
    if (!dom.root || !dom.image) {
      return;
    }
    bindEvents();
    subscribeClose();
    window.addEventListener("resize", function () {
      syncScrollable();
      layoutPalette();
      layoutFloatingPanels();
    });
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
    bindPaletteControls();
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
      'font-family="Segoe UI, sans-serif" font-size="16">' +
      LP.t("pin.previewPlaceholder") +
      "</text></svg>";
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
      showError({ key: "pin.serviceUnavailable" });
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
        showError(failureText(result, LP.t("pin.loadFailed")));
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
        showError({ key: "pin.loadFailedDetail", params: { error: errorText(error) } });
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
    state.errorMessage = null;
    hideError();

    dom.image.onload = onImageLoaded;
    dom.image.onerror = function () {
      if (state.loaded) {
        return;
      }
      showError({ key: "pin.loadFailed" });
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
    /* Keep the descriptor (not the translated copy) so a later language switch
     * can re-render it; `error` stays the display text for QA/debug hooks. */
    state.errorMessage = message || null;
    state.error = localizedMessage(state.errorMessage) || LP.t("pin.loadFailed");
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
   * discards the annotations, the confirm button applies them and copies the
   * pin. */
  function enterEdit() {
    if (state.editing || state.closed || !state.loaded) {
      return;
    }
    hideMenu();
    closeAllColorPanels();
    setHidden(dom.palette, true);
    state.editing = true;
    state.editBusy = false;
    state.editForceCompact = false;
    /* The shell widens the window for the single-row toolbar; pin the image to
     * the size it had before that so only transparent space is added around. */
    state.editImageWidth = dom.image ? dom.image.clientWidth || 0 : 0;
    state.editImageHeight = dom.image ? dom.image.clientHeight || 0 : 0;
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
      /* Anchor the bar to the image, not to the window bottom: the shell grows
       * the window asynchronously, so a bottom-anchored bar would first appear
       * inside the image and then jump into the strip. With a top anchor it is
       * simply clipped until the strip exists and appears in its final spot. */
      placeEditBar();
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
    syncPalette();
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
    state.editLayoutRequest = "";
    stopColorPicking();
    closeAllColorPanels();
    setHidden(dom.palette, true);
    if (editor) {
      editor.setTool(null);
      editor.reset();
    }
    if (dom.editBar) {
      dom.editBar.hidden = true;
      dom.editBar.style.bottom = "";
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

  /* Natural size of the annotation palette while it is visible. The shell grows
   * the window by this size too, so the palette sits next to the edit bar
   * exactly like the screenshot overlay's property bar. */
  function measurePalette() {
    if (!dom.palette || dom.palette.hidden) {
      return null;
    }
    var width = Math.ceil(dom.palette.offsetWidth || 0);
    var height = Math.ceil(dom.palette.offsetHeight || 0);
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width: width, height: height };
  }

  /* Asks the shell to grow the window so the bar floats outside the image and
   * fits in ONE row, anchored to the left edge (exactly like the screenshot
   * toolbar). The window is also grown for the annotation palette below the bar
   * (shape / stroke-fill / width / colour / font / mosaic properties), and the
   * bar itself moves up so the palette keeps the same below-the-bar position as
   * in the screenshot overlay. `topPadding`/`leftPadding` keep the image where
   * it was when the strip had to be added above / the window shifted left. */
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
    var barSize = measureEditBar();
    if (!barSize) {
      resetEditWindowLayout();
      return null;
    }
    var paletteSize = measurePalette();
    var contentWidth = Math.max(barSize.width, paletteSize ? paletteSize.width : 0);
    /* A narrow work area cannot fit the labelled bar: fall back to the
     * icons-only layout (the screenshot toolbar's compact mode) so the bar can
     * never wrap. */
    if (
      !state.compact &&
      !state.editForceCompact &&
      contentWidth + 16 > screenWidth() - 16
    ) {
      state.editForceCompact = true;
      applyCompactToEditBar();
      barSize = measureEditBar();
      if (!barSize) {
        resetEditWindowLayout();
        return null;
      }
      contentWidth = Math.max(barSize.width, paletteSize ? paletteSize.width : 0);
    }
    var toolbarWidth = contentWidth + 16;
    /* Long screenshots fill the window vertically, so there is no outside strip:
     * the bar stays overlaid on the image, but it is still widened to one row
     * (and the palette floats over the image because there is no strip room).
     * Otherwise the strip is: 4px above the bar + bar + 8px gap (+ palette +
     * 12px bottom slack). The slack absorbs the shell/WebView rounding of the
     * fractional layout sizes so the palette never flips above the bar. */
    var toolbarHeight = state.scrollable
      ? 0
      : barSize.height + 12 + (paletteSize ? paletteSize.height + 12 : 0);
    var signature = toolbarWidth + "x" + toolbarHeight;
    /* Every range/colour input triggers the palette sync, but the window only has
     * to change when the measured content size changes. */
    placeEditBar();
    layoutPalette();
    layoutFloatingPanels();
    if (signature === state.editLayoutRequest && state.editOutside) {
      return null;
    }
    state.editLayoutRequest = signature;
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
          state.editLayoutRequest = "";
          requestEditWindow(true, true);
          return;
        }
        /* The shell clamps the palette to the window when even the icons-only
         * bar is wider than the work area: let it wrap instead of clipping. */
        fitPaletteToWindow();
      },
      function () {
        resetEditWindowLayout();
      }
    );
  }

  /* Places the edit bar. Normal pins anchor it to the IMAGE (top = image height
   * + 4px, or above the image when the strip had to be added on top), never to
   * the window bottom: the shell grows the window asynchronously, so a
   * bottom-anchored bar would first show inside the image and then jump into the
   * strip. Long screenshots keep the overlay bar at the window bottom (the
   * window is a scroll viewport and has no outside strip). */
  function placeEditBar() {
    if (!dom.editBar) {
      return;
    }
    if (state.scrollable) {
      var paletteSize = measurePalette();
      dom.editBar.style.top = "auto";
      dom.editBar.style.bottom = paletteSize
        ? paletteSize.height + PALETTE_GAP + 10 + "px"
        : "";
      return;
    }
    var barHeight = dom.editBar.offsetHeight || 0;
    var top;
    if (state.editTopPad > 0) {
      /* Strip above the image: the bar sits just above the image, which the
       * renderer pushes down by `topPadding`. */
      top = state.editTopPad - barHeight - 4;
    } else {
      top = state.editImageHeight + 4;
    }
    dom.editBar.style.top = Math.round(top) + "px";
    dom.editBar.style.bottom = "auto";
  }

  /* When the work area is narrower than the natural palette the shell could not
   * fit both: allow the palette to wrap inside the window instead of clipping. */
  function fitPaletteToWindow() {
    if (!dom.palette || dom.palette.hidden) {
      return;
    }
    var available = Math.max(120, (window.innerWidth || 0) - 2 * EDGE_PAD);
    if (dom.palette.offsetWidth > available) {
      dom.palette.style.maxWidth = available + "px";
      dom.palette.style.width = "";
      layoutPalette();
    }
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
    placeEditBar();
    /* The window grew: keep the annotation surface matched to the image, and
     * re-anchor the palette + colour panels to the new bar position. */
    layoutEditCanvas();
    layoutPalette();
    layoutFloatingPanels();
  }

  function resetEditWindowLayout() {
    state.editOutside = false;
    state.editTopPad = 0;
    state.editLeftPad = 0;
    state.editLayoutRequest = "";
    document.body.style.paddingTop = "";
    document.body.style.paddingLeft = "";
    document.body.style.removeProperty("--pin-image-width");
    if (dom.editBar) {
      dom.editBar.classList.remove("is-above");
      dom.editBar.style.left = "";
      dom.editBar.style.top = "";
      dom.editBar.style.bottom = "";
    }
    if (dom.palette) {
      dom.palette.style.maxWidth = "";
      dom.palette.style.width = "";
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
      /* Same interaction as the screenshot toolbar: clicking a tool activates it
       * (and shows the annotation palette), clicking the active tool again
       * leaves annotation mode. */
      if (button.classList.contains("is-active")) {
        selectEditTool(null, null);
        return;
      }
      selectEditTool(button, tool);
      return;
    }
    var skill = button.getAttribute("data-edit-skill");
    if (skill) {
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

  /* Activates an annotation tool (null = leave annotation mode) and refreshes
   * the palette / history buttons exactly like the screenshot overlay. */
  function selectEditTool(button, tool) {
    if (!editor) {
      return;
    }
    if (tool) {
      editor.setTool(tool);
      if (tool === "shape") {
        editor.setOption("shapeMode", state.editShape || "rect");
      }
    } else {
      editor.setTool(null);
    }
    dom.editToolButtons.forEach(function (item) {
      var active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", active ? "true" : "false");
    });
    syncPalette();
  }

  /* ---- Annotation palette (same component + interaction as the capture tool) ---- *
   * Everything below mirrors capture.js §11.10: the palette sits below the edit
   * bar (pin.js grows the window for it), only the groups relevant to the active
   * tool stay visible, and the colour popover / custom HSV / eyedropper behave
   * identically. The eyedropper samples the pinned image itself. */

  function currentTool() {
    return editor && typeof editor.getTool === "function"
      ? editor.getTool()
      : null;
  }

  function bindPaletteControls() {
    if (dom.palette) {
      dom.palette.addEventListener("click", onPaletteClick);
    }
    bindColorControls();
    bindRange("palette-width", "width");
    bindRange("palette-font-size", "fontSize");
    bindRange("palette-mosaic-size", "mosaicSize");
    bindPaletteShapeButtons();
  }

  function bindPaletteShapeButtons() {
    each(dom.shapeButtons, function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        applyShapeMode(button.getAttribute("data-shape"));
      });
    });
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

  function applyShapeMode(mode) {
    if (editor) {
      editor.setShapeMode(mode);
    }
    state.editShape = mode;
    syncShapeButtons();
    syncPalette();
  }

  function syncShapeButtons() {
    var mode =
      editor && typeof editor.getOptions === "function"
        ? editor.getOptions().shapeMode
        : state.editShape;
    each(dom.shapeButtons, function (button) {
      var active = String(button.getAttribute("data-shape")) === String(mode);
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function syncPalette() {
    if (!dom.palette) {
      return;
    }
    var tool = currentTool();
    if (!state.editing || !tool || !editor) {
      setHidden(dom.palette, true);
      closeAllColorPanels();
      requestEditWindow(true);
      return;
    }
    setHidden(dom.palette, false);
    each(dom.palette.querySelectorAll("[data-tools]"), function (group) {
      var tools = String(group.getAttribute("data-tools") || "").split(/\s+/);
      setHidden(group, tools.indexOf(tool) < 0);
    });
    syncFillVisibility(tool);
    syncPaletteValues();
    syncColorUi();
    syncShapeButtons();
    placeEditBar();
    layoutPalette();
    layoutFloatingPanels();
    /* The palette is part of the strip: let the shell grow/shrink the window. */
    requestEditWindow(true);
  }

  /* The straight-line shape has no fill, so its segmented control is hidden. */
  function syncFillVisibility(tool) {
    var node = byId("palette-fill");
    if (!node || !editor) {
      return;
    }
    var hideLine =
      tool === "shape" && editor.getOptions().shapeMode === "line";
    if (hideLine) {
      var wrapper = node.closest("[data-tools]") || node;
      setHidden(wrapper, true);
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
      var active = node.getAttribute("data-fill") === options.fill;
      node.classList.toggle("is-active", active);
      node.setAttribute("aria-pressed", active ? "true" : "false");
    });
    each(dom.palette.querySelectorAll("[data-bg-color]"), function (node) {
      var value = node.getAttribute("data-bg-color") || "";
      var active = value === (options.textBg || "");
      node.classList.toggle("is-active", active);
      node.setAttribute("aria-pressed", active ? "true" : "false");
    });
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

  /* Palette placement. Normal pins pin the palette to the bar's side that the
   * shell reserved room for (below the bar; above it when the strip was added on
   * top) — never based on the current window height, because the window grows
   * asynchronously and a space-based flip would move the palette after the
   * resize. Until the strip exists it is simply clipped outside the window and
   * appears in its final spot. Long screenshots have no strip, so there the
   * palette flips to the side with room (same rule as the capture overlay). */
  function layoutPalette() {
    if (!dom.palette || dom.palette.hidden || !dom.editBar || dom.editBar.hidden) {
      return;
    }
    var paletteWidth = dom.palette.offsetWidth || 0;
    var paletteHeight = dom.palette.offsetHeight || 0;
    if (!paletteWidth || !paletteHeight) {
      return;
    }
    var size = viewportSize();
    var barRect = dom.editBar.getBoundingClientRect();
    var left = clamp(
      barRect.left,
      EDGE_PAD,
      Math.max(EDGE_PAD, size.width - paletteWidth - EDGE_PAD)
    );
    var top;
    if (!state.scrollable) {
      top =
        state.editTopPad > 0
          ? barRect.top - paletteHeight - PALETTE_GAP
          : barRect.bottom + PALETTE_GAP;
    } else {
      var belowTop = barRect.bottom + PALETTE_GAP;
      var aboveTop = barRect.top - paletteHeight - PALETTE_GAP;
      if (size.height - belowTop >= paletteHeight + EDGE_PAD) {
        top = belowTop;
      } else if (aboveTop >= EDGE_PAD) {
        top = aboveTop;
      } else {
        top = clamp(
          belowTop,
          EDGE_PAD,
          Math.max(EDGE_PAD, size.height - paletteHeight - EDGE_PAD)
        );
      }
    }
    dom.palette.style.left = Math.round(left) + "px";
    dom.palette.style.top = Math.round(top) + "px";
    dom.palette.style.right = "";
    dom.palette.style.bottom = "";
  }

  function viewportSize() {
    return {
      width: Math.max(1, window.innerWidth || 0),
      height: Math.max(1, window.innerHeight || 0)
    };
  }

  /* ---- Colour panel (§11.10.3): preset popover, custom HSV picker, eyedropper ---- */

  function parseHexColor(value) {
    var hex = String(value == null ? "" : value).trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
      return null;
    }
    var body = hex.slice(1);
    if (body.length === 3) {
      body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
    }
    return {
      r: parseInt(body.slice(0, 2), 16),
      g: parseInt(body.slice(2, 4), 16),
      b: parseInt(body.slice(4, 6), 16)
    };
  }

  function channelHex(channel) {
    var value = Math.max(0, Math.min(255, Math.round(numberOr(channel, 0))));
    var hex = value.toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }

  function rgbToHex(red, green, blue) {
    return "#" + channelHex(red) + channelHex(green) + channelHex(blue);
  }

  function rgbToHsv(red, green, blue) {
    var r = Math.max(0, Math.min(255, numberOr(red, 0))) / 255;
    var g = Math.max(0, Math.min(255, numberOr(green, 0))) / 255;
    var b = Math.max(0, Math.min(255, numberOr(blue, 0))) / 255;
    var maximum = Math.max(r, g, b);
    var minimum = Math.min(r, g, b);
    var delta = maximum - minimum;
    var hue = 0;
    if (delta > 0.00001) {
      if (maximum === r) {
        hue = ((g - b) / delta) % 6;
      } else if (maximum === g) {
        hue = (b - r) / delta + 2;
      } else {
        hue = (r - g) / delta + 4;
      }
      hue *= 60;
      if (hue < 0) {
        hue += 360;
      }
    }
    return {
      hue: hue,
      saturation: maximum === 0 ? 0 : delta / maximum,
      value: maximum
    };
  }

  function hsvToRgb(hue, saturation, value) {
    var h = ((numberOr(hue, 0) % 360) + 360) % 360;
    var s = clamp(numberOr(saturation, 0), 0, 1);
    var v = clamp(numberOr(value, 0), 0, 1);
    var c = v * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = v - c;
    var r = 0;
    var g = 0;
    var b = 0;
    if (h < 60) {
      r = c;
      g = x;
    } else if (h < 120) {
      r = x;
      g = c;
    } else if (h < 180) {
      g = c;
      b = x;
    } else if (h < 240) {
      g = x;
      b = c;
    } else if (h < 300) {
      r = x;
      b = c;
    } else {
      r = c;
      b = x;
    }
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
  }

  function currentColorHex() {
    return editor ? String(editor.getOptions().color || "#ef4444") : "#ef4444";
  }

  function positionFloatingPanel(panel, anchorRect) {
    if (!panel) {
      return;
    }
    var panelWidth = panel.offsetWidth || 0;
    var panelHeight = panel.offsetHeight || 0;
    if (!panelWidth || !panelHeight) {
      return;
    }
    var size = viewportSize();
    var left = clamp(
      anchorRect.left,
      EDGE_PAD,
      Math.max(EDGE_PAD, size.width - panelWidth - EDGE_PAD)
    );
    var belowTop = anchorRect.bottom + FLOATING_PANEL_GAP;
    var aboveTop = anchorRect.top - panelHeight - FLOATING_PANEL_GAP;
    var top;
    if (size.height - belowTop >= panelHeight + EDGE_PAD) {
      top = belowTop;
    } else if (aboveTop >= EDGE_PAD) {
      top = aboveTop;
    } else {
      top = clamp(
        belowTop,
        EDGE_PAD,
        Math.max(EDGE_PAD, size.height - panelHeight - EDGE_PAD)
      );
    }
    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
    panel.style.right = "";
    panel.style.bottom = "";
  }

  function colorAnchorRect() {
    var node = dom.colorButton || dom.palette || dom.editBar;
    if (!node || typeof node.getBoundingClientRect !== "function") {
      return {
        left: EDGE_PAD,
        right: EDGE_PAD,
        top: EDGE_PAD,
        bottom: EDGE_PAD,
        width: 0,
        height: 0
      };
    }
    return node.getBoundingClientRect();
  }

  /* Applies a colour to the shared editor state and every colour surface. */
  function pushColor(hex) {
    var color = String(hex || "").trim();
    if (!parseHexColor(color)) {
      return;
    }
    color = color.toLowerCase();
    if (editor) {
      editor.setOption("color", color);
    }
    if (dom.colorSwatch) {
      dom.colorSwatch.style.background = color;
    }
    if (dom.customPreview) {
      dom.customPreview.style.background = color;
    }
    if (dom.colorButton) {
      var colorLabel = LP.t("pin.colorWithValue", { color: color });
      dom.colorButton.title = colorLabel;
      dom.colorButton.setAttribute("aria-label", colorLabel);
    }
    each(document.querySelectorAll(".palette-color[data-color]"), function (node) {
      var value = String(node.getAttribute("data-color") || "").toLowerCase();
      node.classList.toggle("is-active", value === color);
    });
  }

  function syncColorUi() {
    pushColor(currentColorHex());
  }

  function syncHsvFromColor() {
    var color = parseHexColor(currentColorHex());
    if (color) {
      hsvState = rgbToHsv(color.r, color.g, color.b);
    }
  }

  /* Refresh the HSV cursor, hue thumb, preview and RGB inputs without touching
   * the editor colour (callers decide when to apply it). */
  function renderHsvUi() {
    var rgb = hsvToRgb(hsvState.hue, hsvState.saturation, hsvState.value);
    var hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    if (dom.hsv) {
      dom.hsv.style.backgroundColor =
        "hsl(" + Math.round(hsvState.hue) + ", 100%, 50%)";
      if (dom.hsvCursor) {
        var hsvWidth = dom.hsv.clientWidth || 0;
        var hsvHeight = dom.hsv.clientHeight || 0;
        dom.hsvCursor.style.left =
          Math.round(hsvState.saturation * Math.max(1, hsvWidth)) + "px";
        dom.hsvCursor.style.top =
          Math.round((1 - hsvState.value) * Math.max(1, hsvHeight)) + "px";
      }
    }
    if (dom.hueThumb) {
      dom.hueThumb.style.left = (hsvState.hue / 360) * 100 + "%";
    }
    if (dom.customPreview) {
      dom.customPreview.style.background = hex;
    }
    setNumberInputValue(dom.rgbR, rgb.r);
    setNumberInputValue(dom.rgbG, rgb.g);
    setNumberInputValue(dom.rgbB, rgb.b);
  }

  function setNumberInputValue(input, value) {
    if (!input || document.activeElement === input) {
      return;
    }
    input.value = String(value);
  }

  function applyHsvColor() {
    var rgb = hsvToRgb(hsvState.hue, hsvState.saturation, hsvState.value);
    pushColor(rgbToHex(rgb.r, rgb.g, rgb.b));
    renderHsvUi();
  }

  function applyRgbColor(red, green, blue) {
    var r = Math.round(clamp(numberOr(red, 0), 0, 255));
    var g = Math.round(clamp(numberOr(green, 0), 0, 255));
    var b = Math.round(clamp(numberOr(blue, 0), 0, 255));
    hsvState = rgbToHsv(r, g, b);
    pushColor(rgbToHex(r, g, b));
    renderHsvUi();
  }

  /* ---- floating panels ------------------------------------------------- */

  function openColorPopover() {
    if (!dom.colorPopover) {
      return;
    }
    closeCustomColor();
    setHidden(dom.colorPopover, false);
    state.colorPopoverOpen = true;
    syncColorUi();
    positionFloatingPanel(dom.colorPopover, colorAnchorRect());
  }

  function closeColorPopover() {
    if (!dom.colorPopover) {
      return;
    }
    setHidden(dom.colorPopover, true);
    state.colorPopoverOpen = false;
    if (dom.colorButton) {
      dom.colorButton.setAttribute("aria-expanded", "false");
    }
  }

  function toggleColorPopover() {
    if (state.colorPopoverOpen) {
      closeColorPopover();
    } else {
      openColorPopover();
    }
  }

  function openCustomColor() {
    if (!dom.customColorPanel) {
      return;
    }
    closeColorPopover();
    syncHsvFromColor();
    setHidden(dom.customColorPanel, false);
    state.customColorOpen = true;
    positionFloatingPanel(dom.customColorPanel, colorAnchorRect());
    renderHsvUi();
  }

  function closeCustomColor() {
    if (!dom.customColorPanel) {
      return;
    }
    setHidden(dom.customColorPanel, true);
    state.customColorOpen = false;
  }

  function closeAllColorPanels() {
    closeColorPopover();
    closeCustomColor();
  }

  function layoutFloatingPanels() {
    var anchor = colorAnchorRect();
    if (state.colorPopoverOpen && dom.colorPopover) {
      positionFloatingPanel(dom.colorPopover, anchor);
    }
    if (state.customColorOpen && dom.customColorPanel) {
      positionFloatingPanel(dom.customColorPanel, anchor);
      renderHsvUi();
    }
  }

  function onColorPopoverClick(event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var preset = target.closest("[data-color]");
    if (preset) {
      event.preventDefault();
      pushColor(preset.getAttribute("data-color"));
      closeColorPopover();
      return;
    }
    if (target.closest("#palette-color-custom")) {
      event.preventDefault();
      openCustomColor();
      return;
    }
    if (target.closest("#palette-eyedropper")) {
      event.preventDefault();
      startColorPicking();
    }
  }

  function onCustomColorClick(event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    if (target.closest("#palette-eyedropper")) {
      event.preventDefault();
      startColorPicking();
    }
  }

  /* ---- HSV square / hue bar / RGB inputs ------------------------------- */

  function updateHsvFromPointer(event) {
    if (!dom.hsv) {
      return;
    }
    var rect = dom.hsv.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    hsvState.saturation = clamp(
      (numberOr(event.clientX, rect.left) - rect.left) / rect.width,
      0,
      1
    );
    hsvState.value = 1 - clamp(
      (numberOr(event.clientY, rect.top) - rect.top) / rect.height,
      0,
      1
    );
    applyHsvColor();
  }

  function updateHueFromPointer(event) {
    if (!dom.hue) {
      return;
    }
    var rect = dom.hue.getBoundingClientRect();
    if (!rect.width) {
      return;
    }
    hsvState.hue =
      clamp((numberOr(event.clientX, rect.left) - rect.left) / rect.width, 0, 1) *
      360;
    applyHsvColor();
  }

  function bindDragSurface(node, onMove, onStop) {
    if (!node) {
      return;
    }
    var dragging = false;
    node.addEventListener("pointerdown", function (event) {
      if (event.button !== undefined && event.button !== 0) {
        return;
      }
      event.preventDefault();
      dragging = true;
      try {
        node.setPointerCapture(event.pointerId);
      } catch (error) {
        /* pointer capture is an optimisation only */
      }
      onMove(event);
    });
    node.addEventListener("pointermove", function (event) {
      if (!dragging) {
        return;
      }
      event.preventDefault();
      onMove(event);
    });
    var stop = function (event) {
      if (!dragging) {
        return;
      }
      dragging = false;
      if (typeof onStop === "function") {
        onStop(event);
      }
    };
    node.addEventListener("pointerup", stop);
    node.addEventListener("pointercancel", stop);
  }

  function bindColorControls() {
    if (dom.colorButton) {
      dom.colorButton.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        toggleColorPopover();
      });
    }
    if (dom.colorPopover) {
      dom.colorPopover.addEventListener("click", onColorPopoverClick);
    }
    if (dom.customColorPanel) {
      dom.customColorPanel.addEventListener("click", onCustomColorClick);
    }
    bindDragSurface(
      dom.hsv,
      function (event) {
        hsvDragging = true;
        updateHsvFromPointer(event);
      },
      function () {
        hsvDragging = false;
      }
    );
    bindDragSurface(
      dom.hue,
      function (event) {
        hueDragging = true;
        updateHueFromPointer(event);
      },
      function () {
        hueDragging = false;
      }
    );
    bindRgbInput(dom.rgbR);
    bindRgbInput(dom.rgbG);
    bindRgbInput(dom.rgbB);
    document.addEventListener("pointerdown", onDocumentPointerDownCapture, true);
  }

  function bindRgbInput(input) {
    if (!input) {
      return;
    }
    var update = function () {
      applyRgbColor(
        dom.rgbR ? dom.rgbR.value : 0,
        dom.rgbG ? dom.rgbG.value : 0,
        dom.rgbB ? dom.rgbB.value : 0
      );
    };
    input.addEventListener("input", update);
    input.addEventListener("change", update);
    input.addEventListener("blur", function () {
      renderHsvUi();
    });
  }

  /* Click outside any colour panel closes the topmost ones (§11.10.1). */
  function onDocumentPointerDownCapture(event) {
    if (state.pickingColor) {
      return;
    }
    if (!state.colorPopoverOpen && !state.customColorOpen) {
      return;
    }
    var target = event.target;
    if (target && target.closest) {
      if (
        target.closest(
          "#palette-color-popover, #palette-custom-color, #palette-color-button, #palette-color-group"
        )
      ) {
        return;
      }
    }
    closeAllColorPanels();
  }

  /* ---- eyedropper (§11.10.3): samples the pinned image itself ---------- */

  function startColorPicking() {
    if (state.pickingColor) {
      return;
    }
    if (!editor || typeof editor.sampleColor !== "function") {
      toast(LP.t("pin.toast.pickColorUnavailable"), "error");
      return;
    }
    state.pickingColor = true;
    closeAllColorPanels();
    document.body.classList.add("picking-color");
    document.addEventListener("pointerdown", onColorPickPointerDown, true);
  }

  function stopColorPicking() {
    if (!state.pickingColor) {
      return;
    }
    state.pickingColor = false;
    document.body.classList.remove("picking-color");
    document.removeEventListener("pointerdown", onColorPickPointerDown, true);
    hsvDragging = false;
    hueDragging = false;
  }

  function onColorPickPointerDown(event) {
    if (!state.pickingColor) {
      return;
    }
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    var color = null;
    var rect = dom.image ? dom.image.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0) {
      try {
        color = editor.sampleColor(
          event.clientX - rect.left,
          event.clientY - rect.top
        );
      } catch (error) {
        color = null;
      }
    }
    stopColorPicking();
    if (color) {
      pushColor(color);
      syncHsvFromColor();
      toast(LP.t("pin.toast.colorPicked", { color: color }), "success");
    } else {
      toast(LP.t("pin.toast.colorUnavailable"), "error");
    }
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
        /* The state is authoritative: it also covers a pin that is open
         * while the user changes the UI language in Settings. */
        if (payload && payload.app) {
          applyLocale(payload.app.locale);
        }
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
      toast(LP.t("pin.imageSkillUnavailable"), "error");
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
          toast(
            LP.t("pin.toast.actionFailed", {
              error: failureText(result, LP.t("common.unknownError")),
            }),
            "error"
          );
          return;
        }
        toast(LP.t("pin.toast.resultSent"), "info");
      },
      function (error) {
        state.editBusy = false;
        updateEditBar();
        toast(LP.t("pin.toast.actionFailed", { error: errorText(error) }), "error");
      }
    );
  }

  /* `apply` = the confirm button: replace the pinned image with the annotated
   * one (and copy it); otherwise only copy. */
  function exportEditAnnotations(apply) {
    if (!state.editing || state.editBusy) {
      return;
    }
    if (!API || typeof API.exportAnnotations !== "function") {
      toast(LP.t("pin.editServiceUnavailable"), "error");
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
          toast(
            LP.t("pin.toast.actionFailed", {
              error: failureText(result, LP.t("common.unknownError")),
            }),
            "error"
          );
          return;
        }
        var copied = !result || result.clipboard !== false;
        if (apply) {
          if (result && result.dataUrl && dom.image) {
            dom.image.removeAttribute("src");
            dom.image.src = String(result.dataUrl);
          }
          exitEdit();
          toast(
            copied ? LP.t("pin.toast.savedAndCopied") : LP.t("pin.toast.savedCopyFailed"),
            copied ? "success" : "error"
          );
          return;
        }
        toast(
          copied ? LP.t("pin.toast.copied") : LP.t("pin.toast.copyFailed"),
          copied ? "success" : "error"
        );
      },
      function (error) {
        state.editBusy = false;
        updateEditBar();
        toast(LP.t("pin.toast.actionFailed", { error: errorText(error) }), "error");
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
      toast(LP.t("pin.serviceUnavailable"), "error");
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
          toast(LP.t("pin.toast.copied"), "success");
          return;
        }
        toast(
          LP.t("pin.toast.copyFailedDetail", {
            error: failureText(result, LP.t("common.unknownError")),
          }),
          "error"
        );
      },
      function (error) {
        toast(LP.t("pin.toast.copyFailedDetail", { error: errorText(error) }), "error");
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
    /* Same Esc ladder as the screenshot overlay (contract §11.10): eyedropper ->
     * custom colour panel -> preset popover -> active tool -> leave edit mode. */
    if (state.editing) {
      if (state.pickingColor) {
        stopColorPicking();
        return;
      }
      if (state.customColorOpen) {
        closeCustomColor();
        return;
      }
      if (state.colorPopoverOpen) {
        closeColorPopover();
        return;
      }
      if (currentTool()) {
        selectEditTool(null, null);
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
