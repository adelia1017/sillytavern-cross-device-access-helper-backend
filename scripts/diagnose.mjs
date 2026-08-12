import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function pass(message) {
    console.log(`通过：${message}`);
}

function fail(message) {
    console.error(`失败：${message}`);
    process.exitCode = 1;
}

async function main() {
    const serverRoot = path.resolve(process.cwd());
    const expectedRoot = path.resolve(process.env.HOME ?? '', 'SillyTavern');
    const pluginRoot = path.join(serverRoot, 'plugins', 'cross-device-access-helper-backend');
    const packagePath = path.join(pluginRoot, 'package.json');
    const configPath = path.join(serverRoot, 'config.yaml');

    if (!process.env.HOME || serverRoot !== expectedRoot) {
        fail('请先进入常规路径 ~/SillyTavern 再运行诊断。');
        return;
    }
    pass('当前目录是 ~/SillyTavern');

    let packageJson;
    try {
        packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    } catch (error) {
        fail(`无法读取后端 package.json：${error.message}`);
        return;
    }

    if (packageJson.name !== 'sillytavern-cross-device-access-helper-backend') {
        fail('后端目录中的 package.json 名称不正确。');
        return;
    }
    pass(`后端目录存在（版本 ${packageJson.version ?? '未知'}）`);

    const entryPath = path.resolve(pluginRoot, packageJson.main ?? '');
    if (!packageJson.main || path.relative(pluginRoot, entryPath).startsWith('..')) {
        fail('package.json 的 main 入口无效。');
        return;
    }

    const requireFromServer = createRequire(path.join(serverRoot, 'package.json'));
    const yaml = requireFromServer('yaml');
    const configSource = await fs.readFile(configPath, 'utf8');
    const configDocument = yaml.parseDocument(configSource, { strict: true, uniqueKeys: true });
    if (configDocument.errors.length > 0) {
        fail('config.yaml 存在 YAML 语法错误或重复键。');
        return;
    }
    if (configDocument.get('enableServerPlugins') !== true) {
        fail('当前 config.yaml 的 enableServerPlugins 不是 true。');
        return;
    }
    pass('enableServerPlugins 为 true');

    let plugin;
    try {
        plugin = await import(pathToFileURL(entryPath));
    } catch (error) {
        fail(`Node 无法导入后端入口：${error.message}`);
        return;
    }
    if (plugin.info?.id !== 'cross-device-access-helper-backend' || typeof plugin.init !== 'function') {
        fail('后端入口缺少正确的 info 或 init 导出。');
        return;
    }
    pass('Node 可以导入后端入口');

    const routes = new Map();
    const router = {
        use() {},
        get(route, handler) { routes.set(`GET ${route}`, handler); },
        post(route, handler) { routes.set(`POST ${route}`, handler); },
    };
    try {
        await plugin.init(router);
    } catch (error) {
        fail(`后端初始化失败：${error.message}`);
        return;
    }
    if (!routes.has('GET /status')) {
        fail('后端初始化后没有注册 GET /status。');
        return;
    }
    pass('后端能注册状态接口');

    const response = {
        statusCode: 200,
        body: null,
        set() { return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
    await routes.get('GET /status')({}, response);
    if (response.statusCode !== 200 || response.body?.ok !== true) {
        fail(`状态检查失败：${response.body?.error?.message ?? `HTTP ${response.statusCode}`}`);
        return;
    }
    pass('后端可以安全读取当前配置并生成状态');
    console.log('结论：后端文件本身正常。如果网页仍显示 Not Found，请保留本次结果并检查 SillyTavern 启动日志。');
}

main().catch(error => {
    fail(`诊断发生意外错误：${error.message}`);
});
