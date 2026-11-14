/* Formatting helpers shared by the provider card (C13 latency badge). */
import { expect, test } from "vitest";

import { formatBytes, formatMs } from "./format";

test("formats bytes and latency like the legacy helpers", () => {
  expect(formatBytes(0)).toBe("—");
  expect(formatBytes(-1)).toBe("—");
  expect(formatBytes(Number.NaN)).toBe("—");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
  expect(formatMs(1234.6)).toBe("1235 ms");
  expect(formatMs(0)).toBe("0 ms");
});
