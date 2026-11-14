/* Provider presets (C05) and base-URL validation (C06/C11/C13). */
import { expect, test } from "vitest";

import {
  PRESETS,
  presetFor,
  presetHintKey,
  presetLabelKey,
  presetPatch,
  validateBaseUrl,
} from "./presets";

test("exposes the eight provider presets with legacy base urls", () => {
  expect(PRESETS.map((preset) => preset.id)).toEqual([
    "deepseek",
    "openai",
    "moonshot",
    "zhipu",
    "opencode-go",
    "ollama",
    "lmstudio",
    "custom",
  ]);
  expect(presetFor("deepseek")?.baseUrl).toBe("https://api.deepseek.com/v1");
  expect(presetFor("openai")?.baseUrl).toBe("https://api.openai.com/v1");
  expect(presetFor("moonshot")?.baseUrl).toBe("https://api.moonshot.cn/v1");
  expect(presetFor("zhipu")?.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
  expect(presetFor("opencode-go")?.baseUrl).toBe(
    "https://opencode.ai/inference/go/openai/v1"
  );
  expect(presetFor("opencode-go")?.modelsBaseUrl).toBe(
    "https://opencode.ai/inference/go/v1"
  );
  expect(presetFor("ollama")?.baseUrl).toBe("http://127.0.0.1:11434/v1");
  expect(presetFor("lmstudio")?.baseUrl).toBe("http://127.0.0.1:1234/v1");
  expect(presetFor("custom")?.baseUrl).toBe("");
  expect(presetFor("unknown")).toBeUndefined();
});

test("only the local presets skip the api key", () => {
  expect(PRESETS.filter((preset) => !preset.needsKey).map((preset) => preset.id)).toEqual([
    "ollama",
    "lmstudio",
  ]);
});

test("maps preset ids onto their i18n keys", () => {
  expect(presetLabelKey("zhipu")).toBe("settings.preset.zhipu.label");
  expect(presetHintKey("opencode-go")).toBe("settings.preset.opencode-go.hint");
});

test("switching presets clears key and model and never prefills a model", () => {
  expect(presetPatch("openai")).toEqual({
    provider: {
      online: {
        preset: "openai",
        baseUrl: "https://api.openai.com/v1",
        modelsBaseUrl: "",
        apiKey: "",
        model: "",
      },
    },
  });
  expect(presetPatch("opencode-go")).toEqual({
    provider: {
      online: {
        preset: "opencode-go",
        baseUrl: "https://opencode.ai/inference/go/openai/v1",
        modelsBaseUrl: "https://opencode.ai/inference/go/v1",
        apiKey: "",
        model: "",
      },
    },
  });
  expect(presetPatch("nope")).toEqual({
    provider: {
      online: { preset: "custom", baseUrl: "", modelsBaseUrl: "", apiKey: "", model: "" },
    },
  });
});

test("validates the base url before any network command", () => {
  expect(validateBaseUrl("  ")).toEqual({
    ok: false,
    key: "settings.error.baseUrlRequired",
  });
  expect(validateBaseUrl("ftp://x")).toEqual({
    ok: false,
    key: "settings.error.baseUrlScheme",
  });
  expect(validateBaseUrl(" https://api.x/v1 ")).toEqual({
    ok: true,
    url: "https://api.x/v1",
  });
});
