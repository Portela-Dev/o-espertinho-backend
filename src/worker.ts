import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { startWorker } from './worker-runtime.js';
const config = loadConfig(),
  db = createDatabase(config.DATABASE_URL);
const stop = startWorker(db, config);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void stop().then(() => db.end());
  });
