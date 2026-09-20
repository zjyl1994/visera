import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Lightbox from 'yet-another-react-lightbox'
import Captions from 'yet-another-react-lightbox/plugins/captions'
import DownloadPlugin from 'yet-another-react-lightbox/plugins/download'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/styles.css'
import 'yet-another-react-lightbox/plugins/captions.css'
import {
	Add, ArrowBack, Bookmark, BookmarkBorder, Collections, DeleteOutline, Download, EditOutlined, Face, ImageOutlined, MoreVert, Refresh, Send, StarBorder,
} from '@mui/icons-material'
import {
  Alert, Avatar, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, Divider, IconButton, List, ListItemButton,
  ListItemText, Menu, MenuItem, Paper, Snackbar, Stack, TextField, Tooltip, Typography,
  useMediaQuery, useTheme,
} from '@mui/material'
import { api, assetDownloadURL, assetURL, type Character, type CharacterCard, type CostLine, type GalleryItem, type GenerationUsage, type MemoryCandidate, type Message, type Session } from './api'

type ObjectContent = Record<string, unknown>

function ImageLightbox({ open, onClose, src, alt, downloadURL, title, description }: { open: boolean; onClose: () => void; src: string; alt: string; downloadURL?: string; title?: string; description?: string }) {
  return <Lightbox open={open} close={onClose} slides={[{ src, alt, download: downloadURL, title, description }]} plugins={[Zoom, DownloadPlugin, Captions]} carousel={{ finite: true }} controller={{ closeOnBackdropClick: true }} />
}

function AssetImage({ assetID, alt, className, loading = 'lazy', width, height, style, aspectRatio = '3 / 2', imageClassName, onClick, onKeyDown, interactive = false }: { assetID: string; alt: string; className?: string; loading?: 'eager' | 'lazy'; width?: string | number; height?: string | number; style?: CSSProperties; aspectRatio?: string; imageClassName?: string; onClick?: (event: MouseEvent<HTMLImageElement>) => void; onKeyDown?: (event: KeyboardEvent<HTMLImageElement>) => void; interactive?: boolean }) {
	const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
	useEffect(() => setStatus('loading'), [assetID])
	const frameStyle: CSSProperties = { ...style, width, height, aspectRatio: height ? undefined : aspectRatio }
	return <Box component="span" className={`image-frame ${className || ''} is-${status}`.trim()} style={frameStyle} aria-busy={status === 'loading'}>{status === 'loading' && <span className="image-placeholder" aria-label="图片加载中"><CircularProgress size={24} /></span>}<img key={assetID} className={imageClassName || ''} src={assetURL(assetID)} alt={alt} loading={loading} role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined} onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')} onClick={onClick} onKeyDown={onKeyDown} />{status === 'failed' && <span className="image-load-error" role="status">图片加载失败</span>}</Box>
}

function PreviewImage({ assetID, alt = '图片', className, loading, width, height, style, interactive = true, aspectRatio }: { assetID: string; alt?: string; className?: string; loading?: 'eager' | 'lazy'; width?: string | number; height?: string | number; style?: CSSProperties; interactive?: boolean; aspectRatio?: string }) {
	const [open, setOpen] = useState(false)
	const openPreview = () => setOpen(true)
	return <><AssetImage assetID={assetID} alt={alt} className={className} loading={loading} width={width} height={height} style={style} aspectRatio={aspectRatio} imageClassName="previewable-image" interactive={interactive} onClick={interactive ? (event) => { event.stopPropagation(); openPreview() } : undefined} onKeyDown={interactive ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPreview() } } : undefined} />{interactive && <ImageLightbox open={open} onClose={() => setOpen(false)} src={assetURL(assetID)} alt={alt} downloadURL={assetDownloadURL(assetID)} />}</>
}

function asObject(value: unknown): ObjectContent {
  return typeof value === 'object' && value !== null ? value as ObjectContent : {}
}
function asText(value: unknown) {
  if (typeof value === 'string') return value
  const text = asObject(value).text
  return typeof text === 'string' ? text : ''
}

function sessionPreview(value?: string) {
  if (!value) return '等待你的第一条消息'
  try {
    const content = JSON.parse(value)
    const text = asText(content)
    if (text) return text
    const object = asObject(content)
    if (object.generation_id || object.status) {
      const label = { queued: '正在准备生成画面', running: '正在生成画面', succeeded: '画面已生成', failed: '画面生成失败' }[String(object.status || 'queued')] || '正在生成画面'
      return typeof object.aspect_ratio === 'string' ? `${label} · ${object.aspect_ratio}` : label
    }
    if (typeof object.summary === 'string') return object.summary
    if (typeof object.prompt === 'string') return object.prompt
  } catch { /* Older text previews are already displayable. */ }
  return value
}

function formatTimestamp(value: number | string | undefined) {
	const timestamp = Number(value)
	if (!Number.isFinite(timestamp) || timestamp <= 0) return '时间未记录'
	return new Date(timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp).toLocaleString('zh-CN')
}

function cardLabel(card: CharacterCard, index?: number) {
	if (card.name?.trim()) return card.name.trim()
	return card.is_default ? '默认角色卡' : index == null ? '角色卡' : `角色卡 ${index + 1}`
}

function readyCardsFirst(cards: CharacterCard[]) {
	return cards.filter((card) => card.status === 'ready' && card.output_asset_id).sort((left, right) => Number(right.is_default) - Number(left.is_default))
}

const imageCapabilityCacheKey = 'visera:image-capabilities:v1'
async function cachedImageCapabilities(model = '') {
	try {
		const cached = JSON.parse(localStorage.getItem(imageCapabilityCacheKey) || '') as { expiresAt?: number; value?: import('./api').ImageCapabilities }
		if (cached.expiresAt && cached.expiresAt > Date.now() && cached.value?.aspect_ratios?.length && (!model || cached.value.model === model)) return cached.value
	} catch { /* Cache is optional. */ }
	const value = await api.imageCapabilities()
	try { localStorage.setItem(imageCapabilityCacheKey, JSON.stringify({ value, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 })) } catch { /* Storage may be unavailable. */ }
	return value
}

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const theme = useTheme()
  const mobile = useMediaQuery(theme.breakpoints.down('md'))
  const activeID = /^\/sessions\/([^/]+)$/.exec(location.pathname)?.[1] ?? null
  const [error, setError] = useState('')
	const queryClient = useQueryClient()
	const [authReady, setAuthReady] = useState(false)
	const [authenticated, setAuthenticated] = useState(false)
	const [sessionStartOpen, setSessionStartOpen] = useState(false)
	const [sessionStarting, setSessionStarting] = useState(false)
	// The main pane can show exactly one destination at a time. Keeping this as
	// one state (instead of independent booleans) prevents a library page from
	// continuing to mask the conversation after a session is selected.
	const mainPage: 'chat' | 'characters' | 'gallery' = location.pathname === '/characters' ? 'characters' : location.pathname === '/gallery' ? 'gallery' : 'chat'

  useEffect(() => { void api.authStatus().then((result) => setAuthenticated(result.authenticated)).catch(() => setAuthenticated(false)).finally(() => setAuthReady(true)) }, [])
	const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions, enabled: authenticated })
	const messagesQuery = useQuery({ queryKey: ['sessions', activeID, 'messages'], queryFn: () => api.listMessages(activeID!), enabled: authenticated && Boolean(activeID) })
	const sessions = sessionsQuery.data?.data ?? []
	const messages = messagesQuery.data?.data ?? []
	const loading = sessionsQuery.isPending
	const refreshSessions = async () => { await queryClient.invalidateQueries({ queryKey: ['sessions'] }) }
	const loadMessages = async (id: string) => { await queryClient.invalidateQueries({ queryKey: ['sessions', id, 'messages'] }) }
	useEffect(() => { if (sessionsQuery.isError) setError(errorMessage(sessionsQuery.error)) }, [sessionsQuery.error, sessionsQuery.isError])
	useEffect(() => { if (messagesQuery.isError) setError(errorMessage(messagesQuery.error)) }, [messagesQuery.error, messagesQuery.isError])
  useEffect(() => { if (authenticated && location.pathname === '/') navigate('/sessions', { replace: true }) }, [authenticated, location.pathname, navigate])
  useEffect(() => {
    if (authenticated && !loading && activeID && !sessions.some((session) => session.id === activeID)) {
      setError('会话不存在或已删除')
      navigate('/sessions', { replace: true })
    }
  }, [activeID, authenticated, loading, navigate, sessions])
  useEffect(() => {
    if (!activeID) return
    const events = new EventSource(`/api/v1/sessions/${activeID}/events`)
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['sessions', activeID, 'messages'] }); void queryClient.invalidateQueries({ queryKey: ['sessions'] }) }
    for (const name of ['message.created', 'assistant.plan', 'assistant.question', 'assistant.message', 'generation.progress', 'generation.completed', 'generation.failed']) events.addEventListener(name, refresh)
    return () => events.close()
  }, [activeID, queryClient])

	const createSession = () => setSessionStartOpen(true)
	const startSession = async (characterID: string, characterCardID: string) => { if (sessionStarting) return; setSessionStarting(true); try { const session = await api.createSession(characterID, characterCardID); await refreshSessions(); setSessionStartOpen(false); navigate(`/sessions/${session.id}`) } catch (err) { setError(errorMessage(err)) } finally { setSessionStarting(false) } }
  const deleteSession = async (id: string) => {
    try { await api.deleteSession(id); if (activeID === id) navigate('/sessions'); await refreshSessions() } catch (err) { setError(errorMessage(err)) }
  }
  const active = useMemo(() => sessions.find((session) => session.id === activeID) || null, [sessions, activeID])

  const openCharacters = () => navigate('/characters')
  const openGallery = () => navigate('/gallery')
  const showChat = () => navigate('/sessions')
  const selectSession = (id: string) => navigate(`/sessions/${id}`)
  const list = <ConversationList sessions={sessions} activeID={activeID} loading={loading} onCreate={createSession} onCharacters={openCharacters} onGallery={openGallery} onSelect={selectSession} onDelete={deleteSession} />
  const chat = activeID ? <Chat session={active} sessionID={activeID} messages={messages} onBack={() => navigate('/sessions')} onRefresh={() => { void loadMessages(activeID); void refreshSessions() }} onError={setError} /> : <EmptyChat onCreate={createSession} />
	const content = mainPage === 'gallery' ? <GalleryPage onBack={showChat} onError={setError} /> : mainPage === 'characters' ? <CharacterLibraryPage onBack={showChat} onRefresh={refreshSessions} onError={setError} /> : chat

  if (!authReady) return <Stack className="auth-loading" alignItems="center" justifyContent="center"><CircularProgress /><Typography color="text.secondary">正在打开 Visera…</Typography></Stack>
  if (!authenticated) return <LoginScreen onAuthenticated={() => setAuthenticated(true)} />
  return <Box className="app-shell">
    {mobile ? (mainPage !== 'chat' ? content : activeID ? chat : list) : <><Box className="conversation-pane">{list}</Box><Box className="chat-pane">{content}</Box></>}
		<Snackbar open={Boolean(error)} autoHideDuration={6000} anchorOrigin={{ vertical: 'top', horizontal: 'center' }} onClose={(_event, reason) => { if (reason !== 'clickaway') setError('') }}><Alert className="global-alert" severity="error" variant="filled" onClose={() => setError('')}>{error}</Alert></Snackbar>
		<SessionStartDialog open={sessionStartOpen} onClose={() => !sessionStarting && setSessionStartOpen(false)} onSelect={startSession} busy={sessionStarting} onError={setError} />
  </Box>
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const [remember, setRemember] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const submit = async (event: FormEvent) => { event.preventDefault(); if (!username.trim() || !password || busy) return; setBusy(true); setError(''); try { await api.login(username.trim(), password, remember); onAuthenticated() } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) } }
  return <Box className="auth-page"><Paper component="form" onSubmit={submit} className="login-card"><Avatar variant="rounded" className="brand-avatar login-mark" src="/icons/icon-192.png" alt="Visera" /><Typography variant="h4">欢迎回来，继续创作</Typography><Typography color="text.secondary">你的灵感与作品，都在这里。</Typography><Stack spacing={2.25} sx={{ mt: 3 }}><TextField autoFocus autoComplete="username" label="账户名" value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy} /><TextField autoComplete="current-password" label="密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /><Stack direction="row" alignItems="center" spacing={.5}><Checkbox checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} inputProps={{ 'aria-label': '在这台设备上记住我' }} /><Box><Typography variant="body2">在此设备上记住我</Typography><Typography variant="caption" color="text.secondary">下次打开时可直接继续创作</Typography></Box></Stack>{error && <Alert severity="error">{error}</Alert>}<Button type="submit" size="large" variant="contained" disabled={!username.trim() || !password || busy}>{busy ? '正在进入创作空间…' : '进入创作空间'}</Button><Typography variant="caption" color="text.secondary" textAlign="center">未勾选时，关闭浏览器后将自动退出。</Typography></Stack></Paper></Box>
}

function ConversationList({ sessions, activeID, loading, onCreate, onCharacters, onGallery, onSelect, onDelete }: {
	 sessions: Session[]; activeID: string | null; loading: boolean; onCreate: () => void; onCharacters: () => void; onGallery: () => void; onSelect: (id: string) => void; onDelete: (id: string) => Promise<void>
}) {
  const [target, setTarget] = useState<string | null>(null)
	const [deleting, setDeleting] = useState(false)
	const remove = async () => { if (!target || deleting) return; setDeleting(true); try { await onDelete(target); setTarget(null) } finally { setDeleting(false) } }
  return <Box className="conversation-list">
    <Stack direction="row" alignItems="center" justifyContent="space-between" className="list-header">
      <Stack direction="row" spacing={1} alignItems="center"><Avatar variant="rounded" className="brand-avatar" src="/icons/icon-192.png" alt="Visera" /><Typography variant="h6">Visera</Typography></Stack>
	  <Stack direction="row"><Tooltip title="作品库"><IconButton aria-label="打开作品库" color="primary" onClick={onGallery}><Collections /></IconButton></Tooltip><Tooltip title="角色卡库"><IconButton aria-label="打开角色卡库" color="primary" onClick={onCharacters}><Face /></IconButton></Tooltip></Stack>
    </Stack>
    <Button startIcon={<Add />} variant="contained" fullWidth onClick={onCreate} sx={{ mb: 1.5 }}>新建对话</Button>
    <List disablePadding className="session-list">
      {loading && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>}
      {!loading && sessions.length === 0 && <Typography color="text.secondary" sx={{ p: 3, textAlign: 'center' }}>还没有对话，开始你的第一次创作吧。</Typography>}
      {sessions.map((session) => <ListItemButton key={session.id} selected={session.id === activeID} className="session-row" onClick={() => onSelect(session.id)}>
        <Avatar>{session.title.slice(0, 1)}</Avatar>
        <ListItemText primary={session.title} secondary={<Stack className="session-meta" direction="row" spacing={.5} alignItems="center">{session.status === 'finalized' && <Bookmark className="finalized-mark" aria-label="已保存至作品库" />}<Typography variant="caption" noWrap>{session.status === 'finalized' ? '已保存至作品库' : sessionPreview(session.last_message_preview)}</Typography></Stack>} primaryTypographyProps={{ noWrap: true }} secondaryTypographyProps={{ component: 'div' }} />
        <IconButton aria-label={`删除对话 ${session.title}`} size="small" onClick={(event) => { event.stopPropagation(); setTarget(session.id) }}><DeleteOutline fontSize="small" /></IconButton>
      </ListItemButton>)}
		</List>
	<Dialog open={Boolean(target)} onClose={() => !deleting && setTarget(null)}><DialogTitle>删除对话？</DialogTitle><DialogContent><DialogContentText>对话会从列表中移除，但已保存的图片不会立刻删除。</DialogContentText></DialogContent><DialogActions><Button disabled={deleting} onClick={() => setTarget(null)}>取消</Button><Button color="error" disabled={deleting} onClick={() => void remove()}>{deleting ? '正在删除…' : '删除'}</Button></DialogActions></Dialog>
  </Box>
}

function EmptyChat({ onCreate }: { onCreate: () => void }) {
  return <Stack className="empty-chat" spacing={2} alignItems="center" justifyContent="center"><Avatar variant="rounded" className="home-logo" src="/icons/icon-192.png" alt="Visera" /><Typography variant="h4">让灵感成为画面</Typography><Typography color="text.secondary">从一个想法、一张参考图，或一句有画面感的话开始。</Typography><Button variant="contained" startIcon={<Add />} onClick={onCreate}>开始创作</Button></Stack>
}

function GalleryDialog({ open, onClose, onError }: { open: boolean; onClose: () => void; onError: (message: string) => void }) {
	const [target, setTarget] = useState<GalleryItem | null>(null)
	const queryClient = useQueryClient()
	const galleryQuery = useQuery({ queryKey: ['gallery', 1], queryFn: () => api.listGallery(), enabled: open })
	const items = galleryQuery.data?.data ?? []
	useEffect(() => { if (galleryQuery.isError) onError(errorMessage(galleryQuery.error)) }, [galleryQuery.error, galleryQuery.isError, onError])
	const remove = async () => { if (!target) return; try { await api.deleteGalleryItem(target.id); await queryClient.invalidateQueries({ queryKey: ['gallery'] }); setTarget(null) } catch (err) { onError(errorMessage(err)) } }
	return <><Dialog open={open} onClose={onClose} fullWidth maxWidth="md"><DialogTitle>作品库</DialogTitle><DialogContent><Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>你保留下来的画面都在这里。可以随时预览、下载或移出作品库。</Typography><Box className="gallery-grid">{items.length === 0 && <Typography color="text.secondary">这里还没有作品。保留满意的画面，它会自动出现在这里。</Typography>}{items.map((item) => <Paper key={item.id} className="gallery-item" variant="outlined">{item.asset_id && <PreviewImage assetID={item.asset_id} alt={item.title || '作品预览'} /> }<Typography variant="body2" noWrap>{item.title || '未命名作品'}</Typography><Typography variant="caption" color="text.secondary">{item.cost_recorded ? `本次创作费用：$${Number(item.cost || 0).toFixed(4)}` : '费用信息暂不可用'}</Typography><Stack direction="row" spacing={.5} sx={{ mt: 1 }}><Button size="small" component="a" href={item.asset_id ? assetDownloadURL(item.asset_id) : undefined} startIcon={<Download />} disabled={!item.asset_id}>下载</Button><Button size="small" color="error" onClick={() => setTarget(item)}>移出作品库</Button></Stack></Paper>)}</Box></DialogContent><DialogActions><Button onClick={onClose}>关闭</Button></DialogActions></Dialog><Dialog open={Boolean(target)} onClose={() => setTarget(null)}><DialogTitle>移出作品库？</DialogTitle><DialogContent><DialogContentText>这只会从作品库中移除这张图片，不会影响原来的创作记录。</DialogContentText></DialogContent><DialogActions><Button onClick={() => setTarget(null)}>取消</Button><Button color="error" onClick={() => void remove()}>移出</Button></DialogActions></Dialog></>
}

function GalleryPage({ onBack, onError }: { onBack: () => void; onError: (message: string) => void }) {
	const [page, setPage] = useState(1)
	const [target, setTarget] = useState<GalleryItem | null>(null)
	const [removing, setRemoving] = useState(false)
	const queryClient = useQueryClient()
	const galleryQuery = useQuery({ queryKey: ['gallery', page], queryFn: () => api.listGallery(page) })
	const items = galleryQuery.data?.data ?? []
	const pagination = galleryQuery.data?.pagination ?? { page, page_size: 24, total: 0, total_pages: 1 }
	const loading = galleryQuery.isPending
	useEffect(() => { if (galleryQuery.isError) onError(errorMessage(galleryQuery.error)) }, [galleryQuery.error, galleryQuery.isError, onError])
	const remove = async () => { if (!target || removing) return; setRemoving(true); try { await api.deleteGalleryItem(target.id); setTarget(null); if (items.length === 1 && page > 1) setPage((value) => value - 1); else await queryClient.invalidateQueries({ queryKey: ['gallery', page] }) } catch (err) { onError(errorMessage(err)) } finally { setRemoving(false) } }
	return <Box className="gallery-page"><Stack className="gallery-page-header" direction="row" alignItems="center" spacing={1.5}><IconButton aria-label="返回创作列表" onClick={onBack}><ArrowBack /></IconButton><Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="overline" color="primary">你的作品</Typography><Typography variant="h4">作品库</Typography><Typography variant="body2" color="text.secondary">已保留的画面会在这里安静地陈列。</Typography></Box><Typography className="gallery-count" variant="body2">{pagination.total} 件作品</Typography></Stack><Box className="gallery-page-content">{loading ? <Stack className="gallery-loading" alignItems="center" justifyContent="center" spacing={1}><CircularProgress /><Typography color="text.secondary">正在整理作品…</Typography></Stack> : items.length === 0 ? <Stack className="gallery-empty" alignItems="center" justifyContent="center" spacing={1}><Typography variant="h6">还没有保留的作品</Typography><Typography color="text.secondary">满意的画面会自动收进这里。</Typography></Stack> : <Box className="gallery-page-grid">{items.map((item) => <Paper key={item.id} className="gallery-card" variant="outlined">{item.asset_id && <PreviewImage assetID={item.asset_id} alt={item.title || '作品预览'} loading="lazy" /> }<Box className="gallery-card-body"><Typography variant="subtitle2" noWrap>{item.title || '未命名作品'}</Typography><Typography variant="caption" color="text.secondary">{item.cost_recorded ? `本次创作费用 $${Number(item.cost || 0).toFixed(4)}` : '费用信息暂不可用'}</Typography><Stack direction="row" spacing={.5} sx={{ mt: 1.25 }}><Button size="small" component="a" href={item.asset_id ? assetDownloadURL(item.asset_id) : undefined} startIcon={<Download />} disabled={!item.asset_id}>下载</Button><Button size="small" color="error" onClick={() => setTarget(item)}>移出</Button></Stack></Box></Paper>)}</Box>}</Box>{pagination.total_pages > 1 && <Stack className="gallery-pagination" direction="row" alignItems="center" justifyContent="center" spacing={1.5}><Button disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button><Typography variant="body2" color="text.secondary">第 {pagination.page} / {pagination.total_pages} 页</Typography><Button disabled={loading || page >= pagination.total_pages} onClick={() => setPage((value) => value + 1)}>下一页</Button></Stack>}<Dialog open={Boolean(target)} onClose={() => !removing && setTarget(null)}><DialogTitle>移出作品库？</DialogTitle><DialogContent><DialogContentText>这只会从作品库中移除这张图片，不会影响原来的创作记录。</DialogContentText></DialogContent><DialogActions><Button disabled={removing} onClick={() => setTarget(null)}>取消</Button><Button color="error" disabled={removing} onClick={() => void remove()}>{removing ? '正在移出…' : '移出'}</Button></DialogActions></Dialog></Box>
}

function Chat({ session, sessionID, messages, onBack, onRefresh, onError }: { session: Session | null; sessionID: string; messages: Message[]; onBack: () => void; onRefresh: () => void; onError: (error: string) => void }) {
	const mobile = useMediaQuery(useTheme().breakpoints.down('md'))
	const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
	const latestGenerationMessage = useMemo(() => [...messages].reverse().find((message) => message.kind === 'generation') || null, [messages])
	const latestGenerationContent = asObject(latestGenerationMessage?.content)
	const latestGenerationStatus = String(latestGenerationContent.status || '')
	const latestGeneration = latestGenerationMessage && latestGenerationStatus === 'succeeded' ? { id: String(latestGenerationContent.generation_id || latestGenerationMessage.generation_id || ''), assetID: String(latestGenerationContent.asset_id || latestGenerationMessage.asset_id || ''), aspectRatio: String(latestGenerationContent.aspect_ratio || '') } : null
	const plans = messages.filter((message) => message.kind === 'plan')
	const questions = messages.filter((message) => message.kind === 'question')
	const phase = latestGeneration ? 'studio' : latestGenerationMessage ? 'generating' : messages.length ? 'briefing' : 'setup'
  return <Box className="chat-view">
    <Stack direction="row" className="chat-header" alignItems="center" spacing={1}>
      {mobile && <IconButton aria-label="返回对话列表" onClick={onBack}><ArrowBack /></IconButton>}
	  <Avatar>{session?.title.slice(0, 1) || 'V'}</Avatar><Box sx={{ flex: 1, minWidth: 0 }}><Typography noWrap fontWeight={700}>{session?.title || '新对话'}</Typography><Typography variant="caption" color="text.secondary">AI 角色卡创作对话</Typography></Box>
		<IconButton aria-label="对话选项" onClick={(event) => setMenuAnchor(event.currentTarget)}><MoreVert /></IconButton>
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}><MenuItem onClick={() => { onRefresh(); setMenuAnchor(null) }}><Refresh fontSize="small" />&nbsp;刷新对话</MenuItem></Menu>
    </Stack>
    <Divider />
		{phase === 'studio' && latestGeneration ? <StudioWorkspace session={session} generation={latestGeneration} plans={plans} messages={messages} onRefresh={onRefresh} onError={onError} /> : phase === 'generating' && latestGenerationMessage ? <GenerationProgressWorkspace message={latestGenerationMessage} status={latestGenerationStatus} errorCode={String(latestGenerationContent.error_code || '')} onRefresh={onRefresh} onError={onError} /> : <BriefingWorkspace sessionID={sessionID} phase={phase} messages={messages} plans={plans} questions={questions} onRefresh={onRefresh} onError={onError} />}
	</Box>
}

function GenerationProgressWorkspace({ message, status, errorCode, onRefresh, onError }: { message: Message; status: string; errorCode: string; onRefresh: () => void; onError: (message: string) => void }) {
	const [retrying, setRetrying] = useState(false)
	const [adjustment, setAdjustment] = useState('')
	const generationID = String(asObject(message.content).generation_id || message.generation_id || '')
	const failed = status === 'failed'
	const blocked = errorCode === 'IMAGE_REQUEST_BLOCKED'
	const retry = async () => { if (!generationID || retrying) return; setRetrying(true); try { await api.retryGeneration(generationID); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setRetrying(false) } }
	const adjust = async () => { if (!generationID || !adjustment.trim() || retrying) return; setRetrying(true); try { await api.adjustFailedGeneration(generationID, adjustment.trim()); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setRetrying(false) } }
	return <Box className="generation-progress-page"><Paper className="generation-progress-card" variant="outlined">{failed ? <><Typography variant="overline" color="primary">需要调整画面说明</Typography><Typography variant="h4">这一版先停在这里</Typography><Typography color="text.secondary">{blocked ? '这次描述未能通过画面服务的安全审核。调整成更日常、清晰的表达后，再继续创作。' : '任务没有完成。你可以补充或改写画面说明，然后创建一个新版本。'}</Typography><TextField className="generation-adjustment" value={adjustment} onChange={(event) => setAdjustment(event.target.value)} disabled={retrying} label="想怎么调整？" placeholder="例如：人物为成年女性，穿宽松家居服，安静靠在沙发上阅读" multiline minRows={3} fullWidth /><Stack direction="row" spacing={1} sx={{ mt: 2 }}><Button variant="contained" disabled={retrying || !generationID || !adjustment.trim()} startIcon={retrying ? <CircularProgress size={17} /> : undefined} onClick={() => void adjust()}>{retrying ? '正在创建新版本…' : '调整后重新生成'}</Button>{!blocked && <Button variant="outlined" disabled={retrying || !generationID} startIcon={<Refresh />} onClick={() => void retry()}>原样重试</Button>}</Stack><Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>调整后会保留这次记录，并以新版本继续；不会再自动重复提交。</Typography></> : <><Stack direction="row" spacing={1.5} alignItems="center"><CircularProgress /><Box><Typography variant="overline" color="primary">创作进行中</Typography><Typography variant="h4">正在描绘画面</Typography></Box></Stack><Typography color="text.secondary" sx={{ mt: 2 }}>画面准备好后会自动带你进入工作台。你不需要停留在这里或重复点击。</Typography><Paper className="generation-progress-note" variant="outlined"><Typography variant="body2" fontWeight={700}>{status === 'queued' ? '正在安排这次创作' : '正在生成细节与光影'}</Typography><Typography variant="caption" color="text.secondary">你可以继续留在这里，状态会自动更新。</Typography></Paper><Button sx={{ mt: 3 }} variant="outlined" startIcon={<Refresh />} onClick={onRefresh}>刷新状态</Button></>}</Paper></Box>
}

function BriefingWorkspace({ sessionID, phase, messages, plans, questions, onRefresh, onError }: { sessionID: string; phase: string; messages: Message[]; plans: Message[]; questions: Message[]; onRefresh: () => void; onError: (message: string) => void }) {
	const [idea, setIdea] = useState('')
	const [busy, setBusy] = useState(false)
	const [aspectRatio, setAspectRatio] = useState('3:2')
	const [aspectRatios, setAspectRatios] = useState(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'])
	useEffect(() => { void api.imageCapabilities().then((result) => { if (result.aspect_ratios.length) { setAspectRatios(result.aspect_ratios); setAspectRatio((current) => result.aspect_ratios.includes(current) ? current : result.aspect_ratios[0]) } }).catch(() => {}) }, [])
	const unansweredQuestion = questions.at(-1)
	const send = async (text: string, initialAspectRatio?: string): Promise<boolean> => { if (!text.trim() || busy) return false; setBusy(true); try { await api.sendMessage(sessionID, text, 'draft', 'generate', initialAspectRatio); onRefresh(); return true } catch (err) { onError(errorMessage(err)); return false } finally { setBusy(false) } }
	const latestUserMessage = messages.filter((message) => message.role === 'user').at(-1)
	const answeredQuestion = [...questions].reverse().find((question) => latestUserMessage && latestUserMessage.created_at >= question.created_at)
	const recentAnswer = answeredQuestion && latestUserMessage ? asText(latestUserMessage.content) : ''
	const lastQuestion = unansweredQuestion && (!latestUserMessage || unansweredQuestion.created_at > latestUserMessage.created_at) ? unansweredQuestion : undefined
	const directionMessage = plans.filter((message) => String(asObject(message.content).stage) === '场景方向').at(-1)
	const confirmedBrief = plans.filter((message) => String(asObject(message.content).stage) === '确认后的创作简报').at(-1)
	const step = lastQuestion || confirmedBrief ? 2 : 1
	return <Box className="workflow-page"><Box className="workflow-intro"><Typography variant="overline" color="primary">从灵感到画面</Typography><Typography variant="h4">{step === 1 ? '想画什么？' : '让画面更清晰'}</Typography><Typography color="text.secondary">说说你脑海中的画面；细节不必一次说完，我们会陪你慢慢补全，并在准备好后直接开始创作。</Typography><Stack className="step-rail" direction="row" spacing={1}><Box className="active">1 灵感</Box><Box className={step >= 2 ? 'active' : ''}>2 画面</Box><Box>3 生成</Box></Stack></Box><Stack className="brief-grid" spacing={2}>{recentAnswer && <Paper className="answer-recap" variant="outlined"><Typography variant="caption" color="text.secondary">你刚刚确认</Typography><Typography fontWeight={700}>{recentAnswer}</Typography></Paper>}{lastQuestion ? <QuestionCard key={lastQuestion.id} message={lastQuestion} onChoose={send} /> : confirmedBrief ? <Paper className="brief-card" variant="outlined"><Typography variant="subtitle2" color="primary">正在安排这幅画</Typography><Typography whiteSpace="pre-wrap">{String(asObject(confirmedBrief.content).text || '')}</Typography></Paper> : directionMessage ? <DirectionCard key={directionMessage.id} content={asObject(directionMessage.content)} onChoose={send} /> : <Paper className="start-idea-card" variant="outlined"><Typography variant="subtitle1" fontWeight={700}>从一个画面开始</Typography><Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>地点、心情、人物动作，或任何让你有感觉的片段都可以。</Typography><TextField value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="例如：雨夜的便利店门口，她刚下班，像一幕电影" multiline minRows={4} fullWidth /><Typography variant="subtitle2" sx={{ mt: 2, mb: .75 }}>后续画面比例</Typography><Stack direction="row" useFlexGap flexWrap="wrap" spacing={.5}>{aspectRatios.map((ratio) => <Button key={ratio} size="small" variant={aspectRatio === ratio ? 'contained' : 'outlined'} disabled={busy} onClick={() => setAspectRatio(ratio)}>{ratio}</Button>)}</Stack><Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>这个比例会应用到本次创作的第一张画面及后续版本。</Typography><Button sx={{ mt: 1.5 }} variant="contained" disabled={busy || !idea.trim()} onClick={() => void send(idea, aspectRatio)}>继续</Button></Paper>}</Stack></Box>
}

function DirectionCard({ content, onChoose }: { content: ObjectContent; onChoose: (value: string) => Promise<boolean> }) {
	const directions = Array.isArray(content.directions) ? content.directions.map((value) => value as { id?: string; title?: string; brief?: string }) : []
	const [custom, setCustom] = useState('')
	const [selected, setSelected] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const choose = async (value: string) => { if (submitting) return; setSelected(value); setSubmitting(true); if (!await onChoose(value)) setSelected(''); setSubmitting(false) }
	return <Paper className="direction-card" variant="outlined"><Typography variant="subtitle2" color="primary">选择一个最接近你想法的方向</Typography><Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>也可以直接写下你想呈现的画面。</Typography><Stack spacing={1}>{directions.map((direction, index) => { const value = `${direction.title || ''}：${direction.brief || ''}`; const chosen = selected === value; return <Button key={direction.id || index} className={`direction-option ${chosen ? 'choice-selected' : ''}`} variant={chosen ? 'contained' : 'outlined'} disabled={submitting} onClick={() => void choose(value)}><Box textAlign="left"><Typography fontWeight={700}>{direction.title || `方向 ${index + 1}`}</Typography><Typography variant="body2" color="text.secondary">{direction.brief || ''}</Typography></Box></Button> })}</Stack><Stack direction="row" spacing={1} sx={{ mt: 1.5 }}><TextField size="small" disabled={submitting} value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="写下你想呈现的画面" fullWidth /><Button disabled={submitting || !custom.trim()} onClick={() => void choose(custom)}>继续</Button></Stack>{submitting && <ThinkingNotice choice={selected} />}</Paper>
}

function PromptConfirmation({ message, busy, requested, onGenerate }: { message: Message; busy: boolean; requested: boolean; onGenerate: () => void }) {
	const content = asObject(message.content)
	const drawing = asObject(content.drawing)
	const fields = [
		['画面主角', drawing.subject], ['场景', drawing.scene], ['服装与状态', drawing.outfit], ['动作与神态', [drawing.pose, drawing.expression].filter(Boolean).join('；')],
		['镜头与构图', [drawing.camera, drawing.composition].filter(Boolean).join('；')], ['光线与氛围', drawing.lighting], ['视觉风格', drawing.style], ['画面细节', drawing.details],
	].filter(([, value]) => typeof value === 'string' && value.trim()) as [string, string][]
	return <Paper className="prompt-confirmation" variant="outlined"><Typography variant="subtitle2" color="primary">画面说明</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>确认这幅画要呈现的内容。生成时会自动补全角色设定、参考图规则和画面约束。</Typography>{fields.length ? <Box className="scene-description">{fields.map(([label, value]) => <Box key={label}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2">{value}</Typography></Box>)}</Box> : <Typography className="scene-description" whiteSpace="pre-wrap">{String(content.text || '')}</Typography>}{requested && <ThinkingNotice choice="正在准备画面" />}<Button className="generate-draft-button" size="large" variant="contained" disabled={busy} onClick={onGenerate}>{requested ? '正在准备画面…' : '确认并开始生成'}</Button></Paper>
}

function ThinkingNotice({ choice }: { choice: string }) {
	return <Stack className="thinking-notice" direction="row" spacing={1} alignItems="center"><CircularProgress size={16} /><Box><Typography variant="body2" fontWeight={700}>已选择：{choice}</Typography><Typography variant="caption" color="text.secondary">正在整理画面细节…</Typography></Box></Stack>
}

function QuestionCard({ message, onChoose }: { message: Message; onChoose: (value: string) => Promise<boolean> }) {
	const content = asObject(message.content); const options = Array.isArray(content.options) ? content.options.map((value) => value as { id?: string; label?: string; description?: string }) : []
	const [custom, setCustom] = useState('')
	const [selected, setSelected] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const choose = async (value: string) => { if (submitting) return; setSelected(value); setSubmitting(true); if (!await onChoose(value)) setSelected(''); setSubmitting(false) }
	return <Paper className="question-card" variant="outlined"><Typography variant="subtitle2">还需要确认</Typography><Typography sx={{ mb: 1.5 }}>{String(content.text || '')}</Typography>{selected ? <><Paper className="answer-recap" variant="outlined"><Typography variant="caption" color="text.secondary">你已选择</Typography><Typography fontWeight={700}>{selected}</Typography></Paper>{submitting && <ThinkingNotice choice={selected} />}</> : <><Stack spacing={1}>{options.map((option, index) => { const value = option.label || ''; return <Button key={option.id || index} variant="outlined" disabled={submitting} onClick={() => void choose(value)}>{option.label}{option.description ? ` · ${option.description}` : ''}</Button> })}</Stack><Stack direction="row" spacing={1} sx={{ mt: 1.5 }}><TextField size="small" disabled={submitting} value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="或者直接输入你的答案" fullWidth /><Button disabled={submitting || !custom.trim()} onClick={() => void choose(custom)}>确认</Button></Stack></>}</Paper>
}

function CostBreakdownDialog({ usage, open, onClose }: { usage: GenerationUsage | null; open: boolean; onClose: () => void }) {
	const label = (kind: string) => ({ scene_direction: '构思画面', scene_brief: '整理灵感', text_agent: '创作协作', text_agent_followup: '完善画面', memory_extraction: '整理角色偏好' }[kind] || kind)
	const line = (item: CostLine, index: number, group: 'image' | 'llm') => <Stack key={item.id || `${group}-${index}`} direction="row" justifyContent="space-between" spacing={2} sx={{ py: 1, borderBottom: '1px solid', borderColor: 'divider' }}><Box><Typography variant="body2">{group === 'image' ? `画面生成 ${index + 1}` : label(item.kind)}</Typography><Typography variant="caption" color="text.secondary">{item.model_name || '服务信息暂不可用'} · {formatTimestamp(item.created_at)}</Typography></Box><Typography variant="body2">${Number(item.cost || 0).toFixed(4)}</Typography></Stack>
	return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm"><DialogTitle>本次创作费用</DialogTitle><DialogContent><Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>费用包含画面生成和本次创作协作。</Typography><Paper variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: 'action.hover' }}><Stack direction="row" justifyContent="space-between"><Typography fontWeight={700}>合计</Typography><Typography fontWeight={700}>${Number(usage?.total_cost || 0).toFixed(4)}</Typography></Stack><Typography variant="caption" color="text.secondary">画面生成 ${Number(usage?.image_cost || 0).toFixed(4)} · 创作协作 ${Number(usage?.llm_cost || 0).toFixed(4)}</Typography></Paper><Typography variant="subtitle2">生成画面（{usage?.image_calls || 0} 次）</Typography>{usage?.image_calls_detail?.length ? usage?.image_calls_detail.map((item, index) => line(item, index, 'image')) : <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>费用信息暂不可用。</Typography>}<Typography variant="subtitle2" sx={{ mt: 2 }}>创作协作（{usage?.llm_calls || 0} 次）</Typography>{usage?.llm_calls_detail?.length ? usage.llm_calls_detail.map((item, index) => line(item, index, 'llm')) : <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>暂无可显示的费用信息。</Typography>}</DialogContent><DialogActions><Button onClick={onClose}>关闭</Button></DialogActions></Dialog>
}

function StudioWorkspace({ session, generation, plans, messages, onRefresh, onError }: { session: Session | null; generation: { id: string; assetID: string; aspectRatio: string }; plans: Message[]; messages: Message[]; onRefresh: () => void; onError: (message: string) => void }) {
	const [feedback, setFeedback] = useState(''); const [busy, setBusy] = useState(false); const [candidates, setCandidates] = useState<MemoryCandidate[]>([])
	const [useCharacterCard, setUseCharacterCard] = useState(true)
	const [cardAsset, setCardAsset] = useState('')
	const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>('draft')
	const [usage, setUsage] = useState<GenerationUsage | null>(null)
	const [costOpen, setCostOpen] = useState(false)
	const [finalizeOpen, setFinalizeOpen] = useState(false)
	const [promptOpen, setPromptOpen] = useState(false)
	const [aspectRatios, setAspectRatios] = useState<string[]>(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'])
	const [aspectRatio, setAspectRatio] = useState<string | null>(generation.aspectRatio || null)
	const finalized = session?.status === 'finalized'
	useEffect(() => { if (session?.character_id) void api.listMemoryCandidates(session.character_id).then((result) => setCandidates(result.data)).catch(() => setCandidates([])) }, [session?.character_id, messages.length])
	useEffect(() => { if (!session?.character_id) return; void api.listCards(session.character_id).then((result) => setCardAsset(result.data.find((card) => card.id === session.character_card_id)?.output_asset_id || '')).catch(() => setCardAsset('')) }, [session?.character_id, session?.character_card_id])
	useEffect(() => {
		setAspectRatio(generation.aspectRatio || null)
		void api.getGeneration(generation.id).then((result) => {
			setQuality(result.quality_preset || 'draft')
			setAspectRatio(result.aspect_ratio || generation.aspectRatio || null)
			setUsage(result.usage?.recorded ? result.usage : null)
			void cachedImageCapabilities(result.model_name).then((value) => setAspectRatios(value.aspect_ratios)).catch(() => {})
		}).catch(() => { setQuality('draft'); setUsage(null) })
	}, [generation.id, generation.aspectRatio])
	const revise = async () => { if (finalized || !feedback.trim() || busy) return; setBusy(true); try { await api.feedback(generation.id, feedback, 'draft', aspectRatio ?? undefined, useCharacterCard); setFeedback(''); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) } }
	const resolve = async (id: string, action: 'accept' | 'reject') => { try { await api.resolveMemoryCandidate(id, action); setCandidates((items) => items.filter((item) => item.id !== id)); onRefresh() } catch (err) { onError(errorMessage(err)) } }
	const refine = async (target: 'standard' | 'high') => { if (finalized || busy) return; setBusy(true); try { await api.refineGeneration(generation.id, target); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) } }
	const finalize = async () => { if (!session || busy) return; setBusy(true); try { await api.finalizeSession(session.id, generation.id); setFinalizeOpen(false); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) } }
	const finalPrompt = [...plans].reverse().find((message) => String(asObject(message.content).stage) === '最终绘图提示词')
	return <><Box className="studio-page"><aside className="studio-sidebar"><Typography variant="overline" color="primary">角色设定</Typography><Typography variant="h6">角色参考</Typography>{cardAsset && <PreviewImage className="identity-card" assetID={cardAsset} alt="角色参考卡" />}<Typography variant="body2" color="text.secondary">人物特征会随每一次创作自然延续。</Typography>{!finalized && candidates.length > 0 && <><Divider sx={{ my: 2 }} /><Typography variant="subtitle2">新的角色偏好</Typography>{candidates.map((candidate) => <Paper key={candidate.id} className="memory-candidate" variant="outlined"><Typography variant="body2">{candidate.constraint_text}</Typography><Stack direction="row" spacing={1} sx={{ mt: 1 }}><Button size="small" variant="contained" onClick={() => void resolve(candidate.id, 'accept')}>记住</Button><Button size="small" onClick={() => void resolve(candidate.id, 'reject')}>这次不用</Button></Stack></Paper>)}</>}</aside><main className="canvas-stage"><Stack className="canvas-toolbar" direction="row" justifyContent="space-between" alignItems="center"><Box><Typography variant="overline" color="primary">{finalized ? '已保留作品' : '正在创作'}</Typography><Typography variant="subtitle2">{finalized ? '已收入作品库，不再编辑' : `${quality === 'draft' ? '初稿' : quality === 'standard' ? '标准版' : '高品质版'} · 第 ${messages.filter((message) => message.kind === 'generation').length} 版`}</Typography>{usage ? <Button size="small" sx={{ px: 0, minWidth: 0 }} onClick={() => setCostOpen(true)}>本次创作费用 ${usage.total_cost.toFixed(4)} · 查看</Button> : <Typography variant="caption" color="text.secondary">费用信息暂不可用</Typography>}</Box>{generation.assetID && <Button component="a" href={assetDownloadURL(generation.assetID)} startIcon={<Download />} variant="outlined">下载</Button>}</Stack>{generation.assetID ? <PreviewImage className="studio-image" assetID={generation.assetID} alt="当前创作画面" /> : <CircularProgress sx={{ m: 8 }} />}{!finalized && <Paper className="quality-upgrade" variant="outlined"><Box><Typography fontWeight={700}>继续创作下一版</Typography><Typography variant="body2" color="text.secondary">选择画质会以当前画面为基础生成新版本；保留当前版本会结束本次创作。</Typography></Box><Stack className="quality-actions" direction="row" useFlexGap flexWrap="wrap" spacing={1}><Button disabled={busy} onClick={() => void refine('standard')}>{busy ? '正在创建…' : '标准画质'}</Button><Button disabled={busy} variant="contained" onClick={() => void refine('high')}>{busy ? '正在创建…' : '高品质'}</Button><Button disabled={busy} variant="outlined" onClick={() => setFinalizeOpen(true)}>保留当前版本</Button></Stack></Paper>}{finalPrompt && <Paper className="prompt-summary" variant="outlined"><Button size="small" sx={{ px: 0, minWidth: 0 }} onClick={() => setPromptOpen((open) => !open)}>{promptOpen ? '收起完整提示词' : '查看完整提示词'}</Button>{promptOpen && <Typography variant="body2" whiteSpace="pre-wrap" sx={{ mt: 1 }}>{String(asObject(finalPrompt.content).text || '')}</Typography>}</Paper>}</main><aside className="iteration-panel">{finalized ? <><Typography variant="overline" color="primary">创作完成</Typography><Typography variant="h6">这张作品已保留</Typography><Typography variant="body2" color="text.secondary">它已经收入作品库。为了让这一刻保持不变，这次创作不再继续修改。</Typography></> : <><Typography variant="overline" color="primary">继续调整</Typography><Typography variant="h6">想让哪里不一样？</Typography><Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>告诉我们想改变的部分，其余画面会尽量保持原样。</Typography><Typography variant="subtitle2" sx={{ mb: .75 }}>下一版画幅</Typography><Stack direction="row" useFlexGap flexWrap="wrap" spacing={.5} sx={{ mb: 2 }}>{aspectRatios.map((ratio) => <Button key={ratio} size="small" variant={aspectRatio === ratio ? 'contained' : 'outlined'} disabled={busy} onClick={() => setAspectRatio(ratio)}>{ratio}</Button>)}</Stack><Stack direction="row" alignItems="center" spacing={.5} sx={{ mb: 1 }}><Checkbox size="small" checked={useCharacterCard} disabled={busy} onChange={(event) => setUseCharacterCard(event.target.checked)} /><Typography variant="body2">使用角色卡</Typography></Stack><Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>{useCharacterCard ? '会同时发送当前画面和角色卡。' : '只会发送当前待修改图片。'}</Typography><Stack direction="row" useFlexGap flexWrap="wrap" spacing={.5} sx={{ mb: 1 }}><Button size="small" onClick={() => setFeedback('表情改为自然、中性，不要微笑')}>表情</Button><Button size="small" onClick={() => setFeedback('镜头再低一些，增强透视感')}>镜头</Button><Button size="small" onClick={() => setFeedback('保持构图，只调整人物动作')}>动作</Button></Stack><TextField value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="例如：改为横屏壁纸，镜头更开阔" multiline minRows={5} fullWidth /><Button fullWidth sx={{ mt: 1.5 }} variant="contained" disabled={!feedback.trim() || busy} onClick={() => void revise()}>{busy ? '正在调整画面…' : '生成调整'}</Button></>}<Divider sx={{ my: 3 }} /><Typography variant="subtitle2">创作历程</Typography><Typography variant="body2" color="text.secondary">这次创作已有 {messages.filter((message) => message.kind === 'generation').length} 张画面。</Typography></aside></Box><Dialog open={finalizeOpen} onClose={() => !busy && setFinalizeOpen(false)}><DialogTitle>保留这张作品？</DialogTitle><DialogContent><DialogContentText>它会自动收入作品库。这次创作也会到此结束，之后不能再生成新版本或调整这张图片。</DialogContentText></DialogContent><DialogActions><Button disabled={busy} onClick={() => setFinalizeOpen(false)}>再看看</Button><Button disabled={busy} variant="contained" onClick={() => void finalize()}>{busy ? '正在保留…' : '保留作品'}</Button></DialogActions></Dialog><CostBreakdownDialog usage={usage} open={costOpen} onClose={() => setCostOpen(false)} /></>
}

function MessageBubble({ message, sessionID, onRefresh, onError }: { message: Message; sessionID: string; onRefresh: () => void; onError: (message: string) => void }) {
  const content = asObject(message.content)
  const mine = message.role === 'user'
	const [usage, setUsage] = useState<{ recorded: boolean; cost: number } | null>(null)
	const [saved, setSaved] = useState(false)
	const [saving, setSaving] = useState(false)
	const [retrying, setRetrying] = useState(false)
	const [previewOpen, setPreviewOpen] = useState(false)
	const [prompt, setPrompt] = useState('')
	const [selectedQuestionOption, setSelectedQuestionOption] = useState('')
	const [submittingQuestion, setSubmittingQuestion] = useState(false)
	const messageGenerationID = String(content.generation_id || message.generation_id || '')
	const messageGenerationStatus = String(content.status || 'queued')
	const chooseQuestionOption = async (value: string) => {
		if (submittingQuestion) return
		setSelectedQuestionOption(value)
		setSubmittingQuestion(true)
		try { await api.sendMessage(sessionID, value); onRefresh() } catch (err) { setSelectedQuestionOption(''); onError(errorMessage(err)) } finally { setSubmittingQuestion(false) }
	}
	useEffect(() => {
		if (message.kind !== 'generation' || !messageGenerationID) return
		let cancelled = false
		let retryTimer: number | undefined
		const load = async (attempt = 0) => {
			try {
				const result = await api.getGeneration(messageGenerationID)
				if (cancelled) return
				setUsage(result.usage ? { recorded: result.usage.recorded, cost: result.usage.cost } : null)
				setPrompt(result.prompt || '')
				if (!result.usage?.recorded && attempt < 5) retryTimer = window.setTimeout(() => void load(attempt + 1), 800)
			} catch {
				if (cancelled) return
				if (attempt < 2) retryTimer = window.setTimeout(() => void load(attempt + 1), 800)
				else setUsage(null)
			}
		}
		void load()
		return () => { cancelled = true; if (retryTimer) window.clearTimeout(retryTimer) }
	}, [message.kind, messageGenerationID, messageGenerationStatus])
  if (message.kind === 'reference') {
    const assetID = String(content.asset_id || message.asset_id || '')
		const purpose = String(content.purpose || 'other')
		const characterCard = purpose === 'character_identity'
    return <Box className={`bubble-line ${mine ? 'mine' : ''}`}><Paper className="bubble reference-bubble"><PreviewImage assetID={assetID} alt={characterCard ? '角色卡参考图' : '参考图'} /><Box><Typography fontWeight={700}>{characterCard ? '角色卡' : '参考图'}</Typography><Typography variant="caption" color="text.secondary">用途：{characterCard ? '角色身份' : purpose === 'character_source' ? '角色参考' : purpose === 'other' ? '其他' : purpose}</Typography></Box></Paper></Box>
  }
  if (message.kind === 'generation') {
    const assetID = String(content.asset_id || message.asset_id || '')
    const status = messageGenerationStatus
    const generationID = messageGenerationID
		const save = async () => { if (saving || saved) return; setSaving(true); try { await api.saveToGallery(generationID); setSaved(true) } catch (err) { onError(errorMessage(err)) } finally { setSaving(false) } }
		const retry = async () => { if (retrying) return; setRetrying(true); try { await api.retryGeneration(generationID); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setRetrying(false) } }
		return <><Box className="bubble-line"><Paper className="bubble generation-bubble"><Stack spacing={1}><Stack direction="row" spacing={1} alignItems="center" aria-live="polite">{status !== 'succeeded' && status !== 'failed' && <CircularProgress size={18} />}<Typography fontWeight={700}>{status === 'succeeded' ? '画面准备好了' : status === 'failed' ? '这次没能完成' : status === 'running' ? '正在描绘画面…' : '正在准备画面…'}</Typography></Stack>{assetID && <Box className="generation-media"><img className="previewable-image" src={assetURL(assetID)} alt="生成的画面，按 Enter 查看大图和画面说明" role="button" tabIndex={0} onClick={() => setPreviewOpen(true)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPreviewOpen(true) } }} />{status === 'succeeded' && <Tooltip title={saved ? '已加入作品库' : saving ? '正在加入作品库…' : '加入作品库'}><span><IconButton aria-label={saved ? '已加入作品库' : '加入作品库'} className="gallery-star" color={saved ? 'primary' : 'default'} disabled={saved || saving} onClick={() => void save()}>{saving ? <CircularProgress size={18} /> : saved ? <Bookmark /> : <BookmarkBorder />}</IconButton></span></Tooltip>}</Box>}{status === 'succeeded' && <Typography variant="caption" color="text.secondary">点击画面查看大图和画面说明。{usage?.recorded ? ` 本次创作费用：$${usage.cost.toFixed(4)}` : ' 费用信息暂不可用'}</Typography>}{status === 'failed' && <Button size="small" startIcon={retrying ? <CircularProgress size={16} /> : <Refresh />} disabled={retrying} onClick={() => void retry()}>{retrying ? '正在重试…' : '再试一次'}</Button>}</Stack></Paper></Box>{assetID && <ImageLightbox open={previewOpen} onClose={() => setPreviewOpen(false)} src={assetURL(assetID)} alt="生成的画面" downloadURL={assetDownloadURL(assetID)} title="画面说明" description={prompt || '正在读取画面说明…'} />}</>
  }
  if (message.kind === 'question') {
    const options = Array.isArray(content.options) ? content.options.map((option) => typeof option === 'object' && option ? option as { id?: string; label?: string; description?: string } : { id: String(option), label: String(option) }) : []
    return <Box className="bubble-line"><Paper className="bubble"><Typography>{String(content.text || '')}</Typography><Stack spacing={1} sx={{ mt: 1 }}>{options.map((option, index) => { const value = option.label || ''; const chosen = selectedQuestionOption === value; return <Button key={option.id || index} className={chosen ? 'choice-selected' : ''} variant={chosen ? 'contained' : 'outlined'} disabled={submittingQuestion} onClick={() => void chooseQuestionOption(value)}>{option.label}{option.description ? ` · ${option.description}` : ''}</Button> })}</Stack>{submittingQuestion && <ThinkingNotice choice={selectedQuestionOption} />}</Paper></Box>
  }
	if (message.kind === 'plan') {
		const stage = String(content.stage || '创作简报')
		return <Box className="bubble-line"><Paper className="bubble" variant="outlined"><Typography variant="subtitle2" color="primary">{typeof content.stage === 'number' ? `场景构思 · 第 ${stage} 轮` : stage}</Typography><Typography whiteSpace="pre-wrap" sx={{ mt: .5 }}>{String(content.text || '')}</Typography></Paper></Box>
	}
  return <Box className={`bubble-line ${mine ? 'mine' : ''}`}><Paper className="bubble"><Typography whiteSpace="pre-wrap">{asText(message.content)}</Typography></Paper></Box>
}

function SessionStartDialog({ open, onClose, onSelect, busy, onError }: { open: boolean; onClose: () => void; onSelect: (characterID: string, characterCardID: string) => void; busy: boolean; onError: (message: string) => void }) {
	const mobile = useMediaQuery(useTheme().breakpoints.down('md'))
	const [characters, setCharacters] = useState<Character[]>([])
	const [browsedCharacterID, setBrowsedCharacterID] = useState('')
	const [selectedCharacterID, setSelectedCharacterID] = useState('')
	const [selectedCardID, setSelectedCardID] = useState('')
	const [cardsByCharacter, setCardsByCharacter] = useState<Record<string, CharacterCard[]>>({})
	const [loadingCards, setLoadingCards] = useState(false)
	const [previewCard, setPreviewCard] = useState<{ assetID: string; label: string } | null>(null)
	useEffect(() => {
		if (!open) return
		let cancelled = false
		setBrowsedCharacterID('')
		setSelectedCharacterID('')
		setSelectedCardID('')
		setPreviewCard(null)
		setCharacters([])
		setCardsByCharacter({})
		setLoadingCards(true)
		void (async () => {
			try {
				const result = await api.listCharacters()
				const entries = await Promise.all(result.data.map(async (character) => [character.id, (await api.listCards(character.id)).data] as const))
				if (cancelled) return
				const nextCardsByCharacter = Object.fromEntries(entries)
				const initialCharacter = result.data.find((character) => readyCardsFirst(nextCardsByCharacter[character.id] || []).length > 0) || result.data[0]
				const initialCard = initialCharacter ? readyCardsFirst(nextCardsByCharacter[initialCharacter.id] || [])[0] : undefined
				setCharacters(result.data)
				setCardsByCharacter(nextCardsByCharacter)
				setBrowsedCharacterID(initialCharacter?.id || '')
				setSelectedCharacterID(initialCard ? initialCharacter.id : '')
				setSelectedCardID(initialCard?.id || '')
			} catch (err) {
				if (!cancelled) onError(errorMessage(err))
			} finally {
				if (!cancelled) setLoadingCards(false)
			}
		})()
		return () => { cancelled = true }
	}, [open, onError])
	const selectedCharacter = characters.find((character) => character.id === selectedCharacterID)
	const selectedCard = selectedCharacterID ? cardsByCharacter[selectedCharacterID]?.find((card) => card.id === selectedCardID) : undefined
	const browseCharacter = (characterID: string) => setBrowsedCharacterID(characterID)
	const chooseCard = (characterID: string, cardID: string) => { setBrowsedCharacterID(characterID); setSelectedCharacterID(characterID); setSelectedCardID(cardID) }
	const canCreate = Boolean(selectedCharacterID && selectedCardID && selectedCard?.output_asset_id)
	const close = () => { if (previewCard) setPreviewCard(null); else onClose() }
	if (previewCard) return <ImageLightbox open={open} onClose={() => setPreviewCard(null)} src={assetURL(previewCard.assetID)} alt={previewCard.label} downloadURL={assetDownloadURL(previewCard.assetID)} title={previewCard.label} />
	return <Dialog open={open} onClose={() => !busy && close()} fullScreen={mobile} fullWidth maxWidth="md" aria-labelledby="new-conversation-title"><DialogTitle id="new-conversation-title">新建对话</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}><Typography variant="body2" color="text.secondary">选择这次对话要使用的角色卡；可先预览，再选择并创建对话。</Typography>{loadingCards ? <Stack alignItems="center" spacing={1.5} sx={{ py: 5 }}><CircularProgress /><Typography variant="body2" color="text.secondary">正在载入角色卡…</Typography></Stack> : <>{characters.length === 0 ? <Typography color="text.secondary">还没有角色卡，请先在左上角角色卡库创建或导入。</Typography> : <><Stack className="session-character-tabs" direction="row" spacing={1} aria-label="选择角色" useFlexGap>{characters.map((character) => <Button key={character.id} size="small" variant={character.id === browsedCharacterID ? 'contained' : 'outlined'} aria-pressed={character.id === browsedCharacterID} disabled={busy} onClick={() => browseCharacter(character.id)}>{character.name}</Button>)}</Stack><Box className="session-character-groups">{characters.map((character) => { const readyCards = readyCardsFirst(cardsByCharacter[character.id] || []); return <Box key={character.id} className={`session-character-group ${character.id === browsedCharacterID ? 'is-mobile-active' : ''}`}><Stack direction="row" alignItems="baseline" spacing={1}><Typography variant="subtitle1" fontWeight={700}>{character.name}</Typography><Typography variant="caption" color="text.secondary">{readyCards.length ? `${readyCards.length} 张可用角色卡` : '暂无可用角色卡'}</Typography></Stack>{readyCards.length ? <Box className="session-card-grid">{readyCards.map((card, index) => { const selected = card.id === selectedCardID && character.id === selectedCharacterID; const label = cardLabel(card, index); const previewLabel = `${character.name} · ${label}`; return <Paper key={card.id} className={`session-card-option ${selected ? 'is-selected' : ''}`} variant="outlined"><Button className="session-card-preview" aria-label={`预览 ${previewLabel}`} disabled={busy} onClick={() => setPreviewCard({ assetID: card.output_asset_id!, label: previewLabel })}><img src={assetURL(card.output_asset_id!)} alt="" /></Button><Button className="session-card-select" disabled={busy} aria-pressed={selected} onClick={() => chooseCard(character.id, card.id)}>{label}</Button></Paper> })}</Box> : <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>这个角色尚未有已就绪的卡片。</Typography>}</Box> })}</Box></>}{canCreate && <Paper className="session-selection-summary" variant="outlined"><Typography variant="caption" color="text.secondary">即将创建的对话</Typography><Stack direction="row" spacing={1.25} alignItems="center" sx={{ mt: .5 }}>{selectedCard?.output_asset_id && <PreviewImage assetID={selectedCard.output_asset_id} alt="已选角色卡" interactive={false} />}<Typography fontWeight={700}>{selectedCharacter?.name} · {selectedCard && cardLabel(selectedCard)}</Typography></Stack></Paper>}</>}</Stack></DialogContent><DialogActions><Button disabled={busy} onClick={close}>取消</Button><Button variant="contained" disabled={!canCreate || busy || loadingCards} onClick={() => { if (canCreate) onSelect(selectedCharacterID, selectedCardID) }}>{busy ? '正在创建对话…' : '创建对话'}</Button></DialogActions></Dialog>
}

function CharacterCardVersion({ card, busy, onIterate, onDelete, onSetDefault, onRetry, onRename, onError }: { card: CharacterCard; busy: boolean; onIterate: (card: CharacterCard, assetID: string) => Promise<void>; onDelete: (card: CharacterCard) => void; onSetDefault: (card: CharacterCard) => Promise<void>; onRetry: (card: CharacterCard) => Promise<void>; onRename: (card: CharacterCard, name: string) => Promise<void>; onError: (message: string) => void }) {
	const [deriveOpen, setDeriveOpen] = useState(false)
	const [renameOpen, setRenameOpen] = useState(false)
	const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
	const status = card.status === 'ready' ? card.metadata_status === 'pending' ? '已就绪 · 正在分析' : card.metadata_status === 'failed' ? '已就绪 · 分析失败' : '已就绪 · 已分析' : card.status === 'failed' ? '生成失败' : '生成中'
	const hasMenuActions = card.status === 'ready' && Boolean(card.output_asset_id || !card.is_default)
	return <><Paper className={`character-version-card ${card.is_default ? 'is-default' : ''}`} variant="outlined">{card.output_asset_id ? <PreviewImage assetID={card.output_asset_id} alt={cardLabel(card)} /> : <Box className="character-card-placeholder">{card.status === 'failed' ? <Typography variant="caption" color="error">生成失败</Typography> : <CircularProgress size={22} />}</Box>}<Box sx={{ p: 1.5 }}><Stack direction="row" justifyContent="space-between" spacing={1} alignItems="center"><Box sx={{ minWidth: 0 }}><Typography variant="subtitle2" noWrap>{cardLabel(card)}</Typography><Typography variant="caption" color="text.secondary">{status}{card.is_default ? ' · 默认角色卡' : ''}</Typography></Box><Stack direction="row" spacing={.25}><Tooltip title="重命名角色卡"><span><IconButton aria-label="重命名角色卡" size="small" disabled={busy} onClick={() => setRenameOpen(true)}><EditOutlined fontSize="small" /></IconButton></span></Tooltip>{hasMenuActions && <Tooltip title="更多角色卡操作"><span><IconButton aria-label="更多角色卡操作" size="small" disabled={busy} onClick={(event) => setMenuAnchor(event.currentTarget)}><MoreVert fontSize="small" /></IconButton></span></Tooltip>}</Stack></Stack>{card.status === 'failed' && <Button fullWidth sx={{ mt: 1.25 }} variant="outlined" disabled={busy} onClick={() => void onRetry(card)}>重试生成</Button>}{card.status === 'ready' && card.output_asset_id && <Button fullWidth sx={{ mt: 1.25 }} variant="outlined" disabled={busy} onClick={() => setDeriveOpen(true)}>{busy ? '正在创建新版本…' : '派生新版本…'}</Button>}</Box></Paper><Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>{card.status === 'ready' && card.output_asset_id && <MenuItem component="a" href={assetDownloadURL(card.output_asset_id)} onClick={() => setMenuAnchor(null)}>导出角色卡</MenuItem>}{!card.is_default && <MenuItem onClick={() => { setMenuAnchor(null); void onSetDefault(card) }}>设为默认角色卡</MenuItem>}{!card.is_default && <MenuItem sx={{ color: 'error.main' }} onClick={() => { setMenuAnchor(null); onDelete(card) }}>删除此版本</MenuItem>}</Menu><DeriveCardDialog card={card} open={deriveOpen} busy={busy} onClose={() => setDeriveOpen(false)} onError={onError} onCreate={async (assetID) => { await onIterate(card, assetID); setDeriveOpen(false) }} /><CardRenameDialog card={card} open={renameOpen} busy={busy} onClose={() => setRenameOpen(false)} onSave={onRename} /></>
}

function CardRenameDialog({ card, open, busy, onClose, onSave }: { card: CharacterCard; open: boolean; busy: boolean; onClose: () => void; onSave: (card: CharacterCard, name: string) => Promise<void> }) {
	const [name, setName] = useState('')
	useEffect(() => { if (open) setName(card.name || cardLabel(card)) }, [open, card])
	const save = async () => { if (!name.trim() || busy) return; await onSave(card, name.trim()); onClose() }
	return <Dialog open={open} onClose={() => !busy && onClose()} fullWidth maxWidth="xs"><DialogTitle>重命名角色卡</DialogTitle><DialogContent><TextField autoFocus fullWidth label="角色卡名称" value={name} disabled={busy} inputProps={{ maxLength: 100 }} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void save() } }} sx={{ mt: 1 }} /></DialogContent><DialogActions><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="contained" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? '正在保存…' : '保存名称'}</Button></DialogActions></Dialog>
}

function DeriveCardDialog({ card, open, busy, onClose, onCreate, onError }: { card: CharacterCard | null; open: boolean; busy: boolean; onClose: () => void; onCreate: (assetID: string) => Promise<void>; onError: (message: string) => void }) {
	const [draft, setDraft] = useState('')
	const [currentAsset, setCurrentAsset] = useState('')
	const [previewing, setPreviewing] = useState(false)
	const originalAsset = card?.output_asset_id || ''
	useEffect(() => { if (open) { setDraft(''); setCurrentAsset(card?.output_asset_id || '') } }, [open, card?.id])
	const generate = async () => { if (!card?.character_id || !originalAsset || !draft.trim() || previewing || busy) return; const requirement = draft.trim(); setPreviewing(true); try { const result = await api.previewCard(card.character_id, currentAsset || originalAsset, originalAsset, requirement); setCurrentAsset(result.asset_id); setDraft('') } catch (err) { onError(errorMessage(err)) } finally { setPreviewing(false) } }
	const save = async () => { if (!currentAsset || currentAsset === card?.output_asset_id) return; await onCreate(currentAsset) }
	const hasPreview = Boolean(currentAsset && currentAsset !== originalAsset)
	return <Dialog open={open} onClose={() => !busy && !previewing && onClose()} fullWidth maxWidth="md"><DialogTitle>派生新的角色卡</DialogTitle><DialogContent><Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ pt: 1 }}><Box sx={{ width: { sm: 210 }, flexShrink: 0 }}>{card?.output_asset_id && <PreviewImage assetID={card.output_asset_id} alt="原始角色卡参考图" />}<Typography variant="caption" color="text.secondary">原始角色卡固定作为身份参考，每次生成都会带入。</Typography></Box><Stack spacing={1.25} sx={{ flex: 1, minWidth: 0 }}><Paper variant="outlined" sx={{ p: 1.25 }}><Typography variant="body2">首次生成会使用原始角色卡和本次提示词。若结果不满意，输入新的提示词后会使用当前候选卡与原始角色卡再次生成。</Typography></Paper>{hasPreview && <Box><Typography variant="subtitle2" sx={{ mb: .75 }}>当前候选角色卡</Typography><PreviewImage assetID={currentAsset} alt="当前候选角色卡" /><Typography variant="caption" color="text.secondary">满意后即可保存为新的角色卡版本。</Typography></Box>}{!hasPreview && <Typography variant="body2" color="text.secondary">例如：保留脸部和高马尾，换成日系通勤装，移除耳机。</Typography>}<TextField autoFocus label={hasPreview ? '不满意？描述下一次要调整的内容' : '描述要如何派生角色卡'} value={draft} disabled={busy || previewing} multiline minRows={3} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void generate() } }} /><Button sx={{ alignSelf: 'flex-start' }} variant="outlined" disabled={busy || previewing || !draft.trim()} onClick={() => void generate()}>{previewing ? '正在生成候选卡…' : hasPreview ? '按此提示词重新生成' : '生成候选角色卡'}</Button></Stack></Stack></DialogContent><DialogActions><Button disabled={busy || previewing} onClick={onClose}>取消</Button>{hasPreview && <Button variant="contained" disabled={busy || previewing} onClick={() => void save()}>{busy ? '正在保存…' : '满意，保存为新角色卡'}</Button>}</DialogActions></Dialog>
}

function CharacterLibraryPage({ onBack, onRefresh, onError }: { onBack: () => void; onRefresh: () => void; onError: (message: string) => void }) {
	const [selectedID, setSelectedID] = useState('')
	const [name, setName] = useState('')
	const [files, setFiles] = useState<File[]>([])
	const [createMode, setCreateMode] = useState<'import' | 'generate'>('import')
	const [cardAspectRatio, setCardAspectRatio] = useState('3:2')
	const [createOpen, setCreateOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [deleteTarget, setDeleteTarget] = useState<CharacterCard | null>(null)
	const [deleting, setDeleting] = useState(false)
	const importInput = useRef<HTMLInputElement>(null)
	const queryClient = useQueryClient()
	const charactersQuery = useQuery({ queryKey: ['characters'], queryFn: api.listCharacters })
	const characters = charactersQuery.data?.data ?? []
	const cardsQuery = useQuery({ queryKey: ['characters', selectedID, 'cards'], queryFn: () => api.listCards(selectedID), enabled: Boolean(selectedID) })
	const cards = cardsQuery.data?.data ?? []
	const loadCharacters = async () => { await queryClient.invalidateQueries({ queryKey: ['characters'] }) }
	useEffect(() => { if (!selectedID && characters[0]) setSelectedID(characters[0].id) }, [characters, selectedID])
	useEffect(() => { if (charactersQuery.isError) onError(errorMessage(charactersQuery.error)) }, [charactersQuery.error, charactersQuery.isError, onError])
	useEffect(() => { if (cardsQuery.isError) onError(errorMessage(cardsQuery.error)) }, [cardsQuery.error, cardsQuery.isError, onError])
	useEffect(() => {
		if (!selectedID || !cards.some((card) => card.status === 'queued' || card.status === 'running' || card.metadata_status === 'pending')) return
		const timer = window.setInterval(() => {
			void queryClient.invalidateQueries({ queryKey: ['characters', selectedID, 'cards'] })
		}, 2000)
		return () => window.clearInterval(timer)
	}, [selectedID, cards, queryClient])
	const create = async () => { if (!name.trim() || !files.length || busy) return; setBusy(true); try { const assets = await Promise.all(files.map(api.upload)); const character = await api.createCharacter(name.trim()); if (createMode === 'import') { const cardName = files[0].name.replace(/\.[^.]+$/, '').trim(); await api.importCard(character.id, assets[0].id, cardName || undefined) } else await api.createCard(character.id, assets.map((asset) => asset.id), '', cardAspectRatio); setName(''); setFiles([]); setCardAspectRatio('3:2'); setCreateOpen(false); await loadCharacters(); setSelectedID(character.id); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) } }
	const refreshCards = async () => { if (selectedID) await queryClient.invalidateQueries({ queryKey: ['characters', selectedID, 'cards'] }) }
	const iterate = async (_card: CharacterCard, assetID: string) => { if (!selectedID || !assetID || busy) return; setBusy(true); try { await api.importCard(selectedID, assetID); await refreshCards(); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) } }
	const importCard = async (file?: File) => { if (!selectedID || !file || busy) return; if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { onError('请选择 PNG、JPEG 或 WebP 图片'); return } setBusy(true); try { const asset = await api.upload(file); const name = file.name.replace(/\.[^.]+$/, '').trim(); await api.importCard(selectedID, asset.id, name || undefined); await refreshCards(); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setBusy(false); if (importInput.current) importInput.current.value = '' } }
	const setDefaultCard = async (card: CharacterCard) => { if (!selectedID || busy || card.is_default) return; setBusy(true); try { await api.setDefaultCard(selectedID, card.id); await Promise.all([refreshCards(), loadCharacters()]); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) } }
	const renameCard = async (card: CharacterCard, cardName: string) => { if (!selectedID || busy) return; setBusy(true); try { await api.renameCard(selectedID, card.id, cardName); await refreshCards() } catch (err) { onError(errorMessage(err)); throw err } finally { setBusy(false) } }
	const retryCard = async (card: CharacterCard) => { if (!selectedID || busy) return; setBusy(true); try { await api.retryCard(selectedID, card.id); await refreshCards() } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) } }
	const removeCard = async () => { if (!selectedID || !deleteTarget || deleting) return; setDeleting(true); try { await api.deleteCard(selectedID, deleteTarget.id); await refreshCards(); setDeleteTarget(null); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setDeleting(false) } }
	const selected = characters.find((character) => character.id === selectedID)
	return <>
		<Box className="character-library-page">
			<Stack className="gallery-page-header character-library-header" direction="row" alignItems="center" justifyContent="space-between" spacing={1.5}>
				<Stack direction="row" alignItems="center" spacing={1.5}>
					<IconButton aria-label="返回创作列表" onClick={onBack}><ArrowBack /></IconButton>
					<Box><Typography variant="overline" color="primary">角色设定</Typography><Typography variant="h4">角色卡库</Typography><Typography variant="body2" color="text.secondary">管理角色与可复用的角色卡版本。</Typography></Box>
				</Stack>
				<Button variant="contained" startIcon={<Add />} onClick={() => setCreateOpen(true)}>新建角色</Button>
			</Stack>
			<Box className="character-library-content">
				<Stack className="character-library-layout" direction="row" spacing={2}>
					<Paper className="character-list-panel" variant="outlined"><Typography variant="subtitle2">角色</Typography><Stack spacing={.5} sx={{ mt: 1 }}>{characters.length ? characters.map((character) => <Button key={character.id} className="character-row" variant={selectedID === character.id ? 'contained' : 'text'} onClick={() => setSelectedID(character.id)}>{character.default_card_asset_id && <PreviewImage assetID={character.default_card_asset_id} alt={`${character.name} 默认角色卡`} interactive={false} />}{character.name}</Button>) : <Typography variant="body2" color="text.secondary">尚未创建角色。</Typography>}</Stack></Paper>
					<Box className="character-cards-panel"><Stack direction="row" justifyContent="space-between" alignItems="center"><Box><Typography variant="subtitle1" fontWeight={700}>{selected?.name || '选择角色'}</Typography><Typography variant="caption" color="text.secondary">角色卡是独立版本；可导入图片、导出、重命名、设为默认或派生新版本。</Typography></Box><Stack direction="row" spacing={1}><Button size="small" component="label" startIcon={<ImageOutlined />} disabled={!selectedID || busy}>导入角色卡<input ref={importInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void importCard(event.target.files?.[0])} /></Button><Button size="small" disabled={!selectedID} onClick={() => void refreshCards()}>刷新</Button></Stack></Stack><Box className="character-version-grid">{cards.map((card) => <CharacterCardVersion key={card.id} card={card} busy={busy || deleting} onIterate={iterate} onDelete={setDeleteTarget} onSetDefault={setDefaultCard} onRetry={retryCard} onRename={renameCard} onError={onError} />)}</Box></Box>
				</Stack>
			</Box>
		</Box>
		<CharacterCreateDialog open={createOpen} busy={busy} name={name} files={files} mode={createMode} aspectRatio={cardAspectRatio} onClose={() => !busy && setCreateOpen(false)} onNameChange={setName} onFilesChange={setFiles} onModeChange={setCreateMode} onAspectRatioChange={setCardAspectRatio} onCreate={create} />
		<Dialog open={Boolean(deleteTarget)} onClose={() => !deleting && setDeleteTarget(null)}><DialogTitle>删除这个角色卡版本？</DialogTitle><DialogContent><DialogContentText>只会删除此版本，不会删除角色或其他版本。正在被对话使用的版本不能删除。</DialogContentText></DialogContent><DialogActions><Button disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</Button><Button color="error" disabled={deleting} onClick={() => void removeCard()}>{deleting ? '正在删除…' : '删除'}</Button></DialogActions></Dialog>
	</>
}

function CharacterCreateDialog({ open, busy, name, files, mode, aspectRatio, onClose, onNameChange, onFilesChange, onModeChange, onAspectRatioChange, onCreate }: { open: boolean; busy: boolean; name: string; files: File[]; mode: 'import' | 'generate'; aspectRatio: string; onClose: () => void; onNameChange: (value: string) => void; onFilesChange: (files: File[]) => void; onModeChange: (mode: 'import' | 'generate') => void; onAspectRatioChange: (value: string) => void; onCreate: () => Promise<void> }) {
	const importing = mode === 'import'
	const chooseMode = (next: 'import' | 'generate') => { onModeChange(next); onFilesChange([]) }
	return <Dialog open={open} onClose={() => !busy && onClose()} fullWidth maxWidth="sm" aria-labelledby="new-character-title"><DialogTitle id="new-character-title">新建角色</DialogTitle><DialogContent><Stack spacing={2.25} sx={{ pt: 1 }}><Typography variant="body2" color="text.secondary">选择已有角色卡直接使用，或上传参考图生成一张新的角色卡。</Typography><TextField autoFocus fullWidth label="角色名称" placeholder="例如：林夏" value={name} disabled={busy} inputProps={{ maxLength: 100 }} onChange={(event) => onNameChange(event.target.value)} /><Stack direction="row" spacing={1}><Button variant={importing ? 'contained' : 'outlined'} disabled={busy} onClick={() => chooseMode('import')}>导入已有角色卡</Button><Button variant={!importing ? 'contained' : 'outlined'} disabled={busy} onClick={() => chooseMode('generate')}>从参考图生成</Button></Stack><Box><Typography variant="subtitle2" sx={{ mb: 1 }}>{importing ? '角色卡图片' : '参考图（1–8 张）'}</Typography><Button key={mode} className="character-reference-upload" component="label" variant="outlined" disabled={busy} startIcon={<ImageOutlined />}>{files.length ? '更换图片' : importing ? '选择角色卡' : '选择参考图'}<input hidden type="file" multiple={!importing} accept="image/png,image/jpeg,image/webp" onChange={(event) => onFilesChange(Array.from(event.target.files || []).slice(0, importing ? 1 : 8))} /></Button>{files.length > 0 && <Paper className="character-file-summary" variant="outlined"><Typography variant="body2" noWrap>{files.map((file) => file.name).join('、')}</Typography><Typography variant="caption" color="text.secondary">{importing ? '将作为默认角色卡直接导入' : `将使用 ${files.length} 张参考图生成角色卡`}</Typography></Paper>}</Box>{!importing && <Box><Typography variant="subtitle2" sx={{ mb: 1 }}>角色卡画幅</Typography><Stack direction="row" spacing={.75} useFlexGap flexWrap="wrap">{['3:2', '16:9', '1:1', '2:3', '9:16'].map((ratio) => <Button key={ratio} size="small" variant={aspectRatio === ratio ? 'contained' : 'outlined'} disabled={busy} aria-pressed={aspectRatio === ratio} onClick={() => onAspectRatioChange(ratio)}>{ratio}</Button>)}</Stack></Box>}{busy && <ThinkingNotice choice={importing ? '正在导入角色卡' : '正在生成角色卡'} />}</Stack></DialogContent><DialogActions><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="contained" disabled={busy || !name.trim() || !files.length} onClick={() => void onCreate()}>{busy ? '正在创建…' : importing ? '创建角色' : '创建并生成角色卡'}</Button></DialogActions></Dialog>
}

function Composer({ sessionID, feedbackGenerationID, onRefresh, onError }: { sessionID: string; feedbackGenerationID: string | null; onRefresh: () => void; onError: (message: string) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
	const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>('draft')
  const [mode, setMode] = useState<'new' | 'revise'>('new')
	const [useCharacterCard, setUseCharacterCard] = useState(true)
  const [purpose, setPurpose] = useState('other')
  const [galleryOpen, setGalleryOpen] = useState(false)
	const galleryQuery = useQuery({ queryKey: ['gallery', 1], queryFn: () => api.listGallery(), enabled: galleryOpen })
	const gallery = galleryQuery.data?.data ?? []
  const fileInput = useRef<HTMLInputElement>(null)
	useEffect(() => { if (galleryQuery.isError) onError(errorMessage(galleryQuery.error)) }, [galleryQuery.error, galleryQuery.isError, onError])
	const revise = mode === 'revise' && Boolean(feedbackGenerationID)
	const send = async () => { if (!text.trim() || busy) return; const content = text.trim(); setText(''); setBusy(true); try { if (revise && feedbackGenerationID) await api.feedback(feedbackGenerationID, content, quality, undefined, useCharacterCard); else await api.sendMessage(sessionID, content, quality); onRefresh() } catch (err) { setText(content); onError(errorMessage(err)) } finally { setBusy(false) } }
  const upload = async (file?: File) => { if (!file) return; setBusy(true); try { const asset = await api.upload(file); await api.addReference(sessionID, asset.id, purpose); onRefresh() } catch (err) { onError(errorMessage(err)) } finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' } }
	const openGallery = () => setGalleryOpen(true)
	const useGallery = async (assetID?: string) => { if (!assetID) return; try { await api.addReference(sessionID, assetID, purpose); setGalleryOpen(false); onRefresh() } catch (err) { onError(errorMessage(err)) } }
	const qualityLabels: Record<typeof quality, string> = { draft: '快速', standard: '标准', high: '精细' }
	const purposeLabels: Record<string, string> = { other: '其他', pose: '姿势', composition: '构图', style: '风格', scene: '场景', outfit: '服装' }
  return <Box className="composer"><input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void upload(event.target.files?.[0])} />{feedbackGenerationID && <Stack direction="row" alignItems="center" spacing={1} className="feedback-mode"><Button size="small" variant={mode === 'new' ? 'contained' : 'outlined'} onClick={() => setMode('new')}>新建创作</Button><Button size="small" variant={mode === 'revise' ? 'contained' : 'outlined'} onClick={() => setMode('revise')}>修改上一张</Button><Typography variant="caption">{revise ? useCharacterCard ? '将结合角色卡、上一张画面和本次修改意见生成。' : '只会发送上一张待修改图片和本次修改意见。' : '系统会判断是否还需要补充画面信息。'}</Typography></Stack>}{revise && <Stack direction="row" alignItems="center" spacing={.5} sx={{ mb: 1 }}><Checkbox size="small" checked={useCharacterCard} disabled={busy} onChange={(event) => setUseCharacterCard(event.target.checked)} /><Typography variant="caption">使用角色卡</Typography></Stack>}<Stack direction="row" spacing={.5} alignItems="center" sx={{ mb: 1 }}><Typography variant="caption" color="text.secondary">生成质量</Typography>{(['draft', 'standard', 'high'] as const).map((item) => <Button key={item} size="small" variant={quality === item ? 'contained' : 'outlined'} disabled={busy} onClick={() => setQuality(item)}>{qualityLabels[item]}</Button>)}</Stack>{!revise && <Stack direction="row" spacing={.5} alignItems="center" sx={{ mb: 1 }}><Typography variant="caption">参考用途</Typography>{['other','pose','composition','style','scene','outfit'].map((item) => <Button key={item} size="small" variant={purpose === item ? 'contained' : 'outlined'} onClick={() => setPurpose(item)}>{purposeLabels[item]}</Button>)}</Stack>}{busy && <Typography className="request-status" variant="caption">{revise ? '正在提交修改并创建生成任务…' : '正在理解你的需求并准备生成…'}</Typography>}<Stack direction="row" spacing={1} alignItems="flex-end"><IconButton className="reference-upload" color="primary" disabled={busy || revise} onClick={() => fileInput.current?.click()}><ImageOutlined /></IconButton><IconButton color="primary" disabled={busy || revise} onClick={() => void openGallery()}><StarBorder /></IconButton><TextField value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder={revise ? '例如：镜头再低一些，人物不要微笑' : '描述你想创作的画面…'} multiline maxRows={5} fullWidth /><IconButton color="primary" disabled={!text.trim() || busy} onClick={() => void send()}>{busy ? <CircularProgress size={22} /> : <Send />}</IconButton></Stack><Dialog open={galleryOpen} onClose={() => setGalleryOpen(false)} fullWidth maxWidth="sm"><DialogTitle>从作品库添加参考图</DialogTitle><DialogContent><Stack spacing={1}>{gallery.length === 0 && <Typography color="text.secondary">作品库中还没有已保存的画面。</Typography>}{gallery.map((item) => <Button key={item.id} variant="outlined" onClick={() => void useGallery(item.asset_id)} sx={{ justifyContent: 'flex-start' }}>{item.asset_id && <img src={assetURL(item.asset_id)} width="72" height="54" style={{ objectFit: 'cover', marginRight: 12 }} />}{item.title || '未命名作品'} · 用作{purposeLabels[purpose]}</Button>)}</Stack></DialogContent><DialogActions><Button onClick={() => setGalleryOpen(false)}>关闭</Button></DialogActions></Dialog></Box>
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : '发生未知错误' }
