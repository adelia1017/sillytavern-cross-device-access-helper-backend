import { applyLanSettings, getStatus, previewChange, readConfig, restoreLatestBackup, SafeConfigError } from './config-service.mjs';

const MAX_REQUEST_BYTES = 4096;
let writeOperationInProgress = false;

export const info = Object.freeze({
    id: 'cross-device-access-helper-backend',
    name: '跨设备访问助手（后端版）',
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

async function runExclusiveWrite(operation) {
    if (writeOperationInProgress) {
        throw new SafeConfigError('OPERATION_IN_PROGRESS', '另一项配置操作正在进行，请稍后再试。');
    }
    writeOperationInProgress = true;
    try {
        return await operation();
    } finally {
        writeOperationInProgress = false;
    }
}

export async function init(router) {
    router.use(rejectOversizedRequest);
    let activeConfigSnapshot = null;
    try {
        activeConfigSnapshot = (await readConfig()).allowed;
    } catch (error) {
        console.error('[cross-device-access-helper] Unable to capture startup config:', error?.message ?? error);
    }

    router.get('/status', async (_request, response) => {
        try {
            return noStore(response).json({ ok: true, data: await getStatus({ activeConfigSnapshot }) });
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

    router.post('/apply-lan-settings', async (request, response) => {
        try {
            return noStore(response).json({
                ok: true,
                data: await runExclusiveWrite(() => applyLanSettings(request.body)),
            });
        } catch (error) {
            return sendError(response, error);
        }
    });

    router.post('/restore-latest-backup', async (request, response) => {
        try {
            return noStore(response).json({
                ok: true,
                data: await runExclusiveWrite(() => restoreLatestBackup(request.body)),
            });
        } catch (error) {
            return sendError(response, error);
        }
    });

    console.log('[cross-device-access-helper] Loaded. Safe apply and restore endpoints are available.');
}

export async function exit() {}
