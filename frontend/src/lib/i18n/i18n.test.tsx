import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ReactNode } from "react";
import { I18nProvider, applyStaticToDom, normalizeLocale, translate, useT } from "./index";
import type { Locale } from "./index";

function wrapper(initialLocale: Locale) {
  return ({ children }: { children: ReactNode }) => (
    <I18nProvider initialLocale={initialLocale}>{children}</I18nProvider>
  );
}

test("normalizeLocale maps prefixes and falls back to en", () => {
  expect(normalizeLocale("zh-CN")).toBe("zh");
  expect(normalizeLocale("en-US")).toBe("en");
  expect(normalizeLocale("ja")).toBe("en");
});

test("translate falls back to en then to the key", () => {
  expect(translate("en", "common.ok")).toBe("OK");
  expect(translate("zh", "missing.key")).toBe("missing.key");
  // Prototype members must not leak through either lookup.
  expect(translate("en", "constructor")).toBe("constructor");
  expect(translate("en", "toString")).toBe("toString");
  expect(translate("en", "__proto__")).toBe("__proto__");
});

test("translate interpolates params and keeps unknown placeholders", () => {
  expect(translate("en", "capture.colorWithValue", { color: "#fff" })).toBe("Color #fff");
  expect(translate("en", "capture.colorWithValue", {})).toBe("Color {color}");
});

test("applyStaticToDom translates data-i18n nodes", () => {
  const root = document.createElement("div");
  root.innerHTML = '<span data-i18n="common.ok"></span>';
  applyStaticToDom(root, (key) => translate("zh", key));
  expect(root.querySelector("span")?.textContent).toBe("确定");
});

test("useT switches locale on setLocale", () => {
  const { result } = renderHook(() => useT(), { wrapper: wrapper("zh") });
  expect(result.current.locale).toBe("zh");
  act(() => result.current.setLocale("en"));
  expect(result.current.locale).toBe("en");
  // Unsupported input is ignored, not coerced (legacy setLocale parity).
  act(() => result.current.setLocale("ja" as unknown as Locale));
  expect(result.current.locale).toBe("en");
});
