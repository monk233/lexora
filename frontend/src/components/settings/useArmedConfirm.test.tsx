import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { useArmedConfirm } from "./useArmedConfirm";

afterEach(() => {
  vi.useRealTimers();
});

test("arms for four seconds, confirms once, then disarms", () => {
  vi.useFakeTimers();
  const onConfirm = vi.fn();
  const { result } = renderHook(() => useArmedConfirm(onConfirm));

  act(() => result.current.arm());
  expect(result.current.armed).toBe(true);

  act(() => {
    vi.advanceTimersByTime(3999);
  });
  expect(result.current.armed).toBe(true);

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current.armed).toBe(false);
  expect(onConfirm).not.toHaveBeenCalled();

  act(() => result.current.arm());
  act(() => result.current.arm());
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(result.current.armed).toBe(false);
});

test("cancel disarms without confirming and clears the timer", () => {
  vi.useFakeTimers();
  const onConfirm = vi.fn();
  const { result } = renderHook(() => useArmedConfirm(onConfirm));

  act(() => result.current.arm());
  act(() => result.current.cancel());
  expect(result.current.armed).toBe(false);

  act(() => {
    vi.advanceTimersByTime(4000);
  });
  expect(onConfirm).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("unmount clears the pending timer", () => {
  vi.useFakeTimers();
  const onConfirm = vi.fn();
  const { result, unmount } = renderHook(() => useArmedConfirm(onConfirm));

  act(() => result.current.arm());
  unmount();

  expect(vi.getTimerCount()).toBe(0);
  expect(onConfirm).not.toHaveBeenCalled();
});
