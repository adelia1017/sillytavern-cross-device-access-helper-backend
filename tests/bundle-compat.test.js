import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

class FakeRouter {
    constructor() {
        this.routes = new Map();
    }

    use() {}
    get(route, handler) { this.routes.set(`GET ${route}`, handler); }
    post(route, handler) { this.routes.set(`POST ${route}`, handler); }
}

function fakeResponse() {
    return {
        statusCode: 200,
        body: null,
        set() { return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

test('bundled ESM entry can parse YAML without a global CommonJS require', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-device-bundle-'));
    await fs.writeFile(path.join(root, 'config.yaml'), 'listen: false\nwhitelistMode: true\nwhitelist:\n  - ::1\n');
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const previousDirectory = process.cwd();
    process.chdir(root);
    try {
        const plugin = await import(`../dist/server-plugin.mjs?bundle-test=${Date.now()}`);
        const router = new FakeRouter();
        await plugin.init(router);
        const response = fakeResponse();
        await router.routes.get('GET /status')({}, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.ok, true);
        assert.deepEqual(response.body.data.config, {
            listen: false,
            whitelistMode: true,
            whitelist: ['::1'],
        });
    } finally {
        process.chdir(previousDirectory);
    }
});
