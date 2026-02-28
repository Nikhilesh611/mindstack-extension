import { useState, FormEvent } from 'react';
import { supabase } from '../../lib/supabase';

interface AuthScreenProps {
    onAuthenticated: () => void;
}

type AuthMode = 'login' | 'signup';

export default function AuthScreen({ onAuthenticated }: AuthScreenProps) {
    const [mode, setMode] = useState<AuthMode>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);
        setInfo(null);
        setLoading(true);

        try {
            if (mode === 'signup') {
                const { data, error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;

                const jwt = data.session?.access_token;
                if (jwt) {
                    await chrome.storage.local.set({ mindstack_jwt: jwt });
                    onAuthenticated();
                } else {
                    setInfo('Account created! Check your email to confirm, then log in.');
                }
            } else {
                const { data, error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;

                const jwt = data.session?.access_token;
                if (!jwt) throw new Error('No access token returned.');
                await chrome.storage.local.set({ mindstack_jwt: jwt });
                onAuthenticated();
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Authentication failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col min-h-screen bg-ghost-bg p-5 animate-fade-in">
            {/* Header */}
            <div className="flex flex-col items-center mb-6 mt-2">
                <div className="text-2xl mb-1">👻</div>
                <h1 className="font-mono text-base font-semibold text-ghost-text tracking-wide">MindStack</h1>
                <p className="font-mono text-[10px] text-ghost-muted tracking-widest uppercase mt-0.5">
                    The Learning Ghost
                </p>
            </div>

            {/* Mode Toggle */}
            <div className="flex rounded-md overflow-hidden border border-ghost-border mb-5">
                {(['login', 'signup'] as AuthMode[]).map((m) => (
                    <button
                        key={m}
                        onClick={() => { setMode(m); setError(null); setInfo(null); }}
                        className={`flex-1 py-2 font-mono text-xs font-semibold transition-colors ${mode === m
                                ? 'bg-ghost-accent text-ghost-bg'
                                : 'bg-ghost-surface text-ghost-muted hover:text-ghost-text'
                            }`}
                    >
                        {m === 'login' ? '⎋ Login' : '⊕ Sign Up'}
                    </button>
                ))}
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <label className="ghost-label">Email</label>
                    <input
                        type="email"
                        className="ghost-input"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        autoComplete="email"
                    />
                </div>

                <div className="flex flex-col gap-1">
                    <label className="ghost-label">Password</label>
                    <input
                        type="password"
                        className="ghost-input"
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    />
                </div>

                {error && (
                    <div className="ghost-card border-ghost-red/40 bg-ghost-red/5 text-ghost-red text-xs font-mono animate-fade-in">
                        ✗ {error}
                    </div>
                )}

                {info && (
                    <div className="ghost-card border-ghost-green/40 bg-ghost-green/5 text-ghost-green text-xs font-mono animate-fade-in">
                        ✓ {info}
                    </div>
                )}

                <button
                    type="submit"
                    disabled={loading}
                    className="ghost-btn-primary mt-1 flex items-center justify-center gap-2"
                >
                    {loading ? (
                        <>
                            <div className="w-3 h-3 border border-ghost-bg border-t-transparent rounded-full animate-spin" />
                            {mode === 'login' ? 'Logging in...' : 'Creating account...'}
                        </>
                    ) : (
                        mode === 'login' ? '→ Login' : '→ Create Account'
                    )}
                </button>
            </form>

            <div className="mt-auto pt-4 text-center">
                <p className="font-mono text-[10px] text-ghost-muted">
                    powered by{' '}
                    <span className="text-ghost-accent">MindStack</span>
                </p>
            </div>
        </div>
    );
}
