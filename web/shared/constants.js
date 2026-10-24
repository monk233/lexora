/* Shared constants for the Lexora web UI.
 *
 * Loaded by both windows (picker + settings) before their own scripts. Keeps
 * skill/language/preset metadata and small formatting helpers in one place so
 * the two frontends cannot drift apart. Exposes everything on `window.LP`.
 */
(function () {
  "use strict";

  var LP = (window.LP = window.LP || {});

  LP.APP_NAME = "Lexora";
  LP.REPO_URL = "https://github.com/monk233/lexora";
  LP.LICENSE = "MIT";

  /* ---- Skills ---------------------------------------------------------- */

  /* Display order when a skill is not enabled yet (settings window). */
  LP.SKILLS = [
    {
      id: "translate",
      label: "翻译",
      description: "用默认目标语言翻译选中文本",
    },
    {
      id: "summarize",
      label: "总结",
      description: "用简体中文提炼选中文本的要点",
    },
    {
      id: "explain",
      label: "解释",
      description: "用简体中文解释含义、背景与关键概念",
    },
    {
      id: "read",
      label: "朗读",
      description: "用 Windows 系统语音朗读选中文本",
    },
    {
      id: "copy",
      label: "复制",
      description: "把选中文本复制到剪贴板",
    },
  ];

  LP.SKILL_MAP = {};
  LP.SKILLS.forEach(function (skill) {
    LP.SKILL_MAP[skill.id] = skill;
  });

  LP.DEFAULT_SKILLS = LP.SKILLS.map(function (skill) {
    return skill.id;
  });

  /* ---- Skill icons ----------------------------------------------------- */

  /* Icon keys available to built-in skills and user-defined custom skills.
   * Values are SVG markup without the outer wrapper class; the consumers set
   * `innerHTML` (icons are static literals, never model output). */
  LP.SKILL_ICON_KEYS = [
    "translate",
    "summarize",
    "explain",
    "read",
    "copy",
    "sparkles",
    "wand",
    "pen",
    "book",
    "globe",
    "code",
    "list",
    "chat",
    "lightbulb",
    "quote",
    "briefcase",
    "star",
  ];

  LP.SKILL_ICON_SVGS = {
    translate:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h9"></path><path d="M7.5 3v2"></path><path d="M4.5 9.4c1.3 2.4 3.1 4 5.4 5"></path><path d="M11.5 5c-.5 3-2.3 5.4-5.2 7.1"></path><path d="m12.6 20 3.6-8.6 3.6 8.6"></path><path d="M13.9 17h4.6"></path></svg>',
    summarize:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6h14"></path><path d="M5 10h14"></path><path d="M5 14h9"></path><path d="M5 18h6"></path></svg>',
    explain:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-1.6 1.9-2.2 2.6-.3.4-.4.8-.4 1.4"></path><path d="M12 17h.01"></path></svg>',
    read:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h3l5 4V5L7 9H4z"></path><path d="M16 9a4 4 0 0 1 0 6"></path><path d="M18.5 6.5a8 8 0 0 1 0 11"></path></svg>',
    copy:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    sparkles:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"></path><path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z"></path><path d="M5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6L5 15z"></path></svg>',
    wand:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20 16 8"></path><path d="m13.5 4.5 1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1 1-2.4z"></path><path d="M19 13l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z"></path></svg>',
    pen:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
    book:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path><path d="M8 7h8"></path><path d="M8 11h6"></path></svg>',
    globe:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a15 15 0 0 1 0 18"></path><path d="M12 3a15 15 0 0 0 0 18"></path></svg>',
    code:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5"></path><path d="m16 7 5 5-5 5"></path><path d="m13 4-2 16"></path></svg>',
    list:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h11"></path><path d="M9 12h11"></path><path d="M9 18h11"></path><circle cx="4.5" cy="6" r="1"></circle><circle cx="4.5" cy="12" r="1"></circle><circle cx="4.5" cy="18" r="1"></circle></svg>',
    chat:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 0 1 8-8h2a8 8 0 0 1 8 3z"></path><path d="M8 11h8"></path><path d="M8 15h5"></path></svg>',
    lightbulb:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M8.5 14.5a6 6 0 1 1 7 0c-.8.6-1.2 1.5-1.3 2.5h-4.4c-.1-1-.5-1.9-1.3-2.5z"></path></svg>',
    quote:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v1a3 3 0 0 1-3 3"></path><path d="M20 7h-4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v1a3 3 0 0 1-3 3"></path></svg>',
    briefcase:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path><path d="M3 12h18"></path></svg>',
    star:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.4l-5.6 2.9 1.1-6.2L3 9.7l6.2-.9L12 3z"></path></svg>',
  };

  LP.skillIconSvg = function (key) {
    var icons = LP.SKILL_ICON_SVGS || {};
    return icons[key] || icons.sparkles || "";
  };

  LP.CUSTOM_SKILL_ICON_KEYS = [
    "sparkles",
    "wand",
    "pen",
    "book",
    "globe",
    "code",
    "list",
    "chat",
    "lightbulb",
    "quote",
    "briefcase",
    "star",
  ];

  LP.CUSTOM_SKILL_DEFAULT_ICON = "sparkles";

  /* ---- Languages ------------------------------------------------------- */

  /* Languages supported by the Hy-MT2 translation model (33 languages plus
   * Chinese variants and minority languages, see the official model card).
   * Common targets first for a short dropdown. */
  LP.LANGUAGES = [
    { value: "zh", label: "中文" },
    { value: "en", label: "英语" },
    { value: "zh-hant", label: "繁体中文" },
    { value: "yue", label: "粤语" },
    { value: "ja", label: "日语" },
    { value: "ko", label: "韩语" },
    { value: "fr", label: "法语" },
    { value: "de", label: "德语" },
    { value: "es", label: "西班牙语" },
    { value: "pt", label: "葡萄牙语" },
    { value: "ru", label: "俄语" },
    { value: "ar", label: "阿拉伯语" },
    { value: "it", label: "意大利语" },
    { value: "nl", label: "荷兰语" },
    { value: "pl", label: "波兰语" },
    { value: "tr", label: "土耳其语" },
    { value: "th", label: "泰语" },
    { value: "vi", label: "越南语" },
    { value: "id", label: "印尼语" },
    { value: "ms", label: "马来语" },
    { value: "tl", label: "菲律宾语" },
    { value: "hi", label: "印地语" },
    { value: "bn", label: "孟加拉语" },
    { value: "ta", label: "泰米尔语" },
    { value: "te", label: "泰卢固语" },
    { value: "mr", label: "马拉地语" },
    { value: "gu", label: "古吉拉特语" },
    { value: "ur", label: "乌尔都语" },
    { value: "fa", label: "波斯语" },
    { value: "he", label: "希伯来语" },
    { value: "uk", label: "乌克兰语" },
    { value: "cs", label: "捷克语" },
    { value: "km", label: "高棉语" },
    { value: "my", label: "缅甸语" },
    { value: "bo", label: "藏语" },
    { value: "kk", label: "哈萨克语" },
    { value: "mn", label: "蒙古语" },
    { value: "ug", label: "维吾尔语" },
  ];

  LP.LANG_LABELS = {};
  LP.LANGUAGES.forEach(function (language) {
    LP.LANG_LABELS[language.value] = language.label;
  });

  LP.TARGET_LANGS = [{ value: "auto", label: "自动识别" }].concat(LP.LANGUAGES);

  /* ---- Online provider presets ---------------------------------------- */

  LP.PRESETS = [
    {
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      needsKey: true,
      hint: "DeepSeek 开放平台，OpenAI 兼容接口",
    },
    {
      id: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      needsKey: true,
      hint: "api.openai.com，需要可访问的 API Key",
    },
    {
      id: "moonshot",
      label: "Moonshot Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      needsKey: true,
      hint: "Moonshot 开放平台，OpenAI 兼容接口",
    },
    {
      id: "zhipu",
      label: "智谱 GLM",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      needsKey: true,
      hint: "智谱 AI 开放平台，OpenAI 兼容接口",
    },
    {
      id: "ollama",
      label: "Ollama（本机）",
      baseUrl: "http://127.0.0.1:11434/v1",
      needsKey: false,
      hint: "本机 Ollama 服务，通常无需 API Key",
    },
    {
      id: "lmstudio",
      label: "LM Studio（本机）",
      baseUrl: "http://127.0.0.1:1234/v1",
      needsKey: false,
      hint: "本机 LM Studio 本地服务器，通常无需 API Key",
    },
    {
      id: "custom",
      label: "自定义",
      baseUrl: "",
      needsKey: true,
      hint: "任意 OpenAI 兼容服务地址",
    },
  ];

  LP.PRESET_MAP = {};
  LP.PRESETS.forEach(function (preset) {
    LP.PRESET_MAP[preset.id] = preset;
  });

  LP.presetFor = function (id) {
    return LP.PRESET_MAP[String(id || "")] || null;
  };

  /* ---- Formatting ------------------------------------------------------ */

  LP.formatBytes = function (bytes) {
    var value = Number(bytes);
    if (!isFinite(value) || value <= 0) {
      return "—";
    }
    var units = ["B", "KB", "MB", "GB"];
    var index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    var text = index === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
    return text + " " + units[index];
  };

  LP.formatMs = function (milliseconds) {
    var value = Math.round(Number(milliseconds) || 0);
    return value + " ms";
  };

  LP.formatCount = function (value, unit) {
    var number = Number(value) || 0;
    return number + (unit || "");
  };

  /* "qwen2.5-1.5b-instruct-q4_k_m.gguf" -> "Q4_K_M"; "" when unknown. */
  LP.quantLabel = function (filename) {
    var match = /(?:^|[-_.])((?:iq|q)\d(?:_[a-z0-9]){0,3})(?:[-_.]|$)/i.exec(
      String(filename || "")
    );
    return match ? match[1].toUpperCase() : "";
  };

  LP.platformLabel = function (app) {
    var info = app || {};
    var name = info.platform === "windows" ? "Windows" : String(info.platform || "未知平台");
    if (info.portable) {
      return name + " · 便携版";
    }
    if (info.packaged) {
      return name + " · 安装版";
    }
    return name + " · 开发版";
  };

  /* ---- Small utilities ------------------------------------------------- */

  LP.deepMerge = function (target, patch) {
    var result = {};
    var key;
    for (key in target) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        result[key] = target[key];
      }
    }
    for (key in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) {
        continue;
      }
      var value = patch[key];
      var existing = result[key];
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        result[key] = LP.deepMerge(existing, value);
      } else {
        result[key] = Array.isArray(value) ? value.slice() : value;
      }
    }
    return result;
  };

  LP.debounce = function (callback, wait) {
    var timer = null;
    var wrapped = function () {
      var args = arguments;
      var self = this;
      if (timer) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(function () {
        timer = null;
        callback.apply(self, args);
      }, wait);
    };
    wrapped.cancel = function () {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    return wrapped;
  };

  LP.makeId = function (prefix) {
    return (
      String(prefix || "id") +
      "-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  };
})();
