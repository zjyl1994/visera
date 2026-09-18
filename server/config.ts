import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';

// The project intentionally has a small TOML reader rather than a second
// configuration format. It supports the scalar/table features used by Visera's
// documented config file, including quoted OpenRouter header keys.
export function loadConfig(file) {
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) throw new Error(`config ${JSON.stringify(file)} permissions must not be wider than 0600`);
  const config = parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  const imageHasPreset = Boolean(config.image?.default_preset);
  const defaults = {
    server: { listen: '127.0.0.1:8080' }, worker: { count: 2 },
    image: { default_preset: 'draft', moderation: 'auto', draft: { quality: 'low', aspect_ratio: '1:1' }, standard: { quality: 'medium', aspect_ratio: '1:1' }, high: { quality: 'high', aspect_ratio: '1:1' } },
    models: { agent_temperature: 0.75 }, timeouts: { model_ms: 120000, image_ms: 300000 },
    limits: { max_image_retries: 2, max_concurrent_generations: 2, max_daily_generations: 50 }, openrouter: { headers: {} },
  };
  for (const [section, values] of Object.entries(defaults)) config[section] = { ...values, ...(config[section] ?? {}) };
  for (const preset of ['draft', 'standard', 'high']) config.image[preset] = { ...defaults.image[preset], ...(config.image[preset] ?? {}) };
  // Older configs used one image profile. Preserve the Go service's upgrade
  // behaviour so those TOML files remain valid without edits.
  if (config.image.quality) config.image.standard.quality = config.image.quality;
  if (config.image.aspect_ratio) config.image.standard.aspect_ratio = config.image.aspect_ratio;
  if ((config.image.quality || config.image.aspect_ratio) && !imageHasPreset) config.image.default_preset = 'standard';
  if (!config.auth?.username || (!config.auth?.password && !config.auth?.password_hash) || !config.database?.path || !config.storage?.asset_dir || !config.models?.text_model || !config.models?.image_model) throw new Error('missing required TOML configuration values');
  if (!/^https?:\/\//.test(config.openrouter.base_url ?? '')) throw new Error('openrouter.base_url must be an absolute http(s) URL');
  if (!config.openrouter.api_key && !config.openrouter.headers.Authorization) throw new Error('openrouter.api_key or openrouter.headers.Authorization is required');
  config.database.path = path.resolve(path.dirname(file), config.database.path);
  config.storage.asset_dir = path.resolve(path.dirname(file), config.storage.asset_dir);
  return ConfigSchema.parse(config);
}
const PresetSchema = z.object({ quality: z.string(), aspect_ratio: z.string() });
const ConfigSchema = z.object({
  server: z.object({ listen: z.string() }), auth: z.object({ username: z.string().min(1), password: z.string().min(1).optional(), password_hash: z.string().min(1).optional() }).refine(value => value.password || value.password_hash),
  database: z.object({ path: z.string() }), storage: z.object({ asset_dir: z.string() }), worker: z.object({ count: z.number().int().positive() }),
  models: z.object({ text_model: z.string().min(1), image_model: z.string().min(1), agent_temperature: z.number() }),
  image: z.object({ default_preset: z.enum(['draft', 'standard', 'high']), moderation: z.enum(['auto', 'low']), draft: PresetSchema, standard: PresetSchema, high: PresetSchema }).passthrough(),
  openrouter: z.object({ base_url: z.url(), api_key: z.string().optional(), headers: z.record(z.string(), z.string()) }),
  timeouts: z.object({ model_ms: z.number().positive(), image_ms: z.number().positive() }), limits: z.object({ max_image_retries: z.number().int().nonnegative(), max_concurrent_generations: z.number().int().positive(), max_daily_generations: z.number().int().positive() }),
});
