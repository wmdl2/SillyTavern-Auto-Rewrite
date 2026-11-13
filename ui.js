function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

function syncSelect(select, entries, value) {
    const signature = JSON.stringify(entries);
    if (select.dataset.entries !== signature) {
        select.replaceChildren(...entries.map(([id, label]) => new Option(label, id)));
        select.dataset.entries = signature;
    }
    select.value = value;
}

function syncModelPicker({ pickerWrap, picker, list, models, value, allowEmpty, disabled }) {
    const emptyLabel = allowEmpty ? '沿用默认模型（不单独指定）' : '从列表选择模型…';
    const entries = [['', emptyLabel], ...models.map(m => [m.id, m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id])];
    const signature = JSON.stringify(entries);
    if (picker.dataset.entries !== signature) {
        picker.replaceChildren(...entries.map(([id, label], idx) => {
            const opt = new Option(label, id);
            if (idx === 0 && !allowEmpty) opt.disabled = true;
            return opt;
        }));
        picker.dataset.entries = signature;
    }
    if (list.dataset.entries !== signature) {
        list.replaceChildren(...models.map(m => new Option(m.label || m.id, m.id)));
        list.dataset.entries = signature;
    }
    picker.value = models.some(m => m.id === value) ? value : '';
    picker.disabled = disabled || models.length === 0;
    pickerWrap.hidden = models.length === 0;
}

export function createRewriteUI({ getSettings, getView, getRouting, onRoute, onRefreshModels, onMainProfile, onMainModel, onRefreshMainModels, onAuto, onFeedback, onRewrite, onJump, onMutation }) {
    let panel, bar, footer, nativePager, pagerSlot, dialog, observer, frame, poll, clock, shown;
    let dock, dockViewport, dockObserver, dockPadding;
    let disposed = false;
    const forms = new Set();
    const requests = new Map();
    let formSequence = 0;
    const refresh = () => {
        if (disposed || frame) return;
        frame = requestAnimationFrame(() => { frame = null; render(); });
    };
    const abortForm = (root, role) => {
        const prefix = `${root.dataset.formId}:${role ? `${role}` : ''}`;
        for (const [key, req] of requests) {
            if (key.startsWith(prefix)) { req.abort(); requests.delete(key); }
        }
    };
    const triggerRefresh = async (root, role, msgKey, fetcher) => {
        const key = `${root.dataset.formId}:${role}`;
        requests.get(key)?.abort();
        const request = new AbortController();
        const timeout = setTimeout(() => request.abort(), 20000);
        requests.set(key, request);
        root.dataset[msgKey] = '正在读取模型列表…'; sync();
        try {
            const models = await fetcher(request.signal);
            if (requests.get(key) === request) root.dataset[msgKey] = `已获取 ${models.length} 个可选型号，也可手动输入`;
        } catch (error) {
            if (requests.get(key) === request) root.dataset[msgKey] = request.signal.aborted
                ? '读取已取消或超时，可以手动填写型号' : error.message;
        } finally {
            clearTimeout(timeout);
            if (requests.get(key) === request) requests.delete(key);
            sync();
        }
    };
    const controls = () => {
        const root = document.createElement('div');
        root.className = 'auto-rewrite-controls';
        const seq = ++formSequence;
        root.dataset.formId = String(seq);
        const mainListId = `auto-rewrite-main-models-${seq}`;
        const rewriteListId = `auto-rewrite-models-${seq}`;
        root.innerHTML = `<label class="auto-rewrite-setting-toggle"><span><b>自动重写一次</b><small>首轮结束后，按修改意见再写一版</small></span><input type="checkbox" data-auto></label>
            <section class="auto-rewrite-model-card" aria-label="模型与 API 设置">
                <div class="auto-rewrite-model-heading"><span class="auto-rewrite-model-icon"><i class="fa-solid fa-layer-group" aria-hidden="true"></i></span><div><b>API 与模型</b><small>可直接切换主 API，也能为第二轮重写单独指定模型</small></div></div>
                <div class="auto-rewrite-route-group" data-group="main">
                    <div class="auto-rewrite-route-title"><span class="auto-rewrite-role-tag">首轮 · 主 API</span><small>全局生效，影响正常聊天</small><span class="auto-rewrite-model-badge" data-main-source></span></div>
                    <div class="auto-rewrite-route-fields">
                        <div class="auto-rewrite-label"><span>API 配置</span><div class="auto-rewrite-select-wrap"><select class="auto-rewrite-select" data-main-profile aria-label="主 API 连接配置"></select><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></div></div>
                        <div class="auto-rewrite-label"><span>模型型号</span><div class="auto-rewrite-combo"><input type="text" list="${mainListId}" autocomplete="off" spellcheck="false" data-main-model aria-label="主 API 模型型号"><span class="auto-rewrite-picker" data-main-picker-wrap title="从列表选择主模型"><select data-main-model-picker aria-label="从列表选择主 API 模型"></select><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></span><button type="button" class="auto-rewrite-combo-btn" data-refresh-main title="读取主 API 的模型列表" aria-label="刷新主 API 模型列表"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button></div></div>
                    </div>
                    <datalist id="${mainListId}" data-main-models></datalist>
                    <p class="auto-rewrite-model-hint" data-main-hint hidden></p>
                </div>
                <div class="auto-rewrite-route-group" data-group="rewrite">
                    <div class="auto-rewrite-route-title"><span class="auto-rewrite-role-tag is-accent">二轮 · 重写</span><small>仅重写借用，写完自动恢复</small><span class="auto-rewrite-model-badge is-accent" data-source></span></div>
                    <div class="auto-rewrite-route-fields">
                        <div class="auto-rewrite-label"><span>API 配置</span><div class="auto-rewrite-select-wrap"><select class="auto-rewrite-select" data-profile aria-label="重写使用的 API 配置"></select><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></div></div>
                        <div class="auto-rewrite-label"><span>模型型号</span><div class="auto-rewrite-combo"><input type="text" list="${rewriteListId}" autocomplete="off" spellcheck="false" data-model aria-label="重写模型型号"><span class="auto-rewrite-picker" data-picker-wrap title="从列表选择重写模型"><select data-model-picker aria-label="从列表选择重写模型"></select><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></span><button type="button" class="auto-rewrite-combo-btn" data-refresh-models title="读取重写 API 的模型列表" aria-label="刷新重写模型列表"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button></div></div>
                    </div>
                    <datalist id="${rewriteListId}" data-models></datalist>
                    <p class="auto-rewrite-model-hint" data-model-hint></p>
                </div>
                <div class="auto-rewrite-model-summary"><i class="fa-solid fa-arrow-turn-up" aria-hidden="true"></i><span data-route-summary></span></div>
            </section>
            <label class="auto-rewrite-label">修改意见<textarea class="text_pole" rows="4" spellcheck="false" data-feedback></textarea></label>
            <p class="auto-rewrite-note">沿用当前写作预设。重写结束后恢复首轮连接，原稿保留为上一版。</p>
            <p class="auto-rewrite-status" data-status role="status"></p>`;
        root.querySelector('[data-auto]').addEventListener('change', event => { onAuto(event.target.checked); sync(); refresh(); });
        root.querySelector('[data-feedback]').addEventListener('input', event => { onFeedback(event.target.value); sync(); });

        const mainModelInput = root.querySelector('[data-main-model]');
        const commitMainModel = value => {
            const next = String(value ?? '').trim();
            if (!next || next === getRouting().mainModel) return;
            onMainModel(next);
        };
        root.querySelector('[data-main-profile]').addEventListener('change', event => {
            abortForm(root, 'main');
            delete root.dataset.mainModelsMessage;
            onMainProfile(event.target.value);
        });
        mainModelInput.addEventListener('change', () => commitMainModel(mainModelInput.value));
        mainModelInput.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commitMainModel(mainModelInput.value);
        });
        root.querySelector('[data-main-model-picker]').addEventListener('change', event => {
            const val = event.target.value;
            if (!val) return;
            mainModelInput.value = val;
            commitMainModel(val);
        });
        root.querySelector('[data-refresh-main]').addEventListener('click', () => triggerRefresh(root, 'main', 'mainModelsMessage', onRefreshMainModels));

        const rewriteModelInput = root.querySelector('[data-model]');
        root.querySelector('[data-profile]').addEventListener('change', event => {
            abortForm(root, 'rewrite');
            delete root.dataset.modelsMessage;
            onRoute({ profileId: event.target.value, model: '' }); sync(); refresh();
        });
        rewriteModelInput.addEventListener('input', event => {
            onRoute({ model: event.target.value }); sync();
        });
        root.querySelector('[data-model-picker]').addEventListener('change', event => {
            const val = event.target.value;
            rewriteModelInput.value = val;
            onRoute({ model: val }); sync();
        });
        root.querySelector('[data-refresh-models]').addEventListener('click', () => triggerRefresh(root, 'rewrite', 'modelsMessage', onRefreshModels));
        forms.add(root);
        return root;
    };
    const sync = () => {
        const settings = getSettings();
        const route = getRouting();
        const busy = getView().busy;
        for (const root of forms) {
            const seq = root.dataset.formId;
            root.querySelector('[data-auto]').checked = settings.auto;
            const field = root.querySelector('[data-feedback]');
            if (document.activeElement !== field) field.value = settings.feedback;

            // Main API group
            const mainProfile = root.querySelector('[data-main-profile]');
            const mainEntries = [['', '当前手动连接（未选配置）'], ...route.mainProfiles.map(p => [p.id, `${p.name} · ${p.api}`])];
            if (route.mainProfileId && !mainEntries.some(([id]) => id === route.mainProfileId)) mainEntries.push([route.mainProfileId, '当前配置']);
            syncSelect(mainProfile, mainEntries, route.mainProfileId);
            mainProfile.disabled = busy || !route.mainCanProfile;

            const mainModel = root.querySelector('[data-main-model]');
            if (document.activeElement !== mainModel) mainModel.value = route.mainModel;
            mainModel.placeholder = route.supported ? '选择或输入主模型名称' : '仅聊天补全 API 支持切换主模型';
            mainModel.disabled = busy || !route.mainCanModel;
            syncModelPicker({
                pickerWrap: root.querySelector('[data-main-picker-wrap]'),
                picker: root.querySelector('[data-main-model-picker]'),
                list: root.querySelector('[data-main-models]'),
                models: route.mainModels,
                value: route.mainModel,
                allowEmpty: false,
                disabled: busy || !route.mainCanModel,
            });
            root.querySelector('[data-main-source]').textContent = route.mainSource || '未选择';
            const mainRefreshBtn = root.querySelector('[data-refresh-main]');
            const mainLoading = requests.has(`${seq}:main`);
            mainRefreshBtn.disabled = busy || !route.mainCanFetch || mainLoading;
            mainRefreshBtn.classList.toggle('is-loading', mainLoading);
            mainRefreshBtn.querySelector('i').classList.toggle('fa-spin', mainLoading);
            const mainHint = root.querySelector('[data-main-hint]');
            const mainHintText = root.dataset.mainModelsMessage || (!route.mainCanProfile ? '未检测到连接管理扩展，请直接填写模型或前往酒馆 API 面板调整。' : '');
            mainHint.hidden = !mainHintText;
            mainHint.textContent = mainHintText;

            // Rewrite group
            const profile = root.querySelector('[data-profile]');
            const entries = [['', '沿用当前 API'], ...route.profiles.map(p => [p.id, `${p.name} · ${p.api}`])];
            if (settings.profileId && !entries.some(([id]) => id === settings.profileId)) entries.push([settings.profileId, '配置已删除 · 请重新选择']);
            syncSelect(profile, entries, settings.profileId);
            profile.disabled = busy;

            const model = root.querySelector('[data-model]');
            if (document.activeElement !== model) model.value = settings.model;
            model.placeholder = route.model ? `默认：${route.model}` : '沿用默认型号，或输入模型名称';
            model.disabled = busy || !route.supported;
            syncModelPicker({
                pickerWrap: root.querySelector('[data-picker-wrap]'),
                picker: root.querySelector('[data-model-picker]'),
                list: root.querySelector('[data-models]'),
                models: route.models,
                value: settings.model,
                allowEmpty: true,
                disabled: busy || !route.supported,
            });
            root.querySelector('[data-source]').textContent = route.source || '未选择';
            const rewriteRefreshBtn = root.querySelector('[data-refresh-models]');
            const rewriteLoading = requests.has(`${seq}:rewrite`);
            rewriteRefreshBtn.disabled = busy || !route.supported || rewriteLoading;
            rewriteRefreshBtn.classList.toggle('is-loading', rewriteLoading);
            rewriteRefreshBtn.querySelector('i').classList.toggle('fa-spin', rewriteLoading);
            root.querySelector('[data-model-hint]').textContent = route.error || (!route.supported
                ? '模型选择支持聊天补全 API；未指定时仍沿用当前连接。'
                : root.dataset.modelsMessage || (route.canFetch ? '可点击下拉箭头选型号或手动输入，右侧可刷新模型列表。' : '可点击下拉箭头选择已有型号，也可手动输入准确名称。'));
            const mainText = route.mainModel
                ? `${route.mainModel}${route.mainSource ? ` (${route.mainSource})` : ''}`
                : (route.mainSource || '未选择');
            const rewriteText = route.error || `${route.label} · ${route.model || '默认模型'}`;
            root.querySelector('[data-route-summary]').textContent = `主 API：${mainText}  →  重写：${rewriteText}`;
        }
        if (bar) bar.querySelector('[data-auto]').checked = settings.auto;
    };
    const openSettings = () => {
        if (dialog) { dialog.focus(); return; }
        dialog = document.createElement('dialog');
        dialog.className = 'auto-rewrite-dialog';
        const heading = document.createElement('div');
        heading.className = 'auto-rewrite-dialog-heading';
        heading.innerHTML = '<div><small>REWRITE</small><h3>正文重写</h3></div><button type="button" class="auto-rewrite-icon-button" aria-label="关闭设置"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>';
        const form = controls();
        const activeDialog = dialog;
        heading.querySelector('button').addEventListener('click', () => dialog?.close());
        dialog.append(heading, form);
        dialog.addEventListener('close', () => { abortForm(form); forms.delete(form); activeDialog.remove(); if (dialog === activeDialog) dialog = null; });
        document.body.append(dialog);
        sync();
        dialog.showModal();
    };
    const makeBar = () => {
        const root = document.createElement('div');
        root.className = 'auto-rewrite-actions';
        root.innerHTML = `<div class="auto-rewrite-main"><button type="button" class="auto-rewrite-primary" data-rewrite><i class="fa-solid fa-pen-nib" aria-hidden="true"></i><span>重写</span></button>
            <button type="button" class="auto-rewrite-secondary" data-jump><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>查看原稿</span></button>
            <div class="auto-rewrite-meta"><span data-caption></span><span class="auto-rewrite-time" data-time></span></div></div>
            <div class="auto-rewrite-buttons"><label class="auto-rewrite-quick-toggle" title="生成结束后自动重写一次"><input type="checkbox" data-auto><span>自动</span></label>
            <button type="button" class="auto-rewrite-icon-button" data-settings title="重写设置" aria-label="重写设置"><i class="fa-solid fa-sliders" aria-hidden="true"></i></button></div>`;
        root.querySelector('[data-rewrite]').addEventListener('click', () => onRewrite(shown?.reply));
        root.querySelector('[data-jump]').addEventListener('click', () => onJump(shown?.reply, shown?.link?.target));
        root.querySelector('[data-auto]').addEventListener('change', event => { onAuto(event.target.checked); sync(); refresh(); });
        root.querySelector('[data-settings]').addEventListener('click', openSettings);
        return root;
    };
    const detachFooter = () => {
        bar?.remove();
        if (pagerSlot?.isConnected && nativePager?.parentElement === footer) pagerSlot.replaceWith(nativePager);
        else pagerSlot?.remove();
        footer?.remove();
        footer = null; nativePager = null; pagerSlot = null;
    };
    const positionDock = () => {
        if (!dock || !dockViewport) return;
        const rect = dockViewport.getBoundingClientRect();
        dock.style.left = `${rect.left + 8}px`;
        dock.style.width = `${Math.max(0, rect.width - 16)}px`;
        dock.style.bottom = `${Math.max(0, window.innerHeight - rect.bottom) + 8}px`;
        const padding = `${Math.ceil(dock.getBoundingClientRect().height) + 16}px`;
        if (dockViewport.style.getPropertyValue('--auto-rewrite-dock-space') !== padding) {
            dockViewport.style.setProperty('--auto-rewrite-dock-space', padding);
        }
    };
    const releaseDock = () => {
        dockObserver?.disconnect(); dockObserver = null;
        window.removeEventListener('resize', positionDock);
        window.visualViewport?.removeEventListener('resize', positionDock);
        window.visualViewport?.removeEventListener('scroll', positionDock);
        if (dockViewport) {
            dockViewport.classList.remove('auto-rewrite-docked');
            for (const [key, value, priority] of dockPadding ?? []) {
                if (value) dockViewport.style.setProperty(key, value, priority);
                else dockViewport.style.removeProperty(key);
            }
        }
        bar?.remove(); dock?.remove();
        dock = null; dockViewport = null; dockPadding = null;
    };
    const removeBar = () => {
        if (dock) releaseDock();
        detachFooter(); bar = null;
    };
    const mountDock = () => {
        if (dock) return;
        detachFooter();
        if (!bar) bar = makeBar();
        dockViewport = document.getElementById('chat');
        if (!dockViewport) return;
        dockPadding = ['--auto-rewrite-dock-base', '--auto-rewrite-dock-space'].map(key =>
            [key, dockViewport.style.getPropertyValue(key), dockViewport.style.getPropertyPriority(key)]);
        dockViewport.style.setProperty('--auto-rewrite-dock-base', getComputedStyle(dockViewport).paddingBottom);
        dockViewport.classList.add('auto-rewrite-docked');
        dock = document.createElement('div');
        dock.className = 'auto-rewrite-live-dock';
        dock.append(bar);
        document.body.append(dock);
        positionDock();
        dockObserver = new ResizeObserver(positionDock);
        dockObserver.observe(dockViewport); dockObserver.observe(dock);
        window.addEventListener('resize', positionDock);
        window.visualViewport?.addEventListener('resize', positionDock);
        window.visualViewport?.addEventListener('scroll', positionDock);
    };
    const mountBar = block => {
        if (!bar) bar = makeBar();
        nativePager = block.closest('.mes')?.querySelector('.swipeRightBlock');
        if (!nativePager) { block.append(bar); return; }
        // Move the real pager, preserving its handlers and native visibility rules.
        // Remember its original location so disabling the extension restores it.
        pagerSlot = document.createComment('auto-rewrite-native-pager');
        nativePager.before(pagerSlot);
        footer = document.createElement('div');
        footer.className = 'auto-rewrite-footer';
        footer.append(bar, nativePager);
        block.append(footer);
    };
    function render() {
        if (disposed) return;
        const view = getView();
        shown = view;
        sync();
        for (const root of forms) {
            const node = root.querySelector('[data-status]');
            if (node.textContent !== view.status) node.textContent = view.status;
        }
        if (view.busy) {
            // Keep the same controls anchored to the viewport through temporary
            // replies and tool continuations, rather than rebuilding each floor.
            mountDock();
        } else {
            if (dock) releaseDock();
            if (bar?.isConnected && Number(bar.closest('.mes')?.getAttribute('mesid')) !== view.reply?.index) removeBar();
            if (!view.reply) { removeBar(); clearInterval(clock); clock = null; return; }
            const block = document.querySelector(`#chat .mes[mesid="${view.reply.index}"] .mes_block`);
            if (!block) return;
            if (!bar?.isConnected) { detachFooter(); mountBar(block); }
        }
        if (!bar || !view.reply) return;
        const button = bar.querySelector('[data-rewrite]');
        const disabled = view.busy || !view.idle || view.composerBusy;
        button.disabled = disabled;
        const text = view.busy ? view.cancelled ? '已取消' : '重写中…' : '重写';
        if (button.querySelector('span').textContent !== text) button.querySelector('span').textContent = text;
        button.title = view.composerBusy ? '请先发送或清空输入框中的草稿与附件' : `重写当前第 ${view.reply.swipeId + 1} 版`;
        bar.dataset.busy = String(view.busy);
        const swipeCount = view.reply.message.swipes?.length || 1;
        const caption = view.busy
            ? `${view.reply.preview ? '重写中 · ' : ''}${view.status}`
            : view.link?.original ? '正在看原稿' : view.link ? '已重写' : '';
        const captionEl = bar.querySelector('[data-caption]');
        captionEl.hidden = !caption;
        if (captionEl.textContent !== caption) captionEl.textContent = caption;
        const jump = bar.querySelector('[data-jump]');
        jump.hidden = view.busy || !view.link;
        jump.disabled = view.busy || !view.idle;
        if (view.link) jump.querySelector('span').textContent = view.link.label;
        bar.querySelector('[data-auto]').checked = getSettings().auto;
        const timing = view.timing;
        const time = bar.querySelector('[data-time]');
        const end = timing?.finishedAt ?? Date.now();
        time.hidden = !timing;
        const label = timing
            ? `${view.automatic ? `总${duration(end - timing.startedAt)} · ` : ''}重写${duration(end - timing.rewriteStartedAt)}`
            : '';
        if (time.textContent !== label) time.textContent = label;
        const meta = bar.querySelector('.auto-rewrite-meta');
        meta.hidden = !caption && !timing;
        const route = getRouting();
        const mainText = route.mainModel ? `${route.mainModel}${route.mainSource ? ` (${route.mainSource})` : ''}` : (route.mainSource || '未选择');
        const rewriteText = route.error || `${route.label} · ${route.model || '默认模型'}`;
        meta.title = `第 ${view.reply.swipeId + 1}/${swipeCount} 版${caption ? ` · ${caption}` : ''}${label ? ` · ${label}` : ''}\n主 API：${mainText} → 重写：${rewriteText}`;
        if (view.busy && !timing?.finishedAt && !clock) clock = setInterval(refresh, 1000);
        if ((!view.busy || timing?.finishedAt) && clock) { clearInterval(clock); clock = null; }
        if (!view.idle && !view.busy && !poll) poll = setTimeout(() => { poll = null; refresh(); }, 200);
    }
    function install() {
        const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
        if (!panel && target) {
            panel = document.createElement('div');
            panel.className = 'extension_container auto-rewrite-settings';
            panel.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>正文重写 · 独立版</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"></div></div>';
            panel.querySelector('.inline-drawer-content').append(controls());
            target.append(panel);
        }
        const chat = document.getElementById('chat');
        if (!observer && chat) {
            observer = new MutationObserver(() => { onMutation(); refresh(); });
            observer.observe(chat, { childList: true });
        }
        sync(); refresh();
    }
    return { install, refresh, sync, openSettings, dispose() {
        disposed = true;
        observer?.disconnect();
        if (frame) cancelAnimationFrame(frame);
        clearTimeout(poll); clearInterval(clock);
        for (const request of requests.values()) request.abort();
        requests.clear();
        dialog?.close(); panel?.remove(); removeBar(); forms.clear();
    } };
}
