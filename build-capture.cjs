const { spawn } = require('child_process');

const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', 'build'],
    {
        cwd: __dirname,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: 'pipe',
    }
);

let output = '';
child.stdout.on('data', (d) => { process.stderr.write('[stdout] ' + d); output += d; });
child.stderr.on('data', (d) => { process.stderr.write('[stderr] ' + d); output += d; });

child.on('close', (code) => {
    const fs = require('fs');
    fs.writeFileSync(__dirname + '/dist-error.log', output, 'utf8');
    process.exit(code ?? 1);
});
