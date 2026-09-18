import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

const index = process.argv.indexOf('--config');
const config = loadConfig(process.argv[index + 1] ?? 'config.toml');
const db = openDatabase(config.database.path);
db.$client.close();
console.log('SQLite schema is ready. Use `pnpm db:generate` to create versioned Drizzle migrations for subsequent schema changes.');
