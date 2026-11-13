import * as core from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { SWIPE_STATE } from '../../../constants.js';
import { hasPendingFileAttachment } from '../../../chats.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';

const KEY = 'rewrite_writer';
const RUNTIME = Symbol.for('st.auto-rewrite.standalone');
const DEFAULT_FEEDBACK = '上一版的剧情推进和角色行为逻辑不够合理。请根据人物设定、已有关系和当前处境，重新写上一条回复，不要接着初稿续写。重点修正动机与因果、突兀转折和不合理的角色行为。保持当前预设要求的正文、小总结及其他输出格式，只输出完整重写结果。';
let installed = false;
let panel;
let cycle;
let pending;
let running;
let timer;
let sequence = 0;
let status = '等待下一次生成';
const subscriptions = [];

function settings() {
    const all = getContext().extensionSettings;
    if (!all[KEY] || typeof all[KEY] !== 'object') all[KEY] = {};
    if (typeof all[KEY].auto !== 'boolean') all[KEY].auto = false;
    if (typeof all[KEY].feedback !== 'string') all[KEY].feedback = DEFAULT_FEEDBACK;
    return all[KEY];
}

function chatKey(ctx = getContext()) {
    return `${ctx.groupId ?? ''}|${ctx.characterId ?? ''}|${ctx.getCurrentChatId() ?? ''}`;
}

function isSingleChat(ctx) {
    return !ctx.groupId && ctx.characterId != null;
}

function composerBusy() {
    return Boolean(document.getElementById('send_textarea')?.value.trim()) || hasPendingFileAttachment();
}

function isIdle(ctx = getContext()) {
    // A finished stream can still be saving or emitting message events. Wait until
    // core releases it entirely; no private finalization flag or core patch is needed.
    return !core.is_send_press && !core.isChatSaving && !ctx.streamingProcessor
        && (core.swipeState == null || core.swipeState === SWIPE_STATE.NONE)
        && !document.querySelector('.mes_edit_textarea');
}

function setStatus(text) {
    status = text;
    const node = panel?.querySelector('[data-status]');
    if (node) node.textContent = text;
}

function clearPending() {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
}

function matches(attempt, ctx = getContext()) {
    const last = ctx.chat.at(-1);
    return chatKey(ctx) === attempt.key && isSingleChat(ctx)
        && last === attempt.message && !last.is_user && !last.is_system
        && ctx.chat.length - 1 === attempt.index
        && (last.swipe_id ?? 0) === attempt.swipeId && last.mes === attempt.text;
}

function subscribe(type, handler) {
    if (!type) return;
    const ctx = getContext();
    ctx.eventSource.on(type, handler);
    subscriptions.push([type, handler]);
}

function queue() {
    clearTimeout(timer);
    if (!installed || !settings().auto || !pending || running) return;
    timer = setTimeout(() => {
        timer = undefined;
        if (!installed || !settings().auto || !pending || running) return;
        const attempt = pending;
        const ctx = getContext();
        if (!cycle || cycle.id !== attempt.cycleId || cycle.attempted || !matches(attempt, ctx)) {
            clearPending();
            setStatus('聊天或回复已变化，已取消本次自动重写');
            return;
        }
        if (!isIdle(ctx)) { setStatus('等待首轮生成和保存完成'); queue(); return; }
        if (composerBusy()) { setStatus('输入框有草稿或附件，暂缓自动重写'); queue(); return; }
        cycle.attempted = true;
        clearPending();
        void rewrite(attempt);
    }, 150);
}

function sameJob(job) {
    return installed && running === job && !job.cancelled && chatKey() === job.key;
}

function appendFeedback(ctx, text) {
    // An ordinary, persistent user message. Do not rearrange history, inspect
    // preset-specific tags, inject prompts, or change the original assistant turn.
    const message = {
        name: ctx.name1,
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: ctx.substituteParams(getRegexedString(text, regex_placement.USER_INPUT)),
        extra: {},
    };
    if (!message.mes.trim()) throw new Error('修改意见被用户输入正则清空');
    const avatar = core.user_avatar;
    if (avatar && Object.hasOwn(ctx.powerUserSettings?.personas ?? {}, avatar)) {
        message.force_avatar = ctx.getThumbnailUrl('persona', avatar);
    }
    const index = ctx.chat.length;
    ctx.chat.push(message);
    if (ctx.chatMetadata) ctx.chatMetadata.tainted = true;
    ctx.addOneMessage(message);
    return { message, index };
}

async function rewrite(attempt) {
    const ctx = getContext();
    const feedback = settings().feedback.trim();
    if (!feedback) { setStatus('请先填写修改意见'); return; }
    if (!matches(attempt, ctx) || !isIdle(ctx) || composerBusy()) return;
    const job = { key: attempt.key, cancelled: false, generating: false };
    running = job;
    setStatus('正在发送修改意见');
    try {
        const { message, index } = appendFeedback(ctx, feedback);
        job.feedback = message;
        await ctx.saveChat();
        if (!sameJob(job) || getContext().chat.at(-1) !== message) return;
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_SENT, index);
        if (!sameJob(job) || getContext().chat.at(-1) !== message) return;
        await ctx.eventSource.emit(ctx.eventTypes.USER_MESSAGE_RENDERED, index);
        if (!sameJob(job) || getContext().chat.at(-1) !== message) return;
        if (composerBusy()) {
            setStatus('修改意见已保留；输入框有新草稿，未自动开始生成');
            return;
        }
        // Standard generation, exactly as replying to the newly added user turn.
        // This guard remains set through all native tool-call continuation requests.
        job.generating = true;
        setStatus('正在自动重写');
        await getContext().generate('normal', { automatic_trigger: true });
        if (!sameJob(job)) return;
        const last = getContext().chat.at(-1);
        setStatus(last && !last.is_user && !last.is_system && last.mes?.trim() && last.mes.trim() !== '...'
            ? '自动重写已完成' : '未收到重写正文，原稿和修改意见已保留');
    } catch (error) {
        if (!job.cancelled && installed && chatKey() === job.key) {
            const text = job.feedback ? '自动重写未完成，原稿和修改意见已保留' : '自动重写未启动，原稿保持不变';
            setStatus(text);
            console.error('[Auto Rewrite]', error);
            globalThis.toastr?.warning(text);
        }
    } finally {
        if (running === job) running = null;
    }
}

function installSettings() {
    if (panel) return;
    const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!target) return;
    panel = document.createElement('div');
    panel.className = 'extension_container auto-rewrite-settings';
    panel.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>自动重写 · 独立版</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content"><div class="auto-rewrite-body">
            <label class="checkbox_label"><input type="checkbox" data-auto><span>生成结束后自动重写一次</span></label>
            <label for="auto-rewrite-feedback">修改意见</label>
            <textarea id="auto-rewrite-feedback" class="text_pole" rows="5" spellcheck="false"></textarea>
            <p class="auto-rewrite-note">原稿 → 修改意见（用户消息）→ 新回复。沿用当前连接和预设，三条消息都会保留。</p>
            <p class="auto-rewrite-status" data-status role="status"></p>
        </div></div></div>`;
    target.append(panel);
    const auto = panel.querySelector('[data-auto]');
    const feedback = panel.querySelector('textarea');
    auto.checked = settings().auto;
    feedback.value = settings().feedback;
    auto.addEventListener('change', () => {
        settings().auto = auto.checked;
        getContext().saveSettingsDebounced();
        if (!auto.checked) { clearPending(); setStatus(running ? '当前重写继续进行，后续自动重写已关闭' : '自动重写已关闭'); }
        else setStatus('等待下一次生成');
    });
    feedback.addEventListener('input', () => {
        settings().feedback = feedback.value;
        getContext().saveSettingsDebounced();
    });
    setStatus(status);
}

function syncSettings() {
    installSettings();
    if (!panel) return;
    panel.querySelector('[data-auto]').checked = settings().auto;
    panel.querySelector('textarea').value = settings().feedback;
}

export function enable() {
    if (installed) return;
    globalThis[RUNTIME]?.disable?.();
    installed = true;
    globalThis[RUNTIME] = { disable };
    const { eventTypes: events } = getContext();
    installSettings();
    subscribe(events.APP_READY, syncSettings);
    subscribe(events.SETTINGS_LOADED, syncSettings);
    subscribe(events.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun) return;
        if (running) {
            // Another extension started a request while feedback events were firing.
            if (!running.generating) { running.cancelled = true; setStatus('已由其他生成流程接管'); }
            return;
        }
        clearPending();
        cycle = { id: ++sequence, key: chatKey(), attempted: false,
            eligible: [undefined, 'normal', 'regenerate', 'swipe'].includes(type) && isSingleChat(getContext()) };
    });
    subscribe(events.MESSAGE_RECEIVED, (id, type) => {
        if (running || !settings().auto || !cycle?.eligible || cycle.attempted || type === 'first_message') return;
        const ctx = getContext();
        const stream = ctx.streamingProcessor;
        if (stream?.isStopped || stream?.abortController?.signal.aborted) return;
        const message = ctx.chat.at(-1);
        const text = message?.mes;
        if (chatKey(ctx) !== cycle.key || Number(id) !== ctx.chat.length - 1 || !message
            || message.is_user || message.is_system || !text?.trim() || text.trim() === '...') return;
        pending = { cycleId: cycle.id, key: cycle.key, index: Number(id), message, text, swipeId: message.swipe_id ?? 0 };
        queue();
    });
    subscribe(events.GENERATION_ENDED, queue);
    subscribe(events.GENERATION_STOPPED, () => {
        clearPending(); cycle = null;
        if (running) running.cancelled = true;
        setStatus('已停止自动重写，已有聊天记录保留');
    });
    for (const type of [events.CHAT_CHANGED, events.MAIN_API_CHANGED, events.OAI_PRESET_CHANGED_BEFORE,
        events.CONNECTION_PROFILE_LOADED]) subscribe(type, () => {
        clearPending(); cycle = null;
        if (running) running.cancelled = true;
        setStatus('上下文已切换，等待下一次生成');
    });
}

export function disable() {
    installed = false;
    clearPending(); cycle = null;
    const job = running;
    if (job) {
        job.cancelled = true;
        if (job.generating) getContext().stopGeneration();
    }
    const ctx = getContext();
    for (const [type, handler] of subscriptions.splice(0)) ctx.eventSource.removeListener(type, handler);
    panel?.remove(); panel = null;
}

jQuery(enable);
