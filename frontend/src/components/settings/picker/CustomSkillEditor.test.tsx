/* Custom skill editor (C38, C40–C44, assertions 29–30).
 *
 * The editor owns a local draft until Save; validation mirrors
 * `web/settings.js:3595-3643` (collapsed name, trimmed prompt, field errors).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  CustomSkillEditor,
  validateCustomSkill,
  type CustomSkillDraft,
} from "@/components/settings/picker/CustomSkillEditor";
import { I18nProvider } from "@/lib/i18n";

import { zh } from "@/test/settings-harness";

const DRAFT: CustomSkillDraft = {
  id: "custom-abc",
  label: "",
  icon: "sparkles",
  kind: "text",
  prompt: "",
};

function renderEditor(
  overrides: Partial<CustomSkillDraft> = {},
  options: {
    editing?: boolean;
    existingLabel?: string;
    onSave?: (draft: CustomSkillDraft) => void;
    onCancel?: () => void;
    onDelete?: () => void;
  } = {}
) {
  const onSave = options.onSave ?? vi.fn();
  const onCancel = options.onCancel ?? vi.fn();
  const onDelete = options.onDelete ?? vi.fn();
  const view = render(
    <I18nProvider initialLocale="zh">
      <CustomSkillEditor
        draft={{ ...DRAFT, ...overrides }}
        editing={options.editing ?? false}
        existingLabel={options.existingLabel}
        onSave={onSave}
        onCancel={onCancel}
        onDelete={onDelete}
      />
    </I18nProvider>
  );
  return { onSave, onCancel, onDelete, ...view };
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText(zh("settings.field.name")) as HTMLInputElement;
}

function promptInput(): HTMLTextAreaElement {
  return screen.getByLabelText(zh("settings.field.prompt")) as HTMLTextAreaElement;
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: zh("settings.action.save") });
}

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("focuses the name field and scrolls the editor into view on mount", () => {
  renderEditor();
  expect(nameInput()).toHaveFocus();
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
});

test("an empty name shows skillNameRequired, does not save and refocuses the name", () => {
  const { onSave } = renderEditor({ prompt: "Do it" });

  fireEvent.click(saveButton());

  expect(screen.getByText(zh("settings.error.skillNameRequired"))).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
  expect(nameInput()).toHaveFocus();
});

test("a 21-character name shows skillNameTooLong", () => {
  const { onSave } = renderEditor({ label: "x".repeat(21), prompt: "Do it" });

  fireEvent.click(saveButton());

  expect(screen.getByText(zh("settings.error.skillNameTooLong"))).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
});

test("an empty prompt uses the kind-specific required message", () => {
  const { onSave } = renderEditor({ label: "Name" });
  fireEvent.click(saveButton());
  expect(screen.getByText(zh("settings.error.promptRequiredText"))).toBeTruthy();
  expect(promptInput()).toHaveFocus();
  expect(onSave).not.toHaveBeenCalled();

  cleanup();
  renderEditor({ label: "Name", kind: "image" });
  fireEvent.click(saveButton());
  expect(screen.getByText(zh("settings.error.promptRequiredImage"))).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
});

test("a prompt longer than 4000 characters is rejected and the textarea is capped", () => {
  const { onSave } = renderEditor({ label: "Name", prompt: "y".repeat(4001) });

  expect(promptInput()).toHaveAttribute("maxLength", "4000");
  fireEvent.click(saveButton());

  expect(screen.getByText(zh("settings.error.promptTooLong"))).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
});

test("a valid draft saves trimmed values with the original id", () => {
  const { onSave } = renderEditor({
    label: "  My   skill  ",
    prompt: "  Summarize {text}  ",
  });

  fireEvent.click(saveButton());

  expect(onSave).toHaveBeenCalledWith({
    id: "custom-abc",
    label: "My skill",
    icon: "sparkles",
    kind: "text",
    prompt: "Summarize {text}",
  });
});

test("switching kind updates aria-pressed and the variable hint", () => {
  renderEditor();

  const editor = screen.getByTestId("custom-skill-editor");
  expect(editor.textContent).toContain("{text}");
  expect(
    screen.getByRole("button", { name: zh("settings.skillKind.textAria") })
  ).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(
    screen.getByRole("button", { name: zh("settings.skillKind.imageAria") })
  );

  expect(
    screen.getByRole("button", { name: zh("settings.skillKind.imageAria") })
  ).toHaveAttribute("aria-pressed", "true");
  expect(editor.textContent).not.toContain("{text}");
  expect(editor.textContent).toContain("{target}");
  expect(screen.getByText(zh("settings.hint.customKind.image"))).toBeTruthy();
});

test("Escape cancels and Ctrl/Cmd+Enter saves", () => {
  const { onSave, onCancel } = renderEditor({ label: "Name", prompt: "Do it" });

  fireEvent.keyDown(nameInput(), { key: "Enter", ctrlKey: true });
  expect(onSave).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(nameInput(), { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("Escape with the icon gallery open closes the gallery first", () => {
  const { onCancel } = renderEditor();

  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.changeIcon") }));
  expect(screen.getByRole("radiogroup")).toBeTruthy();

  fireEvent.keyDown(screen.getByPlaceholderText(zh("settings.placeholder.iconSearch")), {
    key: "Escape",
  });
  expect(screen.queryByRole("radiogroup")).toBeNull();
  expect(onCancel).not.toHaveBeenCalled();
});

test("editing shows an armed delete button", () => {
  const { onDelete } = renderEditor({ label: "Name", prompt: "Do it" }, { editing: true });

  const remove = screen.getByRole("button", { name: zh("settings.action.delete") });
  fireEvent.click(remove);
  expect(remove).toHaveTextContent(zh("settings.action.confirmDeleteAgain"));
  expect(onDelete).not.toHaveBeenCalled();

  fireEvent.click(remove);
  expect(onDelete).toHaveBeenCalledTimes(1);
});

test("the armed delete disarms after four seconds", () => {
  renderEditor({ label: "Name", prompt: "Do it" }, { editing: true });

  const remove = screen.getByRole("button", { name: zh("settings.action.delete") });
  fireEvent.click(remove);
  expect(remove).toHaveTextContent(zh("settings.action.confirmDeleteAgain"));

  act(() => {
    vi.advanceTimersByTime(4000);
  });
  expect(remove).toHaveTextContent(zh("settings.action.delete"));
});

test("the delete button is hidden for a new skill", () => {
  renderEditor();
  expect(
    screen.queryByRole("button", { name: zh("settings.action.delete") })
  ).toBeNull();
});

test("a duplicate name only shows a non-blocking hint", () => {
  const { onSave } = renderEditor(
    { label: "Same", prompt: "Do it" },
    { existingLabel: "Same" }
  );

  expect(screen.getByText(zh("settings.hint.skillNameDuplicate", { label: "Same" }))).toBeTruthy();
  fireEvent.click(saveButton());
  expect(onSave).toHaveBeenCalledTimes(1);
});

test("validateCustomSkill reports each field branch", () => {
  expect(validateCustomSkill({ ...DRAFT })).toEqual({
    label: "settings.error.skillNameRequired",
    prompt: "settings.error.promptRequiredText",
  });
  expect(
    validateCustomSkill({ ...DRAFT, label: "x".repeat(21), prompt: "Do it" })
  ).toEqual({ label: "settings.error.skillNameTooLong" });
  expect(validateCustomSkill({ ...DRAFT, label: "Name" })).toEqual({
    prompt: "settings.error.promptRequiredText",
  });
  expect(validateCustomSkill({ ...DRAFT, label: "Name", kind: "image" })).toEqual({
    prompt: "settings.error.promptRequiredImage",
  });
  expect(
    validateCustomSkill({ ...DRAFT, label: "Name", prompt: "x".repeat(4001) })
  ).toEqual({ prompt: "settings.error.promptTooLong" });
  expect(
    validateCustomSkill({
      ...DRAFT,
      label: "Name",
      kind: "image",
      prompt: "Describe {answer}",
    })
  ).toEqual({});
});
