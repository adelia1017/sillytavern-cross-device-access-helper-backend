import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

function timestamp(date = new Date()) {
    const part = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function withoutEnableServerPlugins(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const copy = structuredClone(value);
    delete copy.enableServerPlugins;
    return copy;
}

async function loadYamlFromSillyTavern(serverRoot) {
    const requireFromServer = createRequire(path.join(serverRoot, 'package.json'));
    const resolved = requireFromServer.resolve('yaml');
    const expectedRoot = await fs.realpath(path.join(serverRoot, 'node_modules', 'yaml'));
    const resolvedRealPath = await fs.realpath(resolved);
    const relative = path.relative(expectedRoot, resolvedRealPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('拒绝使用 SillyTavern 目录以外的 YAML 解析器。');
    }
    return requireFromServer('yaml');
}

function parseYaml(yaml, source, label) {
    const document = yaml.parseDocument(source, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
    });
    if (document.errors.length > 0) {
        const duplicate = document.errors.some(error => error.code === 'DUPLICATE_KEY');
        throw new Error(duplicate
            ? `${label} 含有重复键，已停止且不会覆盖原配置。`
            : `${label} 的 YAML 语法无效，已停止且不会覆盖原配置。`);
    }
    return document;
}

async function syncFile(filePath) {
    const handle = await fs.open(filePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function enableServerPlugins({
    serverRoot = process.cwd(),
    platform = process.platform,
    yamlModule,
    now = new Date(),
    pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
} = {}) {
    if (platform !== 'android') {
        throw new Error('第一版启用脚本仅支持 Android Termux。');
    }

    const expectedRoot = path.resolve(process.env.HOME ?? '', 'SillyTavern');
    const resolvedRoot = path.resolve(serverRoot);
    if (!process.env.HOME || resolvedRoot !== expectedRoot) {
        throw new Error('第一版只支持常规路径 ~/SillyTavern，请勿从其他目录运行。');
    }

    const expectedPluginsRoot = path.join(resolvedRoot, 'plugins');
    const resolvedPluginRoot = path.resolve(pluginRoot);
    const pluginRelativePath = path.relative(expectedPluginsRoot, resolvedPluginRoot);
    if (!pluginRelativePath || pluginRelativePath.startsWith('..') || path.isAbsolute(pluginRelativePath)) {
        throw new Error('后端仓库必须安装在 ~/SillyTavern/plugins/ 的子目录中。');
    }
    const pluginPackage = JSON.parse(await fs.readFile(path.join(resolvedPluginRoot, 'package.json'), 'utf8'));
    if (pluginPackage.main !== 'dist/server-plugin.mjs') {
        throw new Error('后端 package.json 无效，已停止且不会开启服务器插件。');
    }
    const bundledPlugin = path.join(resolvedPluginRoot, pluginPackage.main);
    let bundledStat;
    try {
        bundledStat = await fs.lstat(bundledPlugin);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error('未找到可信的已打包后端文件，已停止且不会开启服务器插件。');
        }
        throw error;
    }
    if (!bundledStat.isFile() || bundledStat.isSymbolicLink()) {
        throw new Error('未找到可信的已打包后端文件，已停止且不会开启服务器插件。');
    }

    const configPath = path.join(resolvedRoot, 'config.yaml');
    const originalStat = await fs.lstat(configPath);
    if (!originalStat.isFile() || originalStat.isSymbolicLink()) {
        throw new Error('config.yaml 必须是普通文件，不能是符号链接。');
    }

    const yaml = yamlModule ?? await loadYamlFromSillyTavern(resolvedRoot);
    const originalSource = await fs.readFile(configPath, 'utf8');
    const originalDigest = digest(originalSource);
    const document = parseYaml(yaml, originalSource, 'config.yaml');
    const originalValue = document.toJS({ maxAliasCount: 100 });

    if (document.get('enableServerPlugins') === true) {
        return { changed: false, backupPath: null, message: 'enableServerPlugins 已经是 true，无需修改。' };
    }
    if (![undefined, false].includes(document.get('enableServerPlugins'))) {
        throw new Error('enableServerPlugins 当前不是布尔值，已停止且不会修改。');
    }

    document.set('enableServerPlugins', true);
    const nextSource = String(document);
    const verifiedDocument = parseYaml(yaml, nextSource, '临时配置');
    const verifiedValue = verifiedDocument.toJS({ maxAliasCount: 100 });
    if (verifiedDocument.get('enableServerPlugins') !== true
        || !isDeepStrictEqual(withoutEnableServerPlugins(originalValue), withoutEnableServerPlugins(verifiedValue))) {
        throw new Error('临时配置验证失败，已停止且不会覆盖原配置。');
    }

    const suffix = timestamp(now);
    const backupPath = path.join(resolvedRoot, `config.yaml.backend-enable-backup-${suffix}`);
    const temporaryPath = path.join(resolvedRoot, `.config.yaml.backend-enable-${process.pid}-${suffix}.tmp`);
    let temporaryCreated = false;
    try {
        await fs.copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
        await syncFile(backupPath);
        await fs.writeFile(temporaryPath, nextSource, { encoding: 'utf8', flag: 'wx', mode: originalStat.mode });
        temporaryCreated = true;
        await syncFile(temporaryPath);

        const temporarySource = await fs.readFile(temporaryPath, 'utf8');
        parseYaml(yaml, temporarySource, '写入后的临时配置');
        const latestStat = await fs.lstat(configPath);
        const latestSource = await fs.readFile(configPath, 'utf8');
        if (!latestStat.isFile() || latestStat.isSymbolicLink() || digest(latestSource) !== originalDigest) {
            throw new Error('修改期间 config.yaml 发生了变化，已停止且不会覆盖。');
        }

        await fs.rename(temporaryPath, configPath);
        temporaryCreated = false;
        return {
            changed: true,
            backupPath,
            message: '已安全启用服务器插件。请手动运行：cd "$HOME/SillyTavern" && bash start.sh',
        };
    } finally {
        if (temporaryCreated) {
            await fs.unlink(temporaryPath).catch(() => {});
        }
    }
}

async function main() {
    try {
        const result = await enableServerPlugins();
        console.log(result.message);
        if (result.backupPath) console.log(`配置备份：${result.backupPath}`);
        console.log('本脚本没有启动或重启 SillyTavern。下一步请运行：cd "$HOME/SillyTavern" && bash start.sh');
    } catch (error) {
        console.error(`安装停止：${error.message}`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
