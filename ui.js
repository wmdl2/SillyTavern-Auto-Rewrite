function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function createRewriteUI({ getSettings, getView, getRouting, onRoute, onRefreshModels, onAuto, onFeedback, onRewrite, onJump, onMutation }) {
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
    const controls = () => {
        const root = document.createElement('div');
        root.className = 'auto-rewrite-controls';
        const listId = `auto-rewrite-models-${++formSequence}`;
        root.innerHTML = `<label class="auto-rewrite-setting-toggle"><span><b>自动重写一次</b><small>首轮结束后，按修改意见再写一版</small></span><input type="checkbox" data-auto></label>
            <section class="auto-rewrite-model-card" aria-label="重写模型设置">
                <div class="auto-rewrite-model-heading"><span class="auto-rewrite-model-icon"><i class="fa-solid fa-layer-group" aria-hidden="true"></i></span><div><b>重写模型</b><small>为第二轮单独选择连接与型号</small></div><span class="auto-rewrite-model-badge" data-source></span></div>
                <label class="auto-rewrite-label"><span>API 配置</span><select class="text_pole" data-profile aria-label="重写使用的 API 配置"></select></label>
                <label class="auto-rewrite-label"><span>模型型号</span><span class="auto-rewrite-model-input"><input class="text_pole" type="text" list="${listId}" autocomplete="off" spellcheck="false" data-model aria-label="重写模型型号"><button type="button" data-refresh-models title="读取所选 API 的模型列表" aria-label="刷新模型列表"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button></span></label>
                <datalist id="${listId}" data-models></datalist>
                <p class="auto-rewrite-model-hint" data-model-hint></p>
                <div class="auto-rewrite-model-summary"><i class="fa-solid fa-arrow-turn-up" aria-hidden="true"></i><span data-route-summary></span></div>
            </section>
            <label class="auto-rewrite-label">修改意见<textarea class="text_pole" rows="5" spellcheck="false" data-feedback></textarea></label>
            <p class="auto-rewrite-note">沿用当前写作预设。重写结束后恢复首轮连接，原稿保留为上一版。</p>
            <p class="auto-rewrite-status" data-status role="status"></p>`;
        root.querySelector('[data-auto]').addEventListener('change', event => { onAuto(event.target.checked); sync(); refresh(); });
        root.querySelector('[data-feedback]').addEventListener('input', event => { onFeedback(event.target.value); sync(); });
        root.querySelector('[data-profile]').addEventListener('change', event => {
            requests.get(root)?.abort(); requests.delete(root);
            delete root.dataset.modelsMessage;
            onRoute({ profileId: event.target.value, model: '' }); sync(); refresh();
        });
        root.querySelector('[data-model]').addEventListener('input', event => {
            onRoute({ model: event.target.value }); sync();
        });
        root.querySelector('[data-refresh-models]').addEventListener('click', async () => {
            requests.get(root)?.abort();
            const request = new AbortController();
            const timeout = setTimeout(() => request.abort(), 20000);
            requests.set(root, request);
            root.dataset.modelsMessage = '正在读取模型列表…'; sync();
            try {
                const models = await onRefreshModels(request.signal);
                if (requests.get(root) === request) root.dataset.modelsMessage = `可选 ${models.length} 个型号，也可以手动输入`;
            } catch (error) {
                if (requests.get(root) === request) root.dataset.modelsMessage = request.signal.aborted
                    ? '读取已取消或超时，可以手动填写型号' : error.message;
            } finally {
                clearTimeout(timeout);
                if (requests.get(root) === request) requests.delete(root);
                sync();
            }
        });
        forms.add(root);
        return root;
    };
    const sync = () => {
        const settings = getSettings();
        const route = getRouting();
        const busy = getView().busy;
        for (const root of forms) {
            root.querySelector('[data-auto]').checked = settings.auto;
            const field = root.querySelector('[data-feedback]');
            if (document.activeElement !== field) field.value = settings.feedback;
            const profile = root.querySelector('[data-profile]');
            const entries = [['', '沿用当前 API'], ...route.profiles.map(p => [p.id, `${p.name} · ${p.api}`])];
            if (settings.profileId && !entries.some(([id]) => id === settings.profileId)) entries.push([settings.profileId, '配置已删除 · 请重新选择']);
            const profileSignature = JSON.stringify(entries);
            if (profile.dataset.entries !== profileSignature) {
                profile.replaceChildren(...entries.map(([id, name]) => new Option(name, id)));
                profile.dataset.entries = profileSignature;
            }
            profile.value = settings.profileId;
            profile.disabled = busy;
            const model = root.querySelector('[data-model]');
            if (document.activeElement !== model) model.value = settings.model;
            model.placeholder = route.model ? `默认：${route.model}` : '沿用默认型号，或输入模型名称';
            model.disabled = busy || !route.supported;
            const list = root.querySelector('[data-models]');
            const modelSignature = JSON.stringify(route.models);
            if (list.dataset.entries !== modelSignature) {
                list.replaceChildren(...route.models.map(m => new Option(m.label, m.id)));
                list.dataset.entries = modelSignature;
            }
            root.querySelector('[data-source]').textContent = route.source || '未选择';
            root.querySelector('[data-refresh-models]').disabled = busy || !route.supported || requests.has(root);
            root.querySelector('[data-model-hint]').textContent = route.error || (!route.supported
                ? '模型选择支持聊天补全 API；未指定时仍沿用当前连接。'
                : root.dataset.modelsMessage || (route.canFetch ? '可从列表选择，也可输入准确型号；点击右侧刷新获取更多模型。' : '使用酒馆已有模型列表，也可手动输入准确型号。'));
            root.querySelector('[data-route-summary]').textContent = route.error || `${route.label} → ${route.model || '默认模型'}`;
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
        dialog.addEventListener('close', () => { requests.get(form)?.abort(); requests.delete(form); forms.delete(form); activeDialog.remove(); if (dialog === activeDialog) dialog = null; });
        document.body.append(dialog);
        sync();
        dialog.showModal();
    };
    const makeBar = () => {
        const root = document.createElement('div');
        root.className = 'auto-rewrite-actions';
        root.innerHTML = `<div class="auto-rewrite-heading"><span class="auto-rewrite-emblem"><i class="fa-solid fa-pen-nib" aria-hidden="true"></i></span><div><b>正文重写</b><span data-caption></span></div></div>
            <div class="auto-rewrite-buttons"><button type="button" class="auto-rewrite-primary" data-rewrite><i class="fa-solid fa-rotate-right" aria-hidden="true"></i><span>重写</span></button>
            <button type="button" class="auto-rewrite-secondary" data-jump><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>查看原稿</span></button>
            <label class="auto-rewrite-quick-toggle" title="生成结束后自动重写一次"><input type="checkbox" data-auto><span>自动</span></label>
            <button type="button" class="auto-rewrite-icon-button" data-settings title="重写设置" aria-label="重写设置"><i class="fa-solid fa-sliders" aria-hidden="true"></i></button></div>
            <div class="auto-rewrite-time" data-time></div>`;
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
        const caption = view.busy ? `${view.reply.preview ? '重写中 · 新版本 · ' : ''}${view.status}` : `${view.link?.original ? '正在查看原稿' : view.link ? '重写版' : '当前正文'} · 第 ${view.reply.swipeId + 1}/${view.reply.message.swipes?.length || 1} 版`;
        if (bar.querySelector('[data-caption]').textContent !== caption) bar.querySelector('[data-caption]').textContent = caption;
        const jump = bar.querySelector('[data-jump]');
        jump.hidden = view.busy || !view.link;
        jump.disabled = view.busy || !view.idle;
        if (view.link) jump.querySelector('span').textContent = view.link.label;
        bar.querySelector('[data-auto]').checked = getSettings().auto;
        const timing = view.timing;
        const time = bar.querySelector('[data-time]');
        const end = timing?.finishedAt ?? Date.now();
        time.hidden = !timing;
        const label = timing ? `${view.automatic ? `总用时 ${duration(end - timing.startedAt)} · ` : ''}重写 ${duration(end - timing.rewriteStartedAt)}` : '';
        if (time.textContent !== label) time.textContent = label;
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
