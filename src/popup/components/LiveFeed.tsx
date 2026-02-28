import { useState, useEffect, useCallback } from 'react';
import type { Capture, MessageResponse } from '../../lib/types';

interface LiveFeedProps {
    projectId: string;
    activeSessionId: string | null;
}

function sendMsg<T>(msg: unknown): Promise<MessageResponse<T>> {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

const CAPTURE_TYPE_META: Record<string, { icon: string; label: string; color: string }> = {
    WEB_TEXT: { icon: '🔗', label: 'Web Text', color: 'text-ghost-accent' },
    VIDEO_SEGMENT: { icon: '🎬', label: 'Video', color: 'text-ghost-yellow' },
    USER_NOTE: { icon: '📝', label: 'Note', color: 'text-ghost-green' },
    RESOURCE_UPLOAD: { icon: '📎', label: 'File', color: 'text-ghost-muted' },
};

function timeAgo(isoString: string): string {
    const delta = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

export default function LiveFeed({ projectId, activeSessionId }: LiveFeedProps) {
    const [captures, setCaptures] = useState<Capture[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

    const fetchCaptures = useCallback(async () => {
        if (!projectId) return;
        setLoading(true);
        setError(null);

        const res = await sendMsg<Capture[]>({ type: 'GET_CAPTURES', project_id: projectId });

        if (res?.success && Array.isArray(res.data)) {
            // Filter to active session only, then take top 5 newest
            const filtered = activeSessionId
                ? res.data.filter((c) => c.session_id === activeSessionId)
                : res.data;
            setCaptures(filtered.slice(0, 5));
        } else {
            setError(res?.error ?? 'Failed to load captures.');
        }
        setLoading(false);
    }, [projectId, activeSessionId]);

    // Fetch on mount and every 30s
    useEffect(() => {
        fetchCaptures();
        const interval = setInterval(fetchCaptures, 30_000);
        return () => clearInterval(interval);
    }, [fetchCaptures]);

    const handleDelete = async (captureId: string) => {
        // Optimistic removal
        setCaptures((prev) => prev.filter((c) => c.id !== captureId));
        setDeletingIds((prev) => new Set(prev).add(captureId));

        const res = await sendMsg({ type: 'DELETE_CAPTURE', capture_id: captureId });

        if (!res?.success) {
            // Revert on failure
            console.warn('[MindStack] Delete failed, reverting.');
            fetchCaptures();
        }
        setDeletingIds((prev) => { const s = new Set(prev); s.delete(captureId); return s; });
    };

    if (!activeSessionId) {
        return (
            <div className="p-4 flex flex-col items-center justify-center gap-2 text-center min-h-[140px]">
                <div className="text-2xl opacity-30">⚡</div>
                <p className="font-mono text-xs text-ghost-muted">Start a session to see your live capture feed.</p>
            </div>
        );
    }

    return (
        <div className="p-4 flex flex-col gap-2 animate-slide-up">
            <div className="flex items-center justify-between mb-1">
                <span className="ghost-label">Live Captures</span>
                <button
                    onClick={fetchCaptures}
                    className="font-mono text-[10px] text-ghost-muted hover:text-ghost-accent transition-colors"
                    title="Refresh"
                >
                    ↻ refresh
                </button>
            </div>

            {loading && captures.length === 0 && (
                <div className="flex items-center justify-center py-6 gap-2">
                    <div className="w-4 h-4 border border-ghost-accent border-t-transparent rounded-full animate-spin" />
                    <span className="font-mono text-xs text-ghost-muted">Loading...</span>
                </div>
            )}

            {error && !loading && (
                <div className="ghost-card border-ghost-red/30 bg-ghost-red/5 text-ghost-red font-mono text-xs">
                    ✗ {error}
                </div>
            )}

            {!loading && !error && captures.length === 0 && (
                <div className="flex flex-col items-center justify-center py-6 gap-2 text-center">
                    <div className="text-2xl opacity-20">🫙</div>
                    <p className="font-mono text-xs text-ghost-muted">No captures yet in this session.</p>
                    <p className="font-mono text-[10px] text-ghost-muted opacity-60">Browse the web or add a note.</p>
                </div>
            )}

            <div className="flex flex-col gap-2">
                {captures.map((capture) => {
                    const meta = CAPTURE_TYPE_META[capture.capture_type] ?? {
                        icon: '◆', label: capture.capture_type, color: 'text-ghost-muted',
                    };

                    return (
                        <div
                            key={capture.id}
                            className={`ghost-card flex items-start gap-2.5 group animate-slide-up ${deletingIds.has(capture.id) ? 'opacity-40' : ''
                                }`}
                        >
                            <span className="text-base shrink-0 mt-0.5">{meta.icon}</span>

                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 mb-0.5">
                                    <span className={`font-mono text-[10px] font-semibold ${meta.color}`}>
                                        {meta.label}
                                    </span>
                                    <span className="font-mono text-[10px] text-ghost-muted">·</span>
                                    <span className="font-mono text-[10px] text-ghost-muted">
                                        {timeAgo(capture.created_at)}
                                    </span>
                                </div>

                                {capture.page_title && (
                                    <p className="font-sans text-xs text-ghost-text truncate leading-snug">
                                        {capture.page_title}
                                    </p>
                                )}

                                {capture.source_url && (
                                    <p className="font-mono text-[10px] text-ghost-muted truncate mt-0.5">
                                        {new URL(capture.source_url).hostname}
                                    </p>
                                )}

                                {capture.capture_type === 'VIDEO_SEGMENT' &&
                                    capture.video_start_time !== null &&
                                    capture.video_end_time !== null && (
                                        <p className="font-mono text-[10px] text-ghost-yellow mt-0.5">
                                            {Math.floor(capture.video_start_time)}s – {Math.floor(capture.video_end_time)}s
                                        </p>
                                    )}

                                {capture.capture_type === 'USER_NOTE' && capture.text_content && (
                                    <p className="font-sans text-[11px] text-ghost-muted mt-0.5 line-clamp-2 leading-relaxed">
                                        {capture.text_content}
                                    </p>
                                )}

                                {capture.capture_type === 'RESOURCE_UPLOAD' &&
                                    capture.capture_attachments?.length > 0 && (
                                        <p className="font-mono text-[10px] text-ghost-muted mt-0.5">
                                            {capture.capture_attachments[0].file_name}
                                        </p>
                                    )}

                                {capture.ai_markdown_summary && (
                                    <div className="mt-1.5 flex items-center gap-1">
                                        <span className="text-[10px]">✨</span>
                                        <span className="font-mono text-[10px] text-ghost-accent">AI summary ready</span>
                                    </div>
                                )}
                            </div>

                            {/* Delete button */}
                            <button
                                onClick={() => handleDelete(capture.id)}
                                disabled={deletingIds.has(capture.id)}
                                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-ghost-muted hover:text-ghost-red p-1 -mr-1 rounded"
                                title="Delete capture"
                            >
                                🗑
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
