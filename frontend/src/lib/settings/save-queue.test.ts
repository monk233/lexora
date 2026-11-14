import { beforeEach, expect, test, vi } from "vitest";
import { createSaveQueue } from "./save-queue";
import type { SaveResult, StatePayload } from "./types";

const state = { settings: {} } as unknown as StatePayload;
let statuses: string[];
let sends: unknown[];
let failures: string[];

beforeEach(() => {
  statuses = [];
  sends = [];
  failures = [];
  vi.useFakeTimers();
});

function makeQueue(impl?: (patch: unknown) => Promise<SaveResult>) {
  const send = vi.fn(async (patch: unknown) => {
    sends.push(patch);
    return impl ? impl(patch) : { ok: true, state };
  });
  const queue = createSaveQueue({
    send: send as never,
    onStatus: (status) => statuses.push(status.kind),
    onSaved: () => {},
    onFailure: (error) => {
      failures.push(error);
    },
  });
  return { queue, send };
}

test("deep-merges queued patches and sends them serially", async () => {
  const { queue, send } = makeQueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, state };
  });
  queue.enqueue({ provider: { online: { baseUrl: "https://a" } } });
  queue.enqueue({ provider: { online: { apiKey: "k" } } });
  expect(send).toHaveBeenCalledTimes(1);
  // Each mocked send waits 10ms, so the queued patch's own request needs its
  // timer advanced too before `flush()` (which drains the whole queue) settles.
  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(10);
  await queue.flush();
  expect(send.mock.calls[1]?.[0]).toEqual({ provider: { online: { apiKey: "k" } } });
  expect(statuses).toContain("saving");
});

test("goes saved then idle after 2.2s", async () => {
  const { queue } = makeQueue();
  queue.enqueue({ picker: { enabled: false } });
  await vi.runAllTicks();
  await queue.flush();
  expect(statuses).toEqual(["saving", "saved"]);
  await vi.advanceTimersByTimeAsync(2200);
  expect(statuses).toEqual(["saving", "saved", "idle"]);
});

test("reports failure, keeps flushing later patches and resolves ok:false", async () => {
  let call = 0;
  const { queue, send } = makeQueue(async () => {
    call += 1;
    return call === 1 ? { ok: false, error: "boom" } : { ok: true, state };
  });
  queue.enqueue({ picker: { enabled: false } });
  const result = await queue.flush();
  expect(result.ok).toBe(false);
  expect(failures).toEqual(["boom"]);
  expect(statuses).toContain("error");
  queue.enqueue({ picker: { compact: true } });
  await queue.flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect(statuses[statuses.length - 1]).toBe("saved");
});

test("flush never resolves ok when a save is pending failure", async () => {
  const { queue } = makeQueue(async () => ({ ok: false, error: "denied" }));
  queue.enqueue({ app: { closeToTray: false } });
  await expect(queue.flush()).resolves.toEqual({ ok: false, error: "denied" });
});

test("an idle flush after a failure resolves ok:true (legacy empty-queue rule)", async () => {
  let call = 0;
  const { queue } = makeQueue(async () => {
    call += 1;
    return call === 1 ? { ok: false, error: "boom" } : { ok: true, state };
  });
  queue.enqueue({ picker: { enabled: false } });
  await expect(queue.flush()).resolves.toEqual({ ok: false, error: "boom" });

  /* Nothing pending: the historical failure must not stick to this flush. */
  await expect(queue.flush()).resolves.toEqual({ ok: true });

  queue.enqueue({ picker: { compact: true } });
  await expect(queue.flush()).resolves.toEqual({ ok: true });
});

test("awaits an async onFailure rollback before draining the next patch", async () => {
  let releaseRollback!: () => void;
  let call = 0;
  const send = vi.fn(async (patch: unknown) => {
    sends.push(patch);
    call += 1;
    return call === 1
      ? ({ ok: false, error: "boom" } satisfies SaveResult)
      : ({ ok: true, state } satisfies SaveResult);
  });
  const queue = createSaveQueue({
    send: send as never,
    onStatus: () => {},
    onSaved: () => {},
    onFailure: (error) => {
      failures.push(error);
      return new Promise<void>((resolve) => {
        releaseRollback = resolve;
      });
    },
  });

  queue.enqueue({ picker: { enabled: false } });
  queue.enqueue({ picker: { compact: true } });
  let settled = false;
  const flushed = queue.flush().then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(send).toHaveBeenCalledTimes(1);
  expect(failures).toEqual(["boom"]);
  expect(settled).toBe(false);

  releaseRollback();
  await Promise.resolve();
  await Promise.resolve();

  expect(send).toHaveBeenCalledTimes(2);
  expect(sends[1]).toEqual({ picker: { compact: true } });
  await expect(flushed).resolves.toEqual({ ok: false, error: "boom" });
});

test("falls back to the i18n key path when a failure carries no message", async () => {
  const { queue } = makeQueue(async () => ({ ok: false }));
  queue.enqueue({ app: { startAtLogin: false } });
  await expect(queue.flush()).resolves.toEqual({
    ok: false,
    error: "settings.error.saveFailed",
  });
});

