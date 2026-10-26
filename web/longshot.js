/* Lexora manual-scroll long-screenshot preview renderer (contract §11.14.1).
 *
 * Minimal QQ-style preview: the shell keeps stitching frames while the user
 * scrolls the target app (no speed limit) and emits
 * `longshot-progress {width,height,frames,revision,stalled}` after every stitch.
 * This page is event driven: a changed `revision` triggers a throttled
 * (≤80ms) `longshot_preview` fetch, and the PNG is decoded on a back <img>
 * layer before being promoted to the front (double buffering → no flashing).
 * A low-frequency `state` fallback (1s) only recovers missed events / stalled
 * flags. The window itself is resized by the shell to the stitched aspect ratio,
 * so the image always fills the card.
 *
 * Direction / cancel / finish live in the separate `longshot-bar` window below
 * the selection (the capture overlays are click-through while scrolling).
 */
(function () {
  "use strict";

  var API = window.longshotAPI;
  var PREVIEW_MODE = !(window.__TAURI__ && window.__TAURI__.core);
  var PREVIEW_THROTTLE = 80;
  var STATE_FALLBACK = 1000;
  var TOAST_MS = 2600;

  var state = {
    direction: "vertical",
    width: 0,
    height: 0,
    frames: 0,
    stalled: false,
    done: false,
    cancelled: false,
    ready: false,
    revision: 0,
    renderedRevision: 0,
    renders: 0,
    frontLayer: 0,
    lastRenderMs: 0,
    lastProgressRevision: 0,
    stateCalls: 0,
    previewCalls: 0,
    progressEvents: 0,
    imageSrcLength: 0,
    lastError: ""
  };

  /* Test/debug hook used by the CDP checks in tests/ and manual QA. */
  window.__longshotState = state;

  var dom = {};
  var previewTimer = 0;
  var fallbackTimer = 0;
  var toastTimer = 0;
  var previewInflight = false;
  var previewQueued = false;
  var renderToken = 0;

  /* ---- Small helpers --------------------------------------------------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function positiveNumber(value) {
    var number = Number(value);
    return isFinite(number) && number > 0 ? Math.round(number) : 0;
  }

  function now() {
    return window.performance && typeof window.performance.now === "function"
      ? window.performance.now()
      : Date.now();
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

  function apiCall(name) {
    if (!API || typeof API[name] !== "function") {
      return Promise.resolve({
        ok: false,
        error: "长截图服务不可用，请重启 Lexora 后再试。"
      });
    }
    try {
      return Promise.resolve(API[name]());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function locked() {
    return state.done || state.cancelled;
  }

  /* ---- DOM cache + boot ------------------------------------------------ */

  function cacheDom() {
    dom.root = byId("longshot-root");
    dom.canvas = document.querySelector(".longshot-canvas");
    dom.image = byId("longshot-image");
    dom.imageBuffer = byId("longshot-image-buffer");
    dom.empty = byId("longshot-empty");
    dom.meta = byId("longshot-meta");
    dom.error = byId("longshot-error");
    dom.errorText = byId("longshot-error-text");
    dom.errorClose = byId("longshot-error-close");
    dom.toast = byId("longshot-toast");
  }

  function boot() {
    cacheDom();
    if (!dom.root || !dom.image) {
      return;
    }
    bindEvents();
    subscribeLongshot();
    updateUi();
    initialLoad();
  }

  function bindEvents() {
    if (dom.errorClose) {
      dom.errorClose.addEventListener("click", hideError);
    }
  }

  function subscribeLongshot() {
    if (!API) {
      return;
    }
    if (typeof API.onProgress === "function") {
      try {
        API.onProgress(onProgress);
      } catch (error) {
        /* the 1s state fallback still refreshes the preview */
      }
    }
    if (typeof API.onCancelled === "function") {
      try {
        API.onCancelled(onCancelled);
      } catch (error) {
        /* the shell destroys the window anyway */
      }
    }
  }

  /* ---- State <-> UI ---------------------------------------------------- */

  function applyState(result) {
    if (!result) {
      return { changed: false, revisionAdvanced: false };
    }
    var changed = false;
    var width = positiveNumber(result.width);
    var height = positiveNumber(result.height);
    if (width && width !== state.width) {
      state.width = width;
      changed = true;
    }
    if (height && height !== state.height) {
      state.height = height;
      changed = true;
    }
    var frames = positiveNumber(result.frames);
    if (frames && frames !== state.frames) {
      state.frames = frames;
      changed = true;
    }
    if (result.direction === "horizontal" || result.direction === "vertical") {
      state.direction = result.direction;
    }
    if (typeof result.stalled === "boolean") {
      state.stalled = result.stalled;
    }
    if (typeof result.done === "boolean") {
      state.done = state.done || result.done;
    }
    var revision = positiveNumber(result.revision);
    var revisionAdvanced = revision > state.revision;
    if (revisionAdvanced) {
      state.revision = revision;
    }
    updateUi();
    return { changed: changed, revisionAdvanced: revisionAdvanced };
  }

  /* ---- Event-driven preview refresh ----------------------------------- */

  function onProgress(payload) {
    if (!payload || state.done || state.cancelled) {
      return;
    }
    state.progressEvents += 1;
    var progressRevision = positiveNumber(payload.revision);
    var info = applyState(payload);
    var unrendered =
      progressRevision > 0 && progressRevision > state.renderedRevision;
    if (progressRevision > state.lastProgressRevision) {
      state.lastProgressRevision = progressRevision;
    }
    if (info.changed || unrendered || PREVIEW_MODE) {
      schedulePreview();
    }
  }

  function schedulePreview() {
    if (locked() || previewTimer) {
      return;
    }
    previewTimer = window.setTimeout(function () {
      previewTimer = 0;
      fetchPreview();
    }, PREVIEW_THROTTLE);
  }

  function fetchPreview() {
    if (locked()) {
      return;
    }
    if (previewInflight) {
      previewQueued = true;
      return;
    }
    previewInflight = true;
    state.previewCalls += 1;
    apiCall("preview")
      .then(function (result) {
        if (state.done || state.cancelled) {
          return;
        }
        if (!result || result.ok === false) {
          showError(failureText(result, "获取长截图预览失败"));
          return;
        }
        applyState(result);
        if (result.dataUrl) {
          renderPreview(String(result.dataUrl));
        }
      })
      .catch(function (error) {
        showError("获取长截图预览失败：" + errorText(error));
      })
      .then(function () {
        previewInflight = false;
        if (previewQueued) {
          previewQueued = false;
          schedulePreview();
        }
      });
  }

  /* Double buffering: decode on the back layer, then swap the front layer. */
  function renderPreview(dataUrl) {
    var layers = [dom.image];
    if (dom.imageBuffer) {
      layers.push(dom.imageBuffer);
    }
    if (!layers.length) {
      return;
    }
    var front = state.frontLayer % layers.length;
    var backIndex = layers.length > 1 ? (front + 1) % layers.length : front;
    var target = layers[backIndex];
    var token = (renderToken += 1);
    var started = now();
    var applied = false;

    function apply() {
      if (applied || token !== renderToken || state.done || state.cancelled) {
        return;
      }
      applied = true;
      var previous = layers[state.frontLayer % layers.length];
      if (previous && previous !== target) {
        previous.classList.remove("is-front");
      }
      target.hidden = false;
      target.classList.add("is-front");
      state.frontLayer = backIndex;
      state.renders += 1;
      state.lastRenderMs = Math.round(now() - started);
      state.renderedRevision = state.revision;
      state.imageSrcLength = dataUrl.length;
      if (dom.empty) {
        dom.empty.hidden = true;
      }
      updateUi();
    }

    target.classList.remove("is-front");
    target.hidden = false;
    target.onload = function () {
      target.onload = null;
      apply();
    };
    target.onerror = function () {
      target.onerror = null;
      if (token === renderToken) {
        showError("长截图预览加载失败");
      }
    };
    target.src = dataUrl;
    if (typeof target.decode === "function") {
      target.decode().then(apply, function () {
        /* the onload handler still applies the frame */
      });
    }
    if (target.complete && target.naturalWidth > 0) {
      apply();
    }
  }

  function clearPreview() {
    renderToken += 1;
    [dom.image, dom.imageBuffer].forEach(function (node) {
      if (!node) {
        return;
      }
      node.hidden = true;
      node.classList.remove("is-front");
      node.onload = null;
      node.onerror = null;
      node.removeAttribute("src");
    });
    state.frontLayer = 0;
    state.imageSrcLength = 0;
    state.lastRenderMs = 0;
    if (dom.empty) {
      dom.empty.hidden = false;
      dom.empty.textContent = "正在重置拼接…";
    }
    hideError();
  }

  /* ---- Initial load + low-frequency state fallback --------------------- */

  function initialLoad() {
    state.stateCalls += 1;
    apiCall("state")
      .then(function (result) {
        if (!result || result.ok === false) {
          showError(failureText(result, "读取长截图状态失败"));
          return;
        }
        applyState(result);
      })
      .catch(function (error) {
        showError("读取长截图状态失败：" + errorText(error));
      })
      .then(function () {
        state.ready = true;
        updateUi();
        fetchPreview();
        scheduleFallback();
      });
  }

  function scheduleFallback() {
    window.clearTimeout(fallbackTimer);
    if (locked()) {
      return;
    }
    fallbackTimer = window.setTimeout(fallbackTick, STATE_FALLBACK);
  }

  function fallbackTick() {
    if (locked()) {
      return;
    }
    state.stateCalls += 1;
    apiCall("state")
      .then(function (result) {
        if (locked()) {
          return;
        }
        if (!result || result.ok === false) {
          showError(failureText(result, "读取长截图状态失败"));
          return;
        }
        var info = applyState(result);
        if (
          info.revisionAdvanced ||
          (!state.imageSrcLength && info.changed) ||
          state.revision > state.renderedRevision
        ) {
          schedulePreview();
        }
        if (!state.imageSrcLength) {
          fetchPreview();
        }
      })
      .catch(function (error) {
        showError("读取长截图状态失败：" + errorText(error));
      })
      .then(function () {
        if (!locked()) {
          scheduleFallback();
        }
      });
  }

  function onCancelled() {
    state.cancelled = true;
    window.clearTimeout(previewTimer);
    window.clearTimeout(fallbackTimer);
    previewTimer = 0;
    fallbackTimer = 0;
    updateUi();
  }

  /* ---- UI -------------------------------------------------------------- */

  function updateUi() {
    if (dom.meta) {
      var width = state.width || 0;
      var height = state.height || 0;
      var frames = state.frames || 0;
      if (state.width > 0) {
        dom.meta.hidden = false;
        dom.meta.textContent =
          "第 " + frames + " 帧 · " + width + " × " + height;
        if (state.stalled) {
          dom.meta.setAttribute("data-tone", "stalled");
          dom.meta.textContent = "拼接中… · " + width + " × " + height;
        } else {
          dom.meta.removeAttribute("data-tone");
        }
      } else {
        dom.meta.hidden = true;
      }
    }
  }

  function showError(message) {
    state.lastError = String(message || "");
    if (dom.errorText) {
      dom.errorText.textContent = state.lastError;
    }
    if (dom.error) {
      dom.error.hidden = false;
    }
  }

  function hideError() {
    state.lastError = "";
    if (dom.error) {
      dom.error.hidden = true;
    }
  }

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

  /* Test/debug helper: force a state/preview refresh. */
  window.__longshotRefresh = function () {
    hideError();
    return apiCall("state").then(function (result) {
      if (result && result.ok !== false) {
        applyState(result);
      }
      return fetchPreview();
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
