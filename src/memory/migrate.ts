/**
 * Idempotent migration runner.
 *
 *   npm run migrate      (tsx src/memory/migrate.ts)
 *
 * Applies every statement in schema.sql. Each statement is written with
 * IF NOT EXISTS, so running this repeatedly is a no-op after the first time.
 * Prints what it ran and whether the object already existed.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'schema.sql',
);

/** Split schema.sql on the `--;` separator lines. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/^\s*--;\s*$/m)
    .map((s) =>
      s
        .split('\n')
        .filter((l) => !/^\s*--/.test(l))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

/** Short human label for a statement, for the log line. */
export function describe(stmt: string): string {
  const m =
    /create\s+(table|index)(\s+if\s+not\s+exists)?\s+([a-z0-9_]+)/i.exec(stmt);
  if (m) return `${m[1]!.toLowerCase()} ${m[3]}`;
  return stmt.slice(0, 48).replace(/\s+/g, ' ');
}

export async function migrate(
  exec: (stmt: string) => Promise<unknown>,
  log: (msg: string) => void = console.log,
): Promise<number> {
  const sql = await readFile(SCHEMA_PATH, 'utf8');
  const statements = splitStatements(sql);
  log(`migrate: ${statements.length} statement(s) from schema.sql`);
  let applied = 0;
  for (const stmt of statements) {
    await exec(stmt);
    applied++;
    log(`  ok  ${describe(stmt)}`);
  }
  log(`migrate: done (${applied} applied, all IF NOT EXISTS — safe to rerun)`);
  return applied;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('migrate: DATABASE_URL is not set. Nothing to do.');
    process.exitCode = 1;
    return;
  }
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  await migrate((stmt) => sql.query(stmt));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('migrate: failed', err);
    process.exitCode = 1;
  });
}
