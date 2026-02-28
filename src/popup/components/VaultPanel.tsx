import { useState, useRef, DragEvent, FormEvent } from 'react';
import type { MessageResponse, PresignedUrlResponse } from '../../lib/types';

interface VaultPanelProps {
    activeSessionId: string | null;
    projectId: string;
}

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

function sendMsg<T>(msg: unknown): Promise<MessageResponse<T>> {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

export default function VaultPanel({ activeSessionId, projectId }: VaultPanelProps) {
    const [noteText, setNoteText] = useState('');
    const [noteLoading, setNoteLoading] = useState(false);
    const [noteStatus, setNoteStatus] = useState<'idle' | 'success' | 'error'>('idle');
    const [noteError, setNoteError] = useState<string | null>(null);

    const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
    const [uploadProgress, setUploadProgress] = useState<string>('');
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const requiresSession = !activeSessionId || !projectId;

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
                session_id: activeSessionId,
                project_id: projectId,
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

    // ── File Upload (Fix ②: Popup does S3 PUT directly) ────────────────────────
    const handleFile = async (file: File) => {
        if (!activeSessionId || !projectId) return;

        const isPdf = file.type === 'application/pdf';
        const isImage = file.type.startsWith('image/');
        const fileType = isPdf ? 'PDF' : isImage ? 'IMAGE' : null;

        if (!fileType) {
            setUploadError('Only PDF and image files are supported.');
            return;
        }

        setUploadStatus('uploading');
        setUploadError(null);

        try {
            // Step 1: Get presigned URL from background
            setUploadProgress('Requesting upload URL...');
            const presignedRes = await sendMsg<PresignedUrlResponse>({
                type: 'GET_PRESIGNED_URL',
                file_name: file.name,
                file_type: file.type,
            });

            if (!presignedRes?.success || !presignedRes.data) {
                throw new Error(presignedRes?.error ?? 'Failed to get upload URL.');
            }

            const { upload_url, s3_url } = presignedRes.data;

            // Step 2: PUT file directly to S3 from the Popup (Fix ②: avoids message size limit)
            setUploadProgress('Uploading to vault...');
            const putRes = await fetch(upload_url, {
                method: 'PUT',
                headers: { 'Content-Type': file.type },
                body: file,
            });

            if (!putRes.ok) {
                throw new Error(`S3 upload failed (${putRes.status})`);
            }

            // Step 3: Ingest the capture via background
            setUploadProgress('Registering capture...');
            const ingestRes = await sendMsg<{ capture_id: string }>({
                type: 'INGEST_BROWSER',
                payload: {
                    session_id: activeSessionId,
                    project_id: projectId,
                    capture_type: 'RESOURCE_UPLOAD',
                    priority: 5,
                    attachments: [{ s3_url, file_type: fileType, file_name: file.name }],
                },
            });

            if (!ingestRes?.success || !ingestRes.data) {
                throw new Error(ingestRes?.error ?? 'Failed to register upload.');
            }

            const captureId = ingestRes.data.capture_id;

            // Step 4: PDF-only — trigger extraction pipeline
            if (isPdf) {
                setUploadProgress('Processing PDF...');
                await sendMsg({
                    type: 'PROCESS_DOCUMENT',
                    capture_id: captureId,
                    s3_url,
                });
            }

            setUploadStatus('success');
            setUploadProgress(`✓ ${file.name} uploaded`);
            setTimeout(() => { setUploadStatus('idle'); setUploadProgress(''); }, 4000);
        } catch (err) {
            setUploadStatus('error');
            setUploadError(err instanceof Error ? err.message : 'Upload failed.');
            setUploadProgress('');
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

            {/* ── File Dropzone ── */}
            <div>
                <label className="ghost-label block mb-2">📎 File Upload</label>
                <div
                    onClick={() => !requiresSession && fileInputRef.current?.click()}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    className={`
            relative border-2 border-dashed rounded-lg p-5 text-center transition-all duration-200
            ${requiresSession ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
            ${isDragging
                            ? 'border-ghost-accent bg-ghost-accent/10 scale-[1.01]'
                            : 'border-ghost-border hover:border-ghost-accent/60 hover:bg-ghost-surface/50'
                        }
          `}
                >
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,image/*"
                        className="hidden"
                        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                        disabled={requiresSession}
                    />

                    {uploadStatus === 'idle' && (
                        <>
                            <div className="text-2xl mb-1.5">📂</div>
                            <p className="font-mono text-xs text-ghost-text">Drop a PDF or image here</p>
                            <p className="font-mono text-[10px] text-ghost-muted mt-0.5">or click to browse</p>
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
                            <p className="font-mono text-xs text-ghost-red">{uploadError}</p>
                            <button
                                onClick={(e) => { e.stopPropagation(); setUploadStatus('idle'); setUploadError(null); }}
                                className="font-mono text-[10px] text-ghost-muted hover:text-ghost-text mt-1"
                            >
                                try again
                            </button>
                        </div>
                    )}
                </div>
                <p className="font-mono text-[10px] text-ghost-muted mt-1.5 text-center">PDFs are processed for AI search</p>
            </div>
        </div>
    );
}
