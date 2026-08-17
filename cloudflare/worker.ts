const YOUCAM_V2 = 'https://yce-api-01.makeupar.com/s2s/v2.0';
const YOUCAM_V21 = 'https://yce-api-01.makeupar.com/s2s/v2.1';
const MAX_IMAGE_BYTES = 10_000_000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_CATEGORIES = new Set(['clothes', 'hair', 'accessories']);
const ALLOWED_ACCESSORIES = new Set(['hat', 'earring', 'necklace']);
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type ImageInput = { body: Blob; size: number; type: string; name: string };
type PinterestSession = { accessToken: string; refreshToken?: string; expiresAt: number };

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'luku-judge-api', version: '1.1.12' });
      }
      if (request.method === 'POST' && url.pathname === '/validate-photo') return await validatePhoto(request);
      if (request.method === 'POST' && url.pathname === '/try-on') return await tryOn(request, env);
      if (request.method === 'POST' && url.pathname === '/pinterest/session') return await createPinterestSession(request, env);
      if (request.method === 'GET' && url.pathname === '/pinterest/callback') return await pinterestCallback(request, env);
      if (request.method === 'GET' && url.pathname === '/pinterest/pins') return await pinterestPins(url, env);
      if (request.method === 'GET' && url.pathname === '/pinterest/boards') return await pinterestBoards(url, env);
      if (request.method === 'DELETE' && url.pathname === '/pinterest/session') return await deletePinterestSession(url, env);
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      const message = error instanceof Error ? error.message : 'The Luku service failed.';
      console.error(JSON.stringify({ event: 'request_failed', path: url.pathname, status, message }));
      return json({ error: message }, status);
    }
  },
} satisfies ExportedHandler<Env>;

async function validatePhoto(request: Request): Promise<Response> {
  const form = await parseForm(request);
  requireImage(form.get('person'), 'Take or choose a photo first.');
  return json({ ok: true });
}

async function tryOn(request: Request, env: Env): Promise<Response> {
  if (!env.YOUCAM_API_KEY) throw new HttpError(503, 'The YouCam API key is not configured.');
  const form = await parseForm(request);
  const person = requireImage(form.get('person'), 'Take or choose a shopper photo first.');
  const localReference = optionalImage(form.get('reference'));
  const referenceUrl = textField(form, 'reference_url');
  const referenceFallbackUrl = textField(form, 'reference_fallback_url');
  if (!localReference && !referenceUrl.startsWith('https://')) {
    throw new HttpError(400, 'Choose a product image or a public product link.');
  }

  const category = textField(form, 'look_category') || 'clothes';
  const accessoryType = textField(form, 'accessory_type') || 'hat';
  if (!ALLOWED_CATEGORIES.has(category)) throw new HttpError(400, 'Choose clothes, hair, or accessories before generating.');
  if (category === 'accessories' && !ALLOWED_ACCESSORIES.has(accessoryType)) throw new HttpError(400, 'Choose a supported accessory type.');
  await enforceRateLimit(request, env);

  let reference = localReference;
  if (!reference) {
    try {
      reference = await downloadReference(referenceUrl);
    } catch (primaryError) {
      if (!referenceFallbackUrl.startsWith('https://') || referenceFallbackUrl === referenceUrl) throw primaryError;
      reference = await downloadReference(referenceFallbackUrl);
    }
  }

  const inputs = [person, reference];
  const fileRoute = category === 'clothes' ? '/file/cloth-v3' : category === 'hair' ? '/file/hair-transfer' : '/file';
  const reservation = await youcam(env.YOUCAM_API_KEY, fileRoute, 'POST', {
    files: inputs.map(item => ({ content_type: item.type, file_name: item.name, file_size: item.size })),
  });
  const reserved = getObjectArray(getObject(reservation, 'data'), 'files');
  await Promise.all(inputs.map((input, index) => uploadReserved(reserved[index], input)));
  const sourceId = getString(reserved[0], 'file_id');
  const referenceId = getString(reserved[1], 'file_id');
  if (!sourceId) throw new Error('The shopper image was not accepted for upload.');
  if (!referenceId) throw new Error('The reference image was not accepted for upload.');

  const route = taskRoute(category, accessoryType);
  const task = await youcam(env.YOUCAM_API_KEY, route.create, 'POST', taskPayload(category, accessoryType, sourceId, referenceId, form));
  const taskId = getString(getObject(task, 'data'), 'task_id');
  if (!taskId) throw new Error('YouCam did not return a generation task.');

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(2_000);
    const status = await youcam(env.YOUCAM_API_KEY, `${route.poll}/${encodeURIComponent(taskId)}`, 'GET');
    const data = getObject(status, 'data');
    const taskStatus = getString(data, 'task_status');
    if (taskStatus === 'success') {
      const resultUrl = getString(getObject(data, 'results'), 'url');
      if (!resultUrl) throw new Error('YouCam completed without a result image.');
      return json({ task_id: taskId, result_url: resultUrl });
    }
    if (taskStatus === 'error') throw new Error(readMessage(data) || 'YouCam could not generate this preview.');
  }
  throw new HttpError(504, 'The preview is taking too long. Please try again.');
}

async function createPinterestSession(request: Request, env: Env): Promise<Response> {
  if (!env.PINTEREST_APP_ID || !env.PINTEREST_APP_SECRET) throw new HttpError(503, 'Pinterest connection is not configured yet.');
  const state = randomToken(24);
  await env.PINTEREST_SESSIONS.put(`state:${state}`, '1', { expirationTtl: 600 });
  const redirectUri = `${new URL(request.url).origin}/pinterest/callback`;
  const authorization = new URL('https://www.pinterest.com/oauth/');
  authorization.searchParams.set('client_id', env.PINTEREST_APP_ID);
  authorization.searchParams.set('redirect_uri', redirectUri);
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('scope', 'boards:read,pins:read,user_accounts:read');
  authorization.searchParams.set('state', state);
  return json({ authorization_url: authorization.toString() });
}

async function pinterestCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const pending = state ? await env.PINTEREST_SESSIONS.get(`state:${state}`) : null;
  if (state) await env.PINTEREST_SESSIONS.delete(`state:${state}`);
  if (!code || !pending || !env.PINTEREST_APP_ID || !env.PINTEREST_APP_SECRET) {
    return Response.redirect('luku://pinterest-auth?error=invalid_or_expired_request', 302);
  }

  try {
    const redirectUri = `${url.origin}/pinterest/callback`;
    const credentials = btoa(`${env.PINTEREST_APP_ID}:${env.PINTEREST_APP_SECRET}`);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, continuous_refresh: 'true' });
    const upstream = await fetchWithTimeout('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    }, 20_000);
    const token = await readJson(upstream);
    const accessToken = getString(token, 'access_token');
    if (!upstream.ok || !accessToken) throw new Error(readMessage(token) || 'Pinterest did not authorize this account.');
    const sessionId = randomToken(32);
    const expiresIn = getNumber(token, 'expires_in') || 2_592_000;
    const session: PinterestSession = {
      accessToken,
      refreshToken: getString(token, 'refresh_token') || undefined,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    await env.PINTEREST_SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), { expirationTtl: Math.max(60, expiresIn) });
    return Response.redirect(`luku://pinterest-auth?session=${encodeURIComponent(sessionId)}`, 302);
  } catch (error) {
    console.error(JSON.stringify({ event: 'pinterest_authorization_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return Response.redirect('luku://pinterest-auth?error=authorization_failed', 302);
  }
}

async function pinterestPins(url: URL, env: Env): Promise<Response> {
  const session = await getPinterestSession(url.searchParams.get('session') || '', env);
  const boardId = url.searchParams.get('board') || '';
  if (boardId && !/^\d+$/.test(boardId)) throw new HttpError(400, 'That Pinterest board is invalid.');
  const upstreamUrl = new URL(boardId ? `https://api.pinterest.com/v5/boards/${boardId}/pins` : 'https://api.pinterest.com/v5/pins');
  upstreamUrl.searchParams.set('page_size', '50');
  addBookmark(upstreamUrl, url);
  const payload = await pinterestGet(upstreamUrl, session.accessToken, 'Pinterest could not load your Pins.');
  const items = getObjectArray(payload, 'items').map(pin => ({
    id: getString(pin, 'id'),
    title: getString(pin, 'title') || getString(pin, 'description') || 'Pinterest inspiration',
    description: getString(pin, 'description'),
    source: 'Pinterest',
    image_url: pinterestImageUrl(pin),
    thumbnail_url: pinterestThumbnailUrl(pin),
  })).filter(item => item.id && item.image_url);
  return json({ items, bookmark: getString(payload, 'bookmark') || null });
}

async function pinterestBoards(url: URL, env: Env): Promise<Response> {
  const session = await getPinterestSession(url.searchParams.get('session') || '', env);
  const upstreamUrl = new URL('https://api.pinterest.com/v5/boards');
  upstreamUrl.searchParams.set('page_size', '50');
  addBookmark(upstreamUrl, url);
  const payload = await pinterestGet(upstreamUrl, session.accessToken, 'Pinterest could not load your boards.');
  const items = getObjectArray(payload, 'items').map(board => ({
    id: getString(board, 'id'),
    name: getString(board, 'name') || 'Untitled board',
    description: getString(board, 'description'),
    pin_count: getNumber(board, 'pin_count'),
    privacy: getString(board, 'privacy') || 'PUBLIC',
  })).filter(item => item.id);
  return json({ items, bookmark: getString(payload, 'bookmark') || null });
}

async function deletePinterestSession(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get('session') || '';
  if (sessionId) await env.PINTEREST_SESSIONS.delete(`session:${sessionId}`);
  return json({ ok: true });
}

async function getPinterestSession(sessionId: string, env: Env): Promise<PinterestSession> {
  const raw = sessionId ? await env.PINTEREST_SESSIONS.get(`session:${sessionId}`) : null;
  if (!raw) throw new HttpError(401, 'Reconnect your Pinterest account to continue.');
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || typeof value.accessToken !== 'string' || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()) {
    await env.PINTEREST_SESSIONS.delete(`session:${sessionId}`);
    throw new HttpError(401, 'Reconnect your Pinterest account to continue.');
  }
  return { accessToken: value.accessToken, refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : undefined, expiresAt: value.expiresAt };
}

async function pinterestGet(url: URL, accessToken: string, fallback: string): Promise<JsonObject> {
  const upstream = await fetchWithTimeout(url.toString(), { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }, 20_000);
  const payload = await readJson(upstream);
  if (!upstream.ok) throw new HttpError(502, readMessage(payload) || fallback);
  return payload;
}

async function enforceRateLimit(request: Request, env: Env): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `limit:${ip}:${hour}`;
  const count = Number(await env.PINTEREST_SESSIONS.get(key) || '0');
  if (count >= 20) throw new HttpError(429, 'Too many previews were requested. Wait a few minutes and try again.');
  await env.PINTEREST_SESSIONS.put(key, String(count + 1), { expirationTtl: 3_900 });
}

async function parseForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(400, 'Upload the images as form data.');
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > MAX_IMAGE_BYTES * 2 + 100_000) throw new HttpError(413, 'Each image must be 10MB or smaller.');
  try {
    return await request.formData();
  } catch {
    throw new HttpError(400, 'The uploaded image could not be read.');
  }
}

function requireImage(value: FormDataEntryValue | null, missingMessage: string): ImageInput {
  const image = optionalImage(value);
  if (!image) throw new HttpError(400, missingMessage);
  return image;
}

function optionalImage(value: FormDataEntryValue | null): ImageInput | undefined {
  if (!(value instanceof File) || value.size === 0) return undefined;
  if (value.size > MAX_IMAGE_BYTES) throw new HttpError(413, 'Each image must be 10MB or smaller.');
  const type = value.type.toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(type)) throw new HttpError(400, 'Use a JPG, PNG, WebP, or HEIC image.');
  return { body: value, size: value.size, type, name: safeFileName(value.name || 'image.jpg') };
}

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function taskRoute(category: string, accessoryType: string): { create: string; poll: string } {
  if (category === 'hair') return { create: '/task/hair-transfer', poll: '/task/hair-transfer' };
  if (category === 'accessories') {
    if (accessoryType === 'earring') return { create: '/task/2d-vto/earring', poll: '/task/2d-vto/earring' };
    if (accessoryType === 'necklace') return { create: '/task/2d-vto/necklace', poll: '/task/2d-vto/necklace' };
    return { create: '/task/hat', poll: '/task/hat' };
  }
  return { create: '/task/cloth-v3', poll: '/task/cloth-v3' };
}

function taskPayload(category: string, accessoryType: string, sourceId: string, referenceId: string, form: FormData): JsonObject {
  if (category === 'hair') return { src_file_id: sourceId, ref_file_id: referenceId };
  if (category === 'accessories' && accessoryType === 'hat') {
    return { src_file_id: sourceId, ref_file_id: referenceId, gender: textField(form, 'gender') || 'female', style: 'random' };
  }
  if (category === 'accessories') {
    const prefix = accessoryType === 'earring' ? 'earring' : 'necklace';
    return {
      source_info: { name: sourceId },
      object_infos: [{ name: referenceId, parameter: { [`${prefix}_need_remove_background`]: true } }],
    };
  }
  return { src_file_id: sourceId, ref_file_id: referenceId, garment_category: textField(form, 'garment_category') || 'full_body' };
}

async function uploadReserved(reserved: JsonObject | undefined, input: ImageInput): Promise<void> {
  const signed = getObjectArray(reserved, 'requests')[0];
  const uploadUrl = getString(signed, 'url');
  if (!getString(reserved, 'file_id') || !uploadUrl) throw new Error('The image service did not provide an upload URL.');
  const uploaded = await fetchWithTimeout(uploadUrl, { method: 'PUT', headers: { 'Content-Type': input.type, 'Content-Length': String(input.size) }, body: input.body }, 30_000);
  if (!uploaded.ok) throw new Error(`Image upload failed (${uploaded.status}).`);
}

async function youcam(apiKey: string, path: string, method: 'GET' | 'POST', body?: JsonObject): Promise<JsonObject> {
  const root = path.includes('hair-transfer') ? YOUCAM_V21 : YOUCAM_V2;
  const upstream = await fetchWithTimeout(`${root}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, 25_000);
  const payload = await readJson(upstream);
  const payloadStatus = getNumber(payload, 'status');
  if (!upstream.ok || payloadStatus >= 400) throw new Error(readMessage(payload) || `YouCam request failed (${upstream.status}).`);
  return payload;
}

async function downloadReference(input: string): Promise<ImageInput> {
  const page = await safeFetch(input);
  if (!page.ok) throw new HttpError(400, 'The shared product page could not be opened.');
  const type = contentType(page);
  if (type.startsWith('image/')) return imageFromResponse(page, 'reference');
  if (!type.includes('text/html')) throw new HttpError(400, 'The shared link is not an image or product page.');
  const declared = Number(page.headers.get('content-length') || '0');
  if (declared > 1_000_000) throw new HttpError(400, 'The shared product page is too large.');
  const html = await page.text();
  if (html.length > 1_000_000) throw new HttpError(400, 'The shared product page is too large.');
  const match = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i);
  if (!match?.[1]) throw new HttpError(400, 'No product image was found. Choose an image directly instead.');
  const imageResponse = await safeFetch(new URL(decodeHtml(match[1]), page.url).toString());
  if (!imageResponse.ok || !contentType(imageResponse).startsWith('image/')) throw new HttpError(400, 'The product image could not be downloaded.');
  return imageFromResponse(imageResponse, 'reference');
}

async function imageFromResponse(response: Response, name: string): Promise<ImageInput> {
  const declared = Number(response.headers.get('content-length') || '0');
  if (declared > MAX_IMAGE_BYTES) throw new HttpError(400, 'The reference image must be 10MB or smaller.');
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new HttpError(400, 'The reference image must be 10MB or smaller.');
  const type = contentType(response);
  if (!ALLOWED_IMAGE_TYPES.has(type)) throw new HttpError(400, 'The reference link did not contain a supported image.');
  const extension = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('hei') ? 'heic' : 'jpg';
  return { body: blob, size: blob.size, type, name: `${name}.${extension}` };
}

async function safeFetch(input: string, redirects = 0): Promise<Response> {
  if (redirects > 4) throw new HttpError(400, 'The shared link redirected too many times.');
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, 'Use a valid public HTTPS image or product link.'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || isPrivateHost(url.hostname)) {
    throw new HttpError(400, 'Use a publicly reachable HTTPS image or product link.');
  }
  const response = await fetchWithTimeout(url.toString(), {
    redirect: 'manual',
    headers: { 'User-Agent': 'LukuPreviewBot/1.1', Accept: 'image/*,text/html;q=0.8' },
  }, 15_000);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new HttpError(400, 'The shared link redirected without a destination.');
    return safeFetch(new URL(location, url).toString(), redirects + 1);
  }
  return response;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::') return true;
  if (/^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
}

function pinterestImageUrl(pin: JsonObject): string {
  const images = getObject(getObject(pin, 'media'), 'images');
  return ['originals', '1200x', '600x', '400x300', '150x150'].map(key => getString(getObject(images, key), 'url')).find(Boolean) || '';
}

function pinterestThumbnailUrl(pin: JsonObject): string {
  const images = getObject(getObject(pin, 'media'), 'images');
  return ['400x300', '600x', '150x150', 'originals'].map(key => getString(getObject(images, key), 'url')).find(Boolean) || '';
}

function addBookmark(upstream: URL, requestUrl: URL): void {
  const bookmark = requestUrl.searchParams.get('bookmark');
  if (bookmark) upstream.searchParams.set('bookmark', bookmark);
}

function json(value: JsonValue, status = 200): Response {
  return Response.json(value, { status, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } });
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function readJson(response: Response): Promise<JsonObject> {
  const value: unknown = await response.json().catch(() => ({}));
  return isObject(value) ? value : {};
}

function getObject(value: JsonObject | undefined, key: string): JsonObject | undefined {
  const child = value?.[key];
  return isObject(child) ? child : undefined;
}

function getObjectArray(value: JsonObject | undefined, key: string): JsonObject[] {
  const child = value?.[key];
  return Array.isArray(child) ? child.filter(isObject) : [];
}

function getString(value: JsonObject | undefined, key: string): string {
  const child = value?.[key];
  return typeof child === 'string' ? child : '';
}

function getNumber(value: JsonObject | undefined, key: string): number {
  const child = value?.[key];
  return typeof child === 'number' && Number.isFinite(child) ? child : 0;
}

function readMessage(value: JsonObject | undefined): string {
  return getString(value, 'message') || getString(value, 'error');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentType(response: Response): string {
  return (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'image.jpg';
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

function randomToken(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, value => value.toString(16).padStart(2, '0')).join('');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
