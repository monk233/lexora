/* Lexora manual long-screenshot control bar renderer (contract §11.14.1).
 *
 * The shell places this clickable window right below the selection (where the
 * screenshot toolbar sits) because the capture overlays are click-through while
 * the user scrolls the target application. It owns the direction switch and the
 * cancel / finish actions; the preview window only shows the growing image.
 *
 * State comes from `longshot_state` on boot and from the `longshot-progress`
 * events afterwards (same payload: width/height/frames/direction/revision).
 */
(function () {
  "use strict";

  var API = window.longshotAPI;
  var TOAST_MS = 2600;

  var state = {
    direction: "vertical",
    frames: 0,
    width: 0,
    height: 0,
    busy: false,
    ready: false,
    done: false,
    progressEvents: 0,
    directionCalls: 0,
    finishCalls: 0,
    cancelCalls: 0,
    autoscroll: false,
    autoscrollCalls: 0,
    lastError: ""
  };

  /* Test/debug hook used by the CDP checks in tests/. */
  window.__longshotBarState = state;

  var dom = {};
  var statusTimer = 0;

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

  /* ---- DOM -------------------------------------------------------------- */

  function cacheDom() {
    dom.bar = byId("ls-bar");
    dom.directions = byId("ls-directions");
    dom.autoscroll = byId("ls-autoscroll");
    dom.status = byId("ls-status");
    dom.cancel = byId("ls-cancel");
    dom.finish = byId("ls-finish");
  }

  function boot() {
    cacheDom();
    if (!dom.bar) {
      return;
    }
    bindEvents();
    subscribeProgress();
    refresh();
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
    if (dom.cancel) {
      dom.cancel.addEventListener("click", cancel);
    }
    if (dom.finish) {
      dom.finish.addEventListener("click", finish);
    }
    if (dom.autoscroll) {
      dom.autoscroll.addEventListener("click", toggleAutoscroll);
    }
  }

  function subscribeProgress() {
    if (!API || typeof API.onProgress !== "function") {
      return;
    }
    try {
      API.onProgress(function (payload) {
        state.progressEvents += 1;
        applyState(payload);
        updateUi();
      });
    } catch (error) {
      /* the boot state query still fills the bar */
    }
  }

  /* ---- State ------------------------------------------------------------ */

  function applyState(result) {
    if (!result || result.ok === false) {
      return;
    }
    if (result.direction === "horizontal" || result.direction === "vertical") {
      state.direction = result.direction;
    }
    var width = positiveNumber(result.width);
    var height = positiveNumber(result.height);
    if (width) {
      state.width = width;
    }
    if (height) {
      state.height = height;
    }
    var frames = positiveNumber(result.frames);
    if (frames) {
      state.frames = frames;
    }
    if (typeof result.autoscroll === "boolean") {
      state.autoscroll = result.autoscroll;
    }
    updateUi();
  }

  function refresh() {
    apiCall("state")
      .then(function (result) {
        state.ready = true;
        if (!result || result.ok === false) {
          setStatus(failureText(result, "读取长截图状态失败"), "error");
          updateUi();
          return;
        }
        applyState(result);
      })
      .catch(function (error) {
        state.ready = true;
        setStatus("读取长截图状态失败：" + errorText(error), "error");
        updateUi();
      });
  }

  function updateUi() {
    var locked = state.busy || state.done;
    if (dom.directions) {
      Array.prototype.forEach.call(
        dom.directions.querySelectorAll("[data-direction]"),
        function (button) {
          var active = button.getAttribute("data-direction") === state.direction;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-pressed", active ? "true" : "false");
          button.disabled = locked || !state.ready;
        }
      );
    }
    if (dom.cancel) {
      dom.cancel.disabled = locked || !state.ready;
    }
    if (dom.finish) {
      dom.finish.disabled = locked || !state.ready;
    }
    if (dom.autoscroll) {
      dom.autoscroll.classList.toggle("is-active", state.autoscroll === true);
      dom.autoscroll.setAttribute(
        "aria-pressed",
        state.autoscroll ? "true" : "false"
      );
      dom.autoscroll.disabled = locked || !state.ready;
    }
    if (!state.lastError && !state.done) {
      var prefix = state.autoscroll ? "自动滚动 · " : "";
      setStatus(
        prefix +
          "第 " +
          (state.frames || 1) +
          " 帧 · " +
          state.width +
          " × " +
          state.height,
        ""
      );
    }
  }

  function setStatus(text, tone) {
    if (!dom.status) {
      return;
    }
    dom.status.textContent = String(text || "");
    if (tone) {
      dom.status.setAttribute("data-tone", tone);
    } else {
      dom.status.removeAttribute("data-tone");
    }
  }

  function flashStatus(text, tone) {
    state.lastError = String(text || "");
    setStatus(text, tone);
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(function () {
      state.lastError = "";
      updateUi();
    }, TOAST_MS);
  }

  /* ---- Actions ---------------------------------------------------------- */

  function switchDirection(direction) {
    if (state.busy || state.done) {
      return;
    }
    var next = direction === "horizontal" ? "horizontal" : "vertical";
    if (next === state.direction) {
      return;
    }
    state.busy = true;
    state.directionCalls += 1;
    /* Optimistic switch so the segmented control feels instant; the shell event
     * is authoritative and restores it if the command failed. */
    state.direction = next;
    updateUi();
    var request;
    try {
      request = API.direction(next);
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request)
      .then(function (result) {
        if (!result || result.ok === false) {
          state.direction = next === "horizontal" ? "vertical" : "horizontal";
          flashStatus(failureText(result, "切换拼接方向失败"), "error");
        }
      })
      .catch(function (error) {
        state.direction = next === "horizontal" ? "vertical" : "horizontal";
        flashStatus("切换拼接方向失败：" + errorText(error), "error");
      })
      .then(function () {
        state.busy = false;
        updateUi();
      });
  }

  /* Auto-scroll toggle: the shell scrolls the target app in small settled steps,
   * so the user does not have to scroll manually. */
  function toggleAutoscroll() {
    if (state.busy || state.done) {
      return;
    }
    var next = !state.autoscroll;
    state.busy = true;
    state.autoscrollCalls += 1;
    state.autoscroll = next;
    updateUi();
    var request;
    try {
      request =
        API && typeof API.autoscroll === "function"
          ? API.autoscroll(next)
          : Promise.reject(new Error("长截图服务不可用"));
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request)
      .then(function (result) {
        if (!result || result.ok === false) {
          state.autoscroll = !next;
          flashStatus(failureText(result, "切换自动滚动失败"), "error");
          return;
        }
        state.autoscroll = result.autoscroll === true;
      })
      .catch(function (error) {
        state.autoscroll = !next;
        flashStatus("切换自动滚动失败：" + errorText(error), "error");
      })
      .then(function () {
        state.busy = false;
        updateUi();
      });
  }

  function finish() {
    if (state.busy || state.done) {
      return;
    }
    state.busy = true;
    state.finishCalls += 1;
    updateUi();
    apiCall("finish")
      .then(function (result) {
        if (!result || result.ok === false) {
          state.busy = false;
          flashStatus(failureText(result, "完成长截图失败"), "error");
          return;
        }
        state.done = true;
        state.busy = false;
        setStatus("已完成，正在钉在桌面…", "");
        updateUi();
      })
      .catch(function (error) {
        state.busy = false;
        flashStatus("完成长截图失败：" + errorText(error), "error");
        updateUi();
      });
  }

  function cancel() {
    if (state.busy || state.done) {
      return;
    }
    state.busy = true;
    state.cancelCalls += 1;
    updateUi();
    apiCall("cancel")
      .then(function (result) {
        if (!result || result.ok === false) {
          state.busy = false;
          flashStatus(failureText(result, "取消长截图失败"), "error");
          return;
        }
        state.done = true;
        state.busy = false;
        setStatus("已取消长截图", "");
        updateUi();
      })
      .catch(function (error) {
        state.busy = false;
        flashStatus("取消长截图失败：" + errorText(error), "error");
        updateUi();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
