import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('server implementation contains no subprocess or outbound network modules', async () => {
    const files = ['server/index.mjs', 'server/config-service.mjs'];
    const source = (await Promise.all(files.map(file => fs.readFile(path.join(projectRoot, file), 'utf8')))).join('\n');
    for (const forbidden of [
        'node:child_process',
        "from 'child_process'",
        'execFile(',
        'execSync(',
        'spawn(',
        "from 'node:http'",
        "from 'node:https'",
        "from 'node:net'",
        'fetch(',
    ]) {
        assert.equal(source.includes(forbidden), false, forbidden);
    }
});

test('server implementation never names private SillyTavern data domains', async () => {
    const source = await fs.readFile(path.join(projectRoot, 'server/config-service.mjs'), 'utf8');
    for (const forbidden of ['chat', 'character', 'world', 'preset', 'secret', 'api_key', 'dataRoot']) {
        assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
});

test('manual enable script contains no subprocess or outbound network modules', async () => {
    const source = await fs.readFile(path.join(projectRoot, 'scripts/enable-server-plugins.mjs'), 'utf8');
    for (const forbidden of ['node:child_process', 'exec(', 'execFile(', 'spawn(', "from 'node:http'", "from 'node:https'", 'fetch(']) {
        assert.equal(source.includes(forbidden), false, forbidden);
    }
});
