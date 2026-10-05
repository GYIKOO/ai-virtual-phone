import { kvGet, kvSet } from "./kv-db";
import { loadCharacters, saveCharacters } from "./character-storage";
import { hydrateChatStorage, addChatContact, createOrGetSession, clearChatSessionMessages, saveChatSessions, loadChatSessions } from "./chat-storage";
import { ensureSettingsStorageHydrated, loadApiConfigs, saveApiConfigs, loadPresets, savePresetsAsync, loadBindingConfig, saveBindingConfig } from "./settings-storage";

export const TEST_CHARACTER_ID = "float-local-fixture-character-v1";
const API_ID = "float-local-fixture-ollama-v1";
const PRESET_ID = "float-local-fixture-preset-v1";
const RUN_KEY = "float_local_fixture_run_v1";
let initializing: Promise<void> | undefined;

/** Never seed production, remote hosts, or ordinary development sessions. */
export function prepareLocalTestFixtures(): Promise<void> {
    if (process.env.NODE_ENV !== "development" || process.env.NEXT_PUBLIC_LOCAL_TEST_FIXTURES !== "true"
        || process.env.NEXT_PUBLIC_SELF_HOSTED_MODE !== "true" || typeof window === "undefined"
        || !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) return Promise.resolve();
    initializing ??= seed().catch(error => { initializing = undefined; throw error; });
    return initializing;
}

async function seed(): Promise<void> {
    await Promise.all([hydrateChatStorage(), ensureSettingsStorageHydrated()]);
    const run = process.env.NEXT_PUBLIC_LOCAL_TEST_RUN;
    if (!run || kvGet(RUN_KEY) === run) return;
    const now = Date.now();
    const apis = loadApiConfigs();
    saveApiConfigs([...apis.filter(api => api.id !== API_ID), {
        id: API_ID, name: "本地功能测试 · Ollama", provider: "Custom", apiKey: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1", defaultModel: process.env.NEXT_PUBLIC_LOCAL_TEST_MODEL || "qwen2.5:1.5b",
        enableNativeTools: false, enableImageRecognition: false, enableImageGeneration: false,
    }]);
    const presets = loadPresets();
    const builtin = presets.find(preset => preset.builtIn);
    if (!builtin) throw new Error("测试预设初始化失败：未找到内置预设");
    await savePresetsAsync([...presets.filter(preset => preset.id !== PRESET_ID), {
        ...builtin, id: PRESET_ID, name: "本地功能测试 · 短回复", builtIn: false, createdAt: now, updatedAt: now,
        openai_max_tokens: 512, enabled_generation_parameters: ["temperature", "max_tokens"], temperature: 0.7,
    }]);
    const characters = loadCharacters();
    saveCharacters([...characters.filter(character => character.id !== TEST_CHARACTER_ID), {
        id: TEST_CHARACTER_ID, name: "林舟（功能测试）", avatar: null,
        persona: "林舟是一个普通的图书管理员，喜欢散步和观察植物，有自己的工作和日常安排。与用户是普通朋友，不默认恋爱或亲密关系。这是一张功能测试卡；自然简短地交流即可，不需要复杂文风。",
        personality: "温和、独立，愿意分享见闻，也尊重彼此的时间。", tags: ["本地功能测试"],
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    }]);
    const bindings = loadBindingConfig();
    bindings.characterBindings = [...bindings.characterBindings.filter(binding => binding.characterId !== TEST_CHARACTER_ID), {
        characterId: TEST_CHARACTER_ID, defaults: { apiConfigId: API_ID, presetId: PRESET_ID, worldBookIds: [], regexIds: [] }, appOverrides: {},
    }];
    // Bind only the owned test character. Existing default/paid API choices stay untouched.
    saveBindingConfig(bindings);
    addChatContact(TEST_CHARACTER_ID);
    const session = createOrGetSession(TEST_CHARACTER_ID);
    clearChatSessionMessages(session.id);
    saveChatSessions(loadChatSessions().map(item => item.id === session.id
        ? { ...item, autoReplied: true, bilingualTranslationEnabled: false, offlineSummaryRetry: false } : item));
    kvSet(RUN_KEY, run);
}
