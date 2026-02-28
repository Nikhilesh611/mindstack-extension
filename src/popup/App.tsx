import { useEffect, useState } from 'react';
import AuthScreen from './components/AuthScreen';
import CommandCenter from './components/CommandCenter';

type AppState = 'loading' | 'unauthenticated' | 'authenticated';

export default function App() {
    const [appState, setAppState] = useState<AppState>('loading');

    useEffect(() => {
        chrome.storage.local.get(['mindstack_jwt'], (result) => {
            const jwt = result['mindstack_jwt'] as string | undefined;
            setAppState(jwt ? 'authenticated' : 'unauthenticated');
        });

        // Listen for storage changes (e.g., auth expiry from background worker)
        const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
            if ('mindstack_jwt' in changes) {
                const newJwt = changes['mindstack_jwt'].newValue as string | undefined;
                setAppState(newJwt ? 'authenticated' : 'unauthenticated');
            }
        };
        chrome.storage.onChanged.addListener(listener);
        return () => chrome.storage.onChanged.removeListener(listener);
    }, []);

    if (appState === 'loading') {
        return (
            <div className="flex items-center justify-center h-screen bg-ghost-bg">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-6 h-6 border-2 border-ghost-accent border-t-transparent rounded-full animate-spin" />
                    <span className="font-mono text-xs text-ghost-muted">initializing...</span>
                </div>
            </div>
        );
    }

    if (appState === 'unauthenticated') {
        return <AuthScreen onAuthenticated={() => setAppState('authenticated')} />;
    }

    return <CommandCenter onLogout={() => setAppState('unauthenticated')} />;
}
