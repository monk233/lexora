/* Lexora manual-scroll long-screenshot preview renderer (contract §11.14).
 *
 * The shell hides the capture overlay, creates this always-on-top window and
 * keeps stitching frames while the user scrolls the target app. This page polls
 * `longshot_state` for size/frame changes, fetches `longshot_preview` (PNG data
 * URL) when the stitched image changed, and offers direction switch / finish /
 * cancel.
 *
 * Browser preview: the mock increments the stitched size on every preview call,
 * so polling also previews each tick while `window.__TAURI__` is absent.
 */
(function () {
  "use strict";

  var API = window.longshotAPI;
  var PREVIEW_MODE = !(window.__TAURI__ && window.__TAURI__.core);
  var POLL_INTERVAL = 350;
  var PROGRESS_THROTTLE = 200;
  var TOAST_MS = 3200;

  var state = {
    direction: "vertical",
    width: 0,
    height: 0,
    frames: 0,
    stalled: false,
    done: false,
    cancelled: false,
    busy: false,
    ready: false,
    finishCalls: 0,
    cancelCalls: 0,
    directionCalls: 0,
    stateCalls: 0,
    previewCalls: 0,
    imageSrcLength: 0,
    lastError: ""
  };

  /* Test/debug hook used by the CDP checks in tests/ and manual QA. */
  window.__longshotState = state;

  var dom = {};
  var pollTimer = 0;
  var progressTimer = 0;
  var toastTimer = 0;
  var previewInflight = false;

  /* ---- Small helpers --------------------------------------------------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function positiveNumber(value) {
    var number = Number(value);
    return isFinite(number) && number > 0 ? Math.round(number) : 0;
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

  function apiCall(name, argument) {
    if (!API || typeof API[name] !== "function") {
      return Promise.resolve({ ok: false, error: "长截图服务不可用，请重启 Lexora 后再试。" });
    }
    try {
      return Promise.resolve(API[name](argument));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /* ---- DOM cache + boot ------------------------------------------------ */

  function cacheDom() {
    dom.root = byId("longshot-root");
    dom.image = byId("longshot-image");
    dom.empty = byId("longshot-empty");
    dom.error = byId("longshot-error");
    dom.errorText = byId("longshot-error-text");
    dom.errorClose = byId("longshot-error-close");
    dom.size = byId("longshot-size");
    dom.frames = byId("longshot-frames");
    dom.warning = byId("longshot-warning");
    dom.directions = byId("longshot-directions");
    dom.finish = byId("longshot-finish");
    dom.cancel = byId("longshot-cancel");
    dom.toast = byId("longshot-toast");
    dom.done = byId("longshot-done");
    dom.doneText = byId("longshot-done-text");
  }

  function boot() {
    cacheDom();
    if (!dom.root || !dom.image) {
      return;
    }
    bindEvents();
    subscribeLongshot();
    updateUi();
    poll(true, function () {
      state.ready = true;
      updateUi();
    });
    schedulePoll();
  }

  function bindEvents() {
    if (dom.directions) {
      dom.directions.addEventListener("click", function (event) {
        var button =
          event.target && event.target.closest
            ? event.target.closest("[data-direction]")
            : null;
        if (!button || button.disabled) {
          return;
        }
        switchDirection(button.getAttribute("data-direction"));
      });
    }
    if (dom.finish) {
      dom.finish.addEventListener("click", finish);
    }
    if (dom.cancel) {
      dom.cancel.addEventListener("click", cancel);
    }
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
        /* polling still keeps the preview fresh */
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

  /* ---- Polling / preview ----------------------------------------------- */

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(function () {
      pollTimer = 0;
      poll(false);
    }, POLL_INTERVAL);
  }

  function poll(force, onDone) {
    if (state.done || state.cancelled) {
      return;
    }
    state.stateCalls += 1;
    apiCall("state")
      .then(function (result) {
        if (state.done || state.cancelled) {
          return undefined;
        }
        if (!result || result.ok === false) {
          showError(failureText(result, "读取长截图状态失败"));
          return undefined;
        }
        var changed = applyState(result);
        if (force || changed || PREVIEW_MODE) {
          return loadPreview();
        }
        return undefined;
      })
      .catch(function (error) {
        showError("读取长截图状态失败：" + errorText(error));
      })
      .then(function () {
        if (typeof onDone === "function") {
          onDone();
        }
        if (!state.done && !state.cancelled) {
          schedulePoll();
        }
      });
  }

  function applyState(result) {
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
    state.stalled = !!result.stalled;
    if (typeof result.done === "boolean") {
      state.done = state.done || result.done;
    }
    updateUi();
    return changed;
  }

  function loadPreview() {
    if (state.done || state.cancelled || previewInflight) {
      return Promise.resolve();
    }
    previewInflight = true;
    state.previewCalls += 1;
    return apiCall("preview")
      .then(function (result) {
        if (state.done || state.cancelled) {
          return;
        }
        if (!result || result.ok === false) {
          showError(failureText(result, "获取长截图预览失败"));
          return;
        }
        if (positiveNumber(result.width)) {
          state.width = positiveNumber(result.width);
        }
        if (positiveNumber(result.height)) {
          state.height = positiveNumber(result.height);
        }
        if (positiveNumber(result.frames)) {
          state.frames = positiveNumber(result.frames);
        }
        if (result.direction === "horizontal" || result.direction === "vertical") {
          state.direction = result.direction;
        }
        if (result.dataUrl) {
          setImage(String(result.dataUrl));
        }
        updateUi();
      })
      .catch(function (error) {
        showError("获取长截图预览失败：" + errorText(error));
      })
      .then(function () {
        previewInflight = false;
      });
  }

  function setImage(dataUrl) {
    state.imageSrcLength = dataUrl.length;
    dom.image.onload = function () {
      dom.image.hidden = false;
      if (dom.empty) {
        dom.empty.hidden = true;
      }
    };
    dom.image.onerror = function () {
      showError("长截图预览加载失败");
    };
    dom.image.src = dataUrl;
    if (dom.image.complete && dom.image.naturalWidth > 0) {
      dom.image.hidden = false;
      if (dom.empty) {
        dom.empty.hidden = true;
      }
    }
  }

  function clearPreview() {
    state.imageSrcLength = 0;
    dom.image.hidden = true;
    dom.image.onload = null;
    dom.image.onerror = null;
    dom.image.removeAttribute("src");
    if (dom.empty) {
      dom.empty.hidden = false;
      dom.empty.textContent = "正在重置拼接…";
    }
    hideError();
  }

  /* ---- Realtime progress event ---------------------------------------- */

  function onProgress(payload) {
    if (!payload || state.done || state.cancelled) {
      return;
    }
    var changed = false;
    var width = positiveNumber(payload.width);
    var height = positiveNumber(payload.height);
    if (width && width !== state.width) {
      state.width = width;
      changed = true;
    }
    if (height && height !== state.height) {
      state.height = height;
      changed = true;
    }
    var frames = positiveNumber(payload.frames);
    if (frames && frames !== state.frames) {
      state.frames = frames;
      changed = true;
    }
    state.stalled = !!payload.stalled;
    updateUi();
    if (changed) {
      scheduleProgressPreview();
    }
  }

  function scheduleProgressPreview() {
    if (progressTimer) {
      return;
    }
    progressTimer = window.setTimeout(function () {
      progressTimer = 0;
      loadPreview();
    }, PROGRESS_THROTTLE);
  }

  function onCancelled() {
    if (state.cancelled) {
      return;
    }
    state.cancelled = true;
    window.clearTimeout(pollTimer);
    pollTimer = 0;
    if (dom.doneText) {
      dom.doneText.textContent = "已取消长截图";
    }
    if (dom.done) {
      dom.done.hidden = false;
    }
    toast("已取消长截图", "info");
    updateUi();
  }

  /* ---- Actions --------------------------------------------------------- */

  function switchDirection(direction) {
    if (state.busy || state.done || state.cancelled) {
      return;
    }
    var next = direction === "horizontal" ? "horizontal" : "vertical";
    if (next === state.direction) {
      return;
    }
    state.busy = true;
    state.directionCalls += 1;
    updateUi();
    apiCall("direction", next)
      .then(function (result) {
        if (!result || result.ok === false) {
          showError(failureText(result, "切换拼接方向失败"));
          return undefined;
        }
        state.direction =
          result.direction === "horizontal" ? "horizontal" : next;
        state.width = 0;
        state.height = 0;
        state.frames = 0;
        state.stalled = false;
        clearPreview();
        updateUi();
        return poll(true);
      })
      .catch(function (error) {
        showError("切换拼接方向失败：" + errorText(error));
      })
      .then(function () {
        state.busy = false;
        updateUi();
      });
  }

  function finish() {
    if (state.busy || state.done || state.cancelled) {
      return;
    }
    state.busy = true;
    state.finishCalls += 1;
    updateUi();
    apiCall("finish")
      .then(function (result) {
        if (!result || result.ok === false) {
          state.busy = false;
          updateUi();
          showError(failureText(result, "完成长截图失败"));
          return;
        }
        state.done = true;
        state.busy = false;
        window.clearTimeout(pollTimer);
        pollTimer = 0;
        if (dom.doneText) {
          dom.doneText.textContent = "已完成，图片已复制并钉在桌面";
        }
        if (dom.done) {
          dom.done.hidden = false;
        }
        toast("已完成，图片已复制并钉在桌面", "success");
        updateUi();
      })
      .catch(function (error) {
        state.busy = false;
        updateUi();
        showError("完成长截图失败：" + errorText(error));
      });
  }

  function cancel() {
    if (state.busy || state.done || state.cancelled) {
      return;
    }
    state.busy = true;
    state.cancelCalls += 1;
    updateUi();
    apiCall("cancel")
      .then(function (result) {
        if (!result || result.ok === false) {
          state.busy = false;
          updateUi();
          showError(failureText(result, "取消长截图失败"));
          return;
        }
        state.busy = false;
        state.cancelled = true;
        window.clearTimeout(pollTimer);
        pollTimer = 0;
        if (dom.doneText) {
          dom.doneText.textContent = "已取消长截图";
        }
        if (dom.done) {
          dom.done.hidden = false;
        }
        toast("已取消长截图", "info");
        updateUi();
      })
      .catch(function (error) {
        state.busy = false;
        updateUi();
        showError("取消长截图失败：" + errorText(error));
      });
  }

  /* ---- UI -------------------------------------------------------------- */

  function updateUi() {
    var locked = state.busy || state.done || state.cancelled;
    var width = state.width || 0;
    var height = state.height || 0;
    if (dom.size) {
      dom.size.textContent = width + " × " + height;
    }
    if (dom.frames) {
      dom.frames.textContent = "第 " + (state.frames || 0) + " 帧";
    }
    if (dom.warning) {
      dom.warning.hidden = !state.stalled;
    }
    if (dom.directions) {
      Array.prototype.forEach.call(
        dom.directions.querySelectorAll("[data-direction]"),
        function (button) {
          var active =
            button.getAttribute("data-direction") === state.direction;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-pressed", active ? "true" : "false");
          button.disabled = locked || !state.ready;
        }
      );
    }
    if (dom.finish) {
      dom.finish.disabled = locked || !state.ready;
    }
    if (dom.cancel) {
      dom.cancel.disabled = locked || !state.ready;
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
    return new Promise(function (resolve) {
      poll(true, resolve);
    });
  };

  /* ---- Boot ------------------------------------------------------------ */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
