import pg from 'pg';
export type Database = Pick<pg.Pool, 'query' | 'connect' | 'end'>;
export const createDatabase = (connectionString: string): Database => new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 10000 });
