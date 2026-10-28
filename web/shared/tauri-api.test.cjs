const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function checkSettingsMerge(withSharedHelpers) {
  const window = {
    location: { search: "" },
    setTimeout: (callback) => setTimeout(callback, 0),
    clearTimeout,
    setInterval: (callback) => setInterval(callback, 0),
    clearInterval,
  };
  const context = vm.createContext({ window, console });
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context);
  if (withSharedHelpers) load("constants.js");
  load("tauri-api.js");
  const api = window.settingsAPI;
  let result = await api.getState();
  assert.equal(result.ok, true);
  assert.equal(result.state.settings.version, 7);
  assert.ok(result.state.promptDefaults.translate.includes("dictionary assistant"));
  assert.equal(Object.hasOwn(result.state.promptDefaults, "wordLookup"), false);
  assert.equal(Object.hasOwn(result.state.settings.picker, "wordLookupMode"), false);
  result = await api.updateSettings({ picker: { prompts: { translate: "  custom override  " } } });
  assert.equal(result.state.settings.picker.prompts.translate, "custom override");
  assert.equal(result.state.settings.picker.prompts.summarize, "");
  assert.equal(result.state.settings.provider.local.selectedModel, "");
  assert.equal(Object.hasOwn(result.state.settings, "local"), false);
  result = await api.startLocal();
  assert.equal(result.ok, false);
  assert.equal(result.error, "尚未选择本地模型。");
  assert.equal(result.hint, "请手动选择并完整下载 Qwen3.5 后启动。");
  assert.equal((await api.getState()).state.engine.localState, "stopped");
  result = await api.getState();
  assert.equal((await api.restartLocal()).ok, false, "Restart requires a selected model");
  const legacy = result.state.models.find((model) => model.file === "Hy-MT2-1.8B-Q4_K_M.gguf");
  assert.ok(legacy);
  assert.equal(legacy.catalogId, "");
  assert.equal((await api.removeModel(legacy.file)).ok, true, "Legacy models can be deleted");
  assert.equal((await api.removeModel("missing.gguf")).ok, false);
  await api.importModel();
  const imported = (await api.getState()).state.models.find((model) => model.catalogId === "");
  assert.ok(imported);
  assert.equal((await api.removeModel(imported.file)).ok, true);
  result = await api.getState();
  assert.equal(result.state.models.some((model) => model.file === imported.file), false);
  assert.equal(result.state.catalog.length, 6);
  assert.equal(result.state.catalog.some((entry) => entry.id === "hy-mt2-1.8b"), false);
  const original = JSON.parse(JSON.stringify(result.state.settings.provider));
  const ids = result.state.catalog.filter((entry) => entry.vision).map((entry) => entry.id);
  assert.equal(ids.length, 6);
  assert.ok(ids.every((id) => /^qwen3\.5-(?:0\.8b|2b|4b)-q[34]-k-m$/.test(id)));
  assert.ok(ids.includes(result.state.hardwareRecommendation.recommendedModelId));
  for (const id of ids) {
    result = await api.updateSettings({ provider: { local: { selectedModel: id } } });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.state.settings.provider)), {
      ...original, local: { ...original.local, selectedModel: id },
    });
    result = await api.getState();
    assert.equal(result.state.settings.provider.local.selectedModel, id);
  }
  result = await api.startLocal();
  assert.equal(result.ok, false, "An uninstalled selection must not start");
  assert.equal((await api.restartLocal()).ok, false, "Restart requires an installed selection");
  const selectedId = ids[ids.length - 1];
  result = await api.downloadModel(selectedId);
  assert.equal(result.ok, true);
  result = await api.startLocal();
  assert.equal(result.ok, true);
  result = await api.getState();
  assert.equal(result.state.engine.localState, "ready");
  assert.equal(result.state.engine.localModelFile,
    result.state.catalog.find((entry) => entry.id === selectedId).filename);
  assert.equal(result.state.settings.provider.local.selectedModel, selectedId);
  assert.equal((await api.removeModel(result.state.engine.localModelFile)).ok, false);
  assert.equal((await api.restartLocal()).ok, true);
  assert.equal((await api.getState()).state.engine.localState, "ready");
  await api.updateSettings({ provider: { local: { selectedModel: "" } } });
  assert.equal((await api.restartLocal()).ok, false, "Restart revalidates the latest selection even while ready");
  assert.equal((await api.getState()).state.engine.localState, "stopped");
  await api.stopLocal();
  await api.updateSettings({ provider: { local: { selectedModel: "hy-mt2-1.8b" } } });
  assert.equal((await api.startLocal()).ok, false, "Removed legacy models cannot be selected for startup");
  await api.updateSettings({ provider: { local: { selectedModel: selectedId } } });
  // Other settings updates must preserve the manual selection and sibling fields.
  result = await api.updateSettings({ provider: { online: { model: "another-model" } } });
  assert.equal(result.state.settings.provider.local.selectedModel, ids[ids.length - 1]);
  assert.equal(result.state.settings.provider.mode, original.mode);
  assert.equal(result.state.settings.provider.online.baseUrl, original.online.baseUrl);
  result = await api.updateSettings({ provider: { local: { threads: 3 } } });
  assert.equal(result.state.settings.provider.local.selectedModel, ids[ids.length - 1]);
  assert.equal(result.state.settings.provider.local.contextSize, original.local.contextSize);
  assert.equal(result.state.settings.provider.local.threads, 3);
  assert.equal(Object.hasOwn(result.state.settings, "local"), false);
}

(async () => {
  await checkSettingsMerge(false);
  await checkSettingsMerge(true);
  console.log("PASS: startup requires an installed Qwen3.5 selection; both merge paths preserve manual selection and sibling settings");
})().catch((error) => { console.error(error); process.exitCode = 1; });
