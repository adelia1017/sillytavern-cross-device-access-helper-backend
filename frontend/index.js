const API_ROOT = '/api/plugins/cross-device-access-helper-backend';
const REPOSITORY_URL = 'https://github.com/adelia1017/sillytavern-cross-device-access-helper-backend';
const INSTALL_COMMAND = `cd "$HOME/SillyTavern" || { echo "未找到 ~/SillyTavern"; exit 1; }
PLUGIN_DIR="$PWD/plugins/cross-device-access-helper-backend"
if [ -d "$PLUGIN_DIR/.git" ]; then
  git -C "$PLUGIN_DIR" pull --ff-only || exit 1
elif [ -e "$PLUGIN_DIR" ]; then
  echo "停止：目标位置已存在且不是 Git 仓库：$PLUGIN_DIR"
  exit 1
else
  git clone ${REPOSITORY_URL}.git "$PLUGIN_DIR" || exit 1
fi
node "$PLUGIN_DIR/scripts/enable-server-plugins.mjs"`;

function panelMarkup() {
    return `
        <div class="cross-device-backend__notice">
            后端版需要服务器插件。服务器插件没有沙箱，请只从可信来源安装并审查代码。
        </div>
        <div id="cross-device-backend-state" role="status">正在检查服务器插件……</div>
        <section id="cross-device-backend-setup" hidden>
            <h4>第 0 步：安装并启用后端</h4>
            <p>当前前端没有收到后端响应。可能是服务器插件尚未安装、尚未启用，或者安装后还没有重启酒馆。</p>
            <ol>
                <li>先停止 SillyTavern：回到显示运行日志的 Termux，点底部 <b>CTRL</b>，再按键盘 <b>C</b>。看到 <code>~/SillyTavern $</code> 提示符后继续。</li>
                <li>复制并粘贴下面整段安装命令。它会安装后端、检查 YAML、创建带时间的备份，并把 <code>enableServerPlugins</code> 改为 <code>true</code>。</li>
                <li>命令显示成功后运行 <code>npm start</code>，再回到这里刷新页面。</li>
            </ol>
            <p class="cross-device-backend__warning">这一步会开启 SillyTavern 的服务器插件权限。所有服务器插件都没有沙箱；继续表示你理解并接受这个风险。</p>
            <textarea id="cross-device-backend-install-command" class="text_pole" rows="11" readonly spellcheck="false" aria-label="后端安装命令"></textarea>
            <button id="cross-device-backend-copy-install" class="menu_button" type="button">复制整段安装命令</button>
            <div id="cross-device-backend-copy-status" role="status"></div>
            <p>安装脚本不会停止或重启酒馆，也不会修改端口、认证、CSRF 或其他设置。服务器插件运行时同样不能修改 <code>enableServerPlugins</code>。</p>
            <a href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">查看开源代码与风险说明</a>
        </section>
        <section id="cross-device-backend-dashboard" hidden>
            <h4>只读检查（开发阶段）</h4>
            <div id="cross-device-backend-summary"></div>
            <label for="cross-device-backend-device-ip">访问设备 IPv4</label>
            <input id="cross-device-backend-device-ip" class="text_pole" inputmode="decimal" placeholder="例如：192.168.123.17" autocomplete="off">
            <label><input type="radio" name="cross-device-backend-mode" value="single" checked> 仅允许这一台设备</label>
            <label><input type="radio" name="cross-device-backend-mode" value="network"> 允许当前 /24 可信局域网</label>
            <button id="cross-device-backend-preview" class="menu_button" type="button">查看修改预览</button>
            <pre id="cross-device-backend-diff" hidden></pre>
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
    panel.querySelector('#cross-device-backend-summary').innerHTML = `
        <p>配置文件：listen=${status.config.listen}，whitelistMode=${status.config.whitelistMode}</p>
        <p>本次运行：listen=${status.runtime.listen ?? '未知'}，whitelistMode=${status.runtime.whitelistMode ?? '未知'}</p>
        <p>可尝试的访问地址：<br>${urls}</p>
        ${status.legacyWhitelist.exists ? '<p class="cross-device-backend__error">检测到 whitelist.txt，自动写入将保持禁用。</p>' : ''}
        ${status.supportedPlatform ? '' : '<p class="cross-device-backend__error">第一版仅支持 Android Termux；当前平台只提供查看。</p>'}`;
}

async function checkBackend(panel) {
    const state = panel.querySelector('#cross-device-backend-state');
    const setup = panel.querySelector('#cross-device-backend-setup');
    const dashboard = panel.querySelector('#cross-device-backend-dashboard');
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
    const output = panel.querySelector('#cross-device-backend-diff');
    output.hidden = false;
    output.textContent = '正在生成预览……';
    try {
        const deviceIp = panel.querySelector('#cross-device-backend-device-ip').value;
        const mode = panel.querySelector('input[name="cross-device-backend-mode"]:checked').value;
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

async function copyInstallCommand(panel) {
    const status = panel.querySelector('#cross-device-backend-copy-status');
    try {
        await navigator.clipboard.writeText(INSTALL_COMMAND);
        status.textContent = '安装命令已复制。请先停止酒馆，再粘贴到 Termux。';
    } catch {
        status.textContent = '自动复制失败。请长按上方命令框，选择全部后手动复制。';
    }
}

function initialize() {
    if (document.querySelector('#cross-device-backend-settings')) return;
    const settings = document.querySelector('#extensions_settings');
    if (!settings) {
        setTimeout(initialize, 1000);
        return;
    }

    const details = document.createElement('details');
    details.id = 'cross-device-backend-settings';
    details.className = 'extension_container cross-device-backend';
    details.innerHTML = `<summary class="inline-drawer-header"><b>跨设备访问助手（后端版）</b></summary><div class="inline-drawer-content">${panelMarkup()}</div>`;
    settings.append(details);
    details.querySelector('#cross-device-backend-install-command').value = INSTALL_COMMAND;
    details.querySelector('#cross-device-backend-copy-install').addEventListener('click', () => copyInstallCommand(details));
    details.querySelector('#cross-device-backend-preview').addEventListener('click', () => showPreview(details));
    void checkBackend(details);
}

initialize();
