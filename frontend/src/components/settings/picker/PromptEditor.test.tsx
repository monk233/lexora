/* Inline prompt editor (C36, assertion 25, inventory risk 1).
 *
 * The editor is a controlled textarea backed by `useSettingsTextField`: the
 * local draft is the single source of truth, composition pauses flushing and a
 * value equal to the bundled default normalizes to the empty override.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { PromptEditor } from "@/components/settings/picker/PromptEditor";
import { SettingsFormProvider } from "@/hooks/useSettingsForm";
import { I18nProvider } from "@/lib/i18n";
import { createFakeSettingsApi, makeState } from "@/test/settings-harness";

async function renderEditor(ui: ReactElement) {
  const api = createFakeSettingsApi(makeState());
  const view = render(
    <SettingsFormProvider api={api}>
      <I18nProvider initialLocale="zh">{ui}</I18nProvider>
    </SettingsFormProvider>
  );
  await act(async () => {});
  return { api, ...view };
}

function advance(ms: number): Promise<void> {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

test("prefills the default, debounces 500ms and normalizes to an empty override", async () => {
  vi.useFakeTimers();
  const onSave = vi.fn();
  const { api } = await renderEditor(
    <PromptEditor
      id="p1"
      title="翻译提示词"
      value=""
      defaultPrompt="Translate {target}"
      onSave={onSave}
      onReset={() => {}}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /编辑提示词|翻译提示词/ }));
  const area = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(area.value).toBe("Translate {target}");

  fireEvent.change(area, { target: { value: "  Translate {target}  " } });
  await advance(500);
  expect(onSave).toHaveBeenCalledWith("");
  /* The mock persists nothing, so the store must not send an empty patch. */
  expect(api.calls.filter((call) => call.method === "updateSettings")).toHaveLength(0);

  fireEvent.change(area, { target: { value: "自定义" } });
  fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
  expect(onSave).toHaveBeenLastCalledWith("自定义");
  await act(async () => {});
});

test("reset writes an empty override", async () => {
  const onReset = vi.fn();
  await renderEditor(
    <PromptEditor id="p2" title="t" value="x" defaultPrompt="d" onSave={() => {}} onReset={onReset} />
  );

  fireEvent.click(screen.getByRole("button", { name: /编辑提示词/ }));
  fireEvent.click(screen.getByRole("button", { name: /重置/ }));
  expect(onReset).toHaveBeenCalledTimes(1);
});

test("composition never flushes, and compositionend reschedules the debounce", async () => {
  vi.useFakeTimers();
  const onSave = vi.fn();
  await renderEditor(
    <PromptEditor
      id="p3"
      title="t"
      value=""
      defaultPrompt="default"
      onSave={onSave}
      onReset={() => {}}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /编辑提示词/ }));
  const area = screen.getByRole("textbox");

  fireEvent.compositionStart(area);
  fireEvent.change(area, { target: { value: "中" } });
  await advance(1000);
  expect(onSave).not.toHaveBeenCalled();

  fireEvent.compositionEnd(area);
  await advance(499);
  expect(onSave).not.toHaveBeenCalled();
  await advance(1);
  expect(onSave).toHaveBeenCalledWith("中");
});

test("the textarea is bounded and never spell-checked", async () => {
  await renderEditor(
    <PromptEditor id="p4" title="t" value="x" defaultPrompt="d" onSave={() => {}} onReset={() => {}} />
  );
  fireEvent.click(screen.getByRole("button", { name: /编辑提示词/ }));
  const area = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(area.getAttribute("maxlength")).toBe("4000");
  expect(area.getAttribute("spellcheck")).toBe("false");
  expect(area.rows).toBe(6);
});
