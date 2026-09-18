import type { Config } from 'drizzle-kit';

export default {
  schema: './server/db.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: './data/visera.db' },
} satisfies Config;
