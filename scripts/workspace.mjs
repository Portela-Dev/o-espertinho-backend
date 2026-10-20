import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export function workspaceSteps(command) {
    const npm = (project, ...args) => ({
        project, args, npm: true
    });
    if (command === 'setup')
        return [
            {
                project: '1-backend', args: ['info', '--format', '{{.OSType}}'], docker: true
            },
            ...['1-backend', '2-frontend', 'o-espertinho-chrome-extension'].map(p => npm(p, 'ci', '--no-audit', '--no-fund')),
            npm('1-backend', 'run', 'setup:env'),
            {
                project: '1-backend', args: ['compose', 'up', '-d', '--wait', '--wait-timeout', '120', 'postgres'], docker: true
            },
            npm('1-backend', 'run', 'db:migrate'), npm('o-espertinho-chrome-extension', 'run', 'package'),
        ];
    if (['build', 'typecheck'].includes(command))
        return ['1-backend', '2-frontend', 'o-espertinho-chrome-extension'].map(p => npm(p, 'run', command));
    if (command === 'test')
        return [npm('1-backend', 'test'), npm('2-frontend', 'run', 'test:coverage'), npm('o-espertinho-chrome-extension', 'test')];
    if (command?.startsWith('db:'))
        return [npm('1-backend', 'run', command)];
    throw new Error('Comando não reconhecido.');
}
export function runWorkspace(command) {
    const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmCli = existsSync(bundled) ? bundled : process.env.npm_execpath;
    if (!npmCli)
        throw new Error('Execute pelo npm ou use Node com npm incluído.');
    for (const step of workspaceSteps(command)) {
        const executable = step.docker ? 'docker' : process.execPath, args = step.npm ? [npmCli, ...step.args] : step.args;
        const result = spawnSync(executable, args, {
            cwd: join(root, step.project), stdio: 'inherit', windowsHide: true
        });
        if (result.error)
            throw result.error;
        if (result.status !== 0)
            throw new Error('Comando encerrado com erro em ' + step.project);
    }
    if (command === 'setup') {
        const env = join(root, 'o-espertinho-chrome-extension', '.env');
        if (!existsSync(env) && existsSync(env + '.example'))
            copyFileSync(env + '.example', env);
        console.log('PostgreSQL pronto em segundo plano. Inicie backend e frontend separadamente. Recarregue a extensão a partir de dist. A extensão executa as operações de navegador; nenhum job/extrator é necessário.');
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    runWorkspace(process.argv[2]);
