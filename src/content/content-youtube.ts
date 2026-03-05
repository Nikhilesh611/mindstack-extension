export { };
/**
 * content-youtube.ts
 * Video segment tracker for YouTube (youtube.com only).
 *
 * FIXED BUGS:
 *   1. Hard reload required — added chrome.storage.onChanged listener so the
 *      tracker initialises as soon as a session starts, without needing a reload.
 *   2. No interaction captures — replaced duration-spread intervals with a
 *      fixed PERIODIC_INTERVAL_MS (30 s) that fires unconditionally while playing.
 *   3. Transcript only at instant — fetchTranscriptForSegment now fetches the
 *      full caption text from startTime → endTime of the segment, not a midpoint window.
 */

const MIN_SEGMENT_DURATION_SEC = 3;
const PERIODIC_INTERVAL_SEC = 30;       // capture every 30s of video playback time
const MAX_PERIODIC_CAPTURES = 20;        // safety cap per video

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function injectToast(message: string): void {
    const toast = document.createElement('div');
    toast.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
    background: #0F172A; color: #38BDF8;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px; padding: 8px 14px; border-radius: 6px;
    border: 1px solid #334155; box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    pointer-events: none; opacity: 0; transform: translateY(8px);
    transition: opacity 0.2s ease, transform 0.2s ease;
    max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  `;
    toast.textContent = `👻 MindStack: ${message}`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    }));
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        setTimeout(() => toast.remove(), 250);
    }, 2500);
}

// ---------------------------------------------------------------------------
// Frame capture — MUST be called synchronously (before any await)
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
 * Extracts the current caption/subtitle text visible in the DOM right now.
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
// Transcript extraction — full range from startSec to endSec
// BUG 3 FIX: Instead of a symmetric window around the midpoint, we now fetch
// everything from startSec to endSec so the capture includes all spoken words
// during that segment, not just what was visible at the moment of snapshot.
// ---------------------------------------------------------------------------

function getYouTubeCaptionTrackUrl(): Promise<string | null> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_YT_CAPTION_URL' }, (response) => {
            if (chrome.runtime.lastError) {
                resolve(null);
            } else {
                resolve(response?.data?.url ?? null);
            }
        });
    });
}

async function fetchTranscriptForSegment(
    startSec: number,
    endSec: number,
): Promise<string> {
    try {
        const trackUrl = await getYouTubeCaptionTrackUrl();
        if (!trackUrl) return '';

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

        const startMs = startSec * 1000;
        const endMs = endSec * 1000;

        const text = data.events
            .filter((e) => {
                if (e.tStartMs === undefined) return false;
                const captionStart = e.tStartMs;
                const captionEnd = captionStart + (e.dDurationMs ?? 0);
                // Include any caption event that overlaps [startMs, endMs]
                return captionStart < endMs && captionEnd > startMs;
            })
            .flatMap((e) => e.segs ?? [])
            .map((s) => s.utf8 ?? '')
            .join('')
            .replace(/\n/g, ' ')
            .trim();

        console.log(
            `[MindStack YT] Transcript ${startSec.toFixed(1)}s→${endSec.toFixed(1)}s: ${text.length} chars`
        );
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

async function getActiveSession(): Promise<ActiveSession | null> {
    return new Promise((resolve) => {
        chrome.storage.local.get(
            ['mindstack_session_id', 'mindstack_project_id', 'mindstack_workspace_id'],
            (result) => {
                const sessionId = result['mindstack_session_id'] as string | undefined;
                const projectId = (result['mindstack_project_id'] as string | undefined) ?? null;
                const workspaceId = (result['mindstack_workspace_id'] as string | undefined) ?? null;
                const isActive = !!(sessionId && (projectId || workspaceId));
                resolve(isActive ? { sessionId: sessionId!, projectId, workspaceId } : null);
            }
        );
    });
}

// ---------------------------------------------------------------------------
// Segment sender
// ---------------------------------------------------------------------------

async function sendVideoSegment(
    video: HTMLVideoElement,
    startTime: number,
    endTime: number,
    preCapturedFrame?: string | null,
): Promise<void> {
    const watchedDuration = endTime - startTime;
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

    // BUG 3 FIX: Fetch transcript from startTime → endTime (full segment range)
    let text_content = await fetchTranscriptForSegment(startTime, endTime);
    if (!text_content) {
        // Fallback: DOM captions visible right now
        text_content = extractCaptions();
        if (text_content) {
            console.log(`[MindStack YT] DOM caption fallback: "${text_content.slice(0, 60)}…"`);
        }
    }

    const payload = {
        type: 'INGEST_VIDEO' as const,
        payload: {
            session_id: session.sessionId,
            project_id: session.projectId,
            workspace_id: session.workspaceId,
            source_url: window.location.href,
            page_title: document.title,
            video_start_time: startTime,
            video_end_time: endTime,
            base64Frame,
            caption_text: text_content,
        },
    };

    console.log(
        `[MindStack YT] Sending capture — ${startTime.toFixed(1)}s → ${endTime.toFixed(1)}s ` +
        `(${watchedDuration.toFixed(1)}s), transcript: ${text_content.length} chars, ` +
        `context: ${session.projectId ? `project:${session.projectId}` : `workspace:${session.workspaceId}`}`
    );

    chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
            console.warn('[MindStack YT] sendMessage error:', chrome.runtime.lastError.message);
            return;
        }
        if (response?.success) {
            injectToast(`Captured — ${document.title.replace(' - YouTube', '').slice(0, 35)}`);
        } else {
            console.warn('[MindStack YT] Ingest failed:', response?.error);
            injectToast(`Capture failed — ${response?.error ?? 'unknown'}`);
        }
    });
}

// ---------------------------------------------------------------------------
// VideoTracker
// BUG 1 FIX: Uses native 'timeupdate' event instead of setInterval!
//            Fires reliably based on actual video time playback, immune to
//            background tab throttling or 2x speed variations! No interaction needed.
// BUG 2 FIX: Segments are non-overlapping — segmentStartTime resets to endTime.
// ---------------------------------------------------------------------------

class VideoTracker {
    private video: HTMLVideoElement;
    private segmentStartTime: number | null = null;
    private captureCount = 0;

    private onPlayBound: () => void;
    private onPauseBound: () => void;
    private onEndedBound: () => void;
    private onTimeUpdateBound: () => void;

    constructor(video: HTMLVideoElement) {
        this.video = video;
        this.onPlayBound = this.onPlay.bind(this);
        this.onPauseBound = this.onPause.bind(this);
        this.onEndedBound = this.onEnded.bind(this);
        this.onTimeUpdateBound = this.onTimeUpdate.bind(this);
        this.attach();
    }

    private attach(): void {
        this.video.addEventListener('play', this.onPlayBound);
        this.video.addEventListener('pause', this.onPauseBound);
        this.video.addEventListener('ended', this.onEndedBound);
        this.video.addEventListener('timeupdate', this.onTimeUpdateBound);
        console.log('[MindStack YT] Tracker attached.');

        // If video is already playing when we attach, start tracking immediately
        if (!this.video.paused && !this.video.ended) {
            console.log('[MindStack YT] Already playing — starting tracker.');
            this.onPlay();
        }
    }

    destroy(): void {
        this.video.removeEventListener('play', this.onPlayBound);
        this.video.removeEventListener('pause', this.onPauseBound);
        this.video.removeEventListener('ended', this.onEndedBound);
        this.video.removeEventListener('timeupdate', this.onTimeUpdateBound);
        console.log('[MindStack YT] Tracker destroyed.');
    }

    private onPlay(): void {
        this.segmentStartTime = this.video.currentTime;
        console.log(`[MindStack YT] Play — segment start at ${this.segmentStartTime.toFixed(1)}s`);
    }

    private onPause(): void {
        if (this.segmentStartTime !== null) {
            const frame = captureKeyframe(this.video); // sync, before any await
            const endTime = this.video.currentTime;
            const startTime = this.segmentStartTime;
            this.segmentStartTime = null;
            console.log(`[MindStack YT] Pause — segment ${startTime.toFixed(1)}s → ${endTime.toFixed(1)}s`);
            sendVideoSegment(this.video, startTime, endTime, frame);
        }
    }

    private onEnded(): void {
        this.onPause();
    }

    // Fires ~4 times a second during playback. Fully reliable.
    private onTimeUpdate(): void {
        if (this.video.paused || this.video.ended || this.segmentStartTime === null) return;

        const currentVideoTime = this.video.currentTime;
        const elapsed = currentVideoTime - this.segmentStartTime;

        if (elapsed >= PERIODIC_INTERVAL_SEC) {
            if (this.captureCount >= MAX_PERIODIC_CAPTURES) {
                // Throttle logs so we don't spam every 250ms
                if (Math.random() < 0.05) console.log('[MindStack YT] Max captures reached, skipping.');
                return;
            }

            const frame = captureKeyframe(this.video); // sync capture
            const endTime = currentVideoTime;
            const startTime = this.segmentStartTime;

            // BUG 2 FIX: reset start to endTime so next segment is non-overlapping
            this.segmentStartTime = endTime;
            this.captureCount++;

            console.log(
                `[MindStack YT] Periodic capture #${this.captureCount}/${MAX_PERIODIC_CAPTURES} ` +
                `at ${endTime.toFixed(1)}s`
            );
            sendVideoSegment(this.video, startTime, endTime, frame);
        }
    }
}

// ---------------------------------------------------------------------------
// Page Lifecycle Manager
// BUG 1 FIX: Added chrome.storage.onChanged listener — when a session/context
//            key is written to storage, we re-check and init the tracker if
//            needed. No hard reload required to start capturing.
// ---------------------------------------------------------------------------

let currentTracker: VideoTracker | null = null;

function initTracker(video: HTMLVideoElement): void {
    if (currentTracker) {
        currentTracker.destroy();
    }
    currentTracker = new VideoTracker(video);
}

function findAndTrackVideo(): void {
    const video = document.querySelector<HTMLVideoElement>('video.html5-main-video') || document.querySelector<HTMLVideoElement>('video');
    if (video) {
        initTracker(video);
    } else {
        const mo = new MutationObserver((_, obs) => {
            const v = document.querySelector<HTMLVideoElement>('video.html5-main-video') || document.querySelector<HTMLVideoElement>('video');
            if (v) {
                obs.disconnect();
                initTracker(v);
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }
}

// BUG 1 FIX: Watch for session becoming active without a page reload.
// When the user starts a session in the popup, mindstack_session_id or
// mindstack_project_id/workspace_id are written to storage. We detect that
// here and re-init the tracker so captures start immediately.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const sessionKeys = ['mindstack_session_id', 'mindstack_project_id', 'mindstack_workspace_id'];
    const relevant = sessionKeys.some((k) => k in changes);
    if (!relevant) return;

    const anyNewValue = sessionKeys.some((k) => changes[k]?.newValue);
    if (anyNewValue) {
        console.log('[MindStack YT] Session/context changed — re-initialising tracker.');
        // Small delay to let all storage writes settle
        setTimeout(findAndTrackVideo, 500);
    } else {
        // Session ended — destroy tracker
        if (currentTracker) {
            console.log('[MindStack YT] Session ended — destroying tracker.');
            currentTracker.destroy();
            currentTracker = null;
        }
    }
});

// YouTube SPA navigation — re-initialize on each video navigation
window.addEventListener('yt-navigate-finish', () => {
    console.log('[MindStack YT] yt-navigate-finish — re-initialising tracker.');
    setTimeout(findAndTrackVideo, 800);
});

// Initial load
findAndTrackVideo();
