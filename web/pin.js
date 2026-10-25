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
    closeCalls: 0
  };

  /* Test/debug hook used by the CDP checks in tests/ and manual QA. */
  window.__pinState = state;

  var dom = {};
  var drag = null;
  var toastTimer = 0;

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
      ".pin-toolbar, .pin-menu, .pin-error, .pin-toast"
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
    dom.error = byId("pin-error");
    dom.errorText = byId("pin-error-text");
    dom.errorClose = byId("pin-error-close");
    dom.menu = byId("pin-context-menu");
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
  }

  function bindEvents() {
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);

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
    if (state.closed || !dom.menu) {
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
    if (event.button !== 0 || state.closed || state.dragging) {
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
    if (isUiTarget(event.target)) {
      return;
    }
    event.preventDefault();
    closePin();
  }

  function onKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
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
