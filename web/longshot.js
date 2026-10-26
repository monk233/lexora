/* Lexora manual-scroll long-screenshot preview renderer (contract §11.14.1).
 *
 * Minimal QQ-style preview: only the stitched image, nothing else. The shell
 * keeps stitching while the user scrolls the target app and emits
 * `longshot-progress {width,height,frames,revision,stalled}` after every stitch.
 * This page is event driven: a changed `revision` triggers a throttled (≤80ms)
 * `longshot_preview` fetch, and the PNG (already resized by the shell to the
 * window's content box) is decoded on a back <img> layer before being promoted
 * to the front (double buffering → no flashing). Window sizes are driven by the
 * shell; the page itself has no controls and shows no status/error UI.
 */
(function () {
  "use strict";

  var API = window.longshotAPI;
  var PREVIEW_MODE = !(window.__TAURI__ && window.__TAURI__.core);
  var PREVIEW_THROTTLE = 80;
  var STATE_FALLBACK = 1000;

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
    stateCalls: 0,
    previewCalls: 0,
    progressEvents: 0,
    imageSrcLength: 0,
    previewShown: false
  };

  /* Test/debug hook used by the CDP checks in tests/ and manual QA. */
  window.__longshotState = state;

  var dom = {};
  var previewTimer = 0;
  var fallbackTimer = 0;
  var previewInflight = false;
  var previewQueued = false;
  var renderToken = 0;

  /* ---- Helpers --------------------------------------------------------- */

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

  function apiCall(name) {
    if (!API || typeof API[name] !== "function") {
      return Promise.resolve({ ok: false });
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

  /* ---- Boot ------------------------------------------------------------ */

  function cacheDom() {
    dom.root = byId("longshot-root");
    dom.image = byId("longshot-image");
    dom.imageBuffer = byId("longshot-image-buffer");
    dom.empty = byId("longshot-empty");
  }

  function boot() {
    cacheDom();
    if (!dom.root || !dom.image) {
      return;
    }
    subscribeLongshot();
    initialLoad();
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

  /* ---- State ------------------------------------------------------------ */

  function applyState(result) {
    if (!result || result.ok === false) {
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
    return { changed: changed, revisionAdvanced: revisionAdvanced };
  }

  /* ---- Preview refresh -------------------------------------------------- */

  function onProgress(payload) {
    if (!payload || state.done || state.cancelled) {
      return;
    }
    state.progressEvents += 1;
    var progressRevision = positiveNumber(payload.revision);
    var info = applyState(payload);
    var unrendered =
      progressRevision > 0 && progressRevision > state.renderedRevision;
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
          return;
        }
        applyState(result);
        if (result.dataUrl) {
          renderPreview(String(result.dataUrl));
        }
      })
      .catch(function () {
        /* transient while the session is closing; no UI surface */
      })
      .then(function () {
        previewInflight = false;
        if (previewQueued) {
          previewQueued = false;
          if (!state.cancelled && !state.done) {
            schedulePreview();
          }
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
      /* The window is created hidden: show it only now that the first frame is
       * actually painted, so the start of a long screenshot never flashes white. */
      if (!state.previewShown && API && typeof API.previewReady === "function") {
        state.previewShown = true;
        try {
          Promise.resolve(API.previewReady()).catch(function () {
            /* the shell shows it after a fallback delay anyway */
          });
        } catch (error) {
          /* the shell shows it after a fallback delay anyway */
        }
      }
    }

    target.classList.remove("is-front");
    target.hidden = false;
    target.onload = function () {
      target.onload = null;
      apply();
    };
    target.onerror = function () {
      target.onerror = null;
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

  /* ---- Initial load + low-frequency state fallback ---------------------- */

  function initialLoad() {
    state.stateCalls += 1;
    apiCall("state")
      .then(function (result) {
        if (result && result.ok !== false) {
          applyState(result);
        }
      })
      .catch(function () {
        /* transient while the session is starting */
      })
      .then(function () {
        state.ready = true;
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
      .catch(function () {
        /* transient while the session is closing; no UI surface */
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
  }

  /* Test/debug helper: force a state/preview refresh. */
  window.__longshotRefresh = function () {
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
