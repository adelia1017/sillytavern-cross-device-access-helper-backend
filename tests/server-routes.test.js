import test from 'node:test';
import assert from 'node:assert/strict';
import { init, info } from '../server/index.mjs';

class FakeRouter {
    constructor() {
        this.routes = new Map();
        this.middleware = [];
    }

    use(handler) {
        this.middleware.push(handler);
    }

    get(path, handler) {
        this.routes.set(`GET ${path}`, handler);
    }

    post(path, handler) {
        this.routes.set(`POST ${path}`, handler);
    }
}

function fakeResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        set(name, value) {
            this.headers[name] = value;
            return this;
        },
        status(value) {
            this.statusCode = value;
            return this;
        },
        json(value) {
            this.body = value;
            return this;
        },
    };
}

test('registers only the four documented endpoints under a valid plugin ID', async () => {
    const router = new FakeRouter();
    await init(router);
    assert.match(info.id, /^[a-z0-9_-]+$/);
    assert.deepEqual([...router.routes.keys()].sort(), [
        'GET /status',
        'POST /apply-lan-settings',
        'POST /preview-change',
        'POST /restore-latest-backup',
    ]);
});

test('write and restore routes stay disabled during read-only phase', async () => {
    const router = new FakeRouter();
    await init(router);
    for (const path of ['POST /apply-lan-settings', 'POST /restore-latest-backup']) {
        const response = fakeResponse();
        router.routes.get(path)({}, response);
        assert.equal(response.statusCode, 501);
        assert.equal(response.body.ok, false);
        assert.equal(response.body.error.code, 'READ_ONLY_PHASE');
        assert.equal(response.headers['Cache-Control'], 'no-store');
    }
});

test('oversized declared requests are rejected before a route handler', async () => {
    const router = new FakeRouter();
    await init(router);
    const response = fakeResponse();
    let continued = false;
    router.middleware[0]({ get: () => '4097' }, response, () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(response.statusCode, 413);
    assert.equal(response.body.error.code, 'REQUEST_TOO_LARGE');
});
