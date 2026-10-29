/* Minimal no-build i18n for all Lexora windows.
 *
 * Load after shared/constants.js and the message packs, before the page script.
 * The page calls LP.i18n.init(locale) once the backend state is available; an
 * initial value is guessed from <html lang> / navigator.language to avoid a
 * flash of the wrong language on already-open windows.
 *
 * The runtime is shared with Node-based unit tests (web/i18n.test.cjs), where
 * neither `document` nor `navigator` exists, so every DOM access is guarded.
 */
(function () {
  "use strict";

  var LP = (window.LP = window.LP || {});
  var supported = ["zh", "en"];
  var current = "en";
  var initialized = false;

  function normalize(value) {
    var raw = String(value == null ? "" : value).trim().toLowerCase();
    if (raw.indexOf("zh") === 0) {
      return "zh";
    }
    if (raw.indexOf("en") === 0) {
      return "en";
    }
    return "";
  }

  function pack(locale) {
    return LP.messages && LP.messages[locale] ? LP.messages[locale] : {};
  }

  function interpolate(text, params) {
    if (!params) {
      return text;
    }
    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  function lookup(locale, key) {
    var messages = pack(locale);
    return Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : undefined;
  }

  LP.t = function (key, params) {
    var text = lookup(current, key);
    if (text === undefined) {
      text = lookup("en", key);
    }
    if (text === undefined) {
      return String(key);
    }
    return interpolate(String(text), params);
  };

  function applyElement(node) {
    if (!node || !node.getAttribute) {
      return;
    }
    var key = node.getAttribute("data-i18n");
    if (key) {
      node.textContent = LP.t(key);
    }
    var htmlKey = node.getAttribute("data-i18n-html");
    if (htmlKey) {
      node.innerHTML = LP.t(htmlKey);
    }
    ["title", "aria-label", "placeholder"].forEach(function (attribute) {
      var attributeKey = node.getAttribute("data-i18n-" + attribute);
      if (attributeKey) {
        node.setAttribute(attribute, LP.t(attributeKey));
      }
    });
  }

  function syncDocumentLang(locale) {
    if (typeof document === "undefined" || !document || !document.documentElement) {
      return;
    }
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }

  function applyStatic(root) {
    var scope = root;
    if (scope === undefined || scope === null) {
      scope = typeof document !== "undefined" ? document : null;
    }
    if (!scope || !scope.querySelectorAll) {
      return;
    }
    Array.prototype.forEach.call(scope.querySelectorAll("[data-i18n], [data-i18n-html]"), applyElement);
    Array.prototype.forEach.call(
      scope.querySelectorAll("[data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]"),
      applyElement
    );
  }

  LP.i18n = {
    currentLocale: function () {
      return current;
    },

    init: function (locale) {
      var next = normalize(locale) || "en";
      current = next;
      initialized = true;
      syncDocumentLang(next);
      applyStatic(typeof document !== "undefined" ? document : null);
    },

    setLocale: function (locale) {
      var next = normalize(locale);
      if (!next || next === current) {
        return false;
      }
      current = next;
      if (initialized) {
        LP.i18n.init(next);
      }
      return true;
    },

    applyStatic: applyStatic,

    /* Reserved for packs that may load asynchronously; the skeleton is sync. */
    ready: function () {
      return Promise.resolve();
    },
  };

  /* Guess before the backend responds: <html lang> wins over navigator. */
  var guessed = "";
  if (typeof document !== "undefined" && document.documentElement) {
    guessed = normalize(document.documentElement.lang);
  }
  if (!guessed && typeof navigator !== "undefined") {
    guessed = normalize(navigator.language);
  }
  current = supported.indexOf(guessed) >= 0 ? guessed : "en";
})();
