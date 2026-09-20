import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { sql } from 'drizzle-orm';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import OpenAI from 'openai';
import PQueue from 'p-queue';
import Bottleneck from 'bottleneck';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import sharp from 'sharp';
import { verify as verifyArgon2 } from '@node-rs/argon2';
import { loadConfig } from './config.js';
import { openDatabase, now } from './db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.argv.includes('--config') ? process.argv[process.argv.indexOf('--config') + 1] : 'config.toml';
const cfg = loadConfig(path.resolve(configPath));
fs.mkdirSync(cfg.storage.asset_dir, { recursive: true });
const db = openDatabase(cfg.database.path);
const app = express();
app.set('trust proxy', 'loopback');
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const openai = new OpenAI({ baseURL: cfg.openrouter.base_url, apiKey: cfg.openrouter.api_key || 'configured-by-header', defaultHeaders: cfg.openrouter.headers });
const jobs = new PQueue({ concurrency: cfg.worker.count });
const providerLimiter = new Bottleneck({ maxConcurrent: cfg.limits.max_concurrent_generations, minTime: 100 });
const metrics = new Registry();
collectDefaultMetrics({ register: metrics });
const requestDuration = new Histogram({ name: 'visera_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route', 'status'], registers: [metrics] });
const generationCount = new Counter({ name: 'visera_generations_total', help: 'Image generation outcomes', labelNames: ['status'], registers: [metrics] });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const clients = new Map();
const id = () => crypto.randomUUID();
// Route code goes through Drizzle's prepared SQL interface. `statement`
// safely converts the existing positional-query API while the schema in db.ts
// supplies the typed table model for new query-builder code.
const statement = (query: string, args: unknown[]) => {
  const fragments = query.split('?');
  if (fragments.length - 1 !== args.length) throw new Error(`SQL parameter mismatch: expected ${fragments.length - 1}, received ${args.length}`);
  return sql.join(fragments.flatMap((part, index) => index < args.length ? [sql.raw(part), sql.param(args[index])] : [sql.raw(part)]));
};
const one = (query: string, ...args: unknown[]): any => db.get(statement(query, args)) as any;
const all = (query: string, ...args: unknown[]): any[] => db.all(statement(query, args)) as any[];
const run = (query: string, ...args: unknown[]): any => db.run(statement(query, args));
const json = value => value == null ? null : JSON.parse(value);
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const optional = value => value || null;
const loginAttemptWindowMs = 15 * 60_000;
const loginFailureLimit = 10;
const loginBanMs = 24 * 60 * 60_000;
function validIP(value: unknown) { const candidate = String(value ?? '').trim().replace(/^\[|\]$/g, ''); return isIP(candidate) ? candidate : null; }
function clientIP(req) {
  const real = validIP(req.get('X-Real-IP'));
  if (real) return real;
  const forwarded = String(req.get('X-Forwarded-For') ?? '').split(',').map(validIP).find(Boolean);
  return forwarded || validIP(req.socket.remoteAddress) || 'unknown';
}
function loginBan(ip: string) { const attempt = one('SELECT failed_count,last_attempt_at,ban_until FROM login_attempts WHERE ip=?', ip); return attempt?.ban_until > now() ? attempt : null; }
function recordLoginFailure(ip: string) {
  const stamp = now(), previous = one('SELECT failed_count,last_attempt_at FROM login_attempts WHERE ip=?', ip);
  const failedCount = previous && stamp - Number(previous.last_attempt_at) <= loginAttemptWindowMs ? Number(previous.failed_count) + 1 : 1;
  const banUntil = failedCount >= loginFailureLimit ? stamp + loginBanMs : null;
  run('INSERT INTO login_attempts(ip,failed_count,last_attempt_at,ban_until) VALUES(?,?,?,?) ON CONFLICT(ip) DO UPDATE SET failed_count=excluded.failed_count,last_attempt_at=excluded.last_attempt_at,ban_until=excluded.ban_until', ip, failedCount, stamp, banUntil);
  return banUntil;
}
function clearLoginFailures(ip: string) { run('DELETE FROM login_attempts WHERE ip=?', ip); }

app.use(express.json({ limit: '2mb' }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } }));
app.use(pinoHttp({ logger, genReqId: req => req.headers['x-request-id']?.toString() ?? crypto.randomUUID() }));
app.use('/api/v1/auth/login', (req, res, next) => { const ban = loginBan(clientIP(req)); return ban ? fail(res, 429, 'IP_BANNED', `该 IP 暂时无法登录，请在 ${Math.ceil((ban.ban_until - now()) / 60_000)} 分钟后重试`) : next(); });
app.use('/api/v1/auth/login', rateLimit({ windowMs: loginAttemptWindowMs, limit: loginFailureLimit, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: req => ipKeyGenerator(clientIP(req)) }));
app.use('/api/v1/assets', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/v1/generations', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use((req, res, next) => { const end = requestDuration.startTimer(); res.on('finish', () => end({ method: req.method, route: req.route?.path ?? req.path, status: String(res.statusCode) })); next(); });

const sessionSecret = cfg.auth.password_hash ?? cfg.auth.password!;
function token(expires) { const payload = `${cfg.auth.username}.${expires}`; return `${Buffer.from(payload).toString('base64url')}.${crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`; }
function authenticated(req) { const cookie = Object.fromEntries((req.headers.cookie ?? '').split(';').map(x => x.trim().split('='))); const [payload, signature] = (cookie.visera_session ?? '').split('.'); if (!payload || !signature) return false; const raw = Buffer.from(payload, 'base64url').toString(); const expected = crypto.createHmac('sha256', sessionSecret).update(raw).digest('base64url'); const actual = Buffer.from(signature), wanted = Buffer.from(expected); const [username, expiry] = raw.split('.'); return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted) && username === cfg.auth.username && Number(expiry) + 30_000 > now(); }
function auth(req, res, next) { if (authenticated(req)) return next(); return fail(res, 401, 'AUTH_REQUIRED', '请先登录'); }
function emit(sessionID, event, data) { for (const res of clients.get(sessionID) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function assetView(row) { return row && { id: row.id, kind: row.kind, mime_type: row.mime_type, byte_size: row.byte_size, status: row.status, created_at: row.created_at }; }
function assetDownloadName(asset: any) {
  const extension: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
  return `${asset.id}.${extension[String(asset.mime_type).toLowerCase()] ?? 'bin'}`;
}
function message(row) { return { ...row, content: json(row.content) }; }
function messagePreview(kind: string, content: unknown) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const value = content as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text;
  if (kind === 'generation') {
    const status = String(value.status || 'queued');
    const label = { queued: '正在准备生成画面', running: '正在生成画面', succeeded: '画面已生成', failed: '画面生成失败' }[status] || '正在生成画面';
    return typeof value.aspect_ratio === 'string' ? `${label} · ${value.aspect_ratio}` : label;
  }
  return typeof value.summary === 'string' ? value.summary : typeof value.prompt === 'string' ? value.prompt : '';
}
function addMessage(sessionID, role, kind, content, fields: Record<string, unknown> = {}) { const stamp = now(), messageID = id(), preview = messagePreview(kind, content).trim().slice(0, 160); run('INSERT INTO messages(id,session_id,role,kind,content,asset_id,generation_id,client_request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', messageID, sessionID, role, kind, JSON.stringify(content), optional(fields.asset_id), optional(fields.generation_id), optional(fields.client_request_id), stamp, stamp); run('UPDATE sessions SET last_message_at=?,last_message_preview=?,updated_at=? WHERE id=?', stamp, preview || '创作已更新', stamp, sessionID); return messageID; }
function queue(kind, resourceID, maxAttempts = cfg.limits.max_image_retries + 1) { const stamp = now(); run('INSERT INTO jobs(id,kind,resource_id,status,attempts,max_attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id(), kind, resourceID, 'queued', 0, maxAttempts, stamp, stamp); }

const CreationPlan = z.object({
  prompt: z.string().trim().min(1).max(8_000),
  summary: z.string().trim().max(2_000).optional(),
  memory_candidate: z.object({ category: z.string().trim().min(1).max(40), constraint_text: z.string().trim().min(1).max(500), priority: z.enum(['normal', 'high']).default('normal') }).nullable().optional(),
});
const CharacterCardAnalysis = z.object({
  summary: z.string().trim().min(1).max(500),
  appearance: z.array(z.string().trim().min(1).max(160)).max(12),
  hairstyle: z.string().trim().max(240),
  outfit: z.string().trim().max(360),
  visual_style: z.string().trim().max(240),
  identity_constraints: z.array(z.string().trim().min(1).max(240)).min(1).max(12),
});
async function analyseCharacterCard(cardID: string) {
  const value = one('SELECT * FROM character_cards WHERE id=?', cardID);
  if (!value?.output_asset_id) throw new Error('character card image missing');
  const asset = one('SELECT * FROM assets WHERE id=? AND status=?', value.output_asset_id, 'ready');
  if (!asset) throw new Error('character card asset missing');
  const instructions = 'Analyze this reusable character reference image for consistent future image generation. Describe only visible facts; do not guess a name, age, ethnicity, personality, or unseen details. Return JSON only: {"summary":"short Chinese summary","appearance":["visible facial/body features"],"hairstyle":"Chinese description","outfit":"Chinese description","visual_style":"Chinese description","identity_constraints":["concise Chinese constraints that preserve identity across generations"]}.';
  const response = await providerLimiter.schedule(() => openai.chat.completions.create({ model: cfg.models.text_model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: instructions }, { role: 'user', content: [{ type: 'text', text: 'Analyze this character card.' }, { type: 'image_url', image_url: { url: assetDataURL(asset) } }] }] } as any, { timeout: cfg.timeouts.model_ms }));
  const raw = response.choices[0]?.message?.content ?? '';
  const analysis = CharacterCardAnalysis.safeParse(JSON.parse(raw));
  if (!analysis.success) throw new Error('文本模型没有返回有效的角色卡分析');
  const priorMetadata = json(value.metadata) ?? {};
  const stamp = now(), usageData: any = response.usage ?? {};
  run('UPDATE character_cards SET metadata_status=?,metadata=?,updated_at=? WHERE id=?', 'ready', JSON.stringify({ ...priorMetadata, analysis: analysis.data, analysis_model: cfg.models.text_model, analyzed_at: stamp }), stamp, cardID);
  run('INSERT INTO model_calls(id,kind,resource_id,model_name,cost,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id(), 'character_card_analysis', cardID, cfg.models.text_model, Number(usageData.cost || 0), Number(usageData.prompt_tokens || 0), Number(usageData.completion_tokens || 0), Number(usageData.total_tokens || 0), stamp);
}
async function planCreation(session: any, request: string) {
  const memories = session.character_id ? all("SELECT constraint_text FROM character_memories WHERE character_id=? AND status='active' ORDER BY priority DESC, updated_at DESC LIMIT 12", session.character_id).map(row => row.constraint_text) : [];
  const instructions = `You are a precise image-creation assistant. Turn the user's request into one vivid, production-ready image prompt. Keep requested facts; do not invent named people or copyrighted characters. Active character preferences: ${memories.length ? memories.join('；') : 'none'}. Return JSON only: {"prompt":"...","summary":"short Chinese creative brief","memory_candidate":null or {"category":"appearance|style|preference","constraint_text":"a stable character preference explicitly stated by the user","priority":"normal|high"}}. Only propose memory_candidate for enduring character traits/preferences, never for a one-off scene or camera request.`;
  const response = await providerLimiter.schedule(() => openai.chat.completions.create({ model: cfg.models.text_model, temperature: cfg.models.agent_temperature, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: instructions }, { role: 'user', content: request }] } as any, { timeout: cfg.timeouts.model_ms }));
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = CreationPlan.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('文本模型没有返回有效的创作简报');
  const stamp = now(), usageData: any = response.usage ?? {};
  run('INSERT INTO model_calls(id,kind,resource_id,model_name,cost,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id(), 'creation_planning', session.id, cfg.models.text_model, Number(usageData.cost || 0), Number(usageData.prompt_tokens || 0), Number(usageData.completion_tokens || 0), Number(usageData.total_tokens || 0), stamp);
  return parsed.data;
}
function saveMemoryCandidate(characterID: string | null | undefined, candidate: z.infer<typeof CreationPlan>['memory_candidate']) {
  if (!characterID || !candidate) return;
  const normalized = candidate.constraint_text.toLowerCase();
  if (one("SELECT id FROM character_memories WHERE character_id=? AND normalized_key=? AND status='active'", characterID, normalized) || one("SELECT id FROM memory_candidates WHERE character_id=? AND lower(constraint_text)=? AND status='pending'", characterID, normalized)) return;
  const stamp = now();
  run('INSERT INTO memory_candidates(id,character_id,category,constraint_text,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id(), characterID, candidate.category, candidate.constraint_text, candidate.priority, 'pending', stamp, stamp);
}

app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/metrics', async (_req, res) => { res.type(metrics.contentType); res.send(await metrics.metrics()); });
app.post('/api/v1/auth/login', async (req, res, next) => { try { const ip = clientIP(req); const parsed = z.object({ username: z.string().min(1), password: z.string().min(1), remember: z.boolean().optional().default(false) }).safeParse(req.body); if (!parsed.success) return fail(res, 400, 'INVALID_LOGIN', '请输入账户和密码'); const { username, password, remember } = parsed.data; const passwordOK = cfg.auth.password_hash ? await verifyArgon2(cfg.auth.password_hash, password) : password === cfg.auth.password; if (username !== cfg.auth.username || !passwordOK) { const banUntil = recordLoginFailure(ip); return banUntil ? fail(res, 429, 'IP_BANNED', '登录失败次数过多，该 IP 已被封禁 24 小时') : fail(res, 401, 'INVALID_CREDENTIALS', '账户或密码不正确'); } clearLoginFailures(ip); const expiry = now() + (remember ? 30 : 1) * 86400000; res.cookie('visera_session', token(expiry), { httpOnly: true, sameSite: 'lax', secure: req.secure, ...(remember ? { maxAge: 30 * 86400000 } : {}) }); res.json({ authenticated: true, remembered: remember }); } catch (error) { next(error); } });
app.get('/api/v1/auth/session', (req, res) => res.json({ authenticated: authenticated(req) }));
app.post('/api/v1/auth/logout', (_req, res) => { res.clearCookie('visera_session'); res.status(204).end(); });
app.use('/api/v1', auth);

app.post('/api/v1/assets', upload.single('file'), (req, res) => { if (!req.file?.buffer) return fail(res, 400, 'INVALID_FILE', '请选择文件'); const assetID = id(), hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex'), name = `${assetID}-${hash.slice(0, 12)}`; fs.writeFileSync(path.join(cfg.storage.asset_dir, name), req.file.buffer); const stamp = now(); run('INSERT INTO assets(id,kind,storage_key,mime_type,byte_size,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', assetID, 'upload', name, req.file.mimetype || 'application/octet-stream', req.file.size, hash, 'ready', stamp, stamp); res.status(201).json({ id: assetID }); });
app.get('/api/v1/assets/:id', (req, res) => { const asset = one('SELECT * FROM assets WHERE id=?', req.params.id); return asset ? res.json(assetView(asset)) : fail(res, 404, 'NOT_FOUND', '素材不存在'); });
app.get('/api/v1/assets/:id/content', (req, res) => { const asset = one('SELECT * FROM assets WHERE id=?', req.params.id); if (!asset) return fail(res, 404, 'NOT_FOUND', '素材不存在'); const file = path.join(cfg.storage.asset_dir, asset.storage_key); if (!fs.existsSync(file)) return fail(res, 404, 'ASSET_MISSING', '素材文件不存在'); res.type(asset.mime_type); if (req.query.download) { res.set('Cache-Control', 'no-store'); res.attachment(assetDownloadName(asset)); } else res.set('Cache-Control', 'private, max-age=31536000, immutable'); res.sendFile(file); });

function assetDataURL(asset: any) {
  const bytes = fs.readFileSync(path.join(cfg.storage.asset_dir, asset.storage_key));
  return `data:${asset.mime_type};base64,${bytes.toString('base64')}`;
}
function persistAsset(bytes: Buffer, mimeType: string, kind: string) {
  const assetID = id(), hash = crypto.createHash('sha256').update(bytes).digest('hex'), storageKey = `${assetID}-${hash.slice(0, 12)}`, stamp = now();
  fs.writeFileSync(path.join(cfg.storage.asset_dir, storageKey), bytes);
  run('INSERT INTO assets(id,kind,storage_key,mime_type,byte_size,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', assetID, kind, storageKey, mimeType, bytes.length, hash, 'ready', stamp, stamp);
  return assetID;
}
async function generateReferencedImage(prompt: string, references: string[], presetConfig: any) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...cfg.openrouter.headers };
  if (cfg.openrouter.api_key) headers.Authorization = `Bearer ${cfg.openrouter.api_key}`;
  const response = await providerLimiter.schedule(() => fetch(`${cfg.openrouter.base_url.replace(/\/$/, '')}/images`, {
    method: 'POST', headers, signal: AbortSignal.timeout(cfg.timeouts.image_ms), body: JSON.stringify({ model: cfg.models.image_model, prompt, n: 1, quality: presetConfig.quality, aspect_ratio: presetConfig.aspect_ratio, moderation: cfg.image.moderation, input_references: references.map(url => ({ type: 'image_url', image_url: { url } })) }),
  }));
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `图像服务返回 ${response.status}`);
  const image = body.data?.[0];
  if (!image) throw new Error('图像服务没有返回图片');
  let bytes: Buffer;
  let mime = image.media_type || 'image/png';
  if (image.b64_json) bytes = Buffer.from(image.b64_json, 'base64');
  else if (image.url) {
    const downloaded = await fetch(image.url, { signal: AbortSignal.timeout(cfg.timeouts.image_ms) });
    if (!downloaded.ok) throw new Error('图像服务返回的文件无法下载');
    mime = downloaded.headers.get('content-type') || mime;
    bytes = Buffer.from(await downloaded.arrayBuffer());
  } else throw new Error('图像服务没有返回图片内容');
  return { bytes, mime, requestID: body.id || body.request_id || id(), usage: body.usage ?? {} };
}

app.post('/api/v1/characters', (req, res) => { const parsed = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(req.body); if (!parsed.success) return fail(res, 400, 'INVALID_NAME', '请输入角色名称'); const name = parsed.data.name, stamp = now(), characterID = id(); run('INSERT INTO characters(id,name,default_card_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)', characterID, name, null, 'active', stamp, stamp); res.status(201).json({ id: characterID, name }); });
app.get('/api/v1/characters', (_req, res) => res.json({ data: all(`SELECT c.*, cc.output_asset_id AS default_card_asset_id FROM characters c LEFT JOIN character_cards cc ON cc.id=c.default_card_id WHERE c.status='active' ORDER BY c.created_at DESC`) }));
app.get('/api/v1/characters/:id/cards', (req, res) => res.json({ data: all('SELECT * FROM character_cards WHERE character_id=? ORDER BY created_at DESC', req.params.id).map(x => ({ ...x, is_default: !!x.is_default, metadata: json(x.metadata) })) }));
app.post('/api/v1/characters/:id/cards', (req, res) => {
  if (!one('SELECT id FROM characters WHERE id=?', req.params.id)) return fail(res, 404, 'NOT_FOUND', '角色不存在');
  const input = z.object({ source_asset_ids: z.array(z.string().uuid()).min(1).max(8), extra_requirements: z.string().trim().max(2_000).optional().default(''), aspect_ratio: z.enum(['1:1', '2:3', '3:4', '3:2', '4:3', '9:16', '16:9']).optional().default('3:2') }).safeParse(req.body);
  if (!input.success) return fail(res, 400, 'INVALID_ASSETS', '请至少选择一张有效的素材图片');
  if (input.data.source_asset_ids.some(assetID => !one('SELECT id FROM assets WHERE id=?', assetID))) return fail(res, 400, 'INVALID_ASSET', '存在找不到的素材图片');
  const stamp = now(), cardID = id();
  // `metadata` keeps the request alongside the job. It avoids a second
  // transient table and makes the finished card self-describing.
  run('INSERT INTO character_cards(id,character_id,source_asset_ids,output_asset_id,prompt_version,model_name,status,is_default,metadata_status,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', cardID, req.params.id, JSON.stringify(input.data.source_asset_ids), null, 'v1', cfg.models.image_model, 'queued', 0, 'pending', JSON.stringify({ extra_requirements: input.data.extra_requirements, aspect_ratio: input.data.aspect_ratio }), stamp, stamp);
  queue('character_card', cardID); res.status(202).json({ id: cardID });
});
app.post('/api/v1/characters/:id/cards/import', (req, res) => {
  const input = z.object({ asset_id: z.string().min(1), name: z.string().trim().min(1).max(100).optional() }).safeParse(req.body);
  if (!input.success) return fail(res, 400, 'INVALID_IMPORT', '请选择图片，并为角色卡提供不超过 100 字的名称');
  if (!one('SELECT id FROM characters WHERE id=?', req.params.id)) return fail(res, 404, 'NOT_FOUND', '角色不存在');
  const asset = one('SELECT id,mime_type FROM assets WHERE id=? AND status=?', input.data.asset_id, 'ready');
  if (!asset || !String(asset.mime_type).startsWith('image/')) return fail(res, 400, 'INVALID_ASSET', '请选择可用的图片素材');
  const stamp = now(), cardID = id(), hasDefault = !!one('SELECT id FROM character_cards WHERE character_id=? AND is_default=1', req.params.id);
  run('INSERT INTO character_cards(id,character_id,name,source_asset_ids,output_asset_id,prompt_version,model_name,status,is_default,metadata_status,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', cardID, req.params.id, input.data.name || null, '[]', asset.id, 'import', cfg.models.image_model, 'ready', hasDefault ? 0 : 1, 'pending', JSON.stringify({ imported: true }), stamp, stamp);
  if (!hasDefault) run('UPDATE characters SET default_card_id=?,updated_at=? WHERE id=?', cardID, stamp, req.params.id);
  queue('character_card_analysis', cardID);
  res.status(201).json({ id: cardID });
});
app.post('/api/v1/characters/:id/cards/:cardID/retry', (req, res) => { const card = one("SELECT * FROM character_cards WHERE id=? AND character_id=? AND status='failed'", req.params.cardID, req.params.id); if (!card) return fail(res, 409, 'NOT_RETRYABLE', '这张角色卡当前不能重试'); run("UPDATE character_cards SET status='queued',metadata_status='pending',updated_at=? WHERE id=?", now(), card.id); queue('character_card', card.id); res.status(202).json({ id: card.id }); });
app.post('/api/v1/characters/:id/cards/:cardID/default', (req, res) => { const card = one('SELECT * FROM character_cards WHERE id=? AND character_id=?', req.params.cardID, req.params.id); if (!card) return fail(res, 404, 'NOT_FOUND', '角色卡不存在'); const stamp = now(); run('UPDATE character_cards SET is_default=0 WHERE character_id=?', req.params.id); run('UPDATE character_cards SET is_default=1 WHERE id=?', card.id); run('UPDATE characters SET default_card_id=?,updated_at=? WHERE id=?', card.id, stamp, req.params.id); res.json({ id: card.id, is_default: true }); });
app.patch('/api/v1/characters/:id/cards/:cardID', (req, res) => { const input = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(req.body); if (!input.success) return fail(res, 400, 'INVALID_CARD_NAME', '请输入 1 到 100 个字符的角色卡名称'); const card = one('SELECT id FROM character_cards WHERE id=? AND character_id=?', req.params.cardID, req.params.id); if (!card) return fail(res, 404, 'NOT_FOUND', '角色卡不存在'); const stamp = now(); run('UPDATE character_cards SET name=?,updated_at=? WHERE id=?', input.data.name, stamp, card.id); res.json({ id: card.id, name: input.data.name }); });
app.delete('/api/v1/characters/:id/cards/:cardID', (req, res) => { const card = one('SELECT * FROM character_cards WHERE id=? AND character_id=?', req.params.cardID, req.params.id); if (!card) return fail(res, 404, 'NOT_FOUND', '角色卡不存在'); if (card.is_default) return fail(res, 409, 'DEFAULT_CARD', '不能删除默认角色卡'); if (one("SELECT id FROM sessions WHERE active_card_id=? AND status IN ('active','finalized')", card.id)) return fail(res, 409, 'CARD_IN_USE', '这张角色卡正在被对话使用，暂时不能删除'); run('DELETE FROM character_cards WHERE id=?', card.id); res.status(204).end(); });
app.post('/api/v1/characters/:id/cards/preview', async (req, res, next) => {
  try {
    const input = z.object({ base_asset_id: z.string().uuid(), original_asset_id: z.string().uuid(), requirements: z.string().trim().min(1).max(2_000) }).safeParse(req.body);
    if (!input.success) return fail(res, 400, 'INVALID_PREVIEW', '请提供要调整的内容和角色卡素材');
    if (!one('SELECT id FROM characters WHERE id=?', req.params.id)) return fail(res, 404, 'NOT_FOUND', '角色不存在');
    const assetIDs = [...new Set([input.data.original_asset_id, input.data.base_asset_id])];
    const assets = assetIDs.map(assetID => one('SELECT * FROM assets WHERE id=?', assetID));
    if (assets.some(asset => !asset)) return fail(res, 400, 'INVALID_ASSET', '角色卡素材不存在');
    const references = assets.map(asset => assetDataURL(asset));
    const result = await generateReferencedImage(`Create a revised character card. Preserve the character's identity, face, and recognizable features from the reference image(s). Apply this requested change: ${input.data.requirements}`, references, cfg.image.standard);
    const assetID = persistAsset(result.bytes, result.mime, 'character_card_preview');
    res.json({ asset_id: assetID });
  } catch (error) { next(error); }
});

app.post('/api/v1/sessions', (req, res) => { const characterID = req.body?.character_id || null, cardID = req.body?.character_card_id || null; const character = characterID ? one('SELECT id,name,default_card_id FROM characters WHERE id=?', characterID) : null; if (characterID && !character) return fail(res, 400, 'INVALID_CHARACTER', '角色不存在'); const active = cardID || character?.default_card_id || null; if (active && !one('SELECT id FROM character_cards WHERE id=? AND character_id=?', active, characterID)) return fail(res, 400, 'INVALID_CARD', '角色卡不属于该角色'); const stamp = now(), sessionID = id(); const createdTime = new Date(stamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); const title = `${character?.name || '创作'} · ${createdTime}`; run('INSERT INTO sessions(id,title,character_id,active_card_id,status,last_message_at,last_message_preview,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', sessionID, title, characterID, active, 'active', stamp, null, stamp, stamp); res.status(201).json(sessionView(one('SELECT * FROM sessions WHERE id=?', sessionID))); });
function sessionView(row) { return { ...row, character_card_id: row.active_card_id, has_running_generation: !!one("SELECT id FROM generations WHERE session_id=? AND status IN ('queued','running')", row.id) }; }
app.get('/api/v1/sessions', (_req, res) => res.json({ data: all("SELECT * FROM sessions WHERE status != 'deleted' ORDER BY last_message_at DESC").map(sessionView) }));
app.get('/api/v1/sessions/:id', (req, res) => { const session = one('SELECT * FROM sessions WHERE id=?', req.params.id); return session ? res.json(sessionView(session)) : fail(res, 404, 'NOT_FOUND', '会话不存在'); });
app.patch('/api/v1/sessions/:id', (req, res) => { const session = one("SELECT * FROM sessions WHERE id=? AND status='active'", req.params.id); if (!session) return fail(res, 404, 'NOT_FOUND', '会话不存在或已结束'); const title = String(req.body?.title ?? '').trim(); if (title) run('UPDATE sessions SET title=?,updated_at=? WHERE id=?', title.slice(0, 100), now(), session.id); res.status(204).end(); });
app.delete('/api/v1/sessions/:id', (req, res) => { const session = one('SELECT id FROM sessions WHERE id=?', req.params.id); if (!session) return fail(res, 404, 'NOT_FOUND', '会话不存在'); run("UPDATE sessions SET status='deleted',updated_at=? WHERE id=?", now(), req.params.id); res.status(204).end(); });
app.get('/api/v1/sessions/:id/messages', (req, res) => res.json({ data: all('SELECT * FROM messages WHERE session_id=? ORDER BY created_at,id', req.params.id).map(message) }));
app.post('/api/v1/sessions/:id/messages', async (req, res, next) => {
  try {
    const session = one("SELECT * FROM sessions WHERE id=? AND status='active'", req.params.id);
    if (!session) return fail(res, 404, 'NOT_FOUND', '会话不存在或已结束');
    const content = String(req.body?.content ?? '').trim(), mode = req.body?.mode ?? 'generate', quality = preset(req.body?.quality), requestID = req.headers['idempotency-key'];
    if (!content) return fail(res, 400, 'INVALID_MESSAGE', '请输入内容');
    if (requestID) { const existing = one('SELECT id FROM messages WHERE session_id=? AND client_request_id=?', session.id, requestID); if (existing) return res.status(202).json({ message_id: existing.id, duplicate: true }); }
    addMessage(session.id, 'user', 'text', { text: content }, { client_request_id: requestID });
    emit(session.id, 'message.created', { role: 'user' });
    // Planning is helpful but never makes an image request unusable when a
    // provider has no text model or is temporarily unavailable.
    let plan: z.infer<typeof CreationPlan> = { prompt: content, summary: '已按你的描述准备创作。' };
    try { plan = await planCreation(session, content); }
    catch (error) { logger.warn({ err: error, sessionID: session.id }, 'creation planning unavailable; using the original prompt'); }
    const planID = addMessage(session.id, 'assistant', 'plan', { stage: mode === 'brief' ? '确认后的创作简报' : '最终绘图提示词', text: mode === 'brief' ? (plan.summary || plan.prompt) : plan.prompt });
    emit(session.id, 'assistant.plan', { message_id: planID });
    saveMemoryCandidate(session.character_id, plan.memory_candidate);
    if (mode === 'brief') return res.status(202).json({ status: 'planned' });
    const generationID = createGeneration(session.id, plan.prompt, null, quality, req.body?.aspect_ratio);
    res.status(202).json({ generation_id: generationID });
  } catch (error) { next(error); }
});
function saveGenerationToGallery(generation: any, restore = true) {
  if (restore) run('DELETE FROM gallery_exclusions WHERE generation_id=?', generation.id);
  const existing = one('SELECT id FROM gallery_items WHERE generation_id=?', generation.id);
  if (existing) return existing.id;
  const galleryID = id();
  run('INSERT INTO gallery_items(id,generation_id,asset_id,title,created_at) VALUES(?,?,?,?,?)', galleryID, generation.id, generation.output_asset_id, null, now());
  return galleryID;
}
function backfillFinalizedGallery() {
  const finalized = all("SELECT id FROM sessions WHERE status='finalized'");
  for (const session of finalized) {
    const generation = one("SELECT * FROM generations WHERE session_id=? AND status='succeeded' AND output_asset_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1", session.id);
    if (generation && !one('SELECT generation_id FROM gallery_exclusions WHERE generation_id=?', generation.id)) saveGenerationToGallery(generation, false);
  }
}
app.post('/api/v1/sessions/:id/finalize', (req, res) => { const generation = one("SELECT * FROM generations WHERE id=? AND session_id=? AND status='succeeded' AND output_asset_id IS NOT NULL", req.body?.generation_id, req.params.id); if (!generation) return fail(res, 409, 'NOT_READY', '只能保留已经完成的当前画面'); saveGenerationToGallery(generation); run("UPDATE sessions SET status='finalized',updated_at=? WHERE id=?", now(), req.params.id); res.json({ status: 'finalized' }); });
app.post('/api/v1/sessions/:id/references', (req, res) => { if (!one('SELECT id FROM sessions WHERE id=?', req.params.id) || !one('SELECT id FROM assets WHERE id=?', req.body?.asset_id)) return fail(res, 400, 'INVALID_REFERENCE', '会话或素材不存在'); const referenceID = id(); run('INSERT INTO session_references(id,session_id,asset_id,purpose,created_at) VALUES(?,?,?,?,?)', referenceID, req.params.id, req.body.asset_id, req.body.purpose ?? 'other', now()); res.status(201).json({ id: referenceID }); });
app.delete('/api/v1/sessions/:id/references/:referenceID', (req, res) => { run('DELETE FROM session_references WHERE id=? AND session_id=?', req.params.referenceID, req.params.id); res.status(204).end(); });
app.get('/api/v1/sessions/:id/events', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': connected\n\n'); const set = clients.get(req.params.id) ?? new Set(); set.add(res); clients.set(req.params.id, set); req.on('close', () => { set.delete(res); if (!set.size) clients.delete(req.params.id); }); });

function preset(value) { return ['draft', 'standard', 'high'].includes(value) ? value : cfg.image.default_preset; }
function createGeneration(sessionID, prompt, parentID, quality, ratio, useCharacterCard = true) { const generationID = id(), stamp = now(), aspectRatio = ratio || (cfg.image as any)[quality].aspect_ratio; const dailyCount = Number(one('SELECT count(*) AS count FROM generations WHERE created_at>=?', stamp - 86_400_000)?.count ?? 0); if (dailyCount >= cfg.limits.max_daily_generations) { const error: any = new Error(`今日生成次数已达到上限（${cfg.limits.max_daily_generations} 次）`); error.status = 429; error.code = 'DAILY_GENERATION_LIMIT'; throw error; } run('INSERT INTO generations(id,session_id,parent_generation_id,prompt,model_name,quality_preset,aspect_ratio,use_character_card,status,output_asset_id,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', generationID, sessionID, parentID, prompt, cfg.models.image_model, quality, aspectRatio, useCharacterCard ? 1 : 0, 'queued', null, null, stamp, stamp); addMessage(sessionID, 'assistant', 'generation', { generation_id: generationID, status: 'queued', aspect_ratio: aspectRatio }, { generation_id: generationID }); queue('image_generation', generationID); emit(sessionID, 'generation.progress', { generation_id: generationID, status: 'queued' }); return generationID; }
app.get('/api/v1/generations/:id', (req, res) => { const generation = one('SELECT * FROM generations WHERE id=?', req.params.id); if (!generation) return fail(res, 404, 'NOT_FOUND', '生成任务不存在'); res.set('Cache-Control', 'no-store'); res.json({ ...generation, usage: usage(generation.id, generation.session_id) }); });
app.post('/api/v1/generations/:id/retry', (req, res) => { const generation = one('SELECT * FROM generations WHERE id=?', req.params.id); if (!generation) return fail(res, 404, 'NOT_FOUND', '生成任务不存在'); run("UPDATE generations SET status='queued',error_code=NULL,updated_at=? WHERE id=?", now(), generation.id); queue('image_generation', generation.id); res.status(202).json({ id: generation.id }); });
app.post('/api/v1/generations/:id/adjust', (req, res) => { const source = one('SELECT * FROM generations WHERE id=?', req.params.id); if (!source) return fail(res, 404, 'NOT_FOUND', '生成任务不存在'); const newID = createGeneration(source.session_id, `${source.prompt}\n${String(req.body?.content ?? '')}`, source.id, source.quality_preset, source.aspect_ratio, Number(source.use_character_card) !== 0); res.status(202).json({ generation_id: newID }); });
app.post('/api/v1/generations/:id/refine', (req, res) => { const source = one('SELECT * FROM generations WHERE id=?', req.params.id); if (!source) return fail(res, 404, 'NOT_FOUND', '生成任务不存在'); const newID = createGeneration(source.session_id, source.prompt, source.id, preset(req.body?.quality), source.aspect_ratio, Number(source.use_character_card) !== 0); res.status(202).json({ generation_id: newID }); });
app.post('/api/v1/generations/:id/feedback', (req, res) => { const source = one('SELECT * FROM generations WHERE id=?', req.params.id); if (!source) return fail(res, 404, 'NOT_FOUND', '生成任务不存在'); const input = z.object({ content: z.string().trim().min(1), quality: z.string().optional(), aspect_ratio: z.string().optional(), use_character_card: z.boolean().optional().default(true) }).safeParse(req.body); if (!input.success) return fail(res, 400, 'INVALID_FEEDBACK', '请输入修改意见'); addMessage(source.session_id, 'user', 'feedback', { text: input.data.content }); const newID = createGeneration(source.session_id, `${source.prompt}\nRevision: ${input.data.content}`, source.id, preset(input.data.quality), input.data.aspect_ratio || source.aspect_ratio, input.data.use_character_card); res.status(202).json({ generation_id: newID }); });
app.get('/api/v1/image-capabilities', (_req, res) => res.json({ model: cfg.models.image_model, aspect_ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'], source: 'fallback' }));
app.post('/api/v1/generations/:id/save-to-gallery', (req, res) => { const generation = one("SELECT * FROM generations WHERE id=? AND status='succeeded'", req.params.id); if (!generation) return fail(res, 409, 'NOT_READY', '图片尚未生成完成'); const existing = one('SELECT * FROM gallery_items WHERE generation_id=?', generation.id); if (existing) return res.json(existing); res.status(201).json({ id: saveGenerationToGallery(generation) }); });
app.get('/api/v1/gallery', (req, res) => { backfillFinalizedGallery(); const page = Math.max(1, Number(req.query.page) || 1), pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 24)), total = one('SELECT count(*) AS count FROM gallery_items').count; const rows = all('SELECT gi.*, g.session_id FROM gallery_items gi LEFT JOIN generations g ON g.id=gi.generation_id ORDER BY gi.created_at DESC LIMIT ? OFFSET ?', pageSize, (page - 1) * pageSize); res.json({ data: rows.map(item => { const detail = item.session_id ? usage(item.generation_id, item.session_id) : { recorded: false, cost: 0, image_cost: 0, llm_cost: 0, image_calls: 0, llm_calls: 0 }; return { ...item, cost_recorded: detail.recorded, cost: detail.cost, image_cost: detail.image_cost, llm_cost: detail.llm_cost, image_calls: detail.image_calls, llm_calls: detail.llm_calls }; }), pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) } }); });
app.delete('/api/v1/gallery/:id', (req, res) => { const item = one('SELECT generation_id FROM gallery_items WHERE id=?', req.params.id); if (item?.generation_id) run('INSERT OR REPLACE INTO gallery_exclusions(generation_id,created_at) VALUES(?,?)', item.generation_id, now()); run('DELETE FROM gallery_items WHERE id=?', req.params.id); res.status(204).end(); });
app.get('/api/v1/characters/:id/memories', (req, res) => res.json({ data: all("SELECT * FROM character_memories WHERE character_id=? AND status='active' ORDER BY updated_at DESC", req.params.id) }));
app.get('/api/v1/characters/:id/memory-candidates', (req, res) => res.json({ data: all("SELECT * FROM memory_candidates WHERE character_id=? AND status='pending' ORDER BY created_at DESC", req.params.id) }));
app.post('/api/v1/memory-candidates/:id/resolve', (req, res) => { const candidate = one("SELECT * FROM memory_candidates WHERE id=? AND status='pending'", req.params.id); if (!candidate) return fail(res, 404, 'NOT_FOUND', '记忆建议不存在'); const action = req.body?.action; if (!['accept', 'reject'].includes(action)) return fail(res, 400, 'INVALID_ACTION', '操作无效'); const stamp = now(); run('UPDATE memory_candidates SET status=?,updated_at=? WHERE id=?', action === 'accept' ? 'accepted' : 'rejected', stamp, candidate.id); if (action === 'accept') run('INSERT INTO character_memories(id,character_id,category,constraint_text,normalized_key,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id(), candidate.character_id, candidate.category, candidate.constraint_text, candidate.constraint_text.toLowerCase(), candidate.priority, 'active', stamp, stamp); res.status(204).end(); });
app.get('/api/v1/errors', (_req, res) => res.json({ data: all('SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 100') }));

function usage(generationID, sessionID) { const lines = all('SELECT * FROM model_calls WHERE resource_id IN (?,?) ORDER BY created_at DESC', generationID, sessionID); const image = lines.filter(x => x.kind === 'image_generation'), llm = lines.filter(x => x.kind !== 'image_generation'); const sum = rows => rows.reduce((n, x) => n + x.cost, 0); return { recorded: !!lines.length, cost: sum(lines), total_cost: sum(lines), image_cost: sum(image), image_calls: image.length, image_calls_detail: image, llm_cost: sum(llm), llm_calls: llm.length, llm_calls_detail: llm, current_image_cost: sum(image), current_image_recorded: !!image.length, prompt_tokens: lines.reduce((n,x) => n+x.prompt_tokens,0), completion_tokens: lines.reduce((n,x) => n+x.completion_tokens,0), total_tokens: lines.reduce((n,x) => n+x.total_tokens,0) }; }
function generationReferences(generation: any) {
  const assetIDs: string[] = [];
  if (generation.parent_generation_id) {
    const parent = one('SELECT output_asset_id FROM generations WHERE id=?', generation.parent_generation_id);
    if (parent?.output_asset_id) assetIDs.push(parent.output_asset_id);
  }
  // A card-disabled revision is deliberately image-to-image only: do not
  // append the session's character card or any other session references.
  if (Number(generation.use_character_card) === 0) return [...new Set(assetIDs)].slice(0, 8).map(assetID => one('SELECT * FROM assets WHERE id=? AND status=?', assetID, 'ready')).filter(Boolean).map(assetDataURL);
  const session = one('SELECT active_card_id FROM sessions WHERE id=?', generation.session_id);
  if (session?.active_card_id) {
    const card = one("SELECT output_asset_id FROM character_cards WHERE id=? AND status='ready'", session.active_card_id);
    if (card?.output_asset_id) assetIDs.push(card.output_asset_id);
  }
  for (const reference of all('SELECT asset_id FROM session_references WHERE session_id=? ORDER BY created_at', generation.session_id)) assetIDs.push(reference.asset_id);
  return [...new Set(assetIDs)].slice(0, 8).map(assetID => one('SELECT * FROM assets WHERE id=? AND status=?', assetID, 'ready')).filter(Boolean).map(assetDataURL);
}
function characterConsistencyPrompt(generation: any) {
  if (Number(generation.use_character_card) === 0) return '';
  const session = one('SELECT active_card_id FROM sessions WHERE id=?', generation.session_id);
  if (!session?.active_card_id) return '';
  const card = one("SELECT metadata FROM character_cards WHERE id=? AND status='ready' AND metadata_status='ready'", session.active_card_id);
  const analysis = json(card?.metadata)?.analysis;
  if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.identity_constraints)) return '';
  const constraints = analysis.identity_constraints
    .filter((value: unknown) => typeof value === 'string')
    .map((value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 240))
    .filter(Boolean)
    .slice(0, 12);
  if (!constraints.length) return '';
  return `\n\nCharacter consistency requirements (derived from the selected character card; preserve these unless the latest user request explicitly changes one):\n${constraints.map((value: string) => `- ${value}`).join('\n')}`;
}
async function providerImage(generation) {
  const presetConfig = { ...((cfg.image as any)[generation.quality_preset] ?? cfg.image.draft), aspect_ratio: generation.aspect_ratio };
  return generateReferencedImage(`${generation.prompt}${characterConsistencyPrompt(generation)}`, generationReferences(generation), presetConfig);
}
async function processJobs() { const job = one("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"); if (!job) return; run("UPDATE jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?", now(), job.id); try { if (job.kind === 'image_generation') await generate(job.resource_id); else if (job.kind === 'character_card') await card(job.resource_id); else if (job.kind === 'character_card_analysis') await analyseCharacterCard(job.resource_id); run("UPDATE jobs SET status='succeeded',updated_at=? WHERE id=?", now(), job.id); } catch (error) { const attempts = job.attempts + 1, retry = attempts < job.max_attempts; run('UPDATE jobs SET status=?,attempts=?,updated_at=? WHERE id=?', retry ? 'queued' : 'failed', attempts, now(), job.id); run('INSERT INTO error_logs(id,kind,resource_id,code,message,created_at) VALUES(?,?,?,?,?,?)', id(), job.kind, job.resource_id, 'JOB_FAILED', String(error.message).slice(0, 600), now()); if (job.kind === 'image_generation' && !retry) { const generation = one('SELECT * FROM generations WHERE id=?', job.resource_id); run("UPDATE generations SET status='failed',error_code=?,updated_at=? WHERE id=?", 'GENERATION_FAILED', now(), job.resource_id); generationCount.inc({ status: 'failed' }); emit(generation.session_id, 'generation.failed', { generation_id: generation.id, status: 'failed' }); } if (job.kind === 'character_card' && !retry) run("UPDATE character_cards SET status='failed',metadata_status='failed',updated_at=? WHERE id=?", now(), job.resource_id); if (job.kind === 'character_card_analysis' && !retry) run("UPDATE character_cards SET metadata_status='failed',updated_at=? WHERE id=?", now(), job.resource_id); } }
async function generate(generationID) { const generation = one('SELECT * FROM generations WHERE id=?', generationID); if (!generation) throw new Error('generation missing'); run("UPDATE generations SET status='running',updated_at=? WHERE id=?", now(), generationID); emit(generation.session_id, 'generation.progress', { generation_id: generationID, status: 'running' }); const output = await providerImage(generation); const assetID = id(), hash = crypto.createHash('sha256').update(output.bytes).digest('hex'), name = `${assetID}-${hash.slice(0,12)}`; fs.writeFileSync(path.join(cfg.storage.asset_dir, name), output.bytes); const thumbnail = await sharp(output.bytes).resize({ width: 512, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(); fs.writeFileSync(path.join(cfg.storage.asset_dir, `${name}.thumb.webp`), thumbnail); const stamp = now(); run('INSERT INTO assets(id,kind,storage_key,mime_type,byte_size,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', assetID, 'generated_image', name, output.mime, output.bytes.length, hash, 'ready', stamp, stamp); run("UPDATE generations SET status='succeeded',output_asset_id=?,updated_at=? WHERE id=?", assetID, stamp, generationID); run('UPDATE messages SET content=?,asset_id=?,updated_at=? WHERE generation_id=?', JSON.stringify({ generation_id: generationID, asset_id: assetID, aspect_ratio: generation.aspect_ratio, status: 'succeeded' }), assetID, stamp, generationID); const usageData = output.usage; run('INSERT INTO model_calls(id,kind,resource_id,model_name,cost,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id(), 'image_generation', generationID, generation.model_name, Number(usageData.cost || 0), 0, 0, 0, stamp); generationCount.inc({ status: 'succeeded' }); emit(generation.session_id, 'generation.completed', { generation_id: generationID, asset_id: assetID, status: 'succeeded' }); }
async function card(cardID) {
  const value = one('SELECT * FROM character_cards WHERE id=?', cardID);
  if (!value) throw new Error('card missing');
  const sourceIDs = json(value.source_asset_ids);
  if (!Array.isArray(sourceIDs) || !sourceIDs.length) throw new Error('card source missing');
  const sources = sourceIDs.map(assetID => one('SELECT * FROM assets WHERE id=? AND status=?', assetID, 'ready'));
  if (sources.some(source => !source)) throw new Error('card source asset missing');
  const priorMetadata = json(value.metadata) ?? {};
  const requirements = String(priorMetadata.extra_requirements ?? '').trim();
  const character = one('SELECT * FROM characters WHERE id=?', value.character_id);
  const prompt = `Create a reusable character reference card from the supplied reference image(s). Preserve the person's identity, face, hairstyle, body proportions and distinctive features. Produce one clear, polished full-body character image with a simple unobtrusive background; do not add text, labels, collage panels, or watermarks.${requirements ? ` Requested details: ${requirements}` : ''}`;
  const output = await generateReferencedImage(prompt, sources.map(assetDataURL), { ...cfg.image.standard, aspect_ratio: priorMetadata.aspect_ratio || '3:2' });
  const assetID = persistAsset(output.bytes, output.mime, 'character_card');
  run("UPDATE character_cards SET output_asset_id=?,status='ready',metadata_status='pending',metadata=?,updated_at=? WHERE id=?", assetID, JSON.stringify({ ...priorMetadata, generated: true, source_count: sources.length }), now(), cardID);
  queue('character_card_analysis', cardID);
  if (!character?.default_card_id) {
    run('UPDATE character_cards SET is_default=1 WHERE id=?', cardID);
    run('UPDATE characters SET default_card_id=?,updated_at=? WHERE id=?', cardID, now(), value.character_id);
  }
}
setInterval(() => { while (jobs.size + jobs.pending < cfg.worker.count) jobs.add(processJobs).catch(error => logger.error(error, 'background job failed')); }, 750).unref();

const development = process.argv.includes('--dev');
const dist = path.join(root, 'web', 'dist');
const httpServer = http.createServer(app);
if (development) {
  // Vite is mounted as Express middleware: one listener owns API routes,
  // static modules, and the WebSocket endpoint used by React Fast Refresh.
  const { createServer } = await import('vite');
  const vite = await createServer({ root: path.join(root, 'web'), server: { middlewareMode: true, hmr: { server: httpServer } }, appType: 'spa' });
  app.use(vite.middlewares);
} else if (fs.existsSync(path.join(dist, 'index.html'))) { app.use(express.static(dist)); app.get('*splat', (_req, res) => res.sendFile(path.join(dist, 'index.html'))); }
app.use((error, _req, res, _next) => { console.error(error); fail(res, Number(error?.status) || 500, error?.code || 'INTERNAL_ERROR', error?.status ? error.message : '服务器发生错误'); });
const [host, port] = cfg.server.listen.includes(':') ? [cfg.server.listen.slice(0, cfg.server.listen.lastIndexOf(':')), Number(cfg.server.listen.slice(cfg.server.listen.lastIndexOf(':') + 1))] : ['127.0.0.1', 8080];
const server = httpServer.listen(port, host, () => console.log(`Visera listening on http://${host}:${port}${development ? ' (Vite HMR enabled)' : ''}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.$client.close(); process.exit(0); }));
