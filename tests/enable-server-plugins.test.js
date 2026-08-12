import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'yaml';
import { enableServerPlugins } from '../scripts/enable-server-plugins.mjs';

async function fixture(source) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-device-backend-home-'));
    const root = path.join(home, 'SillyTavern');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'config.yaml'), source, 'utf8');
    const pluginRoot = path.join(root, 'plugins', 'cross-device-access-helper-backend');
    await fs.mkdir(path.join(pluginRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({ main: 'dist/server-plugin.mjs' }));
    await fs.writeFile(path.join(pluginRoot, 'dist', 'server-plugin.mjs'), 'export const info = {};');
    return { home, root, pluginRoot };
}

async function withHome(home, callback) {
    const original = process.env.HOME;
    process.env.HOME = home;
    try {
        return await callback();
    } finally {
        if (original === undefined) delete process.env.HOME;
        else process.env.HOME = original;
    }
}

test('backs up and enables only enableServerPlugins', async t => {
    const original = 'listen: false\nwhitelistMode: true\nwhitelist:\n  - ::1\nport: 9000\nenableServerPlugins: false\n';
    const { home, root, pluginRoot } = await fixture(original);
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const result = await withHome(home, () => enableServerPlugins({
        serverRoot: root,
        platform: 'android',
        yamlModule: yaml,
        now: new Date(2026, 7, 12, 12, 34, 56),
        pluginRoot,
    }));
    assert.equal(result.changed, true);
    assert.equal(await fs.readFile(result.backupPath, 'utf8'), original);
    const next = yaml.parse(await fs.readFile(path.join(root, 'config.yaml'), 'utf8'));
    assert.deepEqual(next, {
        listen: false,
        whitelistMode: true,
        whitelist: ['::1'],
        port: 9000,
        enableServerPlugins: true,
    });
});

test('does not create a backup when already enabled', async t => {
    const original = 'listen: false\nwhitelistMode: true\nwhitelist: []\nenableServerPlugins: true\n';
    const { home, root, pluginRoot } = await fixture(original);
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const result = await withHome(home, () => enableServerPlugins({ serverRoot: root, platform: 'android', yamlModule: yaml, pluginRoot }));
    assert.equal(result.changed, false);
    assert.equal(result.backupPath, null);
    assert.equal(await fs.readFile(path.join(root, 'config.yaml'), 'utf8'), original);
});

test('rejects duplicate keys without changing config', async t => {
    const original = 'listen: false\nwhitelistMode: true\nwhitelist: []\nenableServerPlugins: false\nenableServerPlugins: true\n';
    const { home, root, pluginRoot } = await fixture(original);
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    await assert.rejects(
        () => withHome(home, () => enableServerPlugins({ serverRoot: root, platform: 'android', yamlModule: yaml, pluginRoot })),
        /重复键/,
    );
    assert.equal(await fs.readFile(path.join(root, 'config.yaml'), 'utf8'), original);
    assert.deepEqual((await fs.readdir(root)).sort(), ['config.yaml', 'plugins']);
});

test('rejects unsupported platform and nonstandard path', async t => {
    const { home, root, pluginRoot } = await fixture('listen: false\nwhitelistMode: true\nwhitelist: []\n');
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    await assert.rejects(() => withHome(home, () => enableServerPlugins({ serverRoot: root, platform: 'win32', yamlModule: yaml, pluginRoot })), /Android Termux/);
    await assert.rejects(() => withHome(home, () => enableServerPlugins({ serverRoot: home, platform: 'android', yamlModule: yaml, pluginRoot })), /常规路径/);
});

test('refuses to enable when the backend is outside plugins or its bundle is missing', async t => {
    const { home, root, pluginRoot } = await fixture('listen: false\nwhitelistMode: true\nwhitelist: []\n');
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    await assert.rejects(
        () => withHome(home, () => enableServerPlugins({ serverRoot: root, platform: 'android', yamlModule: yaml, pluginRoot: home })),
        /plugins/,
    );
    await fs.unlink(path.join(pluginRoot, 'dist', 'server-plugin.mjs'));
    await assert.rejects(
        () => withHome(home, () => enableServerPlugins({ serverRoot: root, platform: 'android', yamlModule: yaml, pluginRoot })),
        /打包后端文件/,
    );
});
