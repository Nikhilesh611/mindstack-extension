import type {
    ExtensionMessage,
    MessageResponse,
    Project,
    Workspace,
    Capture,
    PresignedUrlResponse,
} from '../lib/types';

const API_BASE = 'https://mind-stack-theta.vercel.app';
const STORAGE_JWT_KEY = 'mindstack_jwt';
const STORAGE_SESSION_KEY = 'mindstack_session_id';
const STORAGE_PROJECT_KEY = 'mindstack_project_id';
const STORAGE_WORKSPACE_KEY = 'mindstack_workspace_id';
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

        // Surface the server's response body in the error string so 5xx errors
        // are readable rather than just showing "HTTP 500".
        let errorDetail = `HTTP ${res.status}`;
        if (!res.ok && data) {
            const body = data as Record<string, unknown>;
            const msg = body?.message ?? body?.error ?? body?.detail ?? null;
            if (typeof msg === 'string') errorDetail += `: ${msg}`;
        }

        return {
            ok: res.ok,
            status: res.status,
            data,
            error: res.ok ? null : errorDetail,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Network error';
        return { ok: false, status: 0, data: null, error: message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 401 Handler
// ─────────────────────────────────────────────────────────────────────────────

async function handle401(): Promise<void> {
    clearHeartbeat();
    await chrome.storage.local.remove([
        STORAGE_JWT_KEY,
        STORAGE_SESSION_KEY,
        STORAGE_PROJECT_KEY,
        STORAGE_WORKSPACE_KEY,
    ]);
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
    const stored = await chrome.storage.local.get([STORAGE_SESSION_KEY, STORAGE_JWT_KEY]);
    const sessionId = stored[STORAGE_SESSION_KEY] as string | undefined;
    const jwt = stored[STORAGE_JWT_KEY] as string | undefined;

    // Nothing stored — nothing to restore.
    if (!sessionId || !jwt) return;

    // Validate the session is still alive on the server before resuming.
    console.log('[MindStack BG] Startup: validating stored session:', sessionId);
    const validation = await apiFetch('/api/sessions/heartbeat', {
        method: 'POST',
        body: { session_id: sessionId },
    });

    if (validation.ok) {
        startHeartbeat(sessionId);
        console.log('[MindStack BG] Startup: session validated, heartbeat started.');
    } else {
        console.warn(
            `[MindStack BG] Startup: session validation failed (status ${validation.status}) — clearing state.`,
        );
        clearHeartbeat();
        await chrome.storage.local.remove([
            STORAGE_JWT_KEY,
            STORAGE_SESSION_KEY,
            STORAGE_PROJECT_KEY,
            STORAGE_WORKSPACE_KEY,
        ]);

        try {
            chrome.notifications.create('mindstack-session-expired', {
                type: 'basic',
                iconUrl: chrome.runtime.getURL('icons/icon48.png'),
                title: 'MindStack — Session Expired',
                message: 'Your previous session has ended. Click the extension to log in again.',
                priority: 2,
            });
        } catch (e) {
            console.warn('[MindStack BG] Could not create startup notification:', e);
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Main Message Router
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, sender, sendResponse) => {
        handleMessage(message, sender)
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

async function handleMessage(message: ExtensionMessage, sender?: chrome.runtime.MessageSender): Promise<MessageResponse> {
    switch (message.type) {
        // ── GET_PROJECTS ─────────────────────────────────────────────
        case 'GET_PROJECTS': {
            const result = await apiFetch<{ projects: Project[] }>('/api/projects');
            if (!result.ok) return { success: false, error: result.error ?? 'Failed to fetch projects' };
            return { success: true, data: result.data?.projects ?? [] };
        }

        // ── GET_WORKSPACES (NEW) ──────────────────────────────────────
        case 'GET_WORKSPACES': {
            const result = await apiFetch<{ workspaces: Workspace[] }>('/api/workspaces');
            if (!result.ok) return { success: false, error: result.error ?? 'Failed to fetch workspaces' };
            return { success: true, data: result.data?.workspaces ?? [] };
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
            const isWorkspace = !!message.workspace_id;
            const activeId = message.workspace_id || message.project_id;

            if (!activeId) {
                return { success: false, error: 'No project_id or workspace_id provided.' };
            }

            const result = await apiFetch<{ session_id: string }>('/api/sessions/start', {
                method: 'POST',
                body: {
                    project_id: isWorkspace ? null : activeId,
                    workspace_id: isWorkspace ? activeId : null,
                },
            });

            if (!result.ok || !result.data?.session_id) {
                return { success: false, error: result.error ?? 'Failed to start session' };
            }

            const sessionId = result.data.session_id;

            // Store session ID and the right context key; clear the other.
            if (isWorkspace) {
                await chrome.storage.local.set({
                    [STORAGE_SESSION_KEY]: sessionId,
                    [STORAGE_WORKSPACE_KEY]: activeId,
                });
                await chrome.storage.local.remove(STORAGE_PROJECT_KEY);
            } else {
                await chrome.storage.local.set({
                    [STORAGE_SESSION_KEY]: sessionId,
                    [STORAGE_PROJECT_KEY]: activeId,
                });
                await chrome.storage.local.remove(STORAGE_WORKSPACE_KEY);
            }

            startHeartbeat(sessionId);
            console.log('[MindStack BG] Session started:', sessionId, isWorkspace ? `(workspace: ${activeId})` : `(project: ${activeId})`);
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
            await chrome.storage.local.remove([STORAGE_SESSION_KEY, STORAGE_PROJECT_KEY, STORAGE_WORKSPACE_KEY]);
            console.log('[MindStack BG] Session ended:', sessionId);
            return { success: result.ok, error: result.error ?? undefined };
        }

        // ── INGEST_BROWSER ────────────────────────────────────────────
        case 'INGEST_BROWSER': {
            // Always re-read session/project/workspace from storage for MV3 safety
            const stored = await chrome.storage.local.get([
                STORAGE_SESSION_KEY,
                STORAGE_PROJECT_KEY,
                STORAGE_WORKSPACE_KEY,
            ]);
            const storedSessionId = stored[STORAGE_SESSION_KEY] as string | undefined;
            const storedProjectId = stored[STORAGE_PROJECT_KEY] as string | undefined;
            const storedWorkspaceId = stored[STORAGE_WORKSPACE_KEY] as string | undefined;

            if (!storedSessionId || (!storedProjectId && !storedWorkspaceId)) {
                console.warn('[MindStack BG] INGEST_BROWSER called without active session — ignoring.');
                return { success: false, error: 'No active session.' };
            }

            const payload = {
                ...message.payload,
                session_id: storedSessionId,
                project_id: storedProjectId ?? null,
                workspace_id: storedWorkspaceId ?? null,
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
            const stored = await chrome.storage.local.get([
                STORAGE_SESSION_KEY,
                STORAGE_PROJECT_KEY,
                STORAGE_WORKSPACE_KEY,
            ]);
            const sessionId = stored[STORAGE_SESSION_KEY] as string | undefined;
            const projectId = stored[STORAGE_PROJECT_KEY] as string | undefined;
            const workspaceId = stored[STORAGE_WORKSPACE_KEY] as string | undefined;

            if (!sessionId || (!projectId && !workspaceId)) {
                return { success: false, error: 'No active session.' };
            }

            const { source_url, page_title, video_start_time, video_end_time, base64Frame } =
                message.payload;

            // ── Step 1: Obtain a 1-hour pre-signed S3 upload URL ─────────────────
            // Routing: project → project-scoped presign endpoint
            //          workspace → vault presign endpoint (avoids a 404)
            console.log('[MindStack BG] Step 1: Presigning keyframe upload. projectId:', projectId, 'workspaceId:', workspaceId);

            let presignedResult: { ok: boolean; status: number; data: PresignedUrlResponse | null; error: string | null };

            if (projectId) {
                // Try the project-scoped presign endpoint
                const projectPresign = await apiFetch<PresignedUrlResponse>(
                    `/api/projects/${projectId}/captures/presign?filename=keyframe.jpg&contentType=image%2Fjpeg`,
                );

                if (!projectPresign.ok && projectPresign.status === 404) {
                    // New endpoint not deployed yet — fall back to the old vault presign route
                    console.warn('[MindStack BG] New presign endpoint not found (404) — falling back to /api/vault/presigned-url');
                    const legacyResult = await apiFetch<{ upload_url: string; s3_url: string }>(
                        '/api/vault/presigned-url',
                        { method: 'POST', body: { file_name: 'keyframe.jpg', file_type: 'image/jpeg' } },
                    );
                    if (legacyResult.ok && legacyResult.data) {
                        presignedResult = {
                            ok: true,
                            status: 200,
                            data: { url: legacyResult.data.upload_url, key: legacyResult.data.s3_url },
                            error: null,
                        };
                        console.log('[MindStack BG] Legacy presign succeeded — using upload_url/s3_url mapping.');
                    } else {
                        presignedResult = { ok: legacyResult.ok, status: legacyResult.status, data: null, error: legacyResult.error };
                    }
                } else {
                    presignedResult = projectPresign;
                }
            } else {
                // Workspace context — always use the vault presign to avoid 404
                console.log('[MindStack BG] Workspace context — using /api/vault/presigned-url for keyframe presign.');
                const legacyResult = await apiFetch<{ upload_url: string; s3_url: string }>(
                    '/api/vault/presigned-url',
                    { method: 'POST', body: { file_name: 'keyframe.jpg', file_type: 'image/jpeg' } },
                );
                if (legacyResult.ok && legacyResult.data) {
                    presignedResult = {
                        ok: true,
                        status: 200,
                        data: { url: legacyResult.data.upload_url, key: legacyResult.data.s3_url },
                        error: null,
                    };
                } else {
                    presignedResult = { ok: legacyResult.ok, status: legacyResult.status, data: null, error: legacyResult.error };
                }
            }

            if (!presignedResult.ok || !presignedResult.data) {
                console.error('[MindStack BG] Presign failed:', presignedResult.error);
                return { success: false, error: `Presign failed (${presignedResult.status}): ${presignedResult.error ?? 'unknown'}` };
            }

            const { url: uploadUrl, key: s3Key } = presignedResult.data;

            // ── Step 2: PUT the JPEG blob directly to S3 ─────────────────────────
            try {
                const binaryString = atob(base64Frame.replace(/^data:image\/jpeg;base64,/, ''));
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                const s3PutRes = await fetch(uploadUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'image/jpeg' },
                    body: bytes.buffer as ArrayBuffer,
                });

                if (!s3PutRes.ok) {
                    const msg = `S3 PUT failed with status ${s3PutRes.status}`;
                    console.error('[MindStack BG]', msg);
                    return { success: false, error: msg };
                }
                console.log('[MindStack BG] Step 2: S3 PUT succeeded — key:', s3Key);
            } catch (e) {
                const msg = e instanceof Error ? e.message : 'S3 upload error';
                console.error('[MindStack BG] S3 frame upload error:', e);
                return { success: false, error: msg };
            }

            // ── Step 3: Notify the ingest pipeline ───────────────────────────────
            const ingestResult = await apiFetch<{ capture_id: string }>('/api/ingest/browser', {
                method: 'POST',
                body: {
                    session_id: sessionId,
                    project_id: projectId ?? null,
                    workspace_id: workspaceId ?? null,
                    capture_type: 'VIDEO_SEGMENT',
                    source_url,
                    page_title,
                    caption_text: message.payload.caption_text || undefined,
                    video_start_time: Math.round(video_start_time),
                    video_end_time: Math.round(video_end_time),
                    priority: 0,
                    attachments: [
                        { s3_url: uploadUrl.split('?')[0], file_type: 'VIDEO_KEYFRAME', file_name: 'keyframe.jpg' },
                    ],
                },
            });

            if (!ingestResult.ok) {
                console.error('[MindStack BG] Ingest POST failed:', ingestResult.error);
                return { success: false, error: ingestResult.error ?? 'Video ingest failed' };
            }

            console.log('[MindStack BG] Video segment ingested:', ingestResult.data?.capture_id);
            return { success: true, data: ingestResult.data };
        }

        // ── GET_PRESIGNED_URL ─────────────────────────────────────────
        case 'GET_PRESIGNED_URL': {
            const result = await apiFetch<{ upload_url: string; s3_url: string }>('/api/vault/presigned-url', {
                method: 'POST',
                body: { file_name: message.file_name, file_type: message.file_type },
            });

            if (!result.ok || !result.data) {
                return { success: false, error: result.error ?? 'Failed to get presigned URL' };
            }

            // Explicitly destructure so Chrome's message serializer cannot lose fields.
            const { upload_url, s3_url } = result.data;

            // S3 SDK may inject x-amz-checksum-crc32 params into the presigned URL.
            // A plain browser fetch PUT cannot send the matching x-amz-checksum-crc32
            // header, so S3 rejects the request with 400. Strip those params so the
            // PUT succeeds without requiring a checksum.
            const cleanUploadUrl = (() => {
                try {
                    const u = new URL(upload_url);
                    ['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm'].forEach((p) => u.searchParams.delete(p));
                    return u.toString();
                } catch {
                    return upload_url;
                }
            })();

            console.log('[MindStack BG] GET_PRESIGNED_URL — cleaned upload_url prefix:', cleanUploadUrl?.slice(0, 80));

            return { success: true, data: { upload_url: cleanUploadUrl, s3_url } };
        }

        // ── GET_CAPTURES ──────────────────────────────────────────────
        case 'GET_CAPTURES': {
            const { project_id, workspace_id } = message;

            let endpoint: string;
            if (workspace_id) {
                endpoint = `/api/workspaces/${workspace_id}/captures`;
            } else if (project_id) {
                endpoint = `/api/projects/${project_id}/captures`;
            } else {
                return { success: false, error: 'No project_id or workspace_id provided for GET_CAPTURES.' };
            }

            const result = await apiFetch<{ captures: Capture[] }>(endpoint);
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
            // CRITICAL FIX: Re-read both context IDs from storage at call time
            // (same MV3 safety pattern as INGEST_BROWSER). Never trust message-passed
            // IDs alone — the popup's React props may be stale by the time this fires,
            // especially for workspace sessions where project_id is absent from storage.
            const stored = await chrome.storage.local.get([
                STORAGE_PROJECT_KEY,
                STORAGE_WORKSPACE_KEY,
            ]);
            const storedProjectId = stored[STORAGE_PROJECT_KEY] as string | undefined;
            const storedWorkspaceId = stored[STORAGE_WORKSPACE_KEY] as string | undefined;

            // Storage is authoritative; fall back to message values only if storage is empty
            const projectId = storedProjectId ?? message.project_id ?? null;
            const workspaceId = storedWorkspaceId ?? message.workspace_id ?? null;

            console.log(
                `[MindStack BG] PROCESS_DOCUMENT — capture: ${message.capture_id}, ` +
                `project: ${projectId ?? 'none'}, workspace: ${workspaceId ?? 'none'}`
            );

            if (!projectId && !workspaceId) {
                console.error('[MindStack BG] PROCESS_DOCUMENT — no project_id or workspace_id available!');
                return { success: false, error: 'No project_id or workspace_id found for process-document.' };
            }

            const result = await apiFetch('/api/ingest/process-document', {
                method: 'POST',
                body: {
                    capture_id: message.capture_id,
                    s3_url: message.s3_url,
                    project_id: projectId,
                    workspace_id: workspaceId,
                },
            });
            return { success: result.ok, error: result.error ?? undefined };
        }

        // ── GET_YT_CAPTION_URL ─────────────────────────────────────────
        case 'GET_YT_CAPTION_URL': {
            const tabId = sender?.tab?.id;
            if (!tabId) {
                return { success: false, error: 'No active tab ID available' };
            }

            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    world: 'MAIN',
                    func: () => {
                        try {
                            const playerComponent = document.querySelector('ytd-player') as any;
                            let playerResponse = typeof playerComponent?.getPlayerResponse === 'function'
                                ? playerComponent.getPlayerResponse()
                                : null;

                            if (!playerResponse) {
                                playerResponse = (window as any)?.ytInitialPlayerResponse;
                            }

                            const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                            return (tracks && tracks.length > 0) ? (tracks[0].baseUrl as string) : null;
                        } catch (e) {
                            return null;
                        }
                    }
                });
                return { success: true, data: { url: results[0]?.result ?? null } };
            } catch (err) {
                console.error('[MindStack BG] executeScript failed:', err);
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        }

        default: {
            const exhaustive: never = message;
            return { success: false, error: `Unknown message type: ${(exhaustive as ExtensionMessage).type}` };
        }
    }
}
