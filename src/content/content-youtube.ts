export { };
/**
 * content-youtube.ts
 * Video segment tracker for YouTube (youtube.com only).
 *
 * Key behaviours:
 *   - Re-initializes on `yt-navigate-finish` (YouTube SPA navigation)
 *   - MutationObserver fallback to detect <video> element
 *   - Tracks video play/pause to record (startTime, endTime) segments
 *   - Frame snapshot captured SYNCHRONOUSLY at the moment of capture (before
 *     any async work) so the canvas always contains the correct frame
 *   - Periodic auto-capture: up to MAX_PERIODIC_CAPTURES per session, interval
 *     spread evenly across the video duration (min MIN_CAPTURE_INTERVAL_MS)
 *   - On pause: immediate frame snapshot + segment send
 *   - Sends INGEST_VIDEO message to background (background handles S3 + ingest)
 *   - Injects stealth toast on success
 *   - Workspace-aware: session is only active when BOTH session_id AND
 *     (project_id OR workspace_id) are present in storage.
 */

const MIN_SEGMENT_DURATION_SEC = 3;
const MAX_PERIODIC_CAPTURES = 10;
const MIN_CAPTURE_INTERVAL_MS = 30_000;
const DURATION_RETRY_DELAY_MS = 1_500;

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function injectToast(message: string): void {
    const toast = document.createElement('div');
    toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    background: #0F172A;
    color: #38BDF8;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    padding: 8px 14px;
    border-radius: 6px;
    border: 1px solid #334155;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    pointer-events: none;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.2s ease, transform 0.2s ease;
    max-width: 300px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `;
    toast.textContent = `👻 MindStack: ${message}`;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        setTimeout(() => toast.remove(), 250);
    }, 2500);
}

// ---------------------------------------------------------------------------
// Frame capture  — MUST be called synchronously (before any await)
// ---------------------------------------------------------------------------

function captureKeyframe(video: HTMLVideoElement): string | null {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.95);
    } catch (e) {
        console.warn('[MindStack YT] Canvas capture failed:', e);
        return null;
    }
}

/**
 * Extracts the current caption/subtitle text visible on screen.
 */
function extractCaptions(): string {
    const segments = document.querySelectorAll('.ytp-caption-segment');
    if (!segments.length) return '';
    return Array.from(segments)
        .map((s) => s.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
}

// ---------------------------------------------------------------------------
// Transcript extraction via page-world script injection
// ---------------------------------------------------------------------------

function getYouTubeCaptionTrackUrl(): Promise<string | null> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_YT_CAPTION_URL' }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[MindStack YT] getYouTubeCaptionTrackUrl error:', chrome.runtime.lastError.message);
                resolve(null);
            } else {
                resolve(response?.data?.url ?? null);
            }
        });
    });
}

async function fetchTranscriptWindow(
    captureTimeSec: number,
    windowSec = 60,
): Promise<string> {
    try {
        const trackUrl = await getYouTubeCaptionTrackUrl();
        if (!trackUrl) {
            console.log('[MindStack YT] No caption track URL — falling back to DOM captions.');
            return '';
        }

        const res = await fetch(`${trackUrl}&fmt=json3`);
        if (!res.ok) return '';

        const data = await res.json() as {
            events?: Array<{
                tStartMs?: number;
                dDurationMs?: number;
                segs?: Array<{ utf8?: string }>;
            }>;
        };

        if (!Array.isArray(data.events) || data.events.length === 0) return '';

        const halfWindowMs = (windowSec / 2) * 1000;
        const captureMs = captureTimeSec * 1000;
        const rangeStartMs = captureMs - halfWindowMs;
        const rangeEndMs = captureMs + halfWindowMs;

        const text = data.events
            .filter((e) => {
                if (e.tStartMs === undefined) return false;
                const captionStartMs = e.tStartMs;
                const captionEndMs = captionStartMs + (e.dDurationMs ?? 0);
                return captionStartMs <= rangeEndMs && captionEndMs >= rangeStartMs;
            })
            .flatMap((e) => e.segs ?? [])
            .map((s) => s.utf8 ?? '')
            .join('')
            .replace(/\n/g, ' ')
            .trim();

        console.log(`[MindStack YT] Transcript window: ${text.length} chars (±${windowSec / 2}s around ${captureTimeSec.toFixed(1)}s)`);
        return text;
    } catch (e) {
        console.warn('[MindStack YT] Transcript fetch failed:', e);
        return '';
    }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

interface ActiveSession {
    sessionId: string;
    projectId: string | null;
    workspaceId: string | null;
}

/**
 * CRITICAL FIX: Session is only considered active when BOTH session_id AND
 * at least one context ID (project_id OR workspace_id) are present in storage.
 */
async function getActiveSession(): Promise<ActiveSession | null> {
    return new Promise((resolve) => {
        chrome.storage.local.get(
            ['mindstack_session_id', 'mindstack_project_id', 'mindstack_workspace_id'],
            (result) => {
                const sessionId = result['mindstack_session_id'] as string | undefined;
                const projectId = (result['mindstack_project_id'] as string | undefined) ?? null;
                const workspaceId = (result['mindstack_workspace_id'] as string | undefined) ?? null;

                // Must have session AND at least one of project or workspace
                const isActive = !!(sessionId && (projectId || workspaceId));
                resolve(isActive ? { sessionId: sessionId!, projectId, workspaceId } : null);
            }
        );
    });
}

// ---------------------------------------------------------------------------
// Segment sender
// frame is captured by the CALLER synchronously, then passed in here so the
// async session lookup doesn't cause us to draw from the wrong video position.
// ---------------------------------------------------------------------------

async function sendVideoSegment(
    video: HTMLVideoElement,
    startTime: number,
    _endTime: number,
    preCapturedFrame?: string | null,
    _preCapturedCaptions?: string,
): Promise<void> {
    const watchedDuration = _endTime - startTime;
    if (watchedDuration < MIN_SEGMENT_DURATION_SEC) {
        console.log(`[MindStack YT] Segment too short (${watchedDuration.toFixed(1)}s) — skipped.`);
        return;
    }

    const session = await getActiveSession();
    if (!session) {
        console.warn('[MindStack YT] No active session — skipped.');
        return;
    }

    const base64Frame = preCapturedFrame ?? captureKeyframe(video) ?? '';

    // ── Transcript extraction (3-level fallback) ──────────────────────────────
    const segmentDuration = _endTime - startTime;
    const segmentCenter = startTime + (segmentDuration / 2);
    let text_content = await fetchTranscriptWindow(segmentCenter, segmentDuration);
    if (!text_content) {
        text_content = extractCaptions();
        if (text_content) {
            console.log(`[MindStack YT] Using DOM captions as fallback: "${text_content.slice(0, 60)}…"`);
        }
    }

    const captureStartTime = startTime;
    const captureEndTime = _endTime;

    const payload = {
        type: 'INGEST_VIDEO' as const,
        payload: {
            session_id: session.sessionId,
            project_id: session.projectId,
            workspace_id: session.workspaceId,
            source_url: window.location.href,
            page_title: document.title,
            video_start_time: captureStartTime,
            video_end_time: captureEndTime,
            base64Frame,
            caption_text: text_content,
        },
    };

    console.log(
        `[MindStack YT] Sending capture — watched ${watchedDuration.toFixed(1)}s, ` +
        `keyframe window: ${captureStartTime.toFixed(1)}s → ${captureEndTime.toFixed(1)}s, ` +
        `transcript: ${text_content.length} chars, ` +
        `context: ${session.projectId ? `project:${session.projectId}` : `workspace:${session.workspaceId}`}`,
    );

    chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
            console.warn('[MindStack YT] sendMessage error:', chrome.runtime.lastError.message);
            return;
        }
        if (response?.success) {
            const title = document.title.replace(' - YouTube', '').slice(0, 35);
            injectToast(`Captured — ${title}`);
        } else {
            console.warn('[MindStack YT] Video ingest failed:', response?.error);
            injectToast(`Capture failed — ${response?.error ?? 'unknown error'}`);
        }
    });
}

// ---------------------------------------------------------------------------
// Video Tracker
// ---------------------------------------------------------------------------

class VideoTracker {
    private video: HTMLVideoElement;
    private segmentStartTime: number | null = null;
    private captureCount = 0;
    private intervalTimer: ReturnType<typeof setTimeout> | null = null;

    private onPlayBound: () => void;
    private onPauseBound: () => void;
    private onEndedBound: () => void;

    constructor(video: HTMLVideoElement) {
        this.video = video;
        this.onPlayBound = this.onPlay.bind(this);
        this.onPauseBound = this.onPause.bind(this);
        this.onEndedBound = this.onEnded.bind(this);
        this.attach();
    }

    private attach(): void {
        this.video.addEventListener('play', this.onPlayBound);
        this.video.addEventListener('pause', this.onPauseBound);
        this.video.addEventListener('ended', this.onEndedBound);
        console.log('[MindStack YT] Video tracker attached.');

        if (!this.video.paused && !this.video.ended) {
            console.log('[MindStack YT] Video already playing on attach — simulating play event.');
            this.onPlay();
        }
    }

    destroy(): void {
        this.video.removeEventListener('play', this.onPlayBound);
        this.video.removeEventListener('pause', this.onPauseBound);
        this.video.removeEventListener('ended', this.onEndedBound);
        this.stopPeriodicCapture();
        console.log('[MindStack YT] Video tracker destroyed.');
    }

    private onPlay(): void {
        this.segmentStartTime = this.video.currentTime;
        this.scheduleNextCapture();
        console.log(`[MindStack YT] Play — segment started at ${this.segmentStartTime.toFixed(1)}s`);
    }

    private onPause(): void {
        this.stopPeriodicCapture();
        if (this.segmentStartTime !== null) {
            const frame = captureKeyframe(this.video);
            const captions = extractCaptions();
            const endTime = this.video.currentTime;
            const startTime = this.segmentStartTime;
            this.segmentStartTime = null;
            console.log(`[MindStack YT] Pause — sending segment ${startTime.toFixed(1)}s → ${endTime.toFixed(1)}s`);
            sendVideoSegment(this.video, startTime, endTime, frame, captions);
        }
    }

    private onEnded(): void {
        this.onPause();
    }

    private scheduleNextCapture(): void {
        if (this.captureCount >= MAX_PERIODIC_CAPTURES) {
            console.log('[MindStack YT] Periodic cap reached — no more auto-captures.');
            return;
        }

        const duration = this.video.duration;

        if (!isFinite(duration) || duration <= 0) {
            console.log('[MindStack YT] Duration not yet available — retrying schedule in 1.5s.');
            this.intervalTimer = setTimeout(() => {
                this.intervalTimer = null;
                if (!this.video.paused && !this.video.ended) {
                    this.scheduleNextCapture();
                }
            }, DURATION_RETRY_DELAY_MS);
            return;
        }

        const intervalMs = Math.max(
            (duration / MAX_PERIODIC_CAPTURES) * 1000,
            MIN_CAPTURE_INTERVAL_MS,
        );

        console.log(
            `[MindStack YT] Next periodic capture in ${(intervalMs / 1000).toFixed(0)}s ` +
            `(capture ${this.captureCount + 1}/${MAX_PERIODIC_CAPTURES}, ` +
            `video duration: ${duration.toFixed(0)}s)`,
        );

        this.intervalTimer = setTimeout(() => {
            this.intervalTimer = null;

            if (this.video.paused || this.video.ended) return;
            if (this.segmentStartTime === null) return;

            const frame = captureKeyframe(this.video);
            const captions = extractCaptions();
            const endTime = this.video.currentTime;
            const startTime = this.segmentStartTime;
            this.segmentStartTime = endTime;
            this.captureCount++;

            console.log(`[MindStack YT] Periodic capture #${this.captureCount}/${MAX_PERIODIC_CAPTURES} at ${endTime.toFixed(1)}s`);
            sendVideoSegment(this.video, startTime, endTime, frame, captions);

            this.scheduleNextCapture();
        }, intervalMs);
    }

    private stopPeriodicCapture(): void {
        if (this.intervalTimer !== null) {
            clearTimeout(this.intervalTimer);
            this.intervalTimer = null;
        }
    }
}

// ---------------------------------------------------------------------------
// Page Lifecycle Manager
// ---------------------------------------------------------------------------

let currentTracker: VideoTracker | null = null;

function findAndTrackVideo(): void {
    const video = document.querySelector<HTMLVideoElement>('video');
    if (video) {
        initTracker(video);
    } else {
        const mo = new MutationObserver((_, obs) => {
            const v = document.querySelector<HTMLVideoElement>('video');
            if (v) {
                obs.disconnect();
                initTracker(v);
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }
}

function initTracker(video: HTMLVideoElement): void {
    if (currentTracker) {
        currentTracker.destroy();
    }
    currentTracker = new VideoTracker(video);
}

// YouTube SPA navigation — re-initialize on each video navigation
window.addEventListener('yt-navigate-finish', () => {
    console.log('[MindStack YT] yt-navigate-finish fired — re-initializing tracker.');
    setTimeout(findAndTrackVideo, 800);
});

// Initial load
findAndTrackVideo();
