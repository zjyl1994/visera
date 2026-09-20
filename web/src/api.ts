export type Session = {
  id: string
  title: string
	character_id?: string
	character_card_id?: string
  last_message_preview?: string
  last_message_at: number
  has_running_generation: boolean
  status: 'active' | 'finalized' | 'deleted'
}

export type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  kind: 'text' | 'plan' | 'reference' | 'question' | 'generation' | 'feedback' | 'system'
  content: unknown
  asset_id?: string
  generation_id?: string
  created_at: number
}

export type Character = { id: string; name: string; default_card_id?: string; default_card_asset_id?: string }
export type CharacterCard = { id: string; character_id?: string; name?: string; output_asset_id?: string; status: string; is_default: boolean; metadata_status: string; metadata?: Record<string, unknown> }
export type CostLine = { id: string; generation_id?: string; kind: string; model_name?: string; cost: number; created_at: number }
export type GenerationUsage = { recorded: boolean; cost: number; total_cost: number; image_cost: number; image_calls: number; image_calls_detail: CostLine[]; llm_cost: number; llm_calls: number; llm_calls_detail: CostLine[]; current_image_cost: number; current_image_recorded: boolean; prompt_tokens: number; completion_tokens: number; total_tokens: number }
export type Generation = { prompt?: string; model_name?: string; quality_preset?: 'draft' | 'standard' | 'high'; aspect_ratio?: string; usage?: GenerationUsage }
export type ImageCapabilities = { model: string; aspect_ratios: string[]; source: 'model' | 'fallback' }
export type GalleryItem = { id: string; generation_id?: string; title?: string; asset_id?: string; cost_recorded?: boolean; cost?: number; image_cost?: number; llm_cost?: number; image_calls?: number; llm_calls?: number }
export type GalleryPage = { page: number; page_size: number; total: number; total_pages: number }
export type MemoryCandidate = { id: string; category: string; constraint_text: string; priority: 'normal' | 'high' }

type APIError = { error?: { message?: string } }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: requestHeaders, ...requestInit } = init ?? {}
  const response = await fetch(`/api/v1${path}`, {
    ...requestInit,
    cache: 'no-store',
    credentials: 'same-origin',
    // Keep the JSON media type when a caller supplies an additional header
    // (for example Idempotency-Key). Previously that header replaced this
    // whole object, leaving Express with an unparsed empty body.
    headers: { ...(requestInit.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...requestHeaders },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as APIError
    throw new Error(body.error?.message || `请求失败 (${response.status})`)
  }
  // Several mutation endpoints intentionally acknowledge work with 202 and no
  // JSON body. Parsing those responses as JSON turns a successful request into
  // an "Unexpected end of JSON input" client error.
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T
  const body = await response.text()
  if (!body.trim()) return undefined as T
  return JSON.parse(body) as T
}

export const api = {
	login: (username: string, password: string, remember: boolean) => request<{ authenticated: boolean }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, remember }) }),
	authStatus: () => request<{ authenticated: boolean }>('/auth/session'),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  listSessions: () => request<{ data: Session[] }>('/sessions'),
	createSession: (characterID: string, characterCardID?: string) => request<Session>('/sessions', { method: 'POST', body: JSON.stringify({ character_id: characterID, character_card_id: characterCardID }) }),
  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  listMessages: (id: string) => request<{ data: Message[] }>(`/sessions/${id}/messages`),
	 sendMessage: (id: string, content: string, quality: 'draft' | 'standard' | 'high' = 'draft', mode: 'brief' | 'generate' = 'generate', aspectRatio?: string) => request(`/sessions/${id}/messages`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ content, quality, mode, aspect_ratio: aspectRatio }) }),
  upload: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ id: string }>('/assets', { method: 'POST', body: form })
  },
  addReference: (sessionID: string, assetID: string, purpose = 'other') => request(`/sessions/${sessionID}/references`, { method: 'POST', body: JSON.stringify({ asset_id: assetID, purpose }) }),
  createCharacter: (name: string) => request<{ id: string }>('/characters', { method: 'POST', body: JSON.stringify({ name }) }),
	listCharacters: () => request<{ data: Character[] }>('/characters'),
	listCards: (characterID: string) => request<{ data: CharacterCard[] }>(`/characters/${characterID}/cards`),
	deleteCard: (characterID: string, cardID: string) => request<void>(`/characters/${characterID}/cards/${cardID}`, { method: 'DELETE' }),
	setDefaultCard: (characterID: string, cardID: string) => request<{ id: string; is_default: boolean }>(`/characters/${characterID}/cards/${cardID}/default`, { method: 'POST' }),
	renameCard: (characterID: string, cardID: string, name: string) => request<{ id: string; name: string }>(`/characters/${characterID}/cards/${cardID}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
	createCard: (characterID: string, sourceAssetIDs: string[], extraRequirements = '', aspectRatio = '3:2') => request<{ id: string }>(`/characters/${characterID}/cards`, { method: 'POST', body: JSON.stringify({ source_asset_ids: sourceAssetIDs, extra_requirements: extraRequirements, aspect_ratio: aspectRatio }) }),
	retryCard: (characterID: string, cardID: string) => request<{ id: string }>(`/characters/${characterID}/cards/${cardID}/retry`, { method: 'POST' }),
	previewCard: (characterID: string, baseAssetID: string, originalAssetID: string, requirements: string) => request<{ asset_id: string }>(`/characters/${characterID}/cards/preview`, { method: 'POST', body: JSON.stringify({ base_asset_id: baseAssetID, original_asset_id: originalAssetID, requirements }) }),
  importCard: (characterID: string, assetID: string, name?: string) => request<{ id: string }>(`/characters/${characterID}/cards/import`, { method: 'POST', body: JSON.stringify({ asset_id: assetID, name }) }),
  patchSession: (id: string, input: Record<string, string>) => request<void>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  finalizeSession: (id: string, generationID: string) => request<{ status: 'finalized' }>(`/sessions/${id}/finalize`, { method: 'POST', body: JSON.stringify({ generation_id: generationID }) }),
	getGeneration: (id: string) => request<Generation>(`/generations/${id}`, { cache: 'no-store' }),
	imageCapabilities: () => request<ImageCapabilities>('/image-capabilities'),
  retryGeneration: (id: string) => request(`/generations/${id}/retry`, { method: 'POST' }),
	adjustFailedGeneration: (id: string, content: string) => request(`/generations/${id}/adjust`, { method: 'POST', body: JSON.stringify({ content }) }),
	refineGeneration: (id: string, quality: 'standard' | 'high') => request(`/generations/${id}/refine`, { method: 'POST', body: JSON.stringify({ quality }) }),
  feedback: (id: string, content: string, quality: 'draft' | 'standard' | 'high' = 'draft', aspectRatio?: string, useCharacterCard = true) => request(`/generations/${id}/feedback`, { method: 'POST', body: JSON.stringify({ content, quality, aspect_ratio: aspectRatio, use_character_card: useCharacterCard }) }),
  saveToGallery: (id: string) => request(`/generations/${id}/save-to-gallery`, { method: 'POST' }),
  listGallery: (page = 1, pageSize = 24) => request<{ data: GalleryItem[]; pagination: GalleryPage }>(`/gallery?page=${page}&page_size=${pageSize}`),
	deleteGalleryItem: (id: string) => request<void>(`/gallery/${id}`, { method: 'DELETE' }),
	listMemoryCandidates: (characterID: string) => request<{ data: MemoryCandidate[] }>(`/characters/${characterID}/memory-candidates`),
	resolveMemoryCandidate: (id: string, action: 'accept' | 'reject') => request<void>(`/memory-candidates/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action }) }),
}

export const assetURL = (id: string) => `/api/v1/assets/${id}/content`
export const assetDownloadURL = (id: string) => `/api/v1/assets/${id}/content?download=1`
