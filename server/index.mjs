import { getStatus, previewChange, SafeConfigError } from './config-service.mjs';

const MAX_REQUEST_BYTES = 4096;

export const info = Object.freeze({
    id: 'cross-device-access-helper',
    name: '跨设备访问助手（高级版）',
    description: '以最小权限检查并配置 SillyTavern 局域网访问。',
});

function noStore(response) {
    response.set('Cache-Control', 'no-store');
    return response;
}

function sendError(response, error) {
    if (error instanceof SafeConfigError) {
        return noStore(response).status(error.code === 'INVALID_REQUEST' ? 400 : 422).json({
            ok: false,
            error: { code: error.code, message: error.publicMessage },
        });
    }
    console.error('[cross-device-access-helper] Request failed:', error?.message ?? error);
    return noStore(response).status(500).json({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: '操作失败，原配置未被修改。' },
    });
}

function rejectOversizedRequest(request, response, next) {
    const length = Number(request.get('content-length') ?? 0);
    if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
        return noStore(response).status(413).json({
            ok: false,
            error: { code: 'REQUEST_TOO_LARGE', message: '请求内容过大。' },
        });
    }
    next();
}

export async function init(router) {
    router.use(rejectOversizedRequest);

    router.get('/status', async (_request, response) => {
        try {
            return noStore(response).json({ ok: true, data: await getStatus() });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.post('/preview-change', async (request, response) => {
        try {
            return noStore(response).json({ ok: true, data: await previewChange(request.body) });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.post('/apply-lan-settings', (_request, response) => noStore(response).status(501).json({
        ok: false,
        error: { code: 'READ_ONLY_PHASE', message: '安全写入尚未启用；当前版本不会修改 config.yaml。' },
    }));

    router.post('/restore-latest-backup', (_request, response) => noStore(response).status(501).json({
        ok: false,
        error: { code: 'READ_ONLY_PHASE', message: '恢复功能尚未启用；当前版本不会修改任何文件。' },
    }));

    console.log('[cross-device-access-helper] Loaded in read-only preview phase.');
}

export async function exit() {}
