import { useState, useEffect } from 'react';
import type { Project, Workspace } from '../../lib/types';
import VaultPanel from './VaultPanel';
import LiveFeed from './LiveFeed';

interface CommandCenterProps {
    onLogout: () => void;
}

type SessionState = 'idle' | 'starting' | 'active' | 'stopping';

// Represents whatever is selected in the unified workspace/project dropdown.
type ContextType = 'project' | 'workspace';
interface SelectedContext {
    id: string;
    type: ContextType;
    name: string;
}

// Robust sendMsg — handles MV3 service-worker sleep/wake cycle.
function sendMsg<T>(msg: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError || response === undefined) {
                // SW was asleep — wait briefly then retry once
                setTimeout(() => {
                    chrome.runtime.sendMessage(msg, (retryResponse) => {
                        if (chrome.runtime.lastError || retryResponse === undefined) {
                            resolve({ success: false, error: 'Extension service worker is starting up — please try again.' });
                        } else {
                            resolve(retryResponse as { success: boolean; data?: T; error?: string });
                        }
                    });
                }, 200);
            } else {
                resolve(response as { success: boolean; data?: T; error?: string });
            }
        });
    });
}

export default function CommandCenter({ onLogout }: CommandCenterProps) {
    const [projects, setProjects] = useState<Project[]>([]);
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [selectedContext, setSelectedContext] = useState<SelectedContext | null>(null);
    const [sessionState, setSessionState] = useState<SessionState>('idle');
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [loadingData, setLoadingData] = useState(true);
    const [dataError, setDataError] = useState<string | null>(null);
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
            ['mindstack_session_id', 'mindstack_project_id', 'mindstack_workspace_id'],
            (result) => {
                const sid = result['mindstack_session_id'] as string | undefined;
                const pid = result['mindstack_project_id'] as string | undefined;
                const wid = result['mindstack_workspace_id'] as string | undefined;
                if (sid) {
                    setActiveSessionId(sid);
                    setSessionState('active');
                }
                if (pid) {
                    setSelectedContext({ id: pid, type: 'project', name: '' }); // name patched after fetch
                } else if (wid) {
                    setSelectedContext({ id: wid, type: 'workspace', name: '' }); // name patched after fetch
                }
            }
        );
    }, []);

    const fetchAllData = async () => {
        setLoadingData(true);
        setDataError(null);

        const [projectsRes, workspacesRes] = await Promise.all([
            sendMsg<Project[]>({ type: 'GET_PROJECTS' }),
            sendMsg<Workspace[]>({ type: 'GET_WORKSPACES' }),
        ]);

        const fetchedProjects: Project[] = (projectsRes?.success && Array.isArray(projectsRes.data)) ? projectsRes.data : [];
        const fetchedWorkspaces: Workspace[] = (workspacesRes?.success && Array.isArray(workspacesRes.data)) ? workspacesRes.data : [];

        setProjects(fetchedProjects);
        setWorkspaces(fetchedWorkspaces);

        // Patch the name of the stored context now that we have the lists
        setSelectedContext((prev) => {
            if (!prev) {
                // Nothing in storage — auto-select the first available item
                if (fetchedProjects.length > 0) {
                    const first = fetchedProjects[0];
                    chrome.storage.local.set({ mindstack_project_id: first.id });
                    return { id: first.id, type: 'project', name: first.name };
                }
                if (fetchedWorkspaces.length > 0) {
                    const first = fetchedWorkspaces[0];
                    chrome.storage.local.set({ mindstack_workspace_id: first.id });
                    return { id: first.id, type: 'workspace', name: first.name };
                }
                return null;
            }

            // Patch name for existing selection
            if (prev.type === 'project') {
                const match = fetchedProjects.find((p) => p.id === prev.id);
                return match ? { ...prev, name: match.name } : prev;
            } else {
                const match = fetchedWorkspaces.find((w) => w.id === prev.id);
                return match ? { ...prev, name: match.display_name || match.name } : prev;
            }
        });

        if (!projectsRes?.success && !workspacesRes?.success) {
            setDataError('Failed to load projects and workspaces.');
        }

        setLoadingData(false);
    };

    useEffect(() => {
        fetchAllData();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleCreateProject = async () => {
        if (!newProjectName.trim()) return;
        setCreateLoading(true);
        setCreateError(null);

        const res = await sendMsg<{ project_id: string }>({
            type: 'CREATE_PROJECT',
            name: newProjectName.trim(),
        });

        if (res?.success && res.data?.project_id) {
            const newId = res.data.project_id;
            setNewProjectName('');
            setShowCreateForm(false);
            // Switch to the new project immediately
            const newCtx: SelectedContext = { id: newId, type: 'project', name: newProjectName.trim() };
            setSelectedContext(newCtx);
            chrome.storage.local.set({ mindstack_project_id: newId });
            chrome.storage.local.remove('mindstack_workspace_id');
            await fetchAllData(); // refresh to get full project data
        } else {
            setCreateError(res?.error ?? 'Failed to create workspace.');
        }
        setCreateLoading(false);
    };

    const handleContextChange = (id: string, type: ContextType) => {
        const project = type === 'project' ? projects.find((p) => p.id === id) : null;
        const workspace = type === 'workspace' ? workspaces.find((w) => w.id === id) : null;
        const name = project?.name ?? workspace?.display_name ?? workspace?.name ?? '';

        setSelectedContext({ id, type, name });

        if (type === 'project') {
            chrome.storage.local.set({ mindstack_project_id: id });
            chrome.storage.local.remove('mindstack_workspace_id');
        } else {
            chrome.storage.local.set({ mindstack_workspace_id: id });
            chrome.storage.local.remove('mindstack_project_id');
        }
    };

    const handleStartSession = async () => {
        if (!selectedContext) return;
        setSessionState('starting');
        setStatusMsg(null);

        const msg = selectedContext.type === 'workspace'
            ? { type: 'START_SESSION', workspace_id: selectedContext.id, project_id: null }
            : { type: 'START_SESSION', project_id: selectedContext.id, workspace_id: null };

        const res = await sendMsg<{ session_id: string }>(msg);

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
            'mindstack_workspace_id',
        ]);
        onLogout();
    };

    const isSessionActive = sessionState === 'active';
    const hasItems = projects.length > 0 || workspaces.length > 0;

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

            {/* ── Project / Workspace Selector ── */}
            <div className="px-4 pt-3 pb-2">
                <div className="flex items-center justify-between mb-1.5">
                    <label className="ghost-label">Workspace</label>
                    <button
                        onClick={() => { setShowCreateForm((v) => !v); setCreateError(null); }}
                        className="font-mono text-[10px] text-ghost-accent hover:text-ghost-accent/80 transition-colors"
                    >
                        {showCreateForm ? '✕ cancel' : '+ new project'}
                    </button>
                </div>

                {/* Inline create form */}
                {showCreateForm && (
                    <div className="flex flex-col gap-2 mb-2 animate-slide-up">
                        <input
                            type="text"
                            className="ghost-input"
                            placeholder="Project name..."
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
                            ) : '→ Create Project'}
                        </button>
                    </div>
                )}

                {loadingData ? (
                    <div className="ghost-input flex items-center gap-2 text-ghost-muted">
                        <div className="w-3 h-3 border border-ghost-muted border-t-transparent rounded-full animate-spin" />
                        Loading workspaces...
                    </div>
                ) : dataError ? (
                    <div className="text-ghost-red font-mono text-xs">{dataError}</div>
                ) : !hasItems ? (
                    <div className="ghost-card border-ghost-accent/30 bg-ghost-accent/5 animate-fade-in text-center py-3">
                        <p className="font-mono text-xs text-ghost-text mb-1">No projects or workspaces yet.</p>
                        <p className="font-mono text-[10px] text-ghost-muted">
                            Click <span className="text-ghost-accent">+ new project</span> above to create one.
                        </p>
                    </div>
                ) : (
                    <select
                        value={selectedContext ? `${selectedContext.type}:${selectedContext.id}` : ''}
                        onChange={(e) => {
                            const [type, id] = e.target.value.split(':') as [ContextType, string];
                            handleContextChange(id, type);
                        }}
                        className="ghost-input cursor-pointer"
                    >
                        {/* ── Personal Projects section ── */}
                        {projects.length > 0 && (
                            <optgroup label="Personal Projects">
                                {projects.map((p) => (
                                    <option key={p.id} value={`project:${p.id}`} className="bg-ghost-surface">
                                        {p.name}
                                    </option>
                                ))}
                            </optgroup>
                        )}

                        {/* ── Team Workspaces section ── */}
                        {workspaces.length > 0 && (
                            <optgroup label="Team Workspaces">
                                {workspaces.map((w) => (
                                    <option key={w.id} value={`workspace:${w.id}`} className="bg-ghost-surface">
                                        {w.display_name || w.name}
                                        {w.role ? ` (${w.role})` : ''}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                    </select>
                )}
            </div>

            {/* ── Session Control ── (only if items exist) */}
            {hasItems && selectedContext && (
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
            {hasItems && selectedContext && (
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
                                projectId={selectedContext.type === 'project' ? selectedContext.id : null}
                                workspaceId={selectedContext.type === 'workspace' ? selectedContext.id : null}
                                activeSessionId={activeSessionId}
                            />
                        ) : (
                            <VaultPanel
                                activeSessionId={activeSessionId}
                                projectId={selectedContext.type === 'project' ? selectedContext.id : null}
                                workspaceId={selectedContext.type === 'workspace' ? selectedContext.id : null}
                            />
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
