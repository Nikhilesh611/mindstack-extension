/** @type {import('tailwindcss').Config} */
export default {
    content: [
        './src/popup/**/*.{ts,tsx,html}',
    ],
    theme: {
        extend: {
            colors: {
                'ghost-bg': '#0F172A',
                'ghost-surface': '#1E293B',
                'ghost-border': '#334155',
                'ghost-text': '#CBD5E1',
                'ghost-muted': '#64748B',
                'ghost-accent': '#38BDF8',
                'ghost-green': '#4ADE80',
                'ghost-red': '#F87171',
                'ghost-yellow': '#FBBF24',
            },
            fontFamily: {
                mono: ['"JetBrains Mono"', '"Fira Code"', '"Cascadia Code"', 'monospace'],
                sans: ['"Inter"', 'system-ui', 'sans-serif'],
            },
            animation: {
                'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'fade-in': 'fadeIn 0.2s ease-out',
                'slide-up': 'slideUp 0.25s ease-out',
            },
            keyframes: {
                fadeIn: {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
                slideUp: {
                    '0%': { opacity: '0', transform: 'translateY(8px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
            },
        },
    },
    plugins: [],
};
