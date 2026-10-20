import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
// Resolve once before execution; never search a relative PATH entry or the workspace.
export function executablePath(name) {
    if (!/^[a-z0-9-]+$/i.test(name))
        throw new Error('Nome de executável inválido.');
    const file = process.platform === 'win32' ? name + '.exe' : name;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (!isAbsolute(directory) || resolve(directory) === process.cwd())
            continue;
        try {
            const candidate = realpathSync(join(directory, file));
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch { /* Search the next absolute directory. */
        }
    }
    throw new Error('Executável não disponível: ' + name);
}
