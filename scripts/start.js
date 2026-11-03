// Starts the app with Electron. ELECTRON_RUN_AS_NODE (set by some editors, such as VS Code's
// extension host) would make Electron run as plain Node, so it is removed first.
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
