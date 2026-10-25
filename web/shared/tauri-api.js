/* Tauri frontend bridge for Lexora.
 *
 * Exposes the two API shapes used by the renderers:
 *
 *   window.pickerAPI   - word-selection toolbar window  (contract §5.2/§5.3)
 *   window.settingsAPI - settings window                (contract §5.1/§5.3)
 *
 * In the packaged app (Tauri, `withGlobalTauri: true`) the calls are forwarded
 * to `window.__TAURI__.core.invoke` / `window.__TAURI__.event.listen`. When the
 * page is opened directly in a browser (between-ui preview, design review) a
 * mock backend keeps the whole UI usable: full StatePayload, simulated SSE
 * translation, downloads and progress events.
 *
 * Every command resolves to an object with `ok` instead of rejecting: Tauri
 * rejects with a plain string and the renderers only need inline error text.
 */
(function () {
  "use strict";

  var tauri = window.__TAURI__;
  var core =
    tauri && tauri.core && typeof tauri.core.invoke === "function" ? tauri.core : null;
  var eventApi =
    tauri && tauri.event && typeof tauri.event.listen === "function" ? tauri.event : null;
  var LIVE = !!(core && eventApi);

  /* ------------------------------------------------------------------ */
  /* Shared plumbing                                                     */
  /* ------------------------------------------------------------------ */

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function errorText(error) {
    if (error === null || error === undefined) {
      return "未知错误";
    }
    if (typeof error === "string") {
      return error;
    }
    if (typeof error === "object") {
      if (typeof error.message === "string" && error.message) {
        return error.message;
      }
      if (typeof error.error === "string" && error.error) {
        return error.error;
      }
    }
    try {
      return String(error);
    } catch (ignored) {
      return "未知错误";
    }
  }

  /* Promote a plain command result to the `{ok, ...}` shape the UI expects. */
  function withOk(value) {
    if (value === null || value === undefined) {
      return { ok: true };
    }
    if (typeof value !== "object") {
      return { ok: true, value: value };
    }
    var result = {};
    for (var key in value) {
      if (has(value, key)) {
        result[key] = value[key];
      }
    }
    if (typeof result.ok !== "boolean") {
      result.ok = true;
    }
    return result;
  }

  function safeInvoke(command, args) {
    if (!LIVE) {
      return mockInvoke(command, args).then(withOk, function (error) {
        return { ok: false, error: errorText(error) };
      });
    }
    var request;
    try {
      request = core.invoke(command, args || {});
    } catch (error) {
      return Promise.resolve({ ok: false, error: errorText(error) });
    }
    return Promise.resolve(request).then(withOk, function (error) {
      return { ok: false, error: errorText(error) };
    });
  }

  /* For commands whose return value is not a `{ok}` payload (resize, quit). */
  function invokeQuiet(command, args, fallback) {
    var resolvedFallback = fallback === undefined ? null : fallback;
    if (!LIVE) {
      return mockInvoke(command, args).then(
        function (value) {
          return value === undefined ? resolvedFallback : value;
        },
        function (error) {
          console.warn("[tauri-api] " + command + " failed:", errorText(error));
          return resolvedFallback;
        }
      );
    }
    var request;
    try {
      request = core.invoke(command, args || {});
    } catch (error) {
      console.warn("[tauri-api] " + command + " failed:", errorText(error));
      return Promise.resolve(resolvedFallback);
    }
    return Promise.resolve(request).then(function (value) {
      return value === undefined ? resolvedFallback : value;
    }, function (error) {
      console.warn("[tauri-api] " + command + " failed:", errorText(error));
      return resolvedFallback;
    });
  }

  function subscribe(eventName, handler) {
    if (!LIVE) {
      return mockSubscribe(eventName, handler);
    }
    var disposed = false;
    var unlisten = null;
    var pending = eventApi.listen(eventName, function (event) {
      var payload =
        event && typeof event === "object" && has(event, "payload") ? event.payload : event;
      if (typeof handler !== "function") {
        return;
      }
      try {
        handler(payload);
      } catch (error) {
        console.error("[tauri-api] handler failed for " + eventName, error);
      }
    });
    Promise.resolve(pending).then(
      function (dispose) {
        if (disposed) {
          try {
            dispose();
          } catch (ignored) {
            /* already gone */
          }
        } else if (typeof dispose === "function") {
          unlisten = dispose;
        }
      },
      function (error) {
        console.warn("[tauri-api] listen(" + eventName + ") failed:", errorText(error));
      }
    );
    return function disposeListener() {
      disposed = true;
      if (typeof unlisten === "function") {
        try {
          unlisten();
        } catch (ignored) {
          /* already gone */
        }
        unlisten = null;
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Mock backend (browser preview)                                      */
  /* ------------------------------------------------------------------ */

  var mockListeners = {};
  var mockStore = null;
  var mockDownloads = {};
  var mockDownloadSeq = 0;
  var mockPickerTimer = null;
  var mockPickerAttempts = 0;

  function clone(value) {
    if (value === undefined || value === null) {
      return value;
    }
    return JSON.parse(JSON.stringify(value));
  }

  function mockSubscribe(eventName, handler) {
    var list = mockListeners[eventName] || (mockListeners[eventName] = []);
    var wrapped = function (payload) {
      if (typeof handler === "function") {
        handler(payload);
      }
    };
    list.push(wrapped);
    return function () {
      var index = list.indexOf(wrapped);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  function mockEmit(eventName, payload) {
    var list = mockListeners[eventName] || [];
    list.slice().forEach(function (handler) {
      try {
        handler(clone(payload));
      } catch (error) {
        console.error("[mock] listener failed for " + eventName, error);
      }
    });
  }

  function mockHasListeners(eventName) {
    return (mockListeners[eventName] || []).length > 0;
  }

  function mockCatalogEntry(id, name, description, filename, sizeBytes, recommended, installed, vision) {
    return {
      id: id,
      name: name,
      description: description,
      filename: filename,
      sizeBytes: sizeBytes,
      license: "Apache-2.0",
      languages: "多语言",
      recommended: !!recommended,
      installed: !!installed,
      vision: !!vision,
    };
  }

  /* Screenshot toolbar actions of the preview: `?captureSkills=explain,ocr`. */
  function mockCaptureSkills(query) {
    var match = /[?&]captureSkills=([^&]+)/.exec(String(query || ""));
    var allowed = ["copy", "ocr", "translate", "explain"];
    if (!match) {
      return allowed.slice();
    }
    var result = [];
    match[1]
      .split(",")
      .map(function (item) {
        return item.trim().toLowerCase();
      })
      .forEach(function (item) {
        if (allowed.indexOf(item) >= 0 && result.indexOf(item) < 0) {
          result.push(item);
        }
      });
    return result.length ? result : allowed.slice();
  }

  function initMockStore() {
    var query = String(window.location.search || "");
    var portable = !/[?&]portable=0(?:&|$)/.test(query);
    /* `?engine=0` previews the "engine not installed" download flow;
     * `?compact=1` previews the icon-only picker toolbar. */
    var engineInstalled = !/[?&]engine=0(?:&|$)/.test(query);
    var compactToolbar = /[?&]compact=1(?:&|$)/.test(query);
    var installedModel = {
      file: "Hy-MT2-1.8B-Q4_K_M.gguf",
      name: "Hy-MT2-1.8B-Q4_K_M",
      path: "C:\\Users\\Preview\\AppData\\Roaming\\Lexora\\models\\Hy-MT2-1.8B-Q4_K_M.gguf",
      sizeBytes: 1133080448,
      modifiedAt: Date.now() - 86400000,
      catalogId: "hy-mt2-1.8b",
    };

    mockStore = {
      app: {
        name: "Lexora",
        version: "0.1.0",
        platform: "windows",
        packaged: false,
        portable: portable,
        dataDir: "C:\\Users\\Preview\\AppData\\Roaming\\Lexora",
        modelsDir: "C:\\Users\\Preview\\AppData\\Roaming\\Lexora\\models",
        logsDir: "C:\\Users\\Preview\\AppData\\Roaming\\Lexora\\logs",
        repoUrl: "https://github.com/monk233/lexora",
        license: "MIT",
      },
      settings: {
        version: 4,
        picker: {
          enabled: true,
          skills: ["translate", "summarize", "explain", "polish", "read", "copy", "screenshot", "search"],
          compact: compactToolbar,
          defaultTargetLang: "auto",
          blacklist: ["vscode.exe"],
          maxChars: 5000,
          prompts: { translate: "", summarize: "", explain: "", polish: "" },
          customSkills: [],
          searchEngine: "google",
          panelMode: "auto",
          captureSkills: mockCaptureSkills(query),
        },
        provider: {
          mode: "online",
          online: {
            preset: "deepseek",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "",
            model: "deepseek-chat",
            timeoutMs: 60000,
            temperature: 0.2,
            maxTokens: 1024,
          },
          local: {
            contextSize: 4096,
            threads: 0,
            gpuLayers: 0,
            autoStart: true,
          },
        },
        app: {
          closeToTray: true,
          startAtLogin: false,
          theme: "system",
        },
        capture: {
          regionShortcut: "Win+Shift+X",
        },
      },
      engine: {
        mode: "online",
        ready: true,
        hint: "",
        providerLabel: "在线 · deepseek-chat",
        onlineConfigured: true,
        localState: "stopped",
        localModelFile: "",
        localModelName: "",
        localError: "",
        engineAvailable: engineInstalled,
      },
      models: [installedModel],
      catalog: [
        mockCatalogEntry(
          "hy-mt2-1.8b",
          "腾讯混元 Hy-MT2 1.8B（翻译模型）",
          "翻译专用：混元 Hy-MT2 1.8B Q4_K_M，速度快，适合中英及多语互译",
          "Hy-MT2-1.8B-Q4_K_M.gguf",
          1133080448,
          true,
          true
        ),
        mockCatalogEntry(
          "qwen2.5-3b",
          "Qwen2.5 3B（通用模型）",
          "通用模型：翻译、总结、解释都能用；适合内存 16GB 以上的电脑",
          "qwen2.5-3b-instruct-q4_k_m.gguf",
          2104932768,
          false,
          false
        ),
        mockCatalogEntry(
          "qwen2.5-vl-3b",
          "Qwen2.5-VL 3B（视觉模型）",
          "视觉模型：可理解截图内容，包含 mmproj 视觉投影器；适合内存 16GB 以上的电脑",
          "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
          1929901056,
          false,
          false,
          true
        ),
      ],
      download: null,
      downloads: [],
      picker: { visible: false, pinned: false },
      loginItem: { supported: !portable, enabled: false },
      promptDefaults: {
        translate:
          "You are a professional translation engine. Translate the user's text into {target}. Output only the translation, without explanations, quotes, or the source text.",
        summarize:
          "You are a concise Chinese writing assistant. Summarize the user's text in Simplified Chinese and list the key points accurately, without adding anything that is not in the source.",
        explain:
          "You are a knowledge assistant. Explain the user's text in Simplified Chinese, covering its meaning, background and key concepts, with short examples when helpful.",
        polish:
          "You are a professional editor. Polish the user's text so it reads naturally and fluently while keeping the original meaning. Output only the polished text, without explanations, quotes, or the source text.",
      },
    };
    refreshMockDerived();
  }

  function refreshMockDerived() {
    var settings = mockStore.settings;
    var online = settings.provider.online;
    var local = settings.provider.local;
    var engine = mockStore.engine;

    engine.mode = settings.provider.mode === "local" ? "local" : "online";
    engine.onlineConfigured = !!(
      String(online.baseUrl || "").trim() && String(online.model || "").trim()
    );
    engine.providerLabel =
      engine.mode === "local"
        ? engine.localState === "ready" && engine.localModelName
          ? "本地 · " + engine.localModelName
          : "本地模型"
        : "在线 · " + String(online.model || "").trim();
    engine.ready =
      engine.mode === "local"
        ? engine.localState === "ready"
        : engine.onlineConfigured;
    if (engine.ready) {
      engine.hint = "";
    } else if (engine.mode === "local") {
      engine.hint = !engine.engineAvailable
        ? "尚未安装 llama.cpp 引擎"
        : !mockStore.models.length
          ? "尚未安装本地模型"
          : "本地模型未启动";
    } else {
      engine.hint = "请填写在线服务地址与模型名";
    }

    mockStore.loginItem.supported = !mockStore.app.portable;
    mockStore.loginItem.enabled = !!settings.app.startAtLogin;
    if (!mockStore.loginItem.supported) {
      settings.app.startAtLogin = false;
      mockStore.loginItem.enabled = false;
    }
    mockStore.download = null;
    mockStore.downloads = Object.keys(mockDownloads).map(function (key) {
      return clone(mockDownloads[key].progress);
    });
  }

  function normalizeMockSettings() {
    var settings = mockStore.settings;
    var picker = settings.picker;
    var known = ["translate", "summarize", "explain", "polish", "read", "copy", "screenshot", "search"];
    var customSkills = [];
    (Array.isArray(picker.customSkills) ? picker.customSkills : []).forEach(function (entry) {
      if (!entry || customSkills.length >= 20) {
        return;
      }
      var id = String(entry.id || "").trim().toLowerCase();
      var prompt = String(entry.prompt || "").trim().slice(0, 4000);
      if (!/^custom-[a-z0-9_-]{1,40}$/.test(id) || !prompt) {
        return;
      }
      if (customSkills.some(function (skill) { return skill.id === id; })) {
        return;
      }
      var icons =
        window.LP && Array.isArray(window.LP.CUSTOM_SKILL_ICON_KEYS)
          ? window.LP.CUSTOM_SKILL_ICON_KEYS
          : ["sparkles"];
      var icon = String(entry.icon || "");
      customSkills.push({
        id: id,
        label: String(entry.label || "自定义技能").trim().slice(0, 20) || "自定义技能",
        icon: icons.indexOf(icon) >= 0 ? icon : "sparkles",
        prompt: prompt,
        kind: entry.kind === "image" ? "image" : "text",
      });
    });
    picker.customSkills = customSkills;
    var knownIds = known.concat(customSkills.map(function (skill) { return skill.id; }));
    var skills = [];
    (Array.isArray(picker.skills) ? picker.skills : []).forEach(function (skill) {
      var value = String(skill || "").toLowerCase();
      if (knownIds.indexOf(value) >= 0 && skills.indexOf(value) < 0) {
        skills.push(value);
      }
    });
    picker.skills = skills.length ? skills : known.slice();
    var languageValues =
      window.LP && Array.isArray(window.LP.LANGUAGES)
        ? window.LP.LANGUAGES.map(function (entry) {
            return entry.value;
          })
        : ["zh", "en", "ja", "de", "fr", "es", "ru", "ko"];
    var languages = ["auto"].concat(languageValues);
    if (languages.indexOf(String(picker.defaultTargetLang)) < 0) {
      picker.defaultTargetLang = "auto";
    }
    var blacklist = [];
    (Array.isArray(picker.blacklist) ? picker.blacklist : []).forEach(function (entry) {
      var value = String(entry || "").trim();
      if (!value || blacklist.length >= 200) {
        return;
      }
      var normalized = value.toLowerCase().replace(/\.exe$/, "");
      var duplicate = blacklist.some(function (item) {
        return item.toLowerCase().replace(/\.exe$/, "") === normalized;
      });
      if (!duplicate) {
        blacklist.push(value);
      }
    });
    picker.blacklist = blacklist;
    picker.maxChars = Math.min(20000, Math.max(100, Number(picker.maxChars) || 5000));
    var searchEngines = ["google", "baidu", "bing"];
    picker.searchEngine =
      searchEngines.indexOf(String(picker.searchEngine || "")) >= 0
        ? String(picker.searchEngine)
        : "google";
    var promptStore =
      picker.prompts && typeof picker.prompts === "object" ? picker.prompts : {};
    picker.prompts = {};
    ["translate", "summarize", "explain", "polish"].forEach(function (id) {
      picker.prompts[id] = String(promptStore[id] || "").trim().slice(0, 4000);
    });
    if (settings.provider.mode !== "local") {
      settings.provider.mode = "online";
    }
    var capture = settings.capture && typeof settings.capture === "object" ? settings.capture : {};
    settings.capture = {
      regionShortcut: normalizeMockShortcut(capture.regionShortcut) || "Win+Shift+X",
    };
    var allowedCaptureSkills = ["copy", "ocr", "translate", "explain"];
    var captureSkills = [];
    (Array.isArray(picker.captureSkills) ? picker.captureSkills : []).forEach(function (item) {
      var value = String(item || "").trim().toLowerCase();
      if (allowedCaptureSkills.indexOf(value) >= 0 && captureSkills.indexOf(value) < 0) {
        captureSkills.push(value);
      }
    });
    // An explicit empty list means "no toolbar actions" (the overlay then only
    // shows 确认 / 取消), matching settings.rs. Missing values were already
    // defaulted when the mock store was created.
    picker.captureSkills = captureSkills;
    mockStore.picker.pinned = false;
  }

  function mockPublishState() {
    refreshMockDerived();
    mockEmit("state-changed", clone(mockStore));
  }

  function mockNotFound(command) {
    return { ok: false, error: "浏览器预览模式没有实现命令：" + command };
  }

  var MOCK_TRANSLATIONS = {
    zh: "翻译是把某种语言文本的含义用另一种语言完整、准确地表达出来的活动，也是跨文化交流的桥梁。",
    en: "Translation is the act of expressing the meaning of a text in another language; it also serves as a bridge between cultures.",
    ja: "翻訳とは、ある言語のテキストの意味を別の言語で表現することであり、異文化コミュニケーションの架け橋です。",
    de: "Übersetzung ist die Übertragung der Bedeutung eines Textes in eine andere Sprache und zugleich eine Brücke zwischen Kulturen.",
    fr: "La traduction consiste à exprimer dans une autre langue le sens d'un texte source et sert de pont entre les cultures.",
    es: "La traducción consiste en expresar en otro idioma el significado de un texto y actúa como puente entre culturas.",
    ru: "Перевод — это выражение смысла текста на другом языке; он служит мостом между культурами.",
    ko: "번역은 한 언어로 된 텍스트의 의미를 다른 언어로 표현하는 일이며, 문화 사이의 다리 역할을 합니다.",
  };

  function mockTranslationText(text, targetLang) {
    var language = String(targetLang || "").toLowerCase();
    var fallback =
      MOCK_TRANSLATIONS[language] ||
      MOCK_TRANSLATIONS.en;
    var prefix =
      language === "zh"
        ? "（演示译文）"
        : "（demo translation）";
    return prefix + fallback;
  }

  function startMockTranslate(requestId, text, targetLang) {
    var output = mockTranslationText(text, targetLang);
    var cursor = 0;
    var timer = null;
    var stream = { cancelled: false };
    mockStreams[requestId] = stream;

    function cleanup() {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (mockStreams[requestId] === stream) {
        delete mockStreams[requestId];
      }
    }

    function emitChunk() {
      if (stream.cancelled) {
        cleanup();
        return;
      }
      var size = 2 + Math.floor(Math.random() * 3);
      var chunk = output.slice(cursor, cursor + size);
      cursor += chunk.length;
      if (chunk) {
        mockEmit("translate-event", {
          requestId: requestId,
          type: "chunk",
          text: chunk,
        });
      }
      if (cursor >= output.length) {
        window.setTimeout(function () {
          if (!stream.cancelled) {
            mockEmit("translate-event", { requestId: requestId, type: "done" });
          }
          cleanup();
        }, 120);
        return;
      }
      timer = window.setTimeout(emitChunk, 42);
    }

    timer = window.setTimeout(emitChunk, 260);
  }

  var mockStreams = {};

  function cancelMockTranslate(requestId) {
    var stream = mockStreams[requestId];
    if (stream) {
      stream.cancelled = true;
      delete mockStreams[requestId];
    }
  }

  function scheduleMockPickerData(delay) {
    if (mockPickerTimer) {
      window.clearTimeout(mockPickerTimer);
    }
    mockPickerAttempts = 0;
    var wait = typeof delay === "number" ? delay : 140;

    function attempt() {
      mockPickerTimer = null;
      if (!mockHasListeners("picker-data")) {
        mockPickerAttempts += 1;
        if (mockPickerAttempts < 8) {
          mockPickerTimer = window.setTimeout(attempt, 120);
        }
        return;
      }
      var picker = (mockStore && mockStore.settings.picker) || {};
      var enabledIds = Array.isArray(picker.skills) ? picker.skills : [];
      var customSkills = [];
      (Array.isArray(picker.customSkills) ? picker.customSkills : []).forEach(function (skill) {
        if (enabledIds.indexOf(skill.id) >= 0) {
          customSkills.push({ id: skill.id, label: skill.label, icon: skill.icon, kind: skill.kind === "image" ? "image" : "text" });
        }
      });
      var panelPinned = !!picker.panelPinned;
      mockEmit("picker-data", {
        text: "Translation is the communication of the meaning of a source-language text by means of an equivalent target-language text.",
        programName: "notepad.exe",
        config: {
          skills: enabledIds.slice(),
          customSkills: customSkills,
          compact: !!picker.compact,
          defaultTargetLang: picker.defaultTargetLang || "auto",
          searchEngine: picker.searchEngine || "google",
          panelMode: picker.panelMode === "scroll" ? "scroll" : "auto",
          panelPinned: panelPinned,
        },
      });
    }

    mockPickerTimer = window.setTimeout(attempt, wait);
  }

  function mockDownload(kind, id, entry) {
    var key = kind + ":" + (id || "");
    if (mockDownloads[key]) {
      return { ok: false, error: "该任务已在下载中" };
    }
    var total =
      kind === "engine"
        ? 23100000
        : entry && entry.sizeBytes
          ? entry.sizeBytes
          : 1117320736;
    var filename =
      kind === "engine" ? "llama-b11851-bin-win-cpu-x64.zip" : entry.filename;
    var progress = {
      kind: kind,
      id: id || "",
      filename: filename,
      received: 0,
      total: total,
      percent: 0,
      status: "downloading",
      error: "",
    };
    var task = { progress: progress, cancelled: false, timer: null, resolve: null };
    mockDownloads[key] = task;
    mockDownloadSeq += 1;
    refreshMockDerived();
    mockEmit("download-progress", clone(progress));

    return new Promise(function (resolve) {
      task.resolve = resolve;
      var tick = 0;
      task.timer = window.setInterval(function () {
        if (task.cancelled) {
          return;
        }
        tick += 1;
        if (tick > 28) {
          window.clearInterval(task.timer);
          progress.percent = 100;
          progress.received = total;
          progress.status = "verifying";
          mockEmit("download-progress", clone(progress));
          window.setTimeout(function () {
            if (task.cancelled) {
              return;
            }
            delete mockDownloads[key];
            refreshMockDerived();
            if (kind === "engine") {
              mockStore.engine.engineAvailable = true;
            } else if (entry) {
              entry.installed = true;
              entry.catalogId = entry.id;
              var existing = mockStore.models.some(function (model) {
                return model.file === entry.filename;
              });
              if (!existing) {
                mockStore.models.push({
                  file: entry.filename,
                  name: entry.filename.replace(/\.gguf$/i, ""),
                  path:
                    "C:\\Users\\Preview\\AppData\\Roaming\\Lexora\\models\\" +
                    entry.filename,
                  sizeBytes: entry.sizeBytes,
                  modifiedAt: Date.now(),
                  catalogId: entry.id,
                });
              }
            }
            mockPublishState();
            mockEmit("toast", {
              type: "success",
              message:
                kind === "engine" ? "引擎下载完成" : "模型下载完成：" + entry.name,
            });
            resolve({ ok: true });
          }, 320);
          return;
        }
        progress.received = Math.round((total * tick) / 30);
        progress.percent = Math.min(99, Math.round((tick * 100) / 30));
        mockEmit("download-progress", clone(progress));
      }, 110);
    });
  }

  function cancelMockDownload(id) {
    var wanted = String(id == null ? "" : id).trim();
    var keys = Object.keys(mockDownloads);
    var cancelled = 0;
    keys.forEach(function (key) {
      var matches = key === "model:" + wanted || key === wanted || (wanted === "engine" && key === "engine:");
      if (wanted && !matches) {
        return;
      }
      var task = mockDownloads[key];
      task.cancelled = true;
      if (task.timer) {
        window.clearInterval(task.timer);
      }
      task.progress.status = "cancelled";
      mockEmit("download-progress", clone(task.progress));
      delete mockDownloads[key];
      cancelled += 1;
      if (typeof task.resolve === "function") {
        task.resolve({ ok: false, error: "下载已取消" });
      }
    });
    refreshMockDerived();
    if (cancelled) {
      mockEmit("toast", { type: "info", message: "已取消下载" });
    }
    return { ok: true };
  }


  /* ------------------------------------------------------------------ */
  /* Screenshot capture (browser preview)                               */
  /* ------------------------------------------------------------------ */

  function mockCaptureMonitorInfo(index) {
    var width = 1280;
    var height = 720;
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#1e293b"/><stop offset="1" stop-color="#0f172a"/>' +
      '</linearGradient></defs>' +
      '<rect width="100%" height="100%" fill="url(#g)"/>' +
      '<rect x="120" y="100" width="1040" height="520" rx="16" fill="#334155"/>' +
      '<text x="170" y="200" fill="#e2e8f0" font-family="Segoe UI, sans-serif" font-size="42">Lexora screenshot preview</text>' +
      '<text x="170" y="270" fill="#94a3b8" font-family="Segoe UI, sans-serif" font-size="26">Drag a rectangle to select an area.</text>' +
      '<text x="170" y="330" fill="#94a3b8" font-family="Segoe UI, sans-serif" font-size="26">复制 / 提取文字 / 翻译 / 解释图片</text>' +
      '</svg>';
    return {
      ok: true,
      index: Number(index) || 0,
      width: width,
      height: height,
      dataUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
      preset: null,
    };
  }

  /* Screenshot skill preview: a simulated picker result panel. `picker-image`
   * opens the panel, `translate-event` streams the answer (same channel as the
   * text skills). `?mockImage=ocr|translate|explain|custom` triggers it on load;
   * `?mockImageFail=1` previews the error panel. */
  var MOCK_IMAGE_TEXTS = {
    ocr: "Lexora screenshot preview\nDrag a rectangle to select an area.\n复制 / 提取文字 / 翻译 / 解释图片",
    translate: "这是截图文字的模拟翻译结果：Lexora 截图预览。拖动矩形选择一个区域即可截取。",
    explain:
      "## 图片内容（预览）\n\n画面是 Lexora 截图预览：深色背景上有一段标题文字「Lexora screenshot preview」，下方是拖选提示与工具条说明。\n\n- 主要元素：标题、提示文字、矩形选区\n- 这是浏览器预览模式下的模拟输出",
    custom:
      "## 图片技能结果（预览）\n\n- 检测到一段英文标题\n- 画面中包含操作提示\n\n> 浏览器预览模式：由本地 mock 数据生成。",
  };

  function startMockImageStream(requestId, action) {
    var text = MOCK_IMAGE_TEXTS[action] || MOCK_IMAGE_TEXTS.explain;
    var step = action === "ocr" ? 12 : 6;
    // Screenshot translation reports its resolved target language first (the
    // real shell resolves it from the recognized text, contract §10.3).
    if (action === "translate") {
      mockEmit("translate-event", {
        requestId: requestId,
        type: "target",
        targetLang: "zh",
      });
    }
    var index = 0;
    var timer = window.setInterval(function () {
      if (index >= text.length) {
        window.clearInterval(timer);
        mockEmit("translate-event", { requestId: requestId, type: "done" });
        return;
      }
      mockEmit("translate-event", {
        requestId: requestId,
        type: "chunk",
        text: text.slice(index, index + step),
      });
      index += step;
    }, 45);
  }

  function mockPickerImage(action, options) {
    var opts = options || {};
    var requestId = String(opts.requestId || "capture-" + Date.now().toString(36));
    var labels = {
      ocr: "提取文字",
      translate: "翻译",
      explain: "解释图片",
      custom: opts.label || "图片技能",
    };
    mockEmit("picker-image", {
      requestId: requestId,
      action: action,
      skillId: opts.skillId || "",
      label: labels[action] || "截图",
      targetLang: opts.targetLang || "auto",
      clipboard: true,
      hint: "截图已复制到剪贴板",
    });
    if (opts.error) {
      window.setTimeout(function () {
        mockEmit("translate-event", {
          requestId: requestId,
          type: "error",
          message: String(opts.error),
          hint: opts.hint || "请在「设置 → 翻译服务」配置支持视觉的模型。",
        });
      }, 420);
      return requestId;
    }
    window.setTimeout(function () {
      startMockImageStream(requestId, action);
    }, 300);
    return requestId;
  }

  function scheduleMockPickerImage() {
    var query = String(window.location.search || "");
    var match = /[?&]mockImage=([a-z]+)/.exec(query);
    if (!match) {
      return;
    }
    var action =
      ["ocr", "translate", "explain", "custom"].indexOf(match[1]) >= 0
        ? match[1]
        : "explain";
    var failed = /[?&]mockImageFail=1(?:&|$)/.test(query);
    scheduleMockPickerData(80);
    window.setTimeout(function () {
      mockPickerImage(action, {
        error: failed ? "模拟错误：视觉模型未配置" : "",
      });
    }, 650);
  }

  /* Console helper for manual UI checks: `__mockPickerImage("translate")`. */
  window.__mockPickerImage = function (action, options) {
    return mockPickerImage(String(action || "explain"), options || {});
  };

  /* Console helper for the capture overlay preview: simulates the shell arming
   * the (reused) overlay window for another capture. */
  window.__mockCaptureArmed = function (index) {
    mockEmit("capture-armed", { index: Number(index) || 0 });
  };

  /* Console helper to push an arbitrary translate-event (target language,
   * error, chunk…) while previewing the picker panels. */
  window.__mockTranslateEvent = function (payload) {
    mockEmit("translate-event", payload || {});
  };

  var MOCK_NAMED_KEYS = {
    printscreen: "PrintScreen",
    print: "PrintScreen",
    prtsc: "PrintScreen",
    space: "Space",
    spacebar: "Space",
    tab: "Tab",
    enter: "Enter",
    return: "Enter",
    esc: "Esc",
    escape: "Esc",
    backspace: "Backspace",
    insert: "Insert",
    ins: "Insert",
    delete: "Delete",
    del: "Delete",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pgup: "PageUp",
    pagedown: "PageDown",
    pgdn: "PageDown",
    up: "Up",
    arrowup: "Up",
    down: "Down",
    arrowdown: "Down",
    left: "Left",
    arrowleft: "Left",
    right: "Right",
    arrowright: "Right",
  };

  function canonicalMockKey(token) {
    if (/^[a-z]$/.test(token)) {
      return token.toUpperCase();
    }
    if (/^[0-9]$/.test(token)) {
      return token;
    }
    var fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(token);
    if (fn) {
      return "F" + fn[1];
    }
    return MOCK_NAMED_KEYS[token] || "";
  }

  /* Mirrors `settings::normalize_shortcut` for browser preview. */
  function normalizeMockShortcut(raw) {
    var tokens = String(raw == null ? "" : raw)
      .split("+")
      .map(function (part) {
        return part.trim().toLowerCase();
      });
    if (!tokens.length) {
      return "";
    }
    var flags = { win: false, ctrl: false, alt: false, shift: false };
    var key = "";
    for (var index = 0; index < tokens.length; index += 1) {
      var token = tokens[index];
      if (!token) {
        return "";
      }
      if (token === "win" || token === "windows" || token === "meta" || token === "super" || token === "cmd") {
        flags.win = true;
        continue;
      }
      if (token === "ctrl" || token === "control") {
        flags.ctrl = true;
        continue;
      }
      if (token === "alt" || token === "option") {
        flags.alt = true;
        continue;
      }
      if (token === "shift") {
        flags.shift = true;
        continue;
      }
      if (key) {
        return "";
      }
      key = canonicalMockKey(token);
      if (!key) {
        return "";
      }
    }
    if (!(flags.win || flags.ctrl || flags.alt || flags.shift) || !key) {
      return "";
    }
    var parts = [];
    if (flags.win) {
      parts.push("Win");
    }
    if (flags.ctrl) {
      parts.push("Ctrl");
    }
    if (flags.alt) {
      parts.push("Alt");
    }
    if (flags.shift) {
      parts.push("Shift");
    }
    parts.push(key);
    return parts.join("+");
  }

  function mockHandle(command, args) {
    if (!mockStore) {
      initMockStore();
    }
    var settings;
    switch (command) {
      /* ---- picker ---- */
      case "picker_ready":
        scheduleMockPickerData(120);
        scheduleMockPickerImage();
        return { ok: true };
      case "start_capture":
        return { ok: true, monitors: 1 };
      case "capture_monitor_info":
        return mockCaptureMonitorInfo(args.index);
      case "capture_ready":
        return { ok: true };
      case "capture_copy":
        return { ok: true };
      case "capture_skill": {
        var captureRequestId = String(args.requestId || "");
        if (!captureRequestId) {
          return { ok: false, error: "缺少请求 ID" };
        }
        console.info(
          "[mock] 截图技能：action=" +
            String(args.action || "") +
            "，图片已复制到剪贴板；真实应用会在 picker 窗口显示结果面板"
        );
        return { ok: true, clipboard: true };
      }
      case "capture_retry":
        return { ok: true };
      case "capture_followup":
        return { ok: true };
      case "capture_set_hotkey": {
        var normalizedShortcut = normalizeMockShortcut(args.shortcut);
        if (!normalizedShortcut) {
          return {
            ok: false,
            shortcut: String((mockStore.settings.capture || {}).regionShortcut || ""),
            error: "快捷键格式无效。",
            hint: "至少需要一个修饰键（Ctrl / Alt / Shift / Win）和一个主键。",
          };
        }
        mockStore.settings.capture = { regionShortcut: normalizedShortcut };
        mockPublishState();
        return { ok: true, shortcut: normalizedShortcut };
      }
      case "capture_close":
        return { ok: true };
      case "picker_close":
        mockEmit("picker-hidden", {});
        scheduleMockPickerData(1600);
        return { ok: true };
      case "picker_pin":
        mockStore.picker.pinned = !!args.pinned;
        if (args.remember === true) {
          mockStore.settings.picker.panelPinned = !!args.pinned;
        }
        return { ok: true, pinned: !!args.pinned };
      case "picker_panel_state":
        return { ok: true };
      case "picker_activate":
        return { ok: true };
      case "picker_drag_panel":
        return { ok: true };
      case "picker_resize":
        return {
          x: 0,
          y: 0,
          width: Number(args.width) || 0,
          height: Number(args.height) || 0,
        };
      case "picker_copy":
        console.info("[mock] 复制到剪贴板：", String(args.text || "").slice(0, 80));
        return { ok: true };
      case "picker_open_settings":
        console.info("[mock] 打开设置窗口");
        return { ok: true };
      case "picker_translate":
        if (!String(args.text || "").trim()) {
          return { ok: false, error: "没有可翻译的文本" };
        }
        startMockTranslate(
          String(args.requestId || ""),
          String(args.text || ""),
          String(args.targetLang || "")
        );
        return { ok: true };
      case "picker_custom_skill":
        if (!String(args.text || "").trim()) {
          return { ok: false, error: "没有可处理的文本" };
        }
        startMockTranslate(
          String(args.requestId || ""),
          String(args.text || ""),
          "zh"
        );
        return { ok: true };
      case "picker_polish":
        if (!String(args.text || "").trim()) {
          return { ok: false, error: "没有可润色的文本" };
        }
        startMockTranslate(
          String(args.requestId || ""),
          String(args.text || ""),
          "zh"
        );
        return { ok: true };
      case "open_external":
        console.info("[mock] 打开外部链接：", String(args.url || ""));
        return { ok: true };
      case "picker_abort_translate":
        cancelMockTranslate(String(args.requestId || ""));
        return { ok: true };
      case "picker_assist": {
        var assistRequestId = String(args.requestId || "");
        if (!assistRequestId) {
          return { ok: false, error: "缺少请求 ID" };
        }
        startMockTranslate(assistRequestId, String(args.text || ""), "zh");
        return { ok: true };
      }
      case "picker_followup": {
        var followupRequestId = String(args.requestId || "");
        if (!followupRequestId) {
          return { ok: false, error: "缺少请求 ID" };
        }
        startMockTranslate(
          followupRequestId,
          String(args.question || args.text || ""),
          "zh"
        );
        return { ok: true };
      }
      case "picker_status":
        return {
          ok: true,
          mode: mockStore.engine.mode,
          ready: mockStore.engine.ready,
          configured: mockStore.engine.onlineConfigured,
          providerLabel: mockStore.engine.providerLabel,
          localState: mockStore.engine.localState,
          hint: mockStore.engine.hint,
        };
      case "picker_disable_in_app":
        mockEmit("toast", {
          type: "success",
          message: "已在 " + String(args.programName || "当前应用") + " 中禁用（预览模式）",
        });
        return { ok: true };
      case "picker_disable_tool":
        mockEmit("toast", {
          type: "success",
          message: "已禁用划词工具（预览模式）",
        });
        return { ok: true };

      /* ---- settings: state ---- */
      case "get_state":
        mockPublishState();
        return clone(mockStore);
      case "update_settings":
        settings = mockStore.settings;
        mockStore.settings = window.LP
          ? window.LP.deepMerge(settings, args.patch || {})
          : mergePlain(settings, args.patch || {});
        normalizeMockSettings();
        mockPublishState();
        return { state: clone(mockStore) };
      case "reset_settings": {
        var portable = mockStore.app.portable;
        var installed = mockStore.models.slice();
        var keptCustomSkills = (mockStore.settings.picker.customSkills || []).slice();
        var keptCustomEnabled = (mockStore.settings.picker.skills || []).filter(function (id) {
          return String(id).indexOf("custom-") === 0;
        });
        initMockStore();
        mockStore.app.portable = portable;
        mockStore.models = installed;
        mockStore.loginItem.supported = !portable;
        mockStore.settings.picker.customSkills = keptCustomSkills;
        mockStore.settings.picker.skills = mockStore.settings.picker.skills.concat(keptCustomEnabled);
        normalizeMockSettings();
        mockPublishState();
        return { state: clone(mockStore) };
      }
      case "check_update": {
        return {
          ok: true,
          currentVersion: "0.1.0",
          latestVersion: "0.1.1",
          hasUpdate: true,
          assetName: "Lexora-0.1.1-win-x64.exe",
          assetUrl: "https://github.com/monk233/lexora/releases/download/v0.1.1/Lexora-0.1.1-win-x64.exe",
          notes: "浏览器预览模式：这里显示新版本的更新说明。\\n\\n- 修复若干问题\\n- 改进技能面板",
          publishedAt: "2026-10-24T12:00:00Z",
          sizeBytes: 9500000,
        };
      }
      case "install_update": {
        return new Promise(function (resolve) {
          window.setTimeout(function () {
            mockEmit("update-progress", { status: "downloading", received: 2800000, total: 9500000, percent: 30 });
          }, 250);
          window.setTimeout(function () {
            mockEmit("update-progress", { status: "downloading", received: 6600000, total: 9500000, percent: 70 });
          }, 650);
          window.setTimeout(function () {
            mockEmit("update-progress", { status: "ready", received: 9500000, total: 9500000, percent: 100 });
          }, 1000);
          window.setTimeout(function () {
            resolve({ ok: true, version: "0.1.1" });
          }, 1200);
        });
      }

      /* ---- settings: online provider ---- */
      case "test_online": {
        var baseUrl = String(args.baseUrl || "").trim();
        if (!/^https?:\/\//i.test(baseUrl)) {
          return {
            ok: false,
            latencyMs: 0,
            models: [],
            model: String(args.model || ""),
            error: "服务地址无效：必须以 http:// 或 https:// 开头",
            hint: "请填写 OpenAI 兼容服务的 /v1 根地址。",
          };
        }
        var isLoopback = /127\.0\.0\.1|localhost/i.test(baseUrl);
        if (!isLoopback && !String(args.apiKey || "").trim()) {
          return {
            ok: false,
            latencyMs: 0,
            models: [],
            model: String(args.model || ""),
            error: "401 Unauthorized：API Key 为空或无效",
            hint: "请到服务商控制台创建 API Key 后填入，再重试。",
          };
        }
        return {
          ok: true,
          latencyMs: 520 + Math.round(Math.random() * 380),
          models: ["deepseek-chat", "deepseek-reasoner", "gpt-4o-mini", "qwen2.5:1.5b"],
          model: String(args.model || ""),
          error: "",
          hint: "",
        };
      }
      case "list_online_models":
        return {
          models: ["deepseek-chat", "deepseek-reasoner", "gpt-4o-mini", "qwen2.5:1.5b"],
        };
      case "download_engine":
        if (mockStore.engine.engineAvailable) {
          return { ok: true };
        }
        return mockDownload("engine", "", null);
      case "download_model": {
        var id = String(args.id || "");
        var entry = null;
        mockStore.catalog.forEach(function (item) {
          if (item.id === id) {
            entry = item;
          }
        });
        if (!entry) {
          return { ok: false, error: "未知的模型：" + id };
        }
        if (entry.installed) {
          return { ok: true };
        }
        return mockDownload("model", id, entry);
      }
      case "cancel_download":
        return cancelMockDownload(args.id);
      case "import_model":
        return new Promise(function (resolve) {
          window.setTimeout(function () {
            var filename = "imported-model-q4_k_m.gguf";
            var exists = mockStore.models.some(function (model) {
              return model.file === filename;
            });
            if (!exists) {
              mockStore.models.push({
                file: filename,
                name: "imported-model-q4_k_m",
                path:
                  "C:\\Users\\Preview\\AppData\\Roaming\\Lexora\\models\\" + filename,
                sizeBytes: 1048576000,
                modifiedAt: Date.now(),
                catalogId: "",
              });
            }
            mockPublishState();
            mockEmit("toast", {
              type: "success",
              message: "已导入模型（预览模式使用示例文件）",
            });
            resolve({ ok: true });
          }, 420);
        });
      case "remove_model": {
        var file = String(args.file || "");
        mockStore.models = mockStore.models.filter(function (model) {
          return model.file !== file;
        });
        mockStore.catalog.forEach(function (item) {
          if (item.filename === file) {
            item.installed = false;
          }
        });
        if (mockStore.engine.localModelFile === file) {
          mockStore.engine.localState = "stopped";
          mockStore.engine.localModelFile = "";
          mockStore.engine.localModelName = "";
        }
        mockPublishState();
        return { ok: true };
      }
      case "start_local":
        return mockStartLocal();
      case "stop_local":
        return mockStopLocal();

      /* ---- settings: app ---- */
      case "open_dir":
        console.info("[mock] 打开目录：", String(args.which || "data"));
        return { ok: true };
      case "open_external":
        try {
          window.open(String(args.url || ""), "_blank", "noopener");
        } catch (ignored) {
          /* popup blocked - fine for a preview */
        }
        return { ok: true };
      case "set_start_at_login":
        if (!mockStore.loginItem.supported) {
          return { ok: false, error: "便携版不支持开机自启" };
        }
        mockStore.settings.app.startAtLogin = !!args.enabled;
        mockPublishState();
        return { ok: true };
      case "quit_app":
        console.info("[mock] 退出程序（预览模式不会真的退出）");
        return { ok: true };
      default:
        return mockNotFound(command);
    }
  }

  function mockStartLocal() {
    if (!mockStore.engine.engineAvailable) {
      return {
        ok: false,
        error: "尚未安装 llama.cpp 引擎",
        hint: "请先在「翻译服务 → 本地模型」中下载引擎。",
      };
    }
    if (!mockStore.models.length) {
      return {
        ok: false,
        error: "尚未安装本地模型",
        hint: "请先下载或导入 GGUF 模型。",
      };
    }
    if (mockStore.engine.localState === "ready") {
      return { ok: true };
    }
    var preferred =
      mockStore.models.filter(function (model) {
        return model.catalogId === "hy-mt2-1.8b";
      })[0] || mockStore.models[0];
    mockStore.engine.localState = "starting";
    mockStore.engine.localError = "";
    mockStore.engine.localModelFile = preferred.file;
    mockStore.engine.localModelName = preferred.name;
    mockPublishState();
    return new Promise(function (resolve) {
      window.setTimeout(function () {
        mockStore.engine.localState = "ready";
        mockPublishState();
        mockEmit("toast", { type: "success", message: "本地引擎已启动" });
        resolve({ ok: true });
      }, 1100);
    });
  }

  function mockStopLocal() {
    mockStore.engine.localState = "stopped";
    mockStore.engine.localError = "";
    mockStore.engine.localModelFile = "";
    mockStore.engine.localModelName = "";
    mockPublishState();
    return { ok: true };
  }

  function mergePlain(target, patch) {
    var result = {};
    var key;
    for (key in target) {
      if (has(target, key)) {
        result[key] = target[key];
      }
    }
    for (key in patch) {
      if (!has(patch, key)) {
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
        result[key] = mergePlain(existing, value);
      } else {
        result[key] = Array.isArray(value) ? value.slice() : value;
      }
    }
    return result;
  }

  function mockInvoke(command, args) {
    if (!mockStore) {
      initMockStore();
    }
    return new Promise(function (resolve, reject) {
      window.setTimeout(function () {
        var result;
        try {
          result = mockHandle(command, args || {});
        } catch (error) {
          reject(errorText(error));
          return;
        }
        resolve(result);
      }, 8);
    });
  }

  /* ------------------------------------------------------------------ */
  /* pickerAPI                                                           */
  /* ------------------------------------------------------------------ */

  window.pickerAPI = {
    live: LIVE,

    ready: function () {
      return safeInvoke("picker_ready", {});
    },
    onData: function (callback) {
      return subscribe("picker-data", callback);
    },
    onHidden: function (callback) {
      return subscribe("picker-hidden", callback);
    },
    /* Screenshot skills hand their result panel to the picker (see §10.5). */
    onImage: function (callback) {
      return subscribe("picker-image", callback);
    },
    close: function () {
      return safeInvoke("picker_close", {});
    },
    pin: function (pinned, remember) {
      return safeInvoke("picker_pin", {
        pinned: !!pinned,
        remember: remember === true,
      });
    },
    /* Tells the shell whether a tool panel is currently open (sticky panel). */
    panelState: function (open) {
      return safeInvoke("picker_panel_state", { open: !!open });
    },
    /* Allows keyboard input in the picker (follow-up text field) while open. */
    activate: function (active) {
      return safeInvoke("picker_activate", { active: !!active });
    },
    resize: function (width, height) {
      return invokeQuiet("picker_resize", { width: width, height: height }, null);
    },
    copy: function (text) {
      return safeInvoke("picker_copy", { text: String(text == null ? "" : text) });
    },
    openSettings: function () {
      return safeInvoke("picker_open_settings", {});
    },
    translate: function (requestId, text, targetLang) {
      return safeInvoke("picker_translate", {
        requestId: String(requestId == null ? "" : requestId),
        text: String(text == null ? "" : text),
        targetLang: String(targetLang == null ? "" : targetLang),
      });
    },
    abortTranslate: function (requestId) {
      return safeInvoke("picker_abort_translate", {
        requestId: String(requestId == null ? "" : requestId),
      });
    },
    /* `requestId` is optional: when given, events of other requests are
     * filtered out here instead of in the caller. */
    onTranslateEvent: function (callback, requestId) {
      var filter = requestId == null ? "" : String(requestId);
      return subscribe("translate-event", function (payload) {
        if (!payload || typeof payload !== "object") {
          return;
        }
        if (filter && String(payload.requestId || "") !== filter) {
          return;
        }
        if (typeof callback === "function") {
          callback(payload);
        }
      });
    },
    assist: function (requestId, action, text) {
      return safeInvoke("picker_assist", {
        requestId: String(requestId == null ? "" : requestId),
        action: String(action == null ? "" : action),
        text: String(text == null ? "" : text),
      });
    },
    /* Streams a user-defined skill through the same translate-event channel. */
    customSkill: function (requestId, skillId, text, programName) {
      return safeInvoke("picker_custom_skill", {
        requestId: String(requestId == null ? "" : requestId),
        skillId: String(skillId == null ? "" : skillId),
        text: String(text == null ? "" : text),
        programName: String(programName == null ? "" : programName),
      });
    },
    /* Streams a follow-up question in the same panel (same translate-event channel). */
    followup: function (requestId, text, previousAnswer, question, history) {
      return safeInvoke("picker_followup", {
        requestId: String(requestId == null ? "" : requestId),
        text: String(text == null ? "" : text),
        previousAnswer: String(previousAnswer == null ? "" : previousAnswer),
        question: String(question == null ? "" : question),
        history: Array.isArray(history) ? history : [],
      });
    },
    /* Re-runs the screenshot skill that opened the current image panel. */
    /* Re-runs the screenshot skill that opened the current image panel.
     * `targetLang` is only used by screenshot translation (language switch or
     * retry with the currently selected target). */
    captureRetry: function (requestId, targetLang) {
      return safeInvoke("capture_retry", {
        requestId: String(requestId == null ? "" : requestId),
        targetLang: String(targetLang == null ? "" : targetLang),
      });
    },
    /* Follow-up on a screenshot panel (vision / OCR context kept in the shell). */
    captureFollowup: function (requestId, question, previousAnswer, history) {
      return safeInvoke("capture_followup", {
        requestId: String(requestId == null ? "" : requestId),
        question: String(question == null ? "" : question),
        previousAnswer: String(previousAnswer == null ? "" : previousAnswer),
        history: Array.isArray(history) ? history : [],
      });
    },
    /* Streams the built-in 润色 skill through the same translate-event channel. */
    polish: function (requestId, text) {
      return safeInvoke("picker_polish", {
        requestId: String(requestId == null ? "" : requestId),
        text: String(text == null ? "" : text),
      });
    },
    /* Opens an https URL in the system browser (search skill). */
    openExternal: function (url) {
      return safeInvoke("open_external", { url: String(url == null ? "" : url) });
    },
    status: function () {
      return safeInvoke("picker_status", {});
    },
    /* Moves the picker window by a logical-pixel delta (panel header drag). */
    dragPanel: function (dx, dy) {
      return safeInvoke("picker_drag_panel", {
        dx: Number(dx) || 0,
        dy: Number(dy) || 0,
      });
    },
    disableInApp: function (programName) {
      return safeInvoke("picker_disable_in_app", {
        programName: String(programName == null ? "" : programName),
      });
    },
    disableTool: function () {
      return safeInvoke("picker_disable_tool", {});
    },
  };

  /* ------------------------------------------------------------------ */
  /* settingsAPI                                                         */
  /* ------------------------------------------------------------------ */

  /* `update_settings` returns a StatePayload; the contract also allows the
   * `{state: StatePayload}` envelope. Accept both. */
  function stateResult(result) {
    if (!result || result.ok === false) {
      return {
        ok: false,
        error: (result && result.error) || "操作失败",
      };
    }
    var payload = null;
    if (result.state && result.state.settings) {
      payload = result.state;
    } else if (result.settings && result.app) {
      payload = result;
    }
    if (!payload) {
      return { ok: false, error: "应用状态格式无效" };
    }
    return { ok: true, state: payload };
  }

  window.settingsAPI = {
    live: LIVE,

    getState: function () {
      return safeInvoke("get_state", {}).then(stateResult);
    },
    updateSettings: function (patch) {
      return safeInvoke("update_settings", { patch: patch || {} }).then(stateResult);
    },
    resetSettings: function () {
      return safeInvoke("reset_settings", {}).then(stateResult);
    },

    testOnline: function (options) {
      var opts = options || {};
      return safeInvoke("test_online", {
        baseUrl: String(opts.baseUrl == null ? "" : opts.baseUrl),
        apiKey: String(opts.apiKey == null ? "" : opts.apiKey),
        model: String(opts.model == null ? "" : opts.model),
        timeoutMs: Number(opts.timeoutMs) || 60000,
      }).then(function (result) {
        if (result.ok === false && !result.error) {
          result.error = "测试连接失败";
        }
        return result;
      });
    },

    listOnlineModels: function (options) {
      var opts = options || {};
      return safeInvoke("list_online_models", {
        baseUrl: String(opts.baseUrl == null ? "" : opts.baseUrl),
        apiKey: String(opts.apiKey == null ? "" : opts.apiKey),
      }).then(function (result) {
        return {
          ok: result.ok !== false,
          models: Array.isArray(result.models) ? result.models : [],
          error: result.error || "",
          hint: result.hint || "",
        };
      });
    },

    downloadEngine: function () {
      return safeInvoke("download_engine", {});
    },
    downloadModel: function (id) {
      return safeInvoke("download_model", { id: String(id == null ? "" : id) });
    },
    cancelDownload: function (id) {
      return safeInvoke("cancel_download", { id: String(id == null ? "" : id) });
    },
    importModel: function () {
      return safeInvoke("import_model", {});
    },
    removeModel: function (file) {
      return safeInvoke("remove_model", { file: String(file == null ? "" : file) });
    },
    startLocal: function () {
      return safeInvoke("start_local", {});
    },
    stopLocal: function () {
      return safeInvoke("stop_local", {});
    },
    openDir: function (which) {
      return safeInvoke("open_dir", { which: String(which == null ? "data" : which) });
    },
    openExternal: function (url) {
      return safeInvoke("open_external", { url: String(url == null ? "" : url) });
    },
    setStartAtLogin: function (enabled) {
      return safeInvoke("set_start_at_login", { enabled: !!enabled });
    },
    /* Updates the region-screenshot shortcut (validates + re-registers it). */
    setCaptureHotkey: function (shortcut) {
      return safeInvoke("capture_set_hotkey", {
        shortcut: String(shortcut == null ? "" : shortcut),
      });
    },
    checkUpdate: function () {
      return safeInvoke("check_update", {});
    },
    installUpdate: function () {
      return safeInvoke("install_update", {});
    },
    onUpdateProgress: function (callback) {
      return subscribe("update-progress", function (payload) {
        if (typeof callback === "function") {
          callback(payload);
        }
      });
    },
    quit: function () {
      return invokeQuiet("quit_app", {}, { ok: true });
    },

    onState: function (callback) {
      return subscribe("state-changed", function (payload) {
        if (typeof callback === "function") {
          callback(payload);
        }
      });
    },
    onDownloadProgress: function (callback) {
      return subscribe("download-progress", function (payload) {
        if (typeof callback === "function") {
          callback(payload);
        }
      });
    },
    onToast: function (callback) {
      return subscribe("toast", function (payload) {
        if (typeof callback === "function") {
          callback(payload);
        }
      });
    },
  };

  if (!LIVE) {
    console.info(
      "[tauri-api] window.__TAURI__ 不可用，picker/settings 使用浏览器预览 mock 数据。"
    );
  }

  window.captureAPI = {
    start: function (presetSkillId) {
      return safeInvoke("start_capture", {
        presetSkillId: String(presetSkillId == null ? "" : presetSkillId),
      });
    },
    monitor: function (index) {
      return safeInvoke("capture_monitor_info", { index: Number(index) || 0 });
    },
    /* Called once the screenshot is painted: the shell only then shows the
     * overlay window (no black flash while the PNG loads). */
    ready: function (index) {
      return safeInvoke("capture_ready", { index: Number(index) || 0 });
    },
    copy: function (index, rect) {
      return safeInvoke("capture_copy", {
        index: Number(index) || 0,
        rect: rect || {},
      });
    },
    /* Runs a panel skill on the selected region: the shell copies the image to
     * the clipboard, closes the overlays and shows the result in the picker. */
    skill: function (requestId, index, rect, action, skillId, targetLang) {
      return safeInvoke("capture_skill", {
        requestId: String(requestId == null ? "" : requestId),
        index: Number(index) || 0,
        rect: rect || {},
        action: String(action == null ? "" : action),
        skillId: String(skillId == null ? "" : skillId),
        targetLang: String(targetLang == null ? "" : targetLang),
      });
    },
    retry: function (requestId, targetLang) {
      return safeInvoke("capture_retry", {
        requestId: String(requestId == null ? "" : requestId),
        targetLang: String(targetLang == null ? "" : targetLang),
      });
    },
    followup: function (requestId, question, previousAnswer, history) {
      return safeInvoke("capture_followup", {
        requestId: String(requestId == null ? "" : requestId),
        question: String(question == null ? "" : question),
        previousAnswer: String(previousAnswer == null ? "" : previousAnswer),
        history: Array.isArray(history) ? history : [],
      });
    },
    close: function () {
      return safeInvoke("capture_close", {});
    },
    /* Re-uses the hidden overlay windows: the shell arms them for a new capture
     * (they fetch the fresh screenshot themselves and report `ready`). */
    onArmed: function (callback) {
      return subscribe("capture-armed", function (payload) {
        if (typeof callback === "function") {
          callback(payload);
        }
      });
    },
  };

})();
