import type {
    ExtensionMessage,
    MessageResponse,
    Project,
    Capture,
    PresignedUrlResponse,
} from '../lib/types';

const API_BASE = 'https://mind-stack-theta.vercel.app';
const STORAGE_JWT_KEY = 'mindstack_jwt';
const STORAGE_SESSION_KEY = 'mindstack_session_id';
const STORAGE_PROJECT_KEY = 'mindstack_project_id';
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat State
// ─────────────────────────────────────────────────────────────────────────────

let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(sessionId: string): void {
    if (heartbeatIntervalId !== null) return; // already running

    console.log('[MindStack BG] Heartbeat started for session:', sessionId);
    heartbeatIntervalId = setInterval(async () => {
        const stored = await chrome.storage.local.get([STORAGE_JWT_KEY, STORAGE_SESSION_KEY]);
        const currentSessionId = stored[STORAGE_SESSION_KEY] as string | undefined;
        if (!currentSessionId) {
            clearHeartbeat();
            return;
        }
        await apiFetch('/api/sessions/heartbeat', {
            method: 'POST',
            body: { session_id: currentSessionId },
        });
        console.log('[MindStack BG] Heartbeat sent for session:', currentSessionId);
    }, HEARTBEAT_INTERVAL_MS);
}

function clearHeartbeat(): void {
    if (heartbeatIntervalId !== null) {
        clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = null;
        console.log('[MindStack BG] Heartbeat cleared.');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT-Gated Fetch Helper
// ─────────────────────────────────────────────────────────────────────────────

interface ApiFetchOptions {
    method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
    body?: unknown;
    skipAuth?: boolean;
}

async function apiFetch<T>(
    path: string,
    options: ApiFetchOptions = {}
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
    const stored = await chrome.storage.local.get([STORAGE_JWT_KEY]);
    const jwt = stored[STORAGE_JWT_KEY] as string | undefined;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (!options.skipAuth) {
        if (!jwt) {
            return { ok: false, status: 401, data: null, error: 'No JWT found in storage.' };
        }
        headers['Authorization'] = `Bearer ${jwt}`;
    }

    try {
        const res = await fetch(`${API_BASE}${path}`, {
            method: options.method ?? 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });

        if (res.status === 401) {
            await handle401();
            return { ok: false, status: 401, data: null, error: 'Unauthorized — session expired.' };
        }

        let data: T | null = null;
        try {
            data = (await res.json()) as T;
        } catch {
            // non-JSON response
        }

        return {
            ok: res.ok,
            status: res.status,
            data,
            error: res.ok ? null : `HTTP ${res.status}`,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Network error';
        return { ok: false, status: 0, data: null, error: message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 401 Handler — Fix ⑤
// ─────────────────────────────────────────────────────────────────────────────

async function handle401(): Promise<void> {
    clearHeartbeat();
    await chrome.storage.local.remove([STORAGE_JWT_KEY, STORAGE_SESSION_KEY, STORAGE_PROJECT_KEY]);
    console.warn('[MindStack BG] 401 received — cleared JWT and session.');

    try {
        chrome.notifications.create('mindstack-auth-expired', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon48.png'),
            title: 'MindStack Session Expired',
            message: 'Click the extension icon to log in again.',
            priority: 2,
        });
    } catch (e) {
        console.warn('[MindStack BG] Could not create notification:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage Change Listener — auto-manage heartbeat
// ─────────────────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes[STORAGE_SESSION_KEY]) {
        const newValue = changes[STORAGE_SESSION_KEY].newValue as string | undefined;
        if (newValue) {
            startHeartbeat(newValue);
        } else {
            clearHeartbeat();
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// On Extension Install/Startup — resume heartbeat if session exists
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
    const stored = await chrome.storage.local.get([STORAGE_SESSION_KEY]);
    const sessionId = stored[STORAGE_SESSION_KEY] as string | undefined;
    if (sessionId) {
        startHeartbeat(sessionId);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Main Message Router
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, _sender, sendResponse) => {
        handleMessage(message)
            .then((response) => sendResponse(response))
            .catch((err) =>
                sendResponse({
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                } satisfies MessageResponse)
            );

        return true; // keep message channel open for async response
    }
);

async function handleMessage(message: ExtensionMessage): Promise<MessageResponse> {
    switch (message.type) {
        // ── GET_PROJECTS ─────────────────────────────────────────────
        case 'GET_PROJECTS': {
            const result = await apiFetch<{ projects: Project[] }>('/api/projects');
            if (!result.ok) return { success: false, error: result.error ?? 'Failed to fetch projects' };
            return { success: true, data: result.data?.projects ?? [] };
        }

        // ── CREATE_PROJECT ────────────────────────────────────────────
        case 'CREATE_PROJECT': {
            const result = await apiFetch<{ project_id: string }>('/api/projects', {
                method: 'POST',
                body: { name: message.name, description: message.description ?? '' },
            });
            if (!result.ok) return { success: false, error: result.error ?? 'Failed to create project' };
            return { success: true, data: result.data };
        }

        // ── START_SESSION ─────────────────────────────────────────────
        case 'START_SESSION': {
            const result = await apiFetch<{ session_id: string }>('/api/sessions/start', {
                method: 'POST',
                body: { project_id: message.project_id },
            });
            if (!result.ok || !result.data?.session_id) {
                return { success: false, error: result.error ?? 'Failed to start session' };
            }

            const sessionId = result.data.session_id;
            await chrome.storage.local.set({
                [STORAGE_SESSION_KEY]: sessionId,
                [STORAGE_PROJECT_KEY]: message.project_id,
            });
            startHeartbeat(sessionId);
            console.log('[MindStack BG] Session started:', sessionId);
            return { success: true, data: { session_id: sessionId } };
        }

        // ── END_SESSION ───────────────────────────────────────────────
        case 'END_SESSION': {
            const stored = await chrome.storage.local.get([STORAGE_SESSION_KEY]);
            const sessionId = stored[STORAGE_SESSION_KEY] as string | undefined;

            if (!sessionId) {
                return { success: false, error: 'No active session to end.' };
            }

            const result = await apiFetch('/api/sessions/end', {
                method: 'POST',
                body: { session_id: sessionId },
            });

            clearHeartbeat();
            await chrome.storage.local.remove([STORAGE_SESSION_KEY]);
            console.log('[MindStack BG] Session ended:', sessionId);
            return { success: result.ok, error: result.error ?? undefined };
        }

        // ── INGEST_BROWSER ────────────────────────────────────────────
        case 'INGEST_BROWSER': {
            // Always re-read session/project from storage for MV3 safety
            const stored = await chrome.storage.local.get([STORAGE_SESSION_KEY, STORAGE_PROJECT_KEY]);
            const storedSessionId = stored[STORAGE_SESSION_KEY] as string | undefined;
            const storedProjectId = stored[STORAGE_PROJECT_KEY] as string | undefined;

            if (!storedSessionId || !storedProjectId) {
                console.warn('[MindStack BG] INGEST_BROWSER called without active session — ignoring.');
                return { success: false, error: 'No active session.' };
            }

            const payload = {
                ...message.payload,
                session_id: storedSessionId,
                project_id: storedProjectId,
            };

            const result = await apiFetch<{ capture_id: string }>('/api/ingest/browser', {
                method: 'POST',
                body: payload,
            });

            if (!result.ok) return { success: false, error: result.error ?? 'Ingest failed' };
            console.log(`[MindStack BG] Ingested ${payload.capture_type}:`, result.data?.capture_id);
            return { success: true, data: result.data };
        }

        // ── INGEST_VIDEO ──────────────────────────────────────────────
        case 'INGEST_VIDEO': {
            const stored = await chrome.storage.local.get([STORAGE_SESSION_KEY, STORAGE_PROJECT_KEY]);
            const sessionId = stored[STORAGE_SESSION_KEY] as string | undefined;
            const projectId = stored[STORAGE_PROJECT_KEY] as string | undefined;

            if (!sessionId || !projectId) {
                return { success: false, error: 'No active session.' };
            }

            const { source_url, page_title, video_start_time, video_end_time, base64Frame } =
                message.payload;

            // Step 1: Get presigned URL
            const presignedResult = await apiFetch<PresignedUrlResponse>('/api/vault/presigned-url', {
                method: 'POST',
                body: { file_name: 'keyframe.jpg', file_type: 'image/jpeg' },
            });

            if (!presignedResult.ok || !presignedResult.data) {
                return { success: false, error: presignedResult.error ?? 'Failed to get presigned URL' };
            }

            const { upload_url, s3_url } = presignedResult.data;

            // Step 2: PUT the Base64 frame to S3
            try {
                const binaryString = atob(base64Frame.replace(/^data:image\/jpeg;base64,/, ''));
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                const s3PutRes = await fetch(upload_url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'image/jpeg' },
                    body: bytes.buffer as ArrayBuffer,
                });

                if (!s3PutRes.ok) {
                    console.warn('[MindStack BG] S3 PUT failed:', s3PutRes.status);
                }
            } catch (e) {
                console.warn('[MindStack BG] S3 frame upload error:', e);
            }

            // Step 3: Ingest the video segment
            const ingestResult = await apiFetch<{ capture_id: string }>('/api/ingest/browser', {
                method: 'POST',
                body: {
                    session_id: sessionId,
                    project_id: projectId,
                    capture_type: 'VIDEO_SEGMENT',
                    source_url,
                    page_title,
                    video_start_time,
                    video_end_time,
                    priority: 1,
                    attachments: [
                        { s3_url, file_type: 'VIDEO_KEYFRAME', file_name: 'keyframe.jpg' },
                    ],
                },
            });

            if (!ingestResult.ok) {
                return { success: false, error: ingestResult.error ?? 'Video ingest failed' };
            }

            console.log('[MindStack BG] Video segment ingested:', ingestResult.data?.capture_id);
            return { success: true, data: ingestResult.data };
        }

        // ── GET_PRESIGNED_URL ─────────────────────────────────────────
        case 'GET_PRESIGNED_URL': {
            const result = await apiFetch<PresignedUrlResponse>('/api/vault/presigned-url', {
                method: 'POST',
                body: { file_name: message.file_name, file_type: message.file_type },
            });

            if (!result.ok || !result.data) {
                return { success: false, error: result.error ?? 'Failed to get presigned URL' };
            }

            // Return the URLs to the Popup — the Popup executes the S3 PUT directly (Fix ②)
            return { success: true, data: result.data };
        }

        // ── GET_CAPTURES ──────────────────────────────────────────────
        case 'GET_CAPTURES': {
            const result = await apiFetch<{ captures: Capture[] }>(
                `/api/projects/${message.project_id}/captures`
            );
            if (!result.ok) return { success: false, error: result.error ?? 'Failed to fetch captures' };
            return { success: true, data: result.data?.captures ?? [] };
        }

        // ── DELETE_CAPTURE ────────────────────────────────────────────
        case 'DELETE_CAPTURE': {
            const result = await apiFetch(`/api/captures/${message.capture_id}`, {
                method: 'DELETE',
            });
            return { success: result.ok, error: result.error ?? undefined };
        }

        // ── PROCESS_DOCUMENT ─────────────────────────────────────────
        case 'PROCESS_DOCUMENT': {
            const result = await apiFetch('/api/ingest/process-document', {
                method: 'POST',
                body: { capture_id: message.capture_id, s3_url: message.s3_url },
            });
            return { success: result.ok, error: result.error ?? undefined };
        }

        default: {
            const exhaustive: never = message;
            return { success: false, error: `Unknown message type: ${(exhaustive as ExtensionMessage).type}` };
        }
    }
}
