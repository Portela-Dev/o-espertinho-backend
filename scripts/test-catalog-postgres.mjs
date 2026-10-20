import { spawnSync } from 'node:child_process';
import { executablePath } from './executable.mjs';
import { randomUUID } from 'node:crypto';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12), name = 'espertinho-catalog-test-' + suffix, password = randomUUID(), database = 'catalog_test_' + suffix;
const dockerExecutable = executablePath('docker');
if (!/^espertinho-catalog-test-[a-f0-9]{12}$/.test(name))
    throw new Error('Container de teste inválido.');
const docker = (args, options = {}) => {
    const r = spawnSync(dockerExecutable, args, {
        encoding: 'utf8', windowsHide: true, ...options
    });
    if (r.error)
        throw r.error;
    if (r.status !== 0)
        throw new Error(r.stderr || 'Falha no Docker de teste.');
    return r.stdout.trim();
};
try {
    docker(['image', 'inspect', 'postgres:17-alpine']);
    docker(['run', '--detach', '--rm', '--name', name, '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER=catalog_test_admin', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=' + database, '-p', '127.0.0.1::5432', 'postgres:17-alpine']);
    let ready = false;
    for (let i = 0; i < 80; i++) {
        const result = spawnSync(dockerExecutable, ['exec', name, 'pg_isready', '-U', 'catalog_test_admin', '-d', database], {
            stdio: 'ignore', windowsHide: true
        });
        if (result.status === 0) {
            ready = true;
            break;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    if (!ready)
        throw new Error('PostgreSQL de teste não ficou pronto.');
    const port = docker(['port', name, '5432/tcp']).split(':').at(-1), url = `postgresql://catalog_test_admin:${password}@127.0.0.1:${port}/${database}`;
    const result = spawnSync(process.execPath, ['--test', 'test/catalog-postgres.integration.test.mjs'], {
        stdio: 'inherit', windowsHide: true, env: {
            ...process.env, CATALOG_TEST_PG_URL: url, CATALOG_TEST_CONTAINER: name
        }
    });
    if (result.error)
        throw result.error;
    process.exitCode = result.status ?? 1;
}
finally {
    spawnSync(dockerExecutable, ['stop', '--time', '3', name], {
        stdio: 'ignore', windowsHide: true
    });
}
