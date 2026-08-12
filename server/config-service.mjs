import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import { validateChangeRequest } from '../shared/ip-utils.js';

const CONFIG_FILE = 'config.yaml';
const WHITELIST_FILE = 'whitelist.txt';
const LOCALHOST_ENTRIES = Object.freeze(['::1', '127.0.0.1']);
const ALLOWED_FIELDS = Object.freeze(['listen', 'whitelistMode', 'whitelist']);
const BACKUP_PATTERN = /^config\.yaml\.cross-device-access-helper-backup-\d{8}-?\d{6}(?:-\d{3})?(?:-\d+)?\.bak$/;

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

function parseConfigSource(source, label = CONFIG_FILE) {
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
                ? `${label} 含有重复键，已拒绝继续。请先修复配置。`
                : `${label} 的 YAML 语法无效，已拒绝继续。`,
        );
    }

    const root = document.toJS({ maxAliasCount: 100 });
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        throw new SafeConfigError('INVALID_YAML_ROOT', `${label} 的根节点必须是配置对象。`);
    }
    const listen = requireBoolean(scalar(document, 'listen'), 'listen');
    const whitelistMode = requireBoolean(scalar(document, 'whitelistMode'), 'whitelistMode');
    const whitelist = requireWhitelist(scalar(document, 'whitelist'));
    const configuredPort = scalar(document, 'port');

    return {
        document,
        root,
        allowed: { listen, whitelistMode, whitelist },
        configuredPort: Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
            ? configuredPort
            : 8000,
    };
}

async function readConfigFile(filePath, label = path.basename(filePath)) {
    await assertRegularFile(filePath);
    const source = await fs.readFile(filePath, 'utf8');
    const parsed = parseConfigSource(source, label);
    const stat = await fs.stat(filePath);
    return { filePath, source, stat, ...parsed };
}

export async function readConfig(serverRoot = process.cwd()) {
    const configPath = path.resolve(serverRoot, CONFIG_FILE);
    const parsed = await readConfigFile(configPath, CONFIG_FILE);

    return {
        configPath,
        ...parsed,
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

function isDefaultTermuxRoot(serverRoot, platform, expectedRoot = path.resolve(process.env.HOME ?? '', 'SillyTavern')) {
    return platform === 'android' && Boolean(process.env.HOME || expectedRoot) && path.resolve(serverRoot) === path.resolve(expectedRoot);
}

function assertWritableEnvironment(serverRoot, platform, expectedRoot) {
    if (platform !== 'android') {
        throw new SafeConfigError('UNSUPPORTED_PLATFORM', '自动写入仅支持 Android Termux。');
    }
    if (!isDefaultTermuxRoot(serverRoot, platform, expectedRoot)) {
        throw new SafeConfigError('UNSUPPORTED_PATH', '自动写入仅支持常规路径 ~/SillyTavern。');
    }
}

function desiredConfig(current, request) {
    const requestedEntry = request.mode === 'network' ? request.subnet24 : request.deviceIp;
    const whitelist = [...current.allowed.whitelist];
    for (const entry of [...LOCALHOST_ENTRIES, requestedEntry]) {
        if (!whitelist.includes(entry)) whitelist.push(entry);
    }
    return {
        requestedEntry,
        allowed: { listen: true, whitelistMode: true, whitelist },
    };
}

function changeList(before, after) {
    return ALLOWED_FIELDS.flatMap(field => isDeepStrictEqual(before[field], after[field])
        ? []
        : [{ field, before: before[field], after: after[field] }]);
}

function withoutAllowedFields(root) {
    const copy = structuredClone(root);
    for (const field of ALLOWED_FIELDS) delete copy[field];
    return copy;
}

function timestamp(date = new Date()) {
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

async function writeExclusiveSynced(filePath, source, mode) {
    const handle = await fs.open(filePath, 'wx', mode);
    try {
        await handle.writeFile(source, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function removeIfPresent(filePath) {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

async function syncDirectory(directory) {
    let handle;
    try {
        handle = await fs.open(directory, 'r');
        await handle.sync();
    } catch (error) {
        if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
    } finally {
        await handle?.close();
    }
}

async function uniqueBackupPath(serverRoot, prefix, now) {
    const base = path.join(serverRoot, `${CONFIG_FILE}.${prefix}-${timestamp(now)}.bak`);
    for (let suffix = 0; suffix < 100; suffix++) {
        const candidate = suffix === 0 ? base : base.replace(/\.bak$/, `-${suffix}.bak`);
        if (!await fileExists(candidate)) return candidate;
    }
    throw new SafeConfigError('BACKUP_NAME_EXHAUSTED', '无法创建唯一的备份文件名，原配置未被修改。');
}

async function replaceConfig({ serverRoot, current, nextSource, verify, backupPrefix, now = new Date(), lifecycleHook, replaceFile = fs.rename }) {
    const tempPath = path.join(serverRoot, `.${CONFIG_FILE}.cross-device-access-helper-${process.pid}-${timestamp(now)}.tmp`);
    let backupPath = null;
    try {
        await writeExclusiveSynced(tempPath, nextSource, current.stat.mode & 0o777);
        const verified = await readConfigFile(tempPath, '临时配置');
        verify(verified);
        await lifecycleHook?.('temporary-verified');

        const latestSource = await fs.readFile(current.configPath, 'utf8');
        if (latestSource !== current.source) {
            throw new SafeConfigError('CONFIG_CHANGED', '操作期间 config.yaml 被其他程序修改，已停止且不会覆盖。');
        }

        backupPath = await uniqueBackupPath(serverRoot, backupPrefix, now);
        await writeExclusiveSynced(backupPath, current.source, current.stat.mode & 0o777);
        await lifecycleHook?.('backup-created');

        const finalSource = await fs.readFile(current.configPath, 'utf8');
        if (finalSource !== current.source) {
            throw new SafeConfigError('CONFIG_CHANGED', '操作期间 config.yaml 被其他程序修改，已停止且不会覆盖。');
        }
        await replaceFile(tempPath, current.configPath);
        await syncDirectory(serverRoot);
        return backupPath;
    } catch (error) {
        await removeIfPresent(tempPath);
        throw error;
    }
}

export async function findLatestBackup(serverRoot = process.cwd()) {
    const entries = await fs.readdir(serverRoot, { withFileTypes: true });
    const candidates = await Promise.all(entries
        .filter(entry => entry.isFile() && BACKUP_PATTERN.test(entry.name))
        .map(async entry => ({ name: entry.name, stat: await fs.stat(path.join(serverRoot, entry.name)) })));
    candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || right.name.localeCompare(left.name));
    return candidates[0]?.name ?? null;
}

export async function getStatus({
    serverRoot = process.cwd(),
    runtime = globalThis.COMMAND_LINE_ARGS,
    interfaces = os.networkInterfaces(),
    platform = process.platform,
    expectedRoot,
    activeConfigSnapshot = null,
} = {}) {
    assertDefaultConfigPath(serverRoot, runtime);
    const config = await readConfig(serverRoot);
    const active = runtimeSnapshot(runtime, config.configuredPort);
    const lanIpv4 = privateLanAddresses(interfaces);
    const accessUrls = lanIpv4.map(item => `${active.protocol}://${item.address}:${active.port}`);

    const runtimeAllowed = activeConfigSnapshot ? {
        listen: typeof runtime?.listen === 'boolean' ? runtime.listen : activeConfigSnapshot.listen,
        whitelistMode: typeof runtime?.whitelistMode === 'boolean' ? runtime.whitelistMode : activeConfigSnapshot.whitelistMode,
        whitelist: activeConfigSnapshot.whitelist,
    } : null;
    const latestBackup = await findLatestBackup(serverRoot);
    return {
        phase: 'full',
        writeEnabled: isDefaultTermuxRoot(serverRoot, platform, expectedRoot) && !config.legacyWhitelistExists,
        platform,
        supportedPlatform: platform === 'android',
        config: config.allowed,
        runtime: { ...active, whitelist: runtimeAllowed?.whitelist ?? null },
        network: { lanIpv4, accessUrls },
        legacyWhitelist: {
            exists: config.legacyWhitelistExists,
            blocksApply: config.legacyWhitelistExists,
        },
        backups: { available: Boolean(latestBackup), latestName: latestBackup },
        restartRequired: runtimeAllowed ? !isDeepStrictEqual(config.allowed, runtimeAllowed) : false,
    };
}

export async function previewChange(body, {
    serverRoot = process.cwd(),
    runtime = globalThis.COMMAND_LINE_ARGS,
    platform = process.platform,
    expectedRoot,
} = {}) {
    const request = validateChangeRequest(body);
    if (!request.valid) {
        throw new SafeConfigError('INVALID_REQUEST', request.message);
    }

    assertDefaultConfigPath(serverRoot, runtime);
    const current = await readConfig(serverRoot);
    const next = desiredConfig(current, request);
    const changes = changeList(current.allowed, next.allowed);
    const supported = isDefaultTermuxRoot(serverRoot, platform, expectedRoot);

    return {
        request: { deviceIp: request.deviceIp, mode: request.mode, whitelistEntry: next.requestedEntry },
        changes,
        changed: changes.length > 0,
        canApply: changes.length > 0 && supported && !current.legacyWhitelistExists,
        applyBlockedReasons: [
            ...(!supported ? ['自动写入仅支持 Android Termux 常规路径 ~/SillyTavern。'] : []),
            ...(current.legacyWhitelistExists ? ['检测到 whitelist.txt；它会覆盖 config.yaml 中的白名单。'] : []),
        ],
        preservedWhitelist: current.allowed.whitelist,
    };
}

export async function applyLanSettings(body, {
    serverRoot = process.cwd(),
    runtime = globalThis.COMMAND_LINE_ARGS,
    platform = process.platform,
    expectedRoot,
    now = new Date(),
    lifecycleHook,
    replaceFile = fs.rename,
} = {}) {
    const request = validateChangeRequest(body);
    if (!request.valid) throw new SafeConfigError('INVALID_REQUEST', request.message);
    assertDefaultConfigPath(serverRoot, runtime);
    assertWritableEnvironment(serverRoot, platform, expectedRoot);
    const current = await readConfig(serverRoot);
    if (current.legacyWhitelistExists) {
        throw new SafeConfigError('LEGACY_WHITELIST', '检测到 whitelist.txt；它会覆盖 config.yaml，已拒绝自动修改。');
    }
    const next = desiredConfig(current, request);
    const changes = changeList(current.allowed, next.allowed);
    if (changes.length === 0) {
        return { changed: false, changes: [], backupName: null, restartRequired: false };
    }

    for (const field of ALLOWED_FIELDS) current.document.set(field, next.allowed[field]);
    const nextSource = String(current.document);
    const backupPath = await replaceConfig({
        serverRoot,
        current,
        nextSource,
        backupPrefix: 'cross-device-access-helper-backup',
        now,
        lifecycleHook,
        replaceFile,
        verify(verified) {
            if (!isDeepStrictEqual(verified.allowed, next.allowed)) {
                throw new SafeConfigError('VERIFY_FAILED', '临时配置中的目标字段验证失败，原配置未被修改。');
            }
            if (!isDeepStrictEqual(withoutAllowedFields(verified.root), withoutAllowedFields(current.root))) {
                throw new SafeConfigError('UNEXPECTED_CHANGE', '检测到允许字段之外的配置变化，原配置未被修改。');
            }
        },
    });
    return {
        changed: true,
        changes,
        backupName: path.basename(backupPath),
        restartRequired: true,
        whitelistEntry: next.requestedEntry,
    };
}

function validateEmptyBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
        throw new SafeConfigError('INVALID_REQUEST', '恢复接口不接受路径或其他参数。');
    }
}

export async function restoreLatestBackup(body, {
    serverRoot = process.cwd(),
    runtime = globalThis.COMMAND_LINE_ARGS,
    platform = process.platform,
    expectedRoot,
    now = new Date(),
    lifecycleHook,
    replaceFile = fs.rename,
} = {}) {
    validateEmptyBody(body);
    assertDefaultConfigPath(serverRoot, runtime);
    assertWritableEnvironment(serverRoot, platform, expectedRoot);
    const backupName = await findLatestBackup(serverRoot);
    if (!backupName) throw new SafeConfigError('BACKUP_NOT_FOUND', '没有找到本助手创建的配置备份。');

    const current = await readConfig(serverRoot);
    const backup = await readConfigFile(path.join(serverRoot, backupName), '待恢复备份');
    if (backup.source === current.source) {
        return { changed: false, restoredBackupName: backupName, safetyBackupName: null, restartRequired: false };
    }
    const safetyBackupPath = await replaceConfig({
        serverRoot,
        current,
        nextSource: backup.source,
        backupPrefix: 'cross-device-access-helper-pre-restore',
        now,
        lifecycleHook,
        replaceFile,
        verify(verified) {
            if (!isDeepStrictEqual(verified.root, backup.root)) {
                throw new SafeConfigError('VERIFY_FAILED', '临时恢复配置与备份内容不一致，原配置未被修改。');
            }
        },
    });
    return {
        changed: true,
        restoredBackupName: backupName,
        safetyBackupName: path.basename(safetyBackupPath),
        restartRequired: true,
    };
}
