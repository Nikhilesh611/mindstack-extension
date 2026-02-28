export {};
/**
 * content-reader.ts
 * Passive web text capture for all non-YouTube pages.
 * Runs at document_idle. Sends WEB_TEXT captures to the background worker.
 *
 * Key behaviours:
 *   - Caches URL/title at observation time (Fix â‘ : SPA URL race condition)
 *   - 3-second dwell before capturing
 *   - Deduplicates by text hash
 *   - Injects stealth toast on success (Fix â‘£)
 *   - Skips nav / header / footer / aside elements
 */

const DWELL_TIME_MS = 3000;
const SESSION_POLL_INTERVAL_MS = 5000;
const IGNORED_SELECTORS = ['nav', 'header', 'footer', 'aside', '[role="navigation"]', '[role="banner"]', '[role="complementary"]'];
const CONTENT_SELECTORS = 'p, article, section, code, pre, blockquote, li, h1, h2, h3, h4';
const MIN_TEXT_LENGTH = 80;

// Simple FNV-1a 32-bit hash for dedup
function hashText(text: string): string {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16);
}

function isIgnoredElement(el: Element): boolean {
    return IGNORED_SELECTORS.some((sel) => el.closest(sel) !== null);
}

function injectToast(message: string): void {
    const toast = document.createElement('div');
    toast.setAttribute('id', 'mindstack-toast-' + Date.now());
    toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    background: #0F172A;
    color: #4ADE80;
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
    max-width: 280px;
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Core Logic
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const sentHashes = new Set<string>();
const pendingTimers = new Map<Element, ReturnType<typeof setTimeout>>();

let isSessionActive = false;

async function checkSessionActive(): Promise<boolean> {
    return new Promise((resolve) => {
        chrome.storage.local.get(['mindstack_session_id'], (result) => {
            resolve(!!result['mindstack_session_id']);
        });
    });
}

async function sendCapture(
    text: string,
    cachedUrl: string,  // Fix â‘ : cached at observation time
    cachedTitle: string // Fix â‘ : cached at observation time
): Promise<void> {
    const hash = hashText(text.trim());
    if (sentHashes.has(hash)) return;
    sentHashes.add(hash);

    // Re-read session/project from storage at send time (MV3 safety)
    const stored: Record<string, string> = await new Promise((resolve) =>
        chrome.storage.local.get(['mindstack_session_id', 'mindstack_project_id'], resolve as () => void)
    );

    const sessionId = stored['mindstack_session_id'];
    const projectId = stored['mindstack_project_id'];
    if (!sessionId || !projectId) return;

    chrome.runtime.sendMessage(
        {
            type: 'INGEST_BROWSER',
            payload: {
                session_id: sessionId,
                project_id: projectId,
                capture_type: 'WEB_TEXT',
                text_content: text.trim().slice(0, 4000),
                source_url: cachedUrl,
                page_title: cachedTitle,
                priority: 1,
            },
        },
        (response) => {
            if (response?.success) {
                // Fix â‘£: Stealth toast notification
                const shortTitle = cachedTitle.slice(0, 40) + (cachedTitle.length > 40 ? 'â€¦' : '');
                injectToast(`Captured â€” ${shortTitle}`);
            }
        }
    );
}

function setupObserver(): void {
    const observer = new IntersectionObserver(
        (entries) => {
            if (!isSessionActive) return;

            for (const entry of entries) {
                const el = entry.target as HTMLElement;

                if (entry.isIntersecting) {
                    // Fix â‘ : Cache URL and title at the moment of observation
                    const cachedUrl = window.location.href;
                    const cachedTitle = document.title;

                    const timer = setTimeout(async () => {
                        if (!entry.target.isConnected) return;

                        const text = el.textContent?.trim() ?? '';
                        if (text.length < MIN_TEXT_LENGTH) return;
                        if (isIgnoredElement(el)) return;

                        await sendCapture(text, cachedUrl, cachedTitle);
                    }, DWELL_TIME_MS);

                    pendingTimers.set(el, timer);
                } else {
                    // Element left viewport before timer fired â€” cancel
                    const timer = pendingTimers.get(el);
                    if (timer !== undefined) {
                        clearTimeout(timer);
                        pendingTimers.delete(el);
                    }
                }
            }
        },
        { threshold: 0.6 } // 60% of the element must be visible
    );

    // Observe all content elements
    const elements = document.querySelectorAll<HTMLElement>(CONTENT_SELECTORS);
    elements.forEach((el) => {
        if (!isIgnoredElement(el) && (el.textContent?.trim().length ?? 0) >= MIN_TEXT_LENGTH) {
            observer.observe(el);
        }
    });

    // Also observe dynamically added elements via MutationObserver
    const mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                const el = node as HTMLElement;
                const matches = el.matches(CONTENT_SELECTORS)
                    ? [el]
                    : Array.from(el.querySelectorAll<HTMLElement>(CONTENT_SELECTORS));

                for (const match of matches) {
                    if (!isIgnoredElement(match) && (match.textContent?.trim().length ?? 0) >= MIN_TEXT_LENGTH) {
                        observer.observe(match);
                    }
                }
            }
        }
    });

    mutationObserver.observe(document.body, { childList: true, subtree: true });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Init
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function main(): Promise<void> {
    isSessionActive = await checkSessionActive();

    if (isSessionActive) {
        setupObserver();
    }

    // Poll for session state changes (e.g., user started a new session while on the page)
    setInterval(async () => {
        const nowActive = await checkSessionActive();
        if (nowActive && !isSessionActive) {
            isSessionActive = true;
            setupObserver();
        } else if (!nowActive && isSessionActive) {
            isSessionActive = false;
            pendingTimers.forEach(clearTimeout);
            pendingTimers.clear();
        }
    }, SESSION_POLL_INTERVAL_MS);
}

main();

