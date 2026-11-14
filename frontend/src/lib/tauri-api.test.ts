import { beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

test("exposes the three service objects even without tauri", async () => {
  const api = await import("./tauri-api.js");
  expect(typeof api.pickerAPI.translate).toBe("function");
  expect(typeof api.settingsAPI.getState).toBe("function");
  expect(typeof api.quickAPI.translate).toBe("function");
});

test("invoke failures resolve to an ok:false object instead of rejecting", async () => {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke: vi.fn().mockRejectedValue("boom") },
    event: { listen: vi.fn().mockResolvedValue(() => {}) },
  };
  const api = await import("./tauri-api.js");
  const result = await api.pickerAPI.status();
  expect(result.ok).toBe(false);
});
