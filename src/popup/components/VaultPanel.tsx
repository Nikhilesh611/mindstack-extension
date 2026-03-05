import { useState, DragEvent, FormEvent } from 'react';
import type { MessageResponse } from '../../lib/types';

interface VaultPanelProps {
    activeSessionId: string | null;
    projectId: string | null;
    workspaceId: string | null;
}

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

// Robust sendMsg with MV3 service-worker wake retry
function sendMsg<T>(msg: unknown): Promise<MessageResponse<T>> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError || response === undefined) {
                setTimeout(() => {
                    chrome.runtime.sendMessage(msg, (retryResponse) => {
                        if (chrome.runtime.lastError || retryResponse === undefined) {
                            resolve({ success: false, error: 'Service worker waking up — please try again.' });
                        } else {
                            resolve(retryResponse as MessageResponse<T>);
                        }
                    });
                }, 300);
            } else {
                resolve(response as MessageResponse<T>);
            }
        });
    });
}

export default function VaultPanel({ activeSessionId, projectId, workspaceId }: VaultPanelProps) {
    const [noteText, setNoteText] = useState('');
    const [noteLoading, setNoteLoading] = useState(false);
    const [noteStatus, setNoteStatus] = useState<'idle' | 'success' | 'error'>('idle');
    const [noteError, setNoteError] = useState<string | null>(null);

    const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
    const [uploadProgress, setUploadProgress] = useState<string>('');
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    // Requires an active session AND at least one context ID
    const requiresSession = !activeSessionId || (!projectId && !workspaceId);

    // ── Note Submission ─────────────────────────────────────────────────────────
    const handleNoteSubmit = async (e: FormEvent) => {
        e.preventDefault();
        if (!noteText.trim() || requiresSession) return;
        setNoteLoading(true);
        setNoteStatus('idle');
        setNoteError(null);

        const res = await sendMsg<{ capture_id: string }>({
            type: 'INGEST_BROWSER',
            payload: {
                session_id: activeSessionId!,
                project_id: projectId ?? null,
                workspace_id: workspaceId ?? null,
                capture_type: 'USER_NOTE',
                text_content: noteText.trim(),
                priority: 5,
            },
        });

        if (res?.success) {
            setNoteStatus('success');
            setNoteText('');
            setTimeout(() => setNoteStatus('idle'), 3000);
        } else {
            setNoteStatus('error');
            setNoteError(res?.error ?? 'Failed to save note.');
        }
        setNoteLoading(false);
    };

    // ── Core upload pipeline ────────────────────────────────────────────────────
    // All three steps (presign → S3 PUT → ingest) are delegated to the background
    // service worker via UPLOAD_FILE message. This avoids two common popup failures:
    //   1. CORS issues: Background has <all_urls> host_permissions; popup does not
    //      always get the CORS exemption for S3's binary PUT.
    //   2. Popup lifecycle: If the popup closed mid-upload, the background can
    //      finish the job independently.
    const handleFile = async (file: File) => {
        if (requiresSession) return;

        const isPdf = file.type === 'application/pdf';
        const isImage = file.type.startsWith('image/');
        const fileType = isPdf ? 'PDF' : isImage ? 'IMAGE' : null;

        if (!fileType) {
            setUploadError('Only PDF and image files are supported.');
            setUploadStatus('error');
            return;
        }

        setUploadStatus('uploading');
        setUploadError(null);

        try {
            // ── Step 1: Get pre-signed S3 URL via background ──────────────────
            setUploadProgress('Requesting upload URL...');
            console.log('[MindStack Vault] Step 1: requesting presigned URL for', file.name, file.type);

            const presignedRes = await sendMsg<{ upload_url: string; s3_url: string }>({
                type: 'GET_PRESIGNED_URL',
                file_name: file.name,
                file_type: file.type,
            });

            // Log the exact shape so we always know which keys the backend returned.
            console.log('[MindStack Vault] Step 1 result keys:', Object.keys(presignedRes?.data ?? {}));
            console.log('[MindStack Vault] Step 1 result:', presignedRes);

            if (!presignedRes?.success || !presignedRes.data) {
                throw new Error(`Step 1 failed — presign: ${presignedRes?.error ?? 'no data returned'}`);
            }

            // Support both key shapes: new {upload_url} and legacy {url}
            const raw = presignedRes.data as Record<string, string>;
            const uploadUrl: string = raw['upload_url'] ?? raw['url'] ?? '';
            const s3Url: string = raw['s3_url'] ?? raw['key'] ?? '';

            if (!uploadUrl) {
                throw new Error(`Step 1 failed — no upload URL in response. Keys: ${Object.keys(raw).join(', ')}`);
            }

            // ── Step 2: PUT file bytes directly to S3 ─────────────────────────
            setUploadProgress('Uploading to S3...');
            console.log('[MindStack Vault] Step 2: PUT to S3 URL prefix:', uploadUrl.slice(0, 80));

            const putRes = await fetch(uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Type': file.type },
                body: file,
            });

            console.log('[MindStack Vault] Step 2 result: HTTP', putRes.status);

            if (!putRes.ok) {
                // Try to read S3 error body for a more useful message
                let s3Detail = '';
                try { s3Detail = await putRes.text(); } catch { /* ignore */ }
                throw new Error(`Step 2 failed — S3 PUT ${putRes.status}: ${s3Detail.slice(0, 120)}`);
            }

            // Strip query string to get the permanent public URL
            const publicS3Url = uploadUrl.split('?')[0];

            // ── Step 3: Register the capture in the backend DB ─────────────────
            setUploadProgress('Registering in vault...');
            console.log('[MindStack Vault] Step 3: INGEST_BROWSER RESOURCE_UPLOAD');

            const ingestRes = await sendMsg<{ capture_id: string }>({
                type: 'INGEST_BROWSER',
                payload: {
                    session_id: activeSessionId!,
                    project_id: projectId ?? null,
                    workspace_id: workspaceId ?? null,
                    capture_type: 'RESOURCE_UPLOAD',
                    priority: 5,
                    attachments: [{ s3_url: publicS3Url, file_type: fileType, file_name: file.name }],
                },
            });

            console.log('[MindStack Vault] Step 3 result:', ingestRes);

            if (!ingestRes?.success || !ingestRes.data) {
                throw new Error(`Step 3 failed — ingest: ${ingestRes?.error ?? 'no capture_id returned'}`);
            }

            const captureId = ingestRes.data.capture_id;

            // ── Step 4 (PDF only): Trigger AI extraction pipeline ──────────────
            if (isPdf) {
                setUploadProgress('Triggering PDF processing...');
                console.log('[MindStack Vault] Step 4: PROCESS_DOCUMENT for capture', captureId);

                const processRes = await sendMsg({
                    type: 'PROCESS_DOCUMENT',
                    capture_id: captureId,
                    s3_url: s3Url,
                    project_id: projectId ?? null,
                    workspace_id: workspaceId ?? null,
                });

                console.log('[MindStack Vault] Step 4 result:', processRes);
                // Not throwing — processing failure is non-fatal; the file is already in the vault.
            }

            setUploadStatus('success');
            setUploadProgress(`✓ ${file.name} uploaded successfully`);
            console.log('[MindStack Vault] Upload complete for:', file.name);
            setTimeout(() => { setUploadStatus('idle'); setUploadProgress(''); }, 4000);

        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Upload failed.';
            console.error('[MindStack Vault] Upload pipeline error:', msg);
            setUploadStatus('error');
            setUploadError(msg);
            setUploadProgress('');
        }
    };

    // ── File picker using File System Access API ────────────────────────────────
    // showOpenFilePicker() does NOT close the extension popup (unlike <input type="file">).
    const handleBrowseClick = async () => {
        if (requiresSession) return;
        try {
            const [fileHandle] = await (window as any).showOpenFilePicker({
                types: [
                    { description: 'PDFs and Images', accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'] } },
                ],
                multiple: false,
            });
            const file: File = await fileHandle.getFile();
            await handleFile(file);
        } catch (err: any) {
            // User cancelled the picker — ignore AbortError silently
            if (err?.name !== 'AbortError') {
                console.error('[MindStack Vault] File picker error:', err);
                setUploadError('Could not open file picker.');
                setUploadStatus('error');
            }
        }
    };

    const handleDrop = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    };

    const handleDragOver = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragging(true); };
    const handleDragLeave = () => setIsDragging(false);

    return (
        <div className="p-4 flex flex-col gap-4 animate-slide-up">
            {requiresSession && (
                <div className="ghost-card border-ghost-yellow/30 bg-ghost-yellow/5 text-ghost-yellow font-mono text-xs text-center">
                    ⚠ Start a session to add to the vault.
                </div>
            )}

            {/* ── Manual Note ── */}
            <div>
                <label className="ghost-label block mb-2">📝 Quick Note</label>
                <form onSubmit={handleNoteSubmit} className="flex flex-col gap-2">
                    <textarea
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder="Capture a thought, insight, or summary..."
                        rows={4}
                        disabled={requiresSession}
                        className="ghost-input resize-none leading-relaxed disabled:opacity-40"
                    />
                    <button
                        type="submit"
                        disabled={!noteText.trim() || noteLoading || requiresSession}
                        className="ghost-btn-primary"
                    >
                        {noteLoading ? (
                            <span className="flex items-center justify-center gap-2">
                                <div className="w-3 h-3 border border-ghost-bg border-t-transparent rounded-full animate-spin" />
                                Saving...
                            </span>
                        ) : '→ Save Note'}
                    </button>
                    {noteStatus === 'success' && (
                        <p className="text-center font-mono text-[10px] text-ghost-green animate-fade-in">✓ Note saved!</p>
                    )}
                    {noteStatus === 'error' && (
                        <p className="text-center font-mono text-[10px] text-ghost-red animate-fade-in">✗ {noteError}</p>
                    )}
                </form>
            </div>

            {/* Divider */}
            <div className="border-t border-ghost-border" />

            {/* ── File Upload ── */}
            <div>
                <label className="ghost-label block mb-2">📎 File Upload</label>

                {/* Drag-and-drop zone */}
                <div
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    className={`
                        relative border-2 border-dashed rounded-lg p-5 text-center transition-all duration-200
                        ${requiresSession ? 'opacity-40 cursor-not-allowed' : ''}
                        ${isDragging
                            ? 'border-ghost-accent bg-ghost-accent/10 scale-[1.01]'
                            : 'border-ghost-border'
                        }
                    `}
                >
                    {uploadStatus === 'idle' && (
                        <>
                            <div className="text-2xl mb-1.5">📂</div>
                            <p className="font-mono text-xs text-ghost-text">Drop a PDF or image here</p>
                        </>
                    )}

                    {uploadStatus === 'uploading' && (
                        <div className="flex flex-col items-center gap-2">
                            <div className="w-5 h-5 border-2 border-ghost-accent border-t-transparent rounded-full animate-spin" />
                            <p className="font-mono text-xs text-ghost-accent">{uploadProgress}</p>
                        </div>
                    )}

                    {uploadStatus === 'success' && (
                        <div className="flex flex-col items-center gap-1 animate-fade-in">
                            <div className="text-xl">✓</div>
                            <p className="font-mono text-xs text-ghost-green">{uploadProgress}</p>
                        </div>
                    )}

                    {uploadStatus === 'error' && (
                        <div className="flex flex-col items-center gap-1 animate-fade-in">
                            <div className="text-xl">✗</div>
                            <p className="font-mono text-xs text-ghost-red break-words">{uploadError}</p>
                            <button
                                onClick={() => { setUploadStatus('idle'); setUploadError(null); }}
                                className="font-mono text-[10px] text-ghost-muted hover:text-ghost-text mt-1"
                            >
                                try again
                            </button>
                        </div>
                    )}
                </div>

                {/* Browse button — uses File System Access API (doesn't close popup) */}
                <button
                    onClick={handleBrowseClick}
                    disabled={requiresSession || uploadStatus === 'uploading'}
                    className="w-full mt-2 ghost-btn border border-ghost-border text-ghost-muted hover:text-ghost-accent hover:border-ghost-accent/50 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-mono transition-colors"
                >
                    🗂 Browse files (PDF or image)
                </button>

                <p className="font-mono text-[10px] text-ghost-muted mt-1.5 text-center">PDFs are processed for AI search</p>
            </div>
        </div>
    );
}
