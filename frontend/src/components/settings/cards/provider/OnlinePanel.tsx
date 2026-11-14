/* Translation service card — online API panel (C05–C15).
 *
 * The panel keeps every draft in `useSettingsTextField` (500ms debounce, blur /
 * Enter flush, IME safe) so the fetch / test buttons read the *typed* values
 * rather than the last saved state. Fetched model lists live in an in-memory
 * cache keyed by `baseUrl\0apiKey`, never on disk (inventory D7), and are wiped
 * whenever the provider preset changes.
 *
 * Radix Select cannot use an empty item value: "no model" maps to `__none__`
 * and "custom model…" to `__custom__`, both translated back before writing
 * `provider.online.model` (plan "Radix Select 差异与映射").
 */
import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/settings/Field";
import { useSettingsForm, useSettingsTextField } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import { settingsApi } from "@/lib/settings/api";
import { formatMs } from "@/lib/settings/format";
import {
  PRESETS,
  presetFor,
  presetHintKey,
  presetLabelKey,
  presetPatch,
  validateBaseUrl,
} from "@/lib/settings/presets";
import type { OnlineModelList, SettingsApi } from "@/lib/settings/api";
import type { SettingsPatch } from "@/lib/settings/types";

export const MODEL_NONE = "__none__";
export const MODEL_CUSTOM = "__custom__";

export interface ModelOption {
  value: string;
  label: string;
}

/**
 * Options for the model select (legacy `onlineModelOptions`, settings.js:694):
 * `__none__` only when nothing is saved, the fetched list verbatim, the saved
 * value when it is missing from that list, and `__custom__` last.
 */
export function buildModelOptions(input: {
  models: string[];
  savedModel: string;
  customMode: boolean;
  labels: { none: string; current: (model: string) => string; custom: string };
}): ModelOption[] {
  const { models, savedModel, customMode, labels } = input;
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  if (!savedModel && !customMode) {
    options.push({ value: MODEL_NONE, label: labels.none });
  }
  for (const model of models) {
    if (seen.has(model)) continue;
    seen.add(model);
    options.push({ value: model, label: model });
  }
  if (!customMode && savedModel && !seen.has(savedModel)) {
    options.push({ value: savedModel, label: labels.current(savedModel) });
  }
  options.push({ value: MODEL_CUSTOM, label: labels.custom });
  return options;
}

/** Radix value → settings patch: `__none__` is the only sentinel written to the
 * backend, `__custom__` is handled by the UI branch before this runs. */
export function modelPatch(value: string): SettingsPatch {
  return { provider: { online: { model: value === MODEL_NONE ? "" : value } } };
}

/** Copy captured at command time; translated only when rendered (i18n safe). */
type Notice =
  | { type: "key"; key: string; params?: Record<string, string | number> }
  | { type: "text"; text: string };

interface ConnectionBadge {
  tone: BadgeTone;
  parts: Notice[];
}

function cleanModels(models: string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const model of models) {
    const text = typeof model === "string" ? model.trim() : "";
    if (text && !seen.has(text)) {
      seen.add(text);
      cleaned.push(text);
    }
  }
  return cleaned;
}

function cacheKeyFor(baseUrl: string, apiKey: string): string {
  return `${baseUrl}\u0000${apiKey}`;
}

/** The bridge result carries extra fields beyond `ApiResult`'s envelope. */
function readModels(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function OnlinePanel() {
  const form = useSettingsForm();
  const { t } = useT();
  const online = form.settings?.provider.online;

  const savedModel = online?.model ?? "";
  const baseUrlValue = online?.baseUrl ?? "";
  const apiKeyValue = online?.apiKey ?? "";
  const timeoutMs = online?.timeoutMs || 60000;
  const selectedPreset = presetFor(online?.preset ?? "")?.id ?? "custom";

  const [customMode, setCustomMode] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [modelCache, setModelCache] = useState<Record<string, string[]>>({});
  const [modelHint, setModelHint] = useState<Notice | null>(null);
  const [modelError, setModelError] = useState<Notice | null>(null);
  const [testError, setTestError] = useState<Notice | null>(null);
  const [testHint, setTestHint] = useState<Notice | null>(null);
  const [testBadge, setTestBadge] = useState<ConnectionBadge | null>(null);

  const customInputRef = useRef<HTMLInputElement | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);

  const baseUrlField = useSettingsTextField({
    id: "online-base-url",
    value: baseUrlValue,
    build: (value) => ({ provider: { online: { baseUrl: value.trim() } } }),
  });
  const apiKeyField = useSettingsTextField({
    id: "online-api-key",
    value: apiKeyValue,
    build: (value) => ({ provider: { online: { apiKey: value } } }),
  });
  const customField = useSettingsTextField({
    id: "online-model-custom",
    value: savedModel,
    build: (value) => ({
      provider: { online: { model: value.trim() || savedModel } },
    }),
  });

  /* Focusing after the popover closes: the item click flips `customMode`, and
   * this effect runs after Radix restored focus to the trigger. */
  useEffect(() => {
    if (!customMode) return;
    const input = customInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [customMode]);

  const models = modelCache[cacheKeyFor(baseUrlField.value.trim(), apiKeyField.value)] ?? [];
  const options = buildModelOptions({
    models,
    savedModel,
    customMode,
    labels: {
      none: t("settings.onlineModel.none"),
      current: (model) => t("settings.onlineModel.current", { model }),
      custom: t("settings.action.customModel"),
    },
  });
  const selectedModelValue = customMode ? MODEL_CUSTOM : savedModel || MODEL_NONE;
  const selectedModelLabel =
    options.find((option) => option.value === selectedModelValue)?.label ??
    t("settings.onlineModel.none");

  const noticeText = (notice: Notice): string =>
    notice.type === "key" ? t(notice.key, notice.params) : notice.text;

  const handlePresetChange = (value: string): void => {
    setCustomMode(false);
    setModelCache({});
    setModelHint(null);
    setModelError(null);
    setTestBadge(null);
    setTestError(null);
    setTestHint(null);
    form.save(presetPatch(value));
  };

  const handleModelChange = (value: string): void => {
    if (value === MODEL_CUSTOM) {
      setModelError(null);
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    setModelError(null);
    form.save(modelPatch(value));
  };

  const handleCustomBlur = (): void => {
    const trimmed = customField.value.trim();
    if (!trimmed || trimmed === savedModel.trim()) {
      /* Empty / unchanged custom name: leave custom mode without writing a
       * model value (the draft's build already falls back to the saved model). */
      setCustomMode(false);
      return;
    }
    customField.onBlur();
  };

  const handleReveal = (): void => {
    setRevealed((current) => !current);
    apiKeyInputRef.current?.focus();
  };

  const handleFetchModels = async (): Promise<void> => {
    if (fetching) return;
    const validation = validateBaseUrl(baseUrlField.value);
    if (!validation.ok) {
      setModelHint(null);
      setModelError({ type: "key", key: validation.key });
      return;
    }
    const apiKey = apiKeyField.value;
    const key = cacheKeyFor(validation.url, apiKey);
    setFetching(true);
    setModelHint(null);
    setModelError(null);
    const result: OnlineModelList = await settingsApi.listOnlineModels({
      baseUrl: validation.url,
      apiKey,
    });
    setFetching(false);
    if (result.ok) {
      const cleaned = cleanModels(result.models);
      setModelCache((previous) => ({ ...previous, [key]: cleaned }));
      setModelError(null);
      setModelHint(
        cleaned.length
          ? { type: "key", key: "settings.hint.modelsLoaded", params: { count: cleaned.length } }
          : { type: "key", key: "settings.hint.modelsEmpty" }
      );
      return;
    }
    setModelError(
      result.error
        ? { type: "text", text: result.error }
        : { type: "key", key: "settings.error.fetchModels" }
    );
    setModelHint(
      result.hint
        ? { type: "text", text: result.hint }
        : { type: "key", key: "settings.hint.fetchModelsFallback" }
    );
  };

  const handleTestConnection = async (): Promise<void> => {
    if (testing) return;
    const validation = validateBaseUrl(baseUrlField.value);
    if (!validation.ok) {
      setTestBadge(null);
      setTestError({ type: "key", key: validation.key });
      return;
    }
    const apiKey = apiKeyField.value;
    const model = customMode ? customField.value.trim() : savedModel;
    setTesting(true);
    setTestBadge(null);
    setTestError(null);
    setTestHint(null);
    const result: Awaited<ReturnType<SettingsApi["testOnline"]>> =
      await settingsApi.testOnline({
        baseUrl: validation.url,
        apiKey,
        model,
        timeoutMs,
      });
    setTesting(false);
    if (result.ok) {
      const latencyMs = typeof result.latencyMs === "number" ? result.latencyMs : 0;
      const returned = cleanModels(readModels(result.models));
      const parts: Notice[] = [
        { type: "key", key: "settings.status.connected" },
        { type: "text", text: formatMs(latencyMs) },
      ];
      if (returned.length) {
        parts.push({
          type: "key",
          key: "settings.hint.modelsAvailable",
          params: { count: returned.length },
        });
        setModelCache((previous) => ({
          ...previous,
          [cacheKeyFor(validation.url, apiKey)]: returned,
        }));
        setModelError(null);
        setModelHint({
          type: "key",
          key: "settings.hint.modelsLoaded",
          params: { count: returned.length },
        });
        if (model && !returned.includes(model)) {
          setTestError({
            type: "key",
            key: "settings.error.modelMissing",
            params: { model },
          });
        }
      }
      setTestBadge({ tone: "ok", parts });
      return;
    }
    setTestBadge({
      tone: "error",
      parts: [{ type: "key", key: "settings.badge.connectionFailed" }],
    });
    setTestError(
      result.error
        ? { type: "text", text: result.error }
        : { type: "key", key: "settings.error.testConnection" }
    );
    setTestHint(result.hint ? { type: "text", text: result.hint } : null);
  };

  return (
    <div data-testid="provider-online-panel" className="flex flex-col">
      <Field
        label={t("settings.field.providerPreset")}
        htmlFor="online-preset"
        hint={t(presetHintKey(selectedPreset))}
      >
        <Select value={selectedPreset} onValueChange={handlePresetChange}>
          <SelectTrigger
            id="online-preset"
            aria-label={t("settings.field.providerPreset")}
          >
            <SelectValue>{t(presetLabelKey(selectedPreset))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {t(presetLabelKey(preset.id))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label={t("settings.field.baseUrl")}
        htmlFor="online-base-url"
        hint={t("settings.hint.baseUrl")}
      >
        <Input
          id="online-base-url"
          type="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://api.example.com/v1"
          {...baseUrlField}
        />
      </Field>

      <Field
        label={t("settings.field.apiKey")}
        htmlFor="online-api-key"
        hint={t("settings.hint.apiKey")}
      >
        <div className="flex items-center gap-2">
          <Input
            id="online-api-key"
            ref={apiKeyInputRef}
            type={revealed ? "text" : "password"}
            spellCheck={false}
            autoComplete="off"
            placeholder="sk-..."
            {...apiKeyField}
          />
          <Button
            type="button"
            id="api-key-toggle"
            variant="ghost"
            size="icon"
            aria-pressed={revealed}
            aria-label={t(revealed ? "settings.apiKey.hide" : "settings.apiKey.show")}
            title={t(revealed ? "settings.apiKey.hide" : "settings.apiKey.show")}
            onClick={handleReveal}
          >
            {revealed ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </Field>

      <Field
        label={t("settings.field.modelName")}
        htmlFor="online-model"
        hint={t("settings.hint.modelName")}
      >
        <div className="flex items-center gap-2">
          <Select value={selectedModelValue} onValueChange={handleModelChange}>
            <SelectTrigger
              id="online-model"
              className="flex-1"
              aria-label={t("settings.field.modelName")}
            >
              <SelectValue placeholder={t("settings.onlineModel.none")}>
                {selectedModelLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            id="fetch-online-models"
            variant="outline"
            disabled={fetching}
            onClick={() => {
              void handleFetchModels();
            }}
          >
            {fetching ? t("settings.status.fetching") : t("settings.action.fetchModels")}
          </Button>
        </div>

        {customMode ? (
          <Input
            {...customField}
            ref={customInputRef}
            id="online-model-custom"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="deepseek-chat"
            aria-label={t("settings.field.customModelName")}
            onBlur={handleCustomBlur}
          />
        ) : null}

        {modelHint ? (
          <p data-testid="online-model-hint" className="text-xs text-muted-foreground">
            {noticeText(modelHint)}
          </p>
        ) : null}
        {modelError ? (
          <p
            data-testid="online-model-error"
            role="alert"
            className="text-xs font-medium text-destructive"
          >
            {noticeText(modelError)}
          </p>
        ) : null}
      </Field>

      <Field label={t("settings.field.connection")} hint={t("settings.hint.connection")}>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            id="test-connection"
            disabled={testing}
            onClick={() => {
              void handleTestConnection();
            }}
          >
            {testing ? t("settings.status.testing") : t("settings.action.testConnection")}
          </Button>
          {testBadge ? (
            <Badge
              data-testid="test-badge"
              data-tone={testBadge.tone}
              tone={testBadge.tone}
            >
              {testBadge.parts.map((part) => noticeText(part)).join(" · ")}
            </Badge>
          ) : null}
        </div>
        {testError ? (
          <p data-testid="test-error" role="alert" className="text-xs font-medium text-destructive">
            {noticeText(testError)}
          </p>
        ) : null}
        {testHint ? (
          <p data-testid="test-hint" className="text-xs text-muted-foreground">
            {noticeText(testHint)}
          </p>
        ) : null}
      </Field>
    </div>
  );
}
