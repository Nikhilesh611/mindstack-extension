import { useState, useEffect } from 'react';
import type { Project } from '../../lib/types';
import VaultPanel from './VaultPanel';
import LiveFeed from './LiveFeed';

interface CommandCenterProps {
    onLogout: () => void;
}

type SessionState = 'idle' | 'starting' | 'active' | 'stopping';

// Module-level helper avoids TSX generic-arrow JSX ambiguity (TS1700)
function sendMsg<T>(msg: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

export default function CommandCenter({ onLogout }: CommandCenterProps) {
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedProjectId, setSelectedProjectId] = useState<string>('');
    const [sessionState, setSessionState] = useState<SessionState>('idle');
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [loadingProjects, setLoadingProjects] = useState(true);
    const [projectError, setProjectError] = useState<string | null>(null);
    const [statusMsg, setStatusMsg] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'feed' | 'vault'>('feed');

    // Inline workspace creation state
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newProjectName, setNewProjectName] = useState('');
    const [createLoading, setCreateLoading] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    // Load initial state from storage
    useEffect(() => {
        chrome.storage.local.get(
            ['mindstack_session_id', 'mindstack_project_id'],
            (result) => {
                const sid = result['mindstack_session_id'] as string | undefined;
                const pid = result['mindstack_project_id'] as string | undefined;
                if (sid) {
                    setActiveSessionId(sid);
                    setSessionState('active');
                }
                if (pid) setSelectedProjectId(pid);
            }
        );
    }, []);

    const fetchProjects = async () => {
        setLoadingProjects(true);
        setProjectError(null);
        const res = await sendMsg<Project[]>({ type: 'GET_PROJECTS' });
        if (res?.success && Array.isArray(res.data)) {
            setProjects(res.data);
            setSelectedProjectId((prev) => {
                if (!prev && res.data && res.data.length > 0) {
                    const firstId = res.data[0].id;
                    chrome.storage.local.set({ mindstack_project_id: firstId });
                    return firstId;
                }
                return prev;
            });
        } else {
            setProjectError(res?.error ?? 'Failed to load workspaces.');
        }
        setLoadingProjects(false);
    };

    // Fetch projects on mount
    useEffect(() => {
        fetchProjects();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleCreateProject = async () => {
        if (!newProjectName.trim()) return;
        setCreateLoading(true);
        setCreateError(null);

        const res = await sendMsg<{ project_id: string }>({
            type: 'CREATE_PROJECT',
            name: newProjectName.trim(),
        });

        if (res?.success) {
            setNewProjectName('');
            setShowCreateForm(false);
            await fetchProjects(); // refresh the project list
        } else {
            setCreateError(res?.error ?? 'Failed to create workspace.');
        }
        setCreateLoading(false);
    };

    const handleProjectChange = (projectId: string) => {
        setSelectedProjectId(projectId);
        chrome.storage.local.set({ mindstack_project_id: projectId });
    };

    const handleStartSession = async () => {
        if (!selectedProjectId) return;
        setSessionState('starting');
        setStatusMsg(null);

        const res = await sendMsg<{ session_id: string }>({
            type: 'START_SESSION',
            project_id: selectedProjectId,
        });

        if (res?.success && res.data?.session_id) {
            setActiveSessionId(res.data.session_id);
            setSessionState('active');
            setStatusMsg('Session started — capturing is active.');
        } else {
            setSessionState('idle');
            setStatusMsg(res?.error ?? 'Failed to start session.');
        }
    };

    const handleStopSession = async () => {
        setSessionState('stopping');
        setStatusMsg(null);
        await sendMsg({ type: 'END_SESSION' });
        setActiveSessionId(null);
        setSessionState('idle');
        setStatusMsg('Session ended. AI debrief in progress...');
    };

    const handleLogout = async () => {
        await chrome.storage.local.remove([
            'mindstack_jwt',
            'mindstack_session_id',
            'mindstack_project_id',
        ]);
        onLogout();
    };

    const isSessionActive = sessionState === 'active';

    return (
        <div className="flex flex-col w-full bg-ghost-bg min-h-screen animate-fade-in">
            {/* ── Top Bar ── */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-ghost-border">
                <div className="flex items-center gap-2">
                    <span className="text-base">👻</span>
                    <span className="font-mono text-xs font-semibold text-ghost-text">MindStack</span>
                    {isSessionActive && (
                        <div className="flex items-center gap-1.5 ml-1 px-2 py-0.5 rounded-full bg-ghost-green/10 border border-ghost-green/30">
                            <div className="pulse-dot scale-75" />
                            <span className="font-mono text-[10px] text-ghost-green font-semibold">LIVE</span>
                        </div>
                    )}
                </div>
                <button
                    onClick={handleLogout}
                    className="font-mono text-[10px] text-ghost-muted hover:text-ghost-red transition-colors"
                    title="Logout"
                >
                    ⎋ logout
                </button>
            </div>

            {/* ── Project Selector ── */}
            <div className="px-4 pt-3 pb-2">
                <div className="flex items-center justify-between mb-1.5">
                    <label className="ghost-label">Workspace</label>
                    <button
                        onClick={() => { setShowCreateForm((v) => !v); setCreateError(null); }}
                        className="font-mono text-[10px] text-ghost-accent hover:text-ghost-accent/80 transition-colors"
                    >
                        {showCreateForm ? '✕ cancel' : '+ new'}
                    </button>
                </div>

                {/* Inline create form */}
                {showCreateForm && (
                    <div className="flex flex-col gap-2 mb-2 animate-slide-up">
                        <input
                            type="text"
                            className="ghost-input"
                            placeholder="Workspace name..."
                            value={newProjectName}
                            onChange={(e) => setNewProjectName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCreateProject()}
                            autoFocus
                        />
                        {createError && (
                            <p className="font-mono text-[10px] text-ghost-red">{createError}</p>
                        )}
                        <button
                            onClick={handleCreateProject}
                            disabled={!newProjectName.trim() || createLoading}
                            className="ghost-btn-primary"
                        >
                            {createLoading ? (
                                <span className="flex items-center justify-center gap-2">
                                    <div className="w-3 h-3 border border-ghost-bg border-t-transparent rounded-full animate-spin" />
                                    Creating...
                                </span>
                            ) : '→ Create Workspace'}
                        </button>
                    </div>
                )}

                {loadingProjects ? (
                    <div className="ghost-input flex items-center gap-2 text-ghost-muted">
                        <div className="w-3 h-3 border border-ghost-muted border-t-transparent rounded-full animate-spin" />
                        Loading workspaces...
                    </div>
                ) : projectError ? (
                    <div className="text-ghost-red font-mono text-xs">{projectError}</div>
                ) : projects.length === 0 ? (
                    /* Fix ③: Zero-projects onboarding state — now with inline creation */
                    <div className="ghost-card border-ghost-accent/30 bg-ghost-accent/5 animate-fade-in text-center py-3">
                        <p className="font-mono text-xs text-ghost-text mb-1">No workspaces yet.</p>
                        <p className="font-mono text-[10px] text-ghost-muted">
                            Click <span className="text-ghost-accent">+ new</span> above to create one.
                        </p>
                    </div>
                ) : (
                    <select
                        value={selectedProjectId}
                        onChange={(e) => handleProjectChange(e.target.value)}
                        className="ghost-input cursor-pointer"
                    >
                        {projects.map((p) => (
                            <option key={p.id} value={p.id} className="bg-ghost-surface">
                                {p.name}
                            </option>
                        ))}
                    </select>
                )}
            </div>

            {/* ── Session Control ── (only if projects exist) */}
            {projects.length > 0 && (
                <div className="px-4 pb-3">
                    {sessionState === 'idle' && (
                        <button
                            onClick={handleStartSession}
                            className="w-full ghost-btn bg-ghost-green/20 text-ghost-green border border-ghost-green/30 hover:bg-ghost-green/30 focus:ring-ghost-green"
                        >
                            ▶ Start Capture Session
                        </button>
                    )}
                    {sessionState === 'starting' && (
                        <button disabled className="w-full ghost-btn bg-ghost-green/10 text-ghost-green border border-ghost-green/20 cursor-wait">
                            <div className="inline-block w-3 h-3 border border-ghost-green border-t-transparent rounded-full animate-spin mr-2" />
                            Starting...
                        </button>
                    )}
                    {sessionState === 'active' && (
                        <button
                            onClick={handleStopSession}
                            className="w-full ghost-btn bg-ghost-red/20 text-ghost-red border border-ghost-red/30 hover:bg-ghost-red/30 focus:ring-ghost-red"
                        >
                            ⏹ End Session
                        </button>
                    )}
                    {sessionState === 'stopping' && (
                        <button disabled className="w-full ghost-btn bg-ghost-red/10 text-ghost-red border border-ghost-red/20 cursor-wait">
                            <div className="inline-block w-3 h-3 border border-ghost-red border-t-transparent rounded-full animate-spin mr-2" />
                            Ending session...
                        </button>
                    )}

                    {statusMsg && (
                        <p className="font-mono text-[10px] text-ghost-muted mt-1.5 text-center">{statusMsg}</p>
                    )}
                </div>
            )}

            {/* ── Tab Bar ── */}
            {projects.length > 0 && (
                <>
                    <div className="flex border-b border-ghost-border">
                        {(['feed', 'vault'] as const).map((tab) => (
                            <button
                                key={tab}
                                onClick={() => setActiveTab(tab)}
                                className={`flex-1 py-2.5 font-mono text-xs font-semibold transition-colors ${activeTab === tab
                                        ? 'text-ghost-accent border-b-2 border-ghost-accent -mb-px'
                                        : 'text-ghost-muted hover:text-ghost-text'
                                    }`}
                            >
                                {tab === 'feed' ? '⚡ Live Feed' : '📦 Vault'}
                            </button>
                        ))}
                    </div>

                    <div className="flex-1 overflow-y-auto">
                        {activeTab === 'feed' ? (
                            <LiveFeed
                                projectId={selectedProjectId}
                                activeSessionId={activeSessionId}
                            />
                        ) : (
                            <VaultPanel
                                activeSessionId={activeSessionId}
                                projectId={selectedProjectId}
                            />
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
