// upload.ts — runs in the dedicated upload window (opened via chrome.windows.create)
// This is a Vite/TypeScript entry point. File pickers work here because this is
// a full browser window context, not a popup — so Chrome doesn't close it.

function sendMsg(msg: unknown): Promise<{ success: boolean; data?: Record<string, string>; error?: string; capture_id?: string }> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError || response === undefined) {
                setTimeout(() => {
                    chrome.runtime.sendMessage(msg, (r) =>
                        resolve(r ?? { success: false, error: 'No response from background.' })
                    );
                }, 300);
            } else {
                resolve(response);
            }
        });
    });
}

function setStatus(el: HTMLElement, msg: string, cls = '') {
    el.className = cls;
    el.innerHTML = msg;
}

async function handleFile(file: File, statusEl: HTMLElement): Promise<void> {
    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');
    const fileType = isPdf ? 'PDF' : isImage ? 'IMAGE' : null;

    if (!fileType) {
        setStatus(statusEl, '✗ Only PDF or image files are supported.', 'error');
        return;
    }

    // Read session/context directly from storage
    const stored: Record<string, string> = await new Promise((resolve) =>
        chrome.storage.local.get(
            ['mindstack_session_id', 'mindstack_project_id', 'mindstack_workspace_id'],
            (r) => resolve(r as Record<string, string>)
        )
    );

    const sessionId = stored['mindstack_session_id'];
    const projectId = stored['mindstack_project_id'] ?? null;
    const workspaceId = stored['mindstack_workspace_id'] ?? null;

    if (!sessionId || (!projectId && !workspaceId)) {
        setStatus(statusEl,
            '✗ No active session found.<br>Start a capture session in the extension first.',
            'error'
        );
        return;
    }

    try {
        // Step 1 — presign
        setStatus(statusEl, '<span class="spin"></span> Requesting upload URL…');
        const presignRes = await sendMsg({
            type: 'GET_PRESIGNED_URL',
            file_name: file.name,
            file_type: file.type,
        });
        if (!presignRes?.success || !presignRes.data) {
            throw new Error(presignRes?.error ?? 'Presign failed (no data returned)');
        }
        const raw = presignRes.data as Record<string, string>;
        const uploadUrl = raw['upload_url'] ?? raw['url'] ?? '';
        const s3Url = raw['s3_url'] ?? raw['key'] ?? '';
        if (!uploadUrl) throw new Error(`No upload URL. Keys: ${Object.keys(raw).join(', ')}`);

        // Step 2 — PUT to S3
        setStatus(statusEl, '<span class="spin"></span> Uploading to S3…');
        const putRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type },
            body: file,
        });
        if (!putRes.ok) {
            let detail = '';
            try { detail = await putRes.text(); } catch { /* ignore */ }
            throw new Error(`S3 upload failed (${putRes.status})${detail ? ': ' + detail.slice(0, 100) : ''}`);
        }
        const publicUrl = uploadUrl.split('?')[0];

        // Step 3 — ingest
        setStatus(statusEl, '<span class="spin"></span> Saving to vault…');
        const ingestRes = await sendMsg({
            type: 'INGEST_BROWSER',
            payload: {
                session_id: sessionId,
                project_id: projectId,
                workspace_id: workspaceId,
                capture_type: 'RESOURCE_UPLOAD',
                priority: 5,
                attachments: [{ s3_url: publicUrl, file_type: fileType, file_name: file.name }],
            },
        });
        if (!ingestRes?.success) throw new Error(ingestRes?.error ?? 'Ingest failed');
        const captureId = (ingestRes.data as unknown as { capture_id: string })?.capture_id;

        // Step 4 — PDF extraction
        if (isPdf && captureId) {
            setStatus(statusEl, '<span class="spin"></span> Processing PDF…');
            await sendMsg({
                type: 'PROCESS_DOCUMENT',
                capture_id: captureId,
                s3_url: s3Url,
                project_id: projectId,
                workspace_id: workspaceId,
            });
        }

        setStatus(statusEl, `✓ ${file.name} uploaded!`, 'success');
        setTimeout(() => window.close(), 2000);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[MindStack Upload]', msg);
        setStatus(statusEl, `✗ ${msg}`, 'error');
    }
}

// ── Wire up DOM after load ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone')!;
    const fileInput = document.getElementById('file-input') as HTMLInputElement;
    const statusEl = document.getElementById('status')!;

    // Click → open file picker (works in window context)
    dropZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const file = target.files?.[0];
        if (file) handleFile(file, statusEl);
        target.value = '';
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer?.files?.[0];
        if (file) handleFile(file, statusEl);
    });
});
