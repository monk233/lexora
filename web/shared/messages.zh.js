/* Simplified Chinese UI strings. Keys are dot-separated and must stay in sync
 * with messages.en.js (web/i18n.test.cjs enforces it). */
(function () {
  "use strict";
  var LP = (window.LP = window.LP || {});
  LP.messages = LP.messages || {};
  LP.messages.zh = {
    "common.ok": "确定",
    "common.cancel": "取消",
    "common.search": "搜索",
    "common.reset": "重置为默认",
    "common.language": "界面语言",
    "common.followSystem": "跟随系统",
    "settings.modelHint": "所有本地 AI 任务共用 {model}",
  };
})();
