/* Picker bridge: surface dispatch, subscriptions and the one-shot ready call. */
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { usePickerBridge } from "@/hooks/usePickerBridge";
import { PickerWindow } from "@/windows/PickerWindow";
import { createFakePickerApi, renderPicker } from "@/test/picker-harness";

afterEach(() => {
  vi.restoreAllMocks();
});

function BridgeProbe({ api }: { api: ReturnType<typeof createFakePickerApi> }) {
  const bridge = usePickerBridge({ api });
  return (
    <div>
      <span data-testid="surface-value">{bridge.surface}</span>
      <span data-testid="payload-text">{bridge.payload?.text ?? ""}</span>
      <span data-testid="image-action">{bridge.image?.action ?? ""}</span>
      <span data-testid="hidden">{String(bridge.hidden)}</span>
    </div>
  );
}

describe("usePickerBridge", () => {
  test("defaults to the panel surface and calls ready exactly once", async () => {
    const api = createFakePickerApi();
    renderPicker(<BridgeProbe api={api} />);

    expect(screen.getByTestId("surface-value").textContent).toBe("panel");
    expect(screen.getByTestId("hidden").textContent).toBe("true");
    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "ready")).toHaveLength(1)
    );
  });

  test("stores the picker payload and clears it when hidden", async () => {
    const api = createFakePickerApi();
    renderPicker(<BridgeProbe api={api} />);

    api.emitData({ text: "hello world", config: { compact: false } });
    await waitFor(() =>
      expect(screen.getByTestId("payload-text").textContent).toBe("hello world")
    );
    expect(screen.getByTestId("hidden").textContent).toBe("false");

    api.emitHidden();
    await waitFor(() => expect(screen.getByTestId("hidden").textContent).toBe("true"));
    expect(screen.getByTestId("payload-text").textContent).toBe("");
  });

  test("image payloads arrive as a separate channel", async () => {
    const api = createFakePickerApi();
    renderPicker(<BridgeProbe api={api} />);

    api.emitImage({ requestId: "capture-1", action: "ocr", label: "提取文字" });
    await waitFor(() =>
      expect(screen.getByTestId("image-action").textContent).toBe("ocr")
    );
    expect(screen.getByTestId("hidden").textContent).toBe("false");
  });
});

describe("PickerWindow", () => {
  test("renders the toolbar surface when asked", () => {
    renderPicker(<PickerWindow surface="toolbar" api={createFakePickerApi()} />);
    expect(screen.getByTestId("surface").getAttribute("data-surface")).toBe("toolbar");
  });

  test("renders the panel surface by default", () => {
    renderPicker(<PickerWindow api={createFakePickerApi()} />);
    expect(screen.getByTestId("surface").getAttribute("data-surface")).toBe("panel");
  });
});
