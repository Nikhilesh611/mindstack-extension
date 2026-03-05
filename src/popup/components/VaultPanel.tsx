import { useState, useRef, DragEvent, FormEvent } from 'react';
import type { MessageResponse } from '../../lib/types';

interface VaultPanelProps {
    activeSessionId: string | null;
    projectId: string | null;
    workspaceId: string | null;
}

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

function sendMsg<T>(msg: unknown): Promise<MessageResponse<T>> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError || response === undefined) {
                setTimeout(() => {
                    chrome.runtime.sendMessage(msg, (r) =>
                        resolve((r ?? { success: false, error: 'No response' }) as MessageResponse<T>)
                    );
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
    const [uploadProgress, setUploadProgress] = useState('');
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const requiresSession = !activeSessionId || (!projectId && !workspaceId);

    // ── Note submit ─────────────────────────────────────────────────────────────
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

    // ── File upload pipeline ────────────────────────────────────────────────────
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
            // Step 1: presign
            setUploadProgress('Requesting upload URL…');
            const presignRes = await sendMsg<Record<string, string>>({
                type: 'GET_PRESIGNED_URL',
                file_name: file.name,
                file_type: file.type,
            });

            if (!presignRes?.success || !presignRes.data) {
                throw new Error(presignRes?.error ?? 'Failed to get upload URL');
            }

            const raw = presignRes.data;
            const uploadUrl = raw['upload_url'] ?? raw['url'] ?? '';
            const s3Url = raw['s3_url'] ?? raw['key'] ?? '';

            if (!uploadUrl) {
                throw new Error(`No upload URL returned. Keys: ${Object.keys(raw).join(', ')}`);
            }

            // Step 2: PUT to S3
            setUploadProgress('Uploading file…');
            const putRes = await fetch(uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Type': file.type },
                body: file,
            });

            if (!putRes.ok) {
                let detail = '';
                try { detail = await putRes.text(); } catch { /* ignore */ }
                throw new Error(`S3 upload failed (${putRes.status})${detail ? ': ' + detail.slice(0, 80) : ''}`);
            }

            const publicS3Url = uploadUrl.split('?')[0];

            // Step 3: ingest
            setUploadProgress('Saving to vault…');
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

            if (!ingestRes?.success || !ingestRes.data) {
                throw new Error(ingestRes?.error ?? 'Failed to register upload');
            }

            // Step 4: PDF extraction
            if (isPdf) {
                setUploadProgress('Processing PDF…');
                await sendMsg({
                    type: 'PROCESS_DOCUMENT',
                    capture_id: ingestRes.data.capture_id,
                    s3_url: s3Url,
                    project_id: projectId ?? null,
                    workspace_id: workspaceId ?? null,
                });
            }

            setUploadStatus('success');
            setUploadProgress(`✓ ${file.name} uploaded`);
            setTimeout(() => { setUploadStatus('idle'); setUploadProgress(''); }, 4000);

        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Upload failed';
            console.error('[MindStack Vault]', msg);
            setUploadStatus('error');
            setUploadError(msg);
            setUploadProgress('');
        }
    };

    const handleDrop = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    };

    return (
        <div className="p-4 flex flex-col gap-4 animate-slide-up">
            {requiresSession && (
                <div className="ghost-card border-ghost-yellow/30 bg-ghost-yellow/5 text-ghost-yellow font-mono text-xs text-center">
                    ⚠ Start a session to add to the vault.
                </div>
            )}

            {/* ── Note ── */}
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
                        {noteLoading
                            ? <span className="flex items-center justify-center gap-2"><div className="w-3 h-3 border border-ghost-bg border-t-transparent rounded-full animate-spin" />Saving...</span>
                            : '→ Save Note'}
                    </button>
                    {noteStatus === 'success' && <p className="text-center font-mono text-[10px] text-ghost-green animate-fade-in">✓ Note saved!</p>}
                    {noteStatus === 'error' && <p className="text-center font-mono text-[10px] text-ghost-red animate-fade-in">✗ {noteError}</p>}
                </form>
            </div>

            <div className="border-t border-ghost-border" />

            {/* ── File upload ── */}
            <div>
                <label className="ghost-label block mb-2">📎 File Upload</label>

                {/* Hidden file input — used only for drag-and-drop onChange */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,image/*"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
                    disabled={requiresSession}
                />

                {/* Dropzone — drag files here directly, OR click to open upload window */}
                <div
                    onClick={() => {
                        if (requiresSession) return;
                        // Open a dedicated window — file pickers work there without closing the popup
                        chrome.windows.create({
                            url: chrome.runtime.getURL('src/upload/upload.html'),
                            type: 'popup',
                            width: 480,
                            height: 300,
                        });
                    }}
                    onDrop={handleDrop}
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    className={`
                        border-2 border-dashed rounded-lg p-5 text-center transition-all duration-200
                        ${requiresSession ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                        ${isDragging ? 'border-ghost-accent bg-ghost-accent/10 scale-[1.01]' : 'border-ghost-border hover:border-ghost-accent/50 hover:bg-ghost-surface/40'}
                    `}
                >
                    {uploadStatus === 'idle' && (
                        <>
                            <div className="text-2xl mb-1.5">📂</div>
                            <p className="font-mono text-xs text-ghost-text">Drop a file here or click to browse</p>
                            <p className="font-mono text-[10px] text-ghost-muted mt-0.5">PDF or image</p>
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
                        <div className="flex flex-col items-center gap-2 animate-fade-in">
                            <div className="text-xl">✗</div>
                            <p className="font-mono text-xs text-ghost-red break-words">{uploadError}</p>
                            <button
                                onClick={(e) => { e.stopPropagation(); setUploadStatus('idle'); setUploadError(null); }}
                                className="font-mono text-[10px] text-ghost-muted hover:text-ghost-text"
                            >
                                try again
                            </button>
                        </div>
                    )}
                </div>

                <p className="font-mono text-[10px] text-ghost-muted mt-1.5 text-center">
                    PDFs are processed for AI search · drag &amp; drop is most reliable
                </p>
            </div>
        </div>
    );
}
