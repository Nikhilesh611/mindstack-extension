export {};
/**
 * content-youtube.ts
 * Video segment tracker for YouTube (youtube.com only).
 *
 * Key behaviours:
 *   - Re-initializes on `yt-navigate-finish` (YouTube SPA navigation)
 *   - MutationObserver fallback to detect <video> element
 *   - Tracks video play/pause to record (startTime, endTime) segments
 *   - Captures a Base64 JPEG keyframe from a hidden <canvas>
 *   - Sends INGEST_VIDEO message to background (background handles S3 + ingest)
 *   - Injects stealth toast on success (Fix â‘£)
 */

const MIN_SEGMENT_DURATION_SEC = 5; // don't capture tiny accidental plays

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
    toast.textContent = `ðŸ‘» MindStack: ${message}`;
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

function captureKeyframe(video: HTMLVideoElement): string | null {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.7);
    } catch (e) {
        console.warn('[MindStack YT] Canvas capture failed:', e);
        return null;
    }
}

async function getActiveSession(): Promise<{ sessionId: string; projectId: string } | null> {
    return new Promise((resolve) => {
        chrome.storage.local.get(['mindstack_session_id', 'mindstack_project_id'], (result) => {
            const sessionId = result['mindstack_session_id'] as string | undefined;
            const projectId = result['mindstack_project_id'] as string | undefined;
            resolve(sessionId && projectId ? { sessionId, projectId } : null);
        });
    });
}

async function sendVideoSegment(
    video: HTMLVideoElement,
    startTime: number,
    endTime: number
): Promise<void> {
    const duration = endTime - startTime;
    if (duration < MIN_SEGMENT_DURATION_SEC) return;

    const session = await getActiveSession();
    if (!session) return;

    const base64Frame = captureKeyframe(video);

    const payload = {
        type: 'INGEST_VIDEO' as const,
        payload: {
            session_id: session.sessionId,
            project_id: session.projectId,
            source_url: window.location.href,
            page_title: document.title,
            video_start_time: Math.floor(startTime),
            video_end_time: Math.floor(endTime),
            base64Frame: base64Frame ?? '',
        },
    };

    chrome.runtime.sendMessage(payload, (response) => {
        if (response?.success) {
            const title = document.title.replace(' - YouTube', '').slice(0, 35);
            injectToast(`Video captured â€” ${title}`);
        } else {
            console.warn('[MindStack YT] Video ingest failed:', response?.error);
        }
    });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Video Tracker
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class VideoTracker {
    private video: HTMLVideoElement;
    private segmentStartTime: number | null = null;
    private periodicTimer: ReturnType<typeof setInterval> | null = null;
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

    private onPlay(): void {
        this.segmentStartTime = this.video.currentTime;
        this.startPeriodicCapture();
    }

    private onPause(): void {
        this.stopPeriodicCapture();
        if (this.segmentStartTime !== null) {
            sendVideoSegment(this.video, this.segmentStartTime, this.video.currentTime);
            this.segmentStartTime = null;
        }
    }

    private onEnded(): void {
        this.onPause();
    }

    private startPeriodicCapture(): void {
        this.stopPeriodicCapture();
        // Capture a segment every 60 seconds of continuous play
        this.periodicTimer = setInterval(async () => {
            if (this.segmentStartTime === null) return;
            const endTime = this.video.currentTime;
            const startTime = this.segmentStartTime;
            this.segmentStartTime = endTime; // reset for next segment
            await sendVideoSegment(this.video, startTime, endTime);
        }, 60_000);
    }

    private stopPeriodicCapture(): void {
        if (this.periodicTimer !== null) {
            clearInterval(this.periodicTimer);
            this.periodicTimer = null;
        }
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Page Lifecycle Manager
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// YouTube SPA navigation â€” re-initialize on each video navigation
window.addEventListener('yt-navigate-finish', () => {
    console.log('[MindStack YT] yt-navigate-finish fired â€” re-initializing tracker.');
    // Small delay to let YouTube mount the new <video> element
    setTimeout(findAndTrackVideo, 800);
});

// Initial load
findAndTrackVideo();

