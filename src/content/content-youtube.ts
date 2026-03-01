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
 */

const MIN_SEGMENT_DURATION_SEC = 3;   // lower so short intervals aren't silently dropped
const MAX_PERIODIC_CAPTURES = 10;  // max auto-captures per video session
const MIN_CAPTURE_INTERVAL_MS = 30_000; // never fire faster than every 30 s

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
        canvas.width = 1280; // HD width
        canvas.height = 720;  // HD height
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
        console.warn('[MindStack YT] Canvas capture failed:', e);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

async function getActiveSession(): Promise<{ sessionId: string; projectId: string } | null> {
    return new Promise((resolve) => {
        chrome.storage.local.get(['mindstack_session_id', 'mindstack_project_id'], (result) => {
            const sessionId = result['mindstack_session_id'] as string | undefined;
            const projectId = result['mindstack_project_id'] as string | undefined;
            resolve(sessionId && projectId ? { sessionId, projectId } : null);
        });
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
    endTime: number,
    preCapturedFrame?: string | null,
): Promise<void> {
    const segDuration = endTime - startTime;
    if (segDuration < MIN_SEGMENT_DURATION_SEC) {
        console.log(`[MindStack YT] Segment too short (${segDuration.toFixed(1)}s) — skipped.`);
        return;
    }

    const session = await getActiveSession();
    if (!session) {
        console.warn('[MindStack YT] No active session — skipped.');
        return;
    }

    // Use caller-supplied frame, or fall back to capturing now (best-effort)
    const base64Frame = preCapturedFrame ?? captureKeyframe(video) ?? '';

    const payload = {
        type: 'INGEST_VIDEO' as const,
        payload: {
            session_id: session.sessionId,
            project_id: session.projectId,
            source_url: window.location.href,
            page_title: document.title,
            video_start_time: Math.floor(startTime),
            video_end_time: Math.floor(endTime),
            base64Frame,
        },
    };

    chrome.runtime.sendMessage(payload, (response) => {
        // Guard against MV3 service worker being idle (chrome.runtime.lastError must be read)
        if (chrome.runtime.lastError) {
            console.warn('[MindStack YT] sendMessage error:', chrome.runtime.lastError.message);
            return;
        }
        if (response?.success) {
            const title = document.title.replace(' - YouTube', '').slice(0, 35);
            injectToast(`Captured — ${title}`);
        } else {
            console.warn('[MindStack YT] Video ingest failed:', response?.error);
        }
    });
}

// ---------------------------------------------------------------------------
// Video Tracker
// ---------------------------------------------------------------------------

class VideoTracker {
    private video: HTMLVideoElement;
    private segmentStartTime: number | null = null;
    private captureCount = 0;   // periodic captures so far this session
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
    }

    destroy(): void {
        this.video.removeEventListener('play', this.onPlayBound);
        this.video.removeEventListener('pause', this.onPauseBound);
        this.video.removeEventListener('ended', this.onEndedBound);
        this.stopPeriodicCapture();
        console.log('[MindStack YT] Video tracker destroyed.');
    }

    // ---- event handlers -----------------------------------------------

    private onPlay(): void {
        this.segmentStartTime = this.video.currentTime;
        this.scheduleNextCapture();
        console.log(`[MindStack YT] Play — segment started at ${this.segmentStartTime.toFixed(1)}s`);
    }

    private onPause(): void {
        this.stopPeriodicCapture();
        if (this.segmentStartTime !== null) {
            // ✅ Capture frame synchronously right now, before any async work
            const frame = captureKeyframe(this.video);
            const endTime = this.video.currentTime;
            const startTime = this.segmentStartTime;
            this.segmentStartTime = null;
            console.log(`[MindStack YT] Pause — sending segment ${startTime.toFixed(1)}s → ${endTime.toFixed(1)}s`);
            sendVideoSegment(this.video, startTime, endTime, frame);
        }
    }

    private onEnded(): void {
        this.onPause();
    }

    // ---- periodic capture (setTimeout loop) ---------------------------

    /**
     * Schedules the next periodic capture.
     * Using setTimeout (not setInterval) so the delay recalculates from the
     * current video.duration on every tick — handles cases where YouTube
     * delivers duration late.
     */
    private scheduleNextCapture(): void {
        if (this.captureCount >= MAX_PERIODIC_CAPTURES) {
            console.log('[MindStack YT] Periodic cap reached — no more auto-captures.');
            return;
        }

        const duration = this.video.duration;
        const intervalMs = isFinite(duration) && duration > 0
            ? Math.max((duration / MAX_PERIODIC_CAPTURES) * 1000, MIN_CAPTURE_INTERVAL_MS)
            : MIN_CAPTURE_INTERVAL_MS;

        console.log(
            `[MindStack YT] Next periodic capture in ${(intervalMs / 1000).toFixed(0)}s ` +
            `(capture ${this.captureCount + 1}/${MAX_PERIODIC_CAPTURES}, ` +
            `video duration: ${isFinite(duration) ? duration.toFixed(0) + 's' : 'unknown'})`,
        );

        this.intervalTimer = setTimeout(() => {
            this.intervalTimer = null;

            // Skip if video is paused/ended (onPause already handled it)
            if (this.video.paused || this.video.ended) return;
            if (this.segmentStartTime === null) return;

            // ✅ Capture frame synchronously before any async work
            const frame = captureKeyframe(this.video);
            const endTime = this.video.currentTime;
            const startTime = this.segmentStartTime;
            this.segmentStartTime = endTime; // slide the window forward
            this.captureCount++;

            console.log(`[MindStack YT] Periodic capture #${this.captureCount}/${MAX_PERIODIC_CAPTURES} at ${endTime.toFixed(1)}s`);
            sendVideoSegment(this.video, startTime, endTime, frame);

            // Schedule the next one
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
        // MutationObserver fallback: wait for <video> to appear
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
