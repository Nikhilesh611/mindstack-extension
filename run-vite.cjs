// Run Vite build using the JS API for clean error output
process.chdir('e:\\FullStackForge\\SecondBrain\\mindstack-extension');

async function main() {
    try {
        const vite = await import('e:/FullStackForge/SecondBrain/mindstack-extension/node_modules/vite/dist/node/index.js');
        await vite.build({
            root: 'e:\\FullStackForge\\SecondBrain\\mindstack-extension',
            logLevel: 'info',
        });
        console.log('BUILD SUCCESS');
    } catch (e) {
        console.error('BUILD FAILED:', e.message);
        // Print full stack
        console.error(e.stack);
        // If it's a rollup error, print extra details
        if (e.id) console.error('  at id:', e.id);
        if (e.plugin) console.error('  from plugin:', e.plugin);
        if (e.loc) console.error('  at loc:', JSON.stringify(e.loc));
        if (e.frame) console.error('  frame:', e.frame);
        if (e.cause) console.error('  cause:', e.cause);
        process.exit(1);
    }
}

main();
