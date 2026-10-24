/* Language helpers shared by the picker and the settings window.
 *
 * The picker maps "auto" to a concrete target language: mostly Chinese source
 * text translates to English, everything else to Chinese. This mirrors the
 * behaviour of the Electron build.
 */
(function () {
  "use strict";

  var LP = (window.LP = window.LP || {});
  var CJK_PATTERN = /[\u4e00-\u9fff]/g;

  LP.countCjk = function (text) {
    var matches = String(text == null ? "" : text).match(CJK_PATTERN);
    return matches ? matches.length : 0;
  };

  LP.cjkRatio = function (text) {
    var value = String(text == null ? "" : text);
    if (!value.length) {
      return 0;
    }
    return LP.countCjk(value) / value.length;
  };

  /* Source text with more than 30% Chinese characters -> English, else Chinese. */
  LP.detectAutoTarget = function (text) {
    return LP.cjkRatio(text) > 0.3 ? "en" : "zh";
  };

  /* `configured` is picker.defaultTargetLang ("auto" or a language code). */
  LP.resolveTargetLang = function (text, configured) {
    var value = String(configured || "auto").toLowerCase();
    if (value && value !== "auto") {
      return value;
    }
    return LP.detectAutoTarget(text);
  };

  LP.languageLabel = function (code) {
    return LP.LANG_LABELS[String(code || "")] || String(code || "");
  };
})();
