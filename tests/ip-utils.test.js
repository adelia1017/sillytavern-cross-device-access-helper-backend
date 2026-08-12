import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrivateIpv4, validateChangeRequest } from '../shared/ip-utils.js';

test('accepts RFC1918 IPv4 addresses and computes /24', () => {
    assert.deepEqual(parsePrivateIpv4('192.168.123.17'), {
        valid: true,
        ip: '192.168.123.17',
        subnet24: '192.168.123.0/24',
    });
    assert.equal(parsePrivateIpv4('172.31.9.8').valid, true);
    assert.equal(parsePrivateIpv4('10.0.0.8').valid, true);
});

test('rejects public, malformed, and non-canonical addresses', () => {
    for (const value of ['8.8.8.8', '192.168.1.999', '192.168.001.2', '127.0.0.1', '']) {
        assert.equal(parsePrivateIpv4(value).valid, false, value);
    }
});

test('request schema accepts exactly deviceIp and mode', () => {
    assert.equal(validateChangeRequest({ deviceIp: '192.168.1.8', mode: 'single' }).valid, true);
    assert.equal(validateChangeRequest({ deviceIp: '192.168.1.8', mode: 'all' }).valid, false);
    assert.equal(validateChangeRequest({ deviceIp: '192.168.1.8', mode: 'single', path: '/tmp/x' }).valid, false);
    assert.equal(validateChangeRequest({ mode: 'single' }).valid, false);
});
