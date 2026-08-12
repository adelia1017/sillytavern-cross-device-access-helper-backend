const PRIVATE_RANGES = Object.freeze([
    { first: 10, secondMin: 0, secondMax: 255 },
    { first: 172, secondMin: 16, secondMax: 31 },
    { first: 192, secondMin: 168, secondMax: 168 },
]);

export const CHANGE_MODES = Object.freeze(['single', 'network']);

export function parsePrivateIpv4(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(text)) {
        return { valid: false, code: text ? 'format' : 'empty' };
    }

    const octets = text.split('.').map(Number);
    if (octets.some(octet => octet > 255)) {
        return { valid: false, code: 'range' };
    }

    const isPrivate = PRIVATE_RANGES.some(range => (
        octets[0] === range.first
        && octets[1] >= range.secondMin
        && octets[1] <= range.secondMax
    ));
    if (!isPrivate) {
        return { valid: false, code: 'not-private' };
    }

    return {
        valid: true,
        ip: octets.join('.'),
        subnet24: `${octets[0]}.${octets[1]}.${octets[2]}.0/24`,
    };
}

export function validateChangeRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { valid: false, message: '请求内容必须是 JSON 对象。' };
    }

    const keys = Object.keys(body).sort();
    if (keys.length !== 2 || keys[0] !== 'deviceIp' || keys[1] !== 'mode') {
        return { valid: false, message: '只允许提交 deviceIp 和 mode。' };
    }

    if (!CHANGE_MODES.includes(body.mode)) {
        return { valid: false, message: 'mode 只能是 single 或 network。' };
    }

    const ip = parsePrivateIpv4(body.deviceIp);
    if (!ip.valid) {
        return { valid: false, message: 'deviceIp 必须是有效的私有局域网 IPv4 地址。' };
    }

    return { valid: true, deviceIp: ip.ip, subnet24: ip.subnet24, mode: body.mode };
}
