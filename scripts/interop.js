/**
 * Runs the interop tests against real tus servers in Docker.
 *
 * Starts the servers from tests/interop/docker-compose.yml, runs the
 * interop Jest suite and stops the servers again. Pass --keep to leave them
 * running (then `npm run test:interop` reruns the tests quickly).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const compose = ['compose', '-f', path.join('tests', 'interop', 'docker-compose.yml')];
const keep = process.argv.includes('--keep');

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    return result.status === null ? 1 : result.status;
}

if (run('docker', [...compose, 'up', '-d', '--build', '--wait']) !== 0) {
    process.exit(1);
}

const status = run('npx', ['jest', '-c', 'jest.interop.config.js']);

if (status !== 0) {
    run('docker', [...compose, 'logs', '--tail', '50']);
}
if (!keep) {
    run('docker', [...compose, 'down', '-v']);
}
process.exit(status);
