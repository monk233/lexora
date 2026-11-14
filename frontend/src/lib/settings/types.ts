/* Settings window state and API types.
 *
 * Field names mirror the camelCase serialization of `src-tauri/src/settings.rs`
 * and the `StatePayload` contract (docs/contracts.md §5.4). These types are the
 * shared vocabulary for every card: the IPC wrapper (`api.ts`), the draft store
 * (`useSettingsForm.tsx`) and the card components all consume them.
 */

export type Locale = "zh" | "en";

export type SaveStatusKind = "idle" | "saving" | "saved" | "error";

export interface SaveStatus {
  kind: SaveStatusKind;
  /** Non-empty means "show this server text instead of the localized label". */
  message: string;
}

/** Settings fragment sent to `update_settings` (`{ patch }`). */
export type SettingsPatch = Record<string, unknown>;

/** Deferred inline copy: resolved with `t()` only when rendered, so a language
 * switch never replays a stale translation (inventory §3, legacy `inlineMessage`). */
export interface InlineMessage {
  key: string;
  params?: Record<string, string | number>;
}

export interface CustomSkill {
  id: string;
  label: string;
  icon: string;
  kind: "text" | "image";
  prompt: string;
}

export interface PromptSettings {
  wordLookup: string;
  translate: string;
  summarize: string;
  explain: string;
  polish: string;
}

export interface CapturePrompts {
  translate: string;
  wordLookup: string;
  explain: string;
}

export interface PickerSettings {
  enabled: boolean;
  skills: string[];
  compact: boolean;
  defaultTargetLang: string;
  blacklist: string[];
  maxChars: number;
  searchEngine: string;
  panelPinned: boolean;
  panelMode: "auto" | "scroll";
  captureSkills: string[];
  capturePrompts: CapturePrompts;
  prompts: PromptSettings;
  customSkills: CustomSkill[];
}

export interface OnlineSettings {
  preset: string;
  baseUrl: string;
  modelsBaseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
}

export interface LocalSettings {
  selectedModel: string;
  contextSize: number;
  threads: number;
  gpuLayers: number;
  autoStart: boolean;
  keepRunning: boolean;
}

export interface AppSettings {
  closeToTray: boolean;
  startAtLogin: boolean;
  theme: string;
  language: "system" | "zh" | "en";
}

export interface Settings {
  version: number;
  picker: PickerSettings;
  provider: {
    mode: "online" | "local";
    online: OnlineSettings;
    local: LocalSettings;
  };
  app: AppSettings;
  capture: { regionShortcut: string };
  quick: {
    enabled: boolean;
    hotkey: string;
    targetLang: string;
    sourceLang: string;
    prompt: string;
    wordLookupPrompt: string;
    pinned: boolean;
  };
}

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  packaged: boolean;
  portable: boolean;
  dataDir: string;
  modelsDir: string;
  logsDir: string;
  repoUrl: string;
  license: string;
  locale: Locale;
  languageSetting: string;
}

export interface EngineStatus {
  mode: string;
  ready: boolean;
  hint: string;
  providerLabel: string;
  onlineConfigured: boolean;
  localState: "stopped" | "starting" | "ready" | "error";
  localModelFile: string;
  localModelName: string;
  localError: string;
  engineAvailable: boolean;
}

export interface ModelInfo {
  file: string;
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  catalogId?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  filename: string;
  sizeBytes: number;
  license: string;
  languages: string;
  recommended: boolean;
  installed: boolean;
  vision: boolean;
}

export interface DownloadProgress {
  kind: "engine" | "model";
  id: string;
  filename: string;
  received: number;
  total: number;
  percent: number;
  status: "downloading" | "verifying" | "failed" | "cancelled";
  error: string;
}

export interface UpdateProgress {
  status: "downloading" | "ready";
  received: number;
  total: number;
  percent: number;
}

export interface HardwareRecommendation {
  totalMemoryBytes: number;
  cpuThreads: number;
  gpuVramBytes: number;
  gpuName: string;
  recommendedModelId: string;
  recommendedQuant: string;
  reason: string;
}

export interface LoginItemState {
  supported: boolean;
  enabled: boolean;
}

export interface StatePayload {
  app: AppInfo;
  settings: Settings;
  promptDefaults: Record<string, string>;
  engine: EngineStatus;
  models: ModelInfo[];
  catalog: CatalogEntry[];
  hardwareRecommendation: HardwareRecommendation;
  downloads: DownloadProgress[];
  picker: { visible: boolean; pinned: boolean };
  loginItem: LoginItemState;
}

/* ---- API envelope types (`api.ts`, `save-queue.ts`) ---------------------- */

export interface ApiResult {
  ok: boolean;
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

export interface GetStateResult {
  ok: boolean;
  state?: StatePayload;
  error?: string;
}

export interface SaveResult {
  ok: boolean;
  state?: StatePayload;
  error?: string;
}

export interface HotkeyResult {
  ok: boolean;
  shortcut?: string;
  error?: string;
  hint?: string;
}

export type DirKind = "data" | "models" | "logs" | "engine";

export interface UpdateCheckResult {
  ok: boolean;
  currentVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  assetName?: string;
  assetUrl?: string;
  notes?: string;
  publishedAt?: string;
  sizeBytes?: number;
  error?: string;
  hint?: string;
}

export type Unsubscribe = () => void;
