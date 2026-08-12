import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    applyLanSettings,
    findLatestBackup,
    getStatus,
    previewChange,
    readConfig,
    restoreLatestBackup,
    SafeConfigError,
} from '../server/config-service.mjs';

async function fixture(source, extra = async () => {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-device-helper-'));
    await fs.writeFile(path.join(root, 'config.yaml'), source, 'utf8');
    await extra(root);
    return root;
}

test('reads only supported config fields and reports runtime network URLs', async t => {
    const root = await fixture('listen: false\nwhitelistMode: true\nwhitelist:\n  - ::1\n  - 127.0.0.1\nport: 9000\napi_key: never-return-this\n');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const status = await getStatus({
        serverRoot: root,
        runtime: { listen: false, whitelistMode: true, port: 8123, ssl: false },
        platform: 'android',
        expectedRoot: root,
        interfaces: { wlan0: [{ family: 'IPv4', internal: false, address: '192.168.5.7' }] },
    });
    assert.deepEqual(status.config, { listen: false, whitelistMode: true, whitelist: ['::1', '127.0.0.1'] });
    assert.deepEqual(status.network.accessUrls, ['http://192.168.5.7:8123']);
    assert.equal(JSON.stringify(status).includes('never-return-this'), false);
    assert.equal(status.writeEnabled, true);
});

test('status reports when the saved configuration differs from this running process', async t => {
    const root = await fixture('listen: true\nwhitelistMode: true\nwhitelist:\n  - ::1\n  - 127.0.0.1\n  - 192.168.1.9\n');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const status = await getStatus({
        serverRoot: root,
        runtime: {},
        platform: 'android',
        expectedRoot: root,
        activeConfigSnapshot: { listen: false, whitelistMode: false, whitelist: ['::1', '127.0.0.1'] },
        interfaces: {},
    });
    assert.equal(status.restartRequired, true);
    assert.deepEqual(status.runtime.whitelist, ['::1', '127.0.0.1']);
});

test('rejects duplicate YAML keys', async t => {
    const root = await fixture('listen: false\nlisten: true\nwhitelistMode: true\nwhitelist: []\n');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(() => readConfig(root), error => error instanceof SafeConfigError && error.code === 'DUPLICATE_KEY');
});

test('rejects non-default active config paths', async t => {
    const root = await fixture('listen: false\nwhitelistMode: true\nwhitelist: []\n');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(
        () => getStatus({ serverRoot: root, runtime: { configPath: './another.yaml' } }),
        error => error.code === 'UNSUPPORTED_CONFIG_PATH',
    );
    await assert.rejects(
        () => previewChange(
            { deviceIp: '192.168.1.9', mode: 'single' },
            { serverRoot: root, runtime: { configPath: './another.yaml' } },
        ),
        error => error.code === 'UNSUPPORTED_CONFIG_PATH',
    );
});

test('rejects a symlinked config file when supported', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-device-helper-'));
    const target = path.join(root, 'actual.yaml');
    await fs.writeFile(target, 'listen: false\nwhitelistMode: true\nwhitelist: []\n');
    try {
        await fs.symlink(target, path.join(root, 'config.yaml'));
    } catch (error) {
        if (error.code === 'EPERM') return t.skip('Symlink creation is unavailable');
        throw error;
    }
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(() => readConfig(root), error => error.code === 'UNSAFE_CONFIG_FILE');
});

test('preview preserves existing entries and adds localhost plus one device', async t => {
    const root = await fixture('listen: false\nwhitelistMode: false\nwhitelist:\n  - 192.168.1.2\n');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await previewChange(
        { deviceIp: '192.168.1.9', mode: 'single' },
        { serverRoot: root, platform: 'android', expectedRoot: root },
    );
    const whitelist = result.changes.find(change => change.field === 'whitelist').after;
    assert.deepEqual(whitelist, ['192.168.1.2', '::1', '127.0.0.1', '192.168.1.9']);
    assert.equal(result.canApply, true);
});

test('preview derives /24 and detects legacy whitelist override', async t => {
    const root = await fixture(
        'listen: true\nwhitelistMode: true\nwhitelist: []\n',
        directory => fs.writeFile(path.join(directory, 'whitelist.txt'), '127.0.0.1\n'),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await previewChange({ deviceIp: '172.16.20.99', mode: 'network' }, { serverRoot: root });
    assert.equal(result.request.whitelistEntry, '172.16.20.0/24');
    assert.equal(result.applyBlockedReasons.some(reason => reason.includes('whitelist.txt')), true);
});

test('applies only allowed fields, creates a backup, and reports restart required', async t => {
    const original = 'listen: false\nwhitelistMode: false\nwhitelist:\n  - 192.168.1.2\nport: 9000\nnested:\n  keep: yes\n';
    const root = await fixture(original);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await applyLanSettings(
        { deviceIp: '192.168.1.9', mode: 'single' },
        { serverRoot: root, platform: 'android', expectedRoot: root, now: new Date(2026, 7, 12, 12, 34, 56, 123) },
    );
    assert.equal(result.changed, true);
    assert.equal(result.restartRequired, true);
    assert.match(result.backupName, /^config\.yaml\.cross-device-access-helper-backup-/);
    assert.equal(await fs.readFile(path.join(root, result.backupName), 'utf8'), original);
    const next = await readConfig(root);
    assert.deepEqual(next.allowed, {
        listen: true,
        whitelistMode: true,
        whitelist: ['192.168.1.2', '::1', '127.0.0.1', '192.168.1.9'],
    });
    assert.equal(next.root.port, 9000);
    assert.deepEqual(next.root.nested, { keep: 'yes' });
});

test('apply is idempotent and does not create an unnecessary backup', async t => {
    const root = await fixture('listen: true\nwhitelistMode: true\nwhitelist:\n  - ::1\n  - 127.0.0.1\n  - 192.168.1.9\n');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await applyLanSettings(
        { deviceIp: '192.168.1.9', mode: 'single' },
        { serverRoot: root, platform: 'android', expectedRoot: root },
    );
    assert.deepEqual(result, { changed: false, changes: [], backupName: null, restartRequired: false });
    assert.equal(await findLatestBackup(root), null);
});

test('apply rejects legacy whitelist and non-Termux environments', async t => {
    const root = await fixture(
        'listen: false\nwhitelistMode: true\nwhitelist: []\n',
        directory => fs.writeFile(path.join(directory, 'whitelist.txt'), '127.0.0.1\n'),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(
        () => applyLanSettings({ deviceIp: '192.168.1.9', mode: 'single' }, { serverRoot: root, platform: 'android', expectedRoot: root }),
        error => error.code === 'LEGACY_WHITELIST',
    );
    await assert.rejects(
        () => applyLanSettings({ deviceIp: '192.168.1.9', mode: 'single' }, { serverRoot: root, platform: 'linux', expectedRoot: root }),
        error => error.code === 'UNSUPPORTED_PLATFORM',
    );
});

test('apply refuses to overwrite a config changed during the operation', async t => {
    const original = 'listen: false\nwhitelistMode: true\nwhitelist: []\nport: 8000\n';
    const external = 'listen: false\nwhitelistMode: true\nwhitelist: []\nport: 8123\n';
    const root = await fixture(original);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(
        () => applyLanSettings(
            { deviceIp: '192.168.1.9', mode: 'single' },
            {
                serverRoot: root,
                platform: 'android',
                expectedRoot: root,
                lifecycleHook: stage => stage === 'temporary-verified'
                    ? fs.writeFile(path.join(root, 'config.yaml'), external, 'utf8')
                    : undefined,
            },
        ),
        error => error.code === 'CONFIG_CHANGED',
    );
    assert.equal(await fs.readFile(path.join(root, 'config.yaml'), 'utf8'), external);
    assert.equal(await findLatestBackup(root), null);
});

test('replace failure leaves original config and a valid recovery backup', async t => {
    const original = 'listen: false\nwhitelistMode: true\nwhitelist: []\n';
    const root = await fixture(original);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(
        () => applyLanSettings(
            { deviceIp: '192.168.1.9', mode: 'single' },
            {
                serverRoot: root,
                platform: 'android',
                expectedRoot: root,
                replaceFile: async () => { throw new Error('injected rename failure'); },
            },
        ),
        /injected rename failure/,
    );
    assert.equal(await fs.readFile(path.join(root, 'config.yaml'), 'utf8'), original);
    const backupName = await findLatestBackup(root);
    assert.ok(backupName);
    assert.equal(await fs.readFile(path.join(root, backupName), 'utf8'), original);
});

test('restores only the latest helper backup and creates a pre-restore safety copy', async t => {
    const original = 'listen: false\nwhitelistMode: true\nwhitelist:\n  - ::1\nport: 8000\n';
    const root = await fixture(original);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const applied = await applyLanSettings(
        { deviceIp: '192.168.1.9', mode: 'single' },
        { serverRoot: root, platform: 'android', expectedRoot: root, now: new Date(2026, 7, 12, 12, 0, 0, 1) },
    );
    const changedSource = await fs.readFile(path.join(root, 'config.yaml'), 'utf8');
    const restored = await restoreLatestBackup(
        {},
        { serverRoot: root, platform: 'android', expectedRoot: root, now: new Date(2026, 7, 12, 12, 1, 0, 2) },
    );
    assert.equal(restored.restoredBackupName, applied.backupName);
    assert.match(restored.safetyBackupName, /^config\.yaml\.cross-device-access-helper-pre-restore-/);
    assert.equal(await fs.readFile(path.join(root, restored.safetyBackupName), 'utf8'), changedSource);
    assert.equal(await fs.readFile(path.join(root, 'config.yaml'), 'utf8'), original);
});

test('restore rejects arbitrary fields and reports when no backup exists', async t => {
    const root = await fixture('listen: true\nwhitelistMode: true\nwhitelist: []\n');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(
        () => restoreLatestBackup({ path: '/tmp/anything' }, { serverRoot: root, platform: 'android', expectedRoot: root }),
        error => error.code === 'INVALID_REQUEST',
    );
    await assert.rejects(
        () => restoreLatestBackup({}, { serverRoot: root, platform: 'android', expectedRoot: root }),
        error => error.code === 'BACKUP_NOT_FOUND',
    );
});
