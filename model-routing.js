import { getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { CONNECT_API_MAP } from '../../../slash-commands.js';
import { getChatCompletionModel, model_list, proxies, settingsToUpdate } from '../../../openai.js';

// Only connection fields are borrowed. Prompts, post-processing, tools, regex,
// sampling and the selected writing preset remain owned by the current chat.
const CONNECTION_FIELDS = new Set([
    ...Object.entries(settingsToUpdate).filter(([key, value]) => value[3]
        && !['group_models', 'sort_models', 'custom_prompt_post_processing'].includes(key)).map(([, value]) => value[1]),
    'reverse_proxy', 'proxy_password', 'vertexai_auth_mode', 'vertexai_region',
    'vertexai_express_project_id', 'azure_base_url', 'azure_deployment_name', 'azure_api_version',
]);
const CATALOG_SOURCES = new Set(['openai', 'openrouter', 'custom', 'mistralai', 'cohere', 'groq',
    'chutes', 'electronhub', 'nanogpt', 'deepseek', 'aimlapi', 'xai', 'moonshot', 'fireworks',
    'siliconflow', 'minimax', 'workers_ai', 'pollinations', 'azure_openai', 'zai']);

function modelField(source) {
    return source === 'makersuite' ? 'google_model' : `${source}_model`;
}

function profileSource(profile) {
    const mapped = CONNECT_API_MAP[String(profile.api ?? '').toLowerCase()];
    return mapped?.selected === 'openai' ? mapped.source : null;
}

function catalogKey(target) {
    const s = target.settings;
    return JSON.stringify([s.chat_completion_source, s.custom_url, s.reverse_proxy,
        s.vertexai_region, s.azure_base_url, s.azure_deployment_name, target.secretId,
        s.siliconflow_endpoint, s.minimax_endpoint, s.workers_ai_account_id,
        s.zai_endpoint, s.pollinations_endpoint]);
}

export function createModelRouting() {
    let active;
    const catalogs = new Map();
    const profiles = () => getContext().extensionSettings.connectionManager?.profiles ?? [];
    const baseline = () => active?.before ?? getContext().chatCompletionSettings;

    function targetFor(selection) {
        const base = baseline();
        const settings = structuredClone(base);
        const profile = selection.profileId ? profiles().find(p => p.id === selection.profileId) : null;
        if (selection.profileId && !profile) throw new Error('所选 API 配置已删除，请重新选择');
        let secretId;
        if (profile) {
            const source = profileSource(profile);
            if (!source || profile.mode !== 'cc') throw new Error('重写模型选择目前支持聊天补全 API 配置');
            const excluded = new Set(profile.exclude ?? []);
            let preset;
            if (profile.preset && !excluded.has('preset')) {
                preset = getPresetManager('openai')?.getCompletionPresetByName(profile.preset);
                if (!preset) throw new Error('该 API 配置引用的预设已删除，请先更新连接配置');
                for (const field of CONNECTION_FIELDS) {
                    if (Object.hasOwn(preset, field)) settings[field] = structuredClone(preset[field]);
                }
            }
            settings.chat_completion_source = source;
            if (profile['api-url'] && !excluded.has('api-url')) {
                const urlFields = { custom: 'custom_url', vertexai: 'vertexai_region', zai: 'zai_endpoint',
                    siliconflow: 'siliconflow_endpoint', minimax: 'minimax_endpoint', pollinations: 'pollinations_endpoint' };
                if (urlFields[source]) settings[urlFields[source]] = profile['api-url'];
            }
            if (source === 'custom' && settings.custom_url !== base.custom_url) {
                // Do not forward another endpoint's authorization headers or body
                // overrides when the saved profile has no matching transport data.
                for (const field of ['custom_include_headers', 'custom_include_body', 'custom_exclude_body']) {
                    settings[field] = preset?.[field] ?? '';
                }
            }
            if (profile.proxy && !excluded.has('proxy')) {
                const proxy = proxies.find(p => p.name === profile.proxy);
                if (!proxy) throw new Error('该 API 配置引用的代理配置已删除');
                settings.reverse_proxy = proxy.url ?? '';
                settings.proxy_password = proxy.password ?? '';
            }
            if (!excluded.has('secret-id')) secretId = profile['secret-id'] || undefined;
            if (profile.model && !excluded.has('model')) settings[modelField(source)] = profile.model;
        }
        const source = settings.chat_completion_source;
        const field = modelField(source);
        if (!Object.hasOwn(base, field)) throw new Error('当前酒馆尚不支持此渠道的模型选择');
        if (selection.model?.trim()) settings[field] = selection.model.trim();
        const model = getChatCompletionModel(settings) || '';
        return { settings, secretId, model, profile, source, label: profile?.name || '当前 API' };
    }

    function suggestions(target) {
        const found = new Map();
        const add = (id, label = id) => {
            if (typeof id === 'string' && id.trim()) found.set(id.trim(), { id: id.trim(), label: String(label || id) });
        };
        add(target.model);
        const base = baseline();
        const sameSource = base.chat_completion_source === target.source;
        const sameCustom = target.source !== 'custom' || (base.custom_url === target.settings.custom_url
            && (!target.secretId || getContext().extensionSettings.connectionManager?.selectedProfile === target.profile?.id));
        if (target.source !== 'custom' || (sameSource && sameCustom)) {
            const selector = settingsToUpdate[modelField(target.source)]?.[0];
            const control = selector ? document.querySelector(selector) : null;
            const options = control instanceof HTMLSelectElement ? control.options : control?.list?.options;
            for (const option of options ?? []) add(option.value, option.label);
            if (target.source === 'custom') {
                for (const option of document.querySelectorAll('#model_custom_select option')) add(option.value, option.label);
            }
            if (sameSource && sameCustom && !active) {
                for (const model of model_list ?? []) add(model.id, model.name || model.id);
            }
        }
        for (const profile of profiles()) {
            if (profileSource(profile) !== target.source) continue;
            if (target.source === 'custom' && (profile['api-url'] !== target.settings.custom_url
                || (profile['secret-id'] || undefined) !== target.secretId)) continue;
            add(profile.model);
        }
        for (const model of catalogs.get(catalogKey(target)) ?? []) add(model.id, model.label);
        return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
    }

    function mainModelControl(source) {
        const selector = settingsToUpdate[modelField(source)]?.[0];
        const control = selector ? document.querySelector(selector) : null;
        return control instanceof HTMLSelectElement || control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control : null;
    }

    function describe(selection) {
        const available = profiles().filter(p => p.mode === 'cc' && profileSource(p))
            .map(p => ({ id: p.id, name: p.name || p.api, api: p.api }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const mainProfiles = profiles()
            .map(p => ({ id: p.id, name: p.name || p.api, api: p.api }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const ctx = getContext();
        const base = baseline();
        const mainProfileId = ctx.extensionSettings.connectionManager?.selectedProfile || '';
        const mainSource = ctx.mainApi === 'openai' ? (base?.chat_completion_source || '') : (ctx.mainApi || '');
        const mainModel = ctx.mainApi === 'openai' ? (getChatCompletionModel(base) || '') : '';
        const mainCanProfile = document.getElementById('connection_profiles') instanceof HTMLSelectElement;
        const mainCanModel = ctx.mainApi === 'openai' && Boolean(mainModelControl(mainSource));
        const mainCanFetch = ctx.mainApi === 'openai' && CATALOG_SOURCES.has(mainSource);
        let mainModels = [];
        if (ctx.mainApi === 'openai') {
            try { mainModels = suggestions(targetFor({ profileId: '', model: '' })); } catch {}
        }
        try {
            const target = targetFor(selection);
            return { profiles: available, models: suggestions(target), source: target.source,
                label: target.label, model: target.model,
                mainProfiles, mainProfileId, mainSource, mainModel, mainModels,
                mainCanProfile, mainCanModel, mainCanFetch,
                supported: ctx.mainApi === 'openai',
                canFetch: CATALOG_SOURCES.has(target.source), error: '' };
        } catch (error) {
            return { profiles: available, models: [], error: error.message, supported: false,
                label: '', model: '',
                mainProfiles, mainProfileId, mainSource, mainModel, mainModels,
                mainCanProfile, mainCanModel, mainCanFetch };
        }
    }

    function setMainProfile(profileId) {
        const select = document.getElementById('connection_profiles');
        if (!(select instanceof HTMLSelectElement)) return false;
        if (![...select.options].some(o => o.value === profileId)) return false;
        if (select.value === profileId) return true;
        select.value = profileId;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function setMainModel(model) {
        const next = String(model ?? '').trim();
        const ctx = getContext();
        if (ctx.mainApi !== 'openai' || !next) return false;
        const source = ctx.chatCompletionSettings?.chat_completion_source;
        const control = mainModelControl(source);
        if (!control) return false;
        if (control instanceof HTMLSelectElement) {
            if (![...control.options].some(o => o.value === next)) control.add(new Option(next, next));
            control.value = next;
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        control.value = next;
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        const customSelect = source === 'custom' ? document.getElementById('model_custom_select') : null;
        if (customSelect instanceof HTMLSelectElement && [...customSelect.options].some(o => o.value === next)) {
            customSelect.value = next;
        }
        return true;
    }

    async function refreshModels(selection, signal) {
        const target = targetFor(selection);
        if (!CATALOG_SOURCES.has(target.source)) return suggestions(target);
        const s = target.settings;
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST', headers: getContext().getRequestHeaders(), signal,
            body: JSON.stringify({ chat_completion_source: target.source, secret_id: target.secretId,
                reverse_proxy: s.reverse_proxy, proxy_password: s.proxy_password,
                custom_url: s.custom_url, custom_include_headers: getContext().substituteParams(s.custom_include_headers || ''),
                azure_base_url: s.azure_base_url, azure_deployment_name: s.azure_deployment_name,
                azure_api_version: s.azure_api_version, siliconflow_endpoint: s.siliconflow_endpoint,
                minimax_endpoint: s.minimax_endpoint, pollinations_endpoint: s.pollinations_endpoint,
                zai_endpoint: s.zai_endpoint, workers_ai_account_id: s.workers_ai_account_id }),
        });
        if (!response.ok) throw new Error(`读取模型列表失败（HTTP ${response.status}）`);
        const data = await response.json();
        if (data.error || !Array.isArray(data.data)) throw new Error('渠道未提供模型列表，可手动填写准确型号');
        const models = data.data.filter(m => typeof m.id === 'string').map(m => ({ id: m.id, label: m.name || m.id }));
        catalogs.set(catalogKey(target), models);
        return suggestions(target);
    }

    function acquire(selection, acceptsRequest) {
        if (!selection.profileId && !selection.model?.trim()) return { release() {}, label: '当前 API / 当前模型' };
        if (getContext().mainApi !== 'openai') throw new Error('选择重写模型需要使用聊天补全 API');
        if (active) throw new Error('上一轮模型切换尚未结束');
        const target = targetFor(selection);
        if (!target.model) throw new Error('请为所选 API 配置填写模型型号');
        const ctx = getContext();
        const live = ctx.chatCompletionSettings;
        const before = structuredClone(live);
        const applied = new Map();
        for (const field of CONNECTION_FIELDS) {
            if (!Object.hasOwn(target.settings, field)) continue;
            const value = target.settings[field];
            if (JSON.stringify(value) !== JSON.stringify(live[field])) {
                live[field] = structuredClone(value);
                applied.set(field, structuredClone(value));
            }
        }
        const event = ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
        const injectSecret = data => {
            if (acceptsRequest() && data.chat_completion_source === target.source && target.secretId) data.secret_id = target.secretId;
        };
        if (event) ctx.eventSource.on(event, injectSecret);
        active = { before };
        let released = false;
        return { label: `${target.label} / ${target.model}`, release() {
            if (released) return;
            released = true;
            if (event) ctx.eventSource.removeListener(event, injectSecret);
            // Preserve fields explicitly changed by the user while generation ran.
            for (const [field, value] of applied) {
                if (JSON.stringify(live[field]) !== JSON.stringify(value)) continue;
                if (Object.hasOwn(before, field)) live[field] = before[field];
                else delete live[field];
            }
            active = null;
            // Also repair any normal settings autosave that happened mid-generation.
            getContext().saveSettingsDebounced();
        } };
    }

    return { describe, refreshModels, acquire, setMainProfile, setMainModel };
}
