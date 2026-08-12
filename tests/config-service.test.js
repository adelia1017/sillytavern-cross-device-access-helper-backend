import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getStatus, previewChange, readConfig, SafeConfigError } from '../server/config-service.mjs';

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
        interfaces: { wlan0: [{ family: 'IPv4', internal: false, address: '192.168.5.7' }] },
    });
    assert.deepEqual(status.config, { listen: false, whitelistMode: true, whitelist: ['::1', '127.0.0.1'] });
    assert.deepEqual(status.network.accessUrls, ['http://192.168.5.7:8123']);
    assert.equal(JSON.stringify(status).includes('never-return-this'), false);
    assert.equal(status.writeEnabled, false);
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
    const result = await previewChange({ deviceIp: '192.168.1.9', mode: 'single' }, { serverRoot: root });
    const whitelist = result.changes.find(change => change.field === 'whitelist').after;
    assert.deepEqual(whitelist, ['192.168.1.2', '::1', '127.0.0.1', '192.168.1.9']);
    assert.equal(result.canApply, false);
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
