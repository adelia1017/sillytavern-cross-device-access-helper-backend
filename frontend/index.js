const API_ROOT = '/api/plugins/cross-device-access-helper';
const REPOSITORY_URL = 'https://github.com/adelia1017/sillytavern-cross-device-access-helper-server';

function panelMarkup() {
    return `
        <div class="cross-device-advanced__notice">
            高级版需要服务器插件。服务器插件没有沙箱，请只从可信来源安装并审查代码。
        </div>
        <div id="cross-device-advanced-state" role="status">正在检查服务器插件……</div>
        <section id="cross-device-advanced-setup" hidden>
            <h4>第 0 步：安装并启用服务器插件</h4>
            <p>当前前端没有收到后端响应。常见原因是服务器插件尚未安装，或 <code>enableServerPlugins</code> 尚未启用。</p>
            <p>前端无法也不会偷偷打开这项权限。正式发布前，这里会提供一整段可复制、带备份和 YAML 检查的 Termux 安装命令。</p>
            <a href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">查看开源代码与风险说明</a>
        </section>
        <section id="cross-device-advanced-dashboard" hidden>
            <h4>只读检查（开发阶段）</h4>
            <div id="cross-device-advanced-summary"></div>
            <label for="cross-device-advanced-device-ip">访问设备 IPv4</label>
            <input id="cross-device-advanced-device-ip" class="text_pole" inputmode="decimal" placeholder="例如：192.168.123.17" autocomplete="off">
            <label><input type="radio" name="cross-device-advanced-mode" value="single" checked> 仅允许这一台设备</label>
            <label><input type="radio" name="cross-device-advanced-mode" value="network"> 允许当前 /24 可信局域网</label>
            <button id="cross-device-advanced-preview" class="menu_button" type="button">查看修改预览</button>
            <pre id="cross-device-advanced-diff" hidden></pre>
            <p>当前版本不会写入配置；安全写入通过测试后才会开放。</p>
        </section>`;
}

async function requestJson(path, options = {}) {
    const response = await fetch(`${API_ROOT}${path}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...options,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message ?? `请求失败（HTTP ${response.status}）`);
    }
    return data.data;
}

async function csrfHeaders() {
    const response = await fetch('/csrf-token', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('无法取得 CSRF 令牌。');
    const { token } = await response.json();
    return { 'Content-Type': 'application/json', 'X-CSRF-Token': token };
}

function renderStatus(panel, status) {
    const urls = status.network.accessUrls.length
        ? status.network.accessUrls.map(url => `<code>${url}</code>`).join('<br>')
        : '未检测到私有局域网 IPv4';
    panel.querySelector('#cross-device-advanced-summary').innerHTML = `
        <p>配置文件：listen=${status.config.listen}，whitelistMode=${status.config.whitelistMode}</p>
        <p>本次运行：listen=${status.runtime.listen ?? '未知'}，whitelistMode=${status.runtime.whitelistMode ?? '未知'}</p>
        <p>可尝试的访问地址：<br>${urls}</p>
        ${status.legacyWhitelist.exists ? '<p class="cross-device-advanced__error">检测到 whitelist.txt，自动写入将保持禁用。</p>' : ''}
        ${status.supportedPlatform ? '' : '<p class="cross-device-advanced__error">第一版仅支持 Android Termux；当前平台只提供查看。</p>'}`;
}

async function checkBackend(panel) {
    const state = panel.querySelector('#cross-device-advanced-state');
    const setup = panel.querySelector('#cross-device-advanced-setup');
    const dashboard = panel.querySelector('#cross-device-advanced-dashboard');
    try {
        const status = await requestJson('/status', { signal: AbortSignal.timeout(5000) });
        state.textContent = '服务器插件连接正常。';
        setup.hidden = true;
        dashboard.hidden = false;
        renderStatus(panel, status);
    } catch {
        state.textContent = '未连接到服务器插件。';
        dashboard.hidden = true;
        setup.hidden = false;
    }
}

async function showPreview(panel) {
    const output = panel.querySelector('#cross-device-advanced-diff');
    output.hidden = false;
    output.textContent = '正在生成预览……';
    try {
        const deviceIp = panel.querySelector('#cross-device-advanced-device-ip').value;
        const mode = panel.querySelector('input[name="cross-device-advanced-mode"]:checked').value;
        const data = await requestJson('/preview-change', {
            method: 'POST',
            headers: await csrfHeaders(),
            body: JSON.stringify({ deviceIp, mode }),
        });
        output.textContent = data.changes.length
            ? data.changes.map(change => `${change.field}\n- ${JSON.stringify(change.before)}\n+ ${JSON.stringify(change.after)}`).join('\n\n')
            : '无需修改：目标配置已经存在。';
    } catch (error) {
        output.textContent = error.message;
    }
}

function initialize() {
    if (document.querySelector('#cross-device-advanced-settings')) return;
    const settings = document.querySelector('#extensions_settings');
    if (!settings) {
        setTimeout(initialize, 1000);
        return;
    }

    const details = document.createElement('details');
    details.id = 'cross-device-advanced-settings';
    details.className = 'extension_container cross-device-advanced';
    details.innerHTML = `<summary class="inline-drawer-header"><b>跨设备访问助手（高级版）</b></summary><div class="inline-drawer-content">${panelMarkup()}</div>`;
    settings.append(details);
    details.querySelector('#cross-device-advanced-preview').addEventListener('click', () => showPreview(details));
    void checkBackend(details);
}

initialize();
