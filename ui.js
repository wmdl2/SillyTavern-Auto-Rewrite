function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function createRewriteUI({ getSettings, getView, onAuto, onFeedback, onRewrite, onJump, onMutation }) {
    let panel, bar, dialog, observer, frame, poll, clock, shown;
    let disposed = false;
    const forms = new Set();
    const refresh = () => {
        if (disposed || frame) return;
        frame = requestAnimationFrame(() => { frame = null; render(); });
    };
    const controls = () => {
        const root = document.createElement('div');
        root.className = 'auto-rewrite-controls';
        root.innerHTML = `<label class="auto-rewrite-setting-toggle"><span><b>自动重写一次</b><small>首轮结束后，按修改意见再写一版</small></span><input type="checkbox" data-auto></label>
            <label class="auto-rewrite-label">修改意见<textarea class="text_pole" rows="5" spellcheck="false" data-feedback></textarea></label>
            <p class="auto-rewrite-note">沿用当前连接和预设。完成后替换原楼，原稿保留为上一版。</p>
            <p class="auto-rewrite-status" data-status role="status"></p>`;
        root.querySelector('[data-auto]').addEventListener('change', event => { onAuto(event.target.checked); sync(); refresh(); });
        root.querySelector('[data-feedback]').addEventListener('input', event => { onFeedback(event.target.value); sync(); });
        forms.add(root);
        return root;
    };
    const sync = () => {
        const settings = getSettings();
        for (const root of forms) {
            root.querySelector('[data-auto]').checked = settings.auto;
            const field = root.querySelector('[data-feedback]');
            if (document.activeElement !== field) field.value = settings.feedback;
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
        dialog.addEventListener('close', () => { forms.delete(form); activeDialog.remove(); if (dialog === activeDialog) dialog = null; });
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
    function render() {
        if (disposed) return;
        const view = getView();
        shown = view;
        for (const root of forms) {
            const node = root.querySelector('[data-status]');
            if (node.textContent !== view.status) node.textContent = view.status;
        }
        if (bar && (!bar.isConnected || Number(bar.closest('.mes')?.getAttribute('mesid')) !== view.reply?.index)) { bar.remove(); bar = null; }
        if (!view.reply) { clearInterval(clock); clock = null; return; }
        const block = document.querySelector(`#chat .mes[mesid="${view.reply.index}"] .mes_block`);
        if (!block) return;
        if (!bar) { bar = makeBar(); block.append(bar); }
        const button = bar.querySelector('[data-rewrite]');
        const disabled = view.busy || !view.idle || view.composerBusy;
        button.disabled = disabled;
        const text = view.busy ? view.cancelled ? '已取消' : '重写中…' : '重写';
        if (button.querySelector('span').textContent !== text) button.querySelector('span').textContent = text;
        button.title = view.composerBusy ? '请先发送或清空输入框中的草稿与附件' : `重写当前第 ${view.reply.swipeId + 1} 版`;
        bar.dataset.busy = String(view.busy);
        const caption = view.busy ? view.status : `${view.link?.original ? '正在查看原稿' : view.link ? '重写版' : '当前正文'} · 第 ${view.reply.swipeId + 1}/${view.reply.message.swipes?.length || 1} 版`;
        if (bar.querySelector('[data-caption]').textContent !== caption) bar.querySelector('[data-caption]').textContent = caption;
        const jump = bar.querySelector('[data-jump]');
        jump.hidden = !view.link;
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
        dialog?.close(); panel?.remove(); bar?.remove(); forms.clear();
    } };
}
