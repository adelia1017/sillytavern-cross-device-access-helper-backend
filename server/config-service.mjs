import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { validateChangeRequest } from '../shared/ip-utils.js';

const CONFIG_FILE = 'config.yaml';
const WHITELIST_FILE = 'whitelist.txt';
const LOCALHOST_ENTRIES = Object.freeze(['::1', '127.0.0.1']);

export class SafeConfigError extends Error {
    constructor(code, publicMessage) {
        super(publicMessage);
        this.name = 'SafeConfigError';
        this.code = code;
        this.publicMessage = publicMessage;
    }
}

function scalar(document, key) {
    return document.get(key, true)?.toJSON?.() ?? document.get(key);
}

function requireBoolean(value, key) {
    if (typeof value !== 'boolean') {
        throw new SafeConfigError('INVALID_FIELD_TYPE', `${key} 必须是 true 或 false。`);
    }
    return value;
}

function requireWhitelist(value) {
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
        throw new SafeConfigError('INVALID_FIELD_TYPE', 'whitelist 必须是仅包含文本的列表。');
    }
    return [...value];
}

async function assertRegularFile(filePath) {
    let fileStat;
    try {
        fileStat = await fs.lstat(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new SafeConfigError('CONFIG_NOT_FOUND', '未在 SillyTavern 根目录找到 config.yaml。');
        }
        throw error;
    }

    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new SafeConfigError('UNSAFE_CONFIG_FILE', 'config.yaml 必须是普通文件，不能是符号链接。');
    }
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

export async function readConfig(serverRoot = process.cwd()) {
    const configPath = path.resolve(serverRoot, CONFIG_FILE);
    await assertRegularFile(configPath);
    const source = await fs.readFile(configPath, 'utf8');
    const document = parseDocument(source, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
    });

    if (document.errors.length > 0) {
        const duplicate = document.errors.some(error => error.code === 'DUPLICATE_KEY');
        throw new SafeConfigError(
            duplicate ? 'DUPLICATE_KEY' : 'INVALID_YAML',
            duplicate
                ? 'config.yaml 含有重复键，已拒绝继续。请先修复配置。'
                : 'config.yaml 的 YAML 语法无效，已拒绝继续。',
        );
    }

    const listen = requireBoolean(scalar(document, 'listen'), 'listen');
    const whitelistMode = requireBoolean(scalar(document, 'whitelistMode'), 'whitelistMode');
    const whitelist = requireWhitelist(scalar(document, 'whitelist'));
    const configuredPort = scalar(document, 'port');

    return {
        configPath,
        document,
        source,
        allowed: { listen, whitelistMode, whitelist },
        configuredPort: Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
            ? configuredPort
            : 8000,
        legacyWhitelistExists: await fileExists(path.resolve(serverRoot, WHITELIST_FILE)),
    };
}

function privateLanAddresses(interfaces = os.networkInterfaces()) {
    const addresses = [];
    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            const parts = entry.address.split('.').map(Number);
            const privateAddress = parts[0] === 10
                || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
                || (parts[0] === 192 && parts[1] === 168);
            if (privateAddress && !addresses.some(item => item.address === entry.address)) {
                addresses.push({ interface: name, address: entry.address });
            }
        }
    }
    return addresses;
}

function runtimeSnapshot(runtime, configuredPort) {
    const port = Number.isInteger(runtime?.port) && runtime.port >= 1 && runtime.port <= 65535
        ? runtime.port
        : configuredPort;
    return {
        listen: typeof runtime?.listen === 'boolean' ? runtime.listen : null,
        whitelistMode: typeof runtime?.whitelistMode === 'boolean' ? runtime.whitelistMode : null,
        port,
        protocol: runtime?.ssl === true ? 'https' : 'http',
    };
}

function assertDefaultConfigPath(serverRoot, runtime) {
    if (!runtime?.configPath) return;
    const supportedPath = path.resolve(serverRoot, CONFIG_FILE);
    const activePath = path.resolve(serverRoot, runtime.configPath);
    if (activePath !== supportedPath) {
        throw new SafeConfigError(
            'UNSUPPORTED_CONFIG_PATH',
            '当前 SillyTavern 使用了非标准配置路径；第一版只支持根目录 config.yaml。',
        );
    }
}

export async function getStatus({
    serverRoot = process.cwd(),
    runtime = globalThis.COMMAND_LINE_ARGS,
    interfaces = os.networkInterfaces(),
    platform = process.platform,
} = {}) {
    assertDefaultConfigPath(serverRoot, runtime);
    const config = await readConfig(serverRoot);
    const active = runtimeSnapshot(runtime, config.configuredPort);
    const lanIpv4 = privateLanAddresses(interfaces);
    const accessUrls = lanIpv4.map(item => `${active.protocol}://${item.address}:${active.port}`);

    return {
        phase: 'read-only-preview',
        writeEnabled: false,
        platform,
        supportedPlatform: platform === 'android',
        config: config.allowed,
        runtime: active,
        network: { lanIpv4, accessUrls },
        legacyWhitelist: {
            exists: config.legacyWhitelistExists,
            blocksApply: config.legacyWhitelistExists,
        },
        restartRequired: false,
    };
}

export async function previewChange(body, {
    serverRoot = process.cwd(),
    runtime = globalThis.COMMAND_LINE_ARGS,
} = {}) {
    const request = validateChangeRequest(body);
    if (!request.valid) {
        throw new SafeConfigError('INVALID_REQUEST', request.message);
    }

    assertDefaultConfigPath(serverRoot, runtime);
    const current = await readConfig(serverRoot);
    const requestedEntry = request.mode === 'network' ? request.subnet24 : request.deviceIp;
    const nextWhitelist = [...current.allowed.whitelist];
    for (const entry of [...LOCALHOST_ENTRIES, requestedEntry]) {
        if (!nextWhitelist.includes(entry)) nextWhitelist.push(entry);
    }

    const next = {
        listen: true,
        whitelistMode: true,
        whitelist: nextWhitelist,
    };
    const changes = [];
    for (const key of ['listen', 'whitelistMode', 'whitelist']) {
        if (JSON.stringify(current.allowed[key]) !== JSON.stringify(next[key])) {
            changes.push({ field: key, before: current.allowed[key], after: next[key] });
        }
    }

    return {
        request: { deviceIp: request.deviceIp, mode: request.mode, whitelistEntry: requestedEntry },
        changes,
        changed: changes.length > 0,
        canApply: false,
        applyBlockedReasons: [
            '当前功能只提供读取和预览，不会写入配置。',
            ...(current.legacyWhitelistExists ? ['检测到 whitelist.txt；它会覆盖 config.yaml 中的白名单。'] : []),
        ],
        preservedWhitelist: current.allowed.whitelist,
    };
}
