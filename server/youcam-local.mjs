import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import sharp from 'sharp';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

dotenv.config({ path: 'supabase/.env.local' });

const app = express();
const acceptedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10_000_000, files: 2 },
  fileFilter: (_request, file, done) => done(acceptedImageTypes.has(file.mimetype) ? null : new Error('Use a JPG, PNG, WebP, or HEIC image.'), acceptedImageTypes.has(file.mimetype)),
});
const apiRoot = 'https://yce-api-01.makeupar.com/s2s/v2.0';
const port = Number(process.env.LUKU_BACKEND_PORT || 8787);
let detectorPromise;
const generationWindows = new Map();
const pinterestAuthRequests = new Map();
const pinterestSessions = new Map();

app.use(cors());
app.use(express.json({ limit: '20kb' }));
app.get('/health', (_request, response) => response.json({ ok: true, service: 'luku-youcam' }));
app.use('/internal-models/coco-ssd', express.static(fileURLToPath(new URL('./models/coco-ssd', import.meta.url)), {
  dotfiles: 'deny',
  fallthrough: false,
  immutable: true,
  maxAge: '1y',
}));

app.post('/validate-photo', upload.single('person'), async (request, response) => {
  const person = request.file;
  if (!person) return response.status(400).json({ code: 'PHOTO_QUALITY', error: 'Take or choose a photo first.' });
  const quality = await validateShopperPhoto(person.buffer, true);
  if (!quality.ok) return response.status(422).json({ code: 'PHOTO_QUALITY', error: quality.message });
  return response.json({ ok: true });
});

app.post('/pinterest/session', (request, response) => {
  const appId = process.env.PINTEREST_APP_ID;
  const redirectUri = process.env.PINTEREST_REDIRECT_URI;
  if (!appId || !process.env.PINTEREST_APP_SECRET || !redirectUri) {
    return response.status(503).json({ error: 'Pinterest connection is not configured yet.' });
  }
  const state = randomBytes(24).toString('hex');
  pinterestAuthRequests.set(state, { createdAt: Date.now() });
  const authorization = new URL('https://www.pinterest.com/oauth/');
  authorization.searchParams.set('client_id', appId);
  authorization.searchParams.set('redirect_uri', redirectUri);
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('scope', 'boards:read,pins:read,user_accounts:read');
  authorization.searchParams.set('state', state);
  return response.json({ authorization_url: authorization.toString() });
});

app.get('/pinterest/callback', async (request, response) => {
  const code = String(request.query.code || '');
  const state = String(request.query.state || '');
  const pending = pinterestAuthRequests.get(state);
  pinterestAuthRequests.delete(state);
  if (!code || !pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
    return response.redirect('luku://pinterest-auth?error=invalid_or_expired_request');
  }
  try {
    const credentials = Buffer.from(`${process.env.PINTEREST_APP_ID}:${process.env.PINTEREST_APP_SECRET}`).toString('base64');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.PINTEREST_REDIRECT_URI,
      continuous_refresh: 'true',
    });
    const tokenResponse = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const token = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !token.access_token) throw new Error(token.message || 'Pinterest did not authorize this account.');
    const sessionId = randomBytes(32).toString('hex');
    pinterestSessions.set(sessionId, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Number(token.expires_in || 2_592_000) * 1000,
    });
    return response.redirect(`luku://pinterest-auth?session=${encodeURIComponent(sessionId)}`);
  } catch (error) {
    console.error('Pinterest authorization failed:', error instanceof Error ? error.message : error);
    return response.redirect('luku://pinterest-auth?error=authorization_failed');
  }
});

app.get('/pinterest/pins', async (request, response) => {
  const sessionId = String(request.query.session || '');
  const session = pinterestSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    pinterestSessions.delete(sessionId);
    return response.status(401).json({ error: 'Reconnect your Pinterest account to continue.' });
  }
  try {
    const boardId = String(request.query.board || '');
    const bookmark = String(request.query.bookmark || '');
    if (boardId && !/^\d+$/.test(boardId)) return response.status(400).json({ error: 'That Pinterest board is invalid.' });
    const upstreamUrl = new URL(boardId
      ? `https://api.pinterest.com/v5/boards/${boardId}/pins`
      : 'https://api.pinterest.com/v5/pins');
    upstreamUrl.searchParams.set('page_size', '50');
    if (bookmark) upstreamUrl.searchParams.set('bookmark', bookmark);
    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(payload.message || 'Pinterest could not load your Pins.');
    const items = (payload.items || []).map(pin => ({
      id: String(pin.id),
      title: pin.title || pin.description || 'Pinterest inspiration',
      description: pin.description || '',
      source: pin.board_owner?.username ? `Pinterest · @${pin.board_owner.username}` : 'Pinterest',
      image_url: pinterestImageUrl(pin),
      thumbnail_url: pinterestThumbnailUrl(pin),
    })).filter(item => item.image_url);
    return response.json({ items, bookmark: payload.bookmark || null });
  } catch (error) {
    return response.status(502).json({ error: error instanceof Error ? error.message : 'Pinterest could not load your Pins.' });
  }
});

app.get('/pinterest/boards', async (request, response) => {
  const sessionId = String(request.query.session || '');
  const session = pinterestSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    pinterestSessions.delete(sessionId);
    return response.status(401).json({ error: 'Reconnect your Pinterest account to continue.' });
  }
  try {
    const bookmark = String(request.query.bookmark || '');
    const upstreamUrl = new URL('https://api.pinterest.com/v5/boards');
    upstreamUrl.searchParams.set('page_size', '50');
    if (bookmark) upstreamUrl.searchParams.set('bookmark', bookmark);
    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(payload.message || 'Pinterest could not load your boards.');
    const items = (payload.items || []).map(board => ({
      id: String(board.id),
      name: board.name || 'Untitled board',
      description: board.description || '',
      pin_count: Number(board.pin_count || 0),
      privacy: board.privacy || 'PUBLIC',
    }));
    return response.json({ items, bookmark: payload.bookmark || null });
  } catch (error) {
    return response.status(502).json({ error: error instanceof Error ? error.message : 'Pinterest could not load your boards.' });
  }
});

app.delete('/pinterest/session', (request, response) => {
  pinterestSessions.delete(String(request.query.session || ''));
  return response.json({ ok: true });
});

app.post('/try-on', upload.fields([{ name: 'person', maxCount: 1 }, { name: 'reference', maxCount: 1 }]), async (request, response) => {
  try {
    const apiKey = process.env.YOUCAM_API_KEY;
    if (!apiKey) return response.status(503).json({ error: 'The YouCam API key is not configured.' });
    const files = request.files || {};
    const person = files.person?.[0];
    const localReference = files.reference?.[0];
    if (!person) return response.status(400).json({ error: 'Take or choose a shopper photo first.' });
    const referenceUrl = String(request.body.reference_url || '');
    const referenceFallbackUrl = String(request.body.reference_fallback_url || '');
    if (!localReference && !referenceUrl.startsWith('https://')) return response.status(400).json({ error: 'Choose a product image, upload one, or paste a public product link.' });

    const category = String(request.body.look_category || 'clothes');
    const accessoryType = String(request.body.accessory_type || 'hat');
    if (!['clothes', 'hair', 'accessories'].includes(category)) return response.status(400).json({ error: 'Choose clothes, hair, or accessories before generating.' });
    if (category === 'accessories' && !['hat', 'earring', 'necklace'].includes(accessoryType)) return response.status(400).json({ error: 'Choose a supported accessory type.' });
    if (!allowGeneration(clientAddress(request))) return response.status(429).json({ error: 'Too many previews were requested. Wait a few minutes and try again.' });
    const reference = localReference || await downloadReference(referenceUrl).catch(async primaryError => {
      if (!referenceFallbackUrl.startsWith('https://') || referenceFallbackUrl === referenceUrl) throw primaryError;
      return downloadReference(referenceFallbackUrl);
    });
    const inputs = [person, reference];
    const fileRoute = category === 'clothes' ? '/file/cloth-v3' : category === 'hair' ? '/file/hair-transfer' : '/file';
    const reservation = await youcam(apiKey, fileRoute, 'POST', {
      files: inputs.map((item, index) => ({ content_type: item.mimetype || 'image/jpeg', file_name: item.originalname || (index ? 'reference.jpg' : 'shopper.jpg'), file_size: item.size })),
    });
    const reserved = reservation?.data?.files || [];
    for (let index = 0; index < inputs.length; index += 1) await uploadReserved(reserved[index], inputs[index]);
    const sourceId = reserved[0]?.file_id;
    const referenceId = reserved[1]?.file_id;
    if (!sourceId) throw new Error('The shopper image was not accepted for upload.');
    if (!referenceId) throw new Error('The reference image was not accepted for upload.');

    const route = taskRoute(category, accessoryType);
    const task = await youcam(apiKey, route.create, 'POST', taskPayload(category, accessoryType, sourceId, referenceId, request.body));
    const taskId = task?.data?.task_id;
    if (!taskId) throw new Error('YouCam did not return a generation task.');

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const status = await youcam(apiKey, `${route.poll}/${encodeURIComponent(taskId)}`, 'GET');
      if (status?.data?.task_status === 'success') {
        const resultUrl = status.data.results?.url;
        if (!resultUrl) throw new Error('YouCam completed without a result image.');
        return response.json({ task_id: taskId, result_url: resultUrl });
      }
      if (status?.data?.task_status === 'error') throw new Error(status.data.error || 'YouCam could not generate this preview.');
    }
    return response.status(504).json({ error: 'The preview is taking too long. Please try again.' });
  } catch (error) {
    return response.status(error?.statusCode || 502).json({ error: error instanceof Error ? error.message : 'The try-on service failed.' });
  }
});

app.use((error, _request, response, _next) => {
  const status = error?.code === 'LIMIT_FILE_SIZE' || error?.code === 'LIMIT_FILE_COUNT' ? 413 : 400;
  return response.status(status).json({ error: error instanceof Error ? error.message : 'The uploaded image could not be read.' });
});

app.listen(port, '0.0.0.0', () => console.log(`Luku backend listening on http://0.0.0.0:${port}`));

async function validateShopperPhoto(buffer, detectPerson = false) {
  try {
    const image = sharp(buffer, { failOn: 'warning' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) return { ok: false, message: 'We could not read this photo. Choose a JPG or PNG image.' };
    if (metadata.width < 480 || metadata.height < 480) return { ok: false, message: 'This photo is too small. Choose a clearer image at least 480 × 480 pixels.' };
    const stats = await image.stats();
    if (stats.entropy < 2.4 || stats.sharpness < 1.1) return { ok: false, message: 'This photo looks blurry or too dark. Retake it in good light and hold the camera steady.' };
    if (!detectPerson) return { ok: true };

    const resized = await image.clone().rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const tensor = tf.tensor3d(new Uint8Array(resized.data), [resized.info.height, resized.info.width, resized.info.channels], 'int32');
    try {
      const detector = await getDetector();
      const predictions = await detector.detect(tensor, 10, 0.45);
      const people = predictions.filter(item => item.class === 'person' && item.score >= 0.5);
      if (!people.length) return { ok: false, message: 'We could not find a clear person in this photo. Use a well-lit photo with one person visible.' };
      if (people.length > 1) return { ok: false, message: 'Use a photo with only one person so the preview is applied correctly.' };
      const [, , width, height] = people[0].bbox;
      const coverage = (width * height) / (resized.info.width * resized.info.height);
      if (coverage < 0.1) return { ok: false, message: 'The person is too far away. Move closer and keep your body clearly visible.' };
      return { ok: true };
    } finally {
      tensor.dispose();
    }
  } catch (error) {
    console.error('Shopper photo validation failed:', error instanceof Error ? error.message : error);
    return { ok: false, message: 'This image could not be checked. Choose a clear JPG or PNG photo.' };
  }
}

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = cocoSsd.load({
      base: 'lite_mobilenet_v2',
      modelUrl: `http://127.0.0.1:${port}/internal-models/coco-ssd/model.json`,
    }).catch((error) => {
      detectorPromise = undefined;
      throw error;
    });
  }
  return detectorPromise;
}

function taskRoute(category, accessoryType) {
  if (category === 'hair') return { create: '/task/hair-transfer', poll: '/task/hair-transfer', version: 'v2.1' };
  if (category === 'accessories') {
    if (accessoryType === 'earring') return { create: '/task/2d-vto/earring', poll: '/task/2d-vto/earring' };
    if (accessoryType === 'necklace') return { create: '/task/2d-vto/necklace', poll: '/task/2d-vto/necklace' };
    return { create: '/task/hat', poll: '/task/hat' };
  }
  return { create: '/task/cloth-v3', poll: '/task/cloth-v3' };
}

function taskPayload(category, accessoryType, sourceId, referenceId, fields) {
  const reference = { ref_file_id: referenceId };
  if (category === 'hair') return { src_file_id: sourceId, ...reference };
  if (category === 'accessories' && accessoryType === 'hat') {
    return { src_file_id: sourceId, ...reference, gender: String(fields.gender || 'female'), style: 'random' };
  }
  if (category === 'accessories') {
    const prefix = accessoryType === 'earring' ? 'earring' : 'necklace';
    return {
      source_info: { name: sourceId },
      object_infos: [{ name: referenceId, parameter: { [`${prefix}_need_remove_background`]: true } }],
    };
  }
  return { src_file_id: sourceId, ...reference, garment_category: String(fields.garment_category || 'full_body') };
}

async function uploadReserved(reserved, input) {
  const signed = reserved?.requests?.[0];
  if (!reserved?.file_id || !signed?.url) throw new Error('The image service did not provide an upload URL.');
  const uploaded = await fetch(signed.url, { method: 'PUT', headers: { 'Content-Type': input.mimetype || 'image/jpeg', 'Content-Length': String(input.size) }, body: input.buffer });
  if (!uploaded.ok) throw new Error(`Image upload failed (${uploaded.status}).`);
}

async function youcam(apiKey, path, method, body) {
  const root = path.includes('hair-transfer') ? 'https://yce-api-01.makeupar.com/s2s/v2.1' : apiRoot;
  const normalizedPath = path.startsWith('/task/') || path.startsWith('/file') ? path : `/${path}`;
  const upstream = await fetch(`${root}${normalizedPath}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok || Number(payload?.status) >= 400) {
    const detail = payload?.message || payload?.error || `YouCam request failed (${upstream.status})`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return payload;
}

async function downloadReference(input) {
  const page = await safeFetch(input);
  if (!page.ok) throw clientError('The shared product page could not be opened.');
  if ((page.headers.get('content-type') || '').startsWith('image/')) return imageFileFromResponse(page, 'reference');
  const html = await readLimited(page, 1_000_000);
  const match = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i);
  if (!match?.[1]) throw clientError('No product image was found. Paste a direct image link instead.');
  const imageResponse = await safeFetch(new URL(match[1], page.url).toString());
  if (!imageResponse.ok || !(imageResponse.headers.get('content-type') || '').startsWith('image/')) throw clientError('The product image could not be downloaded.');
  return imageFileFromResponse(imageResponse, 'reference');
}

async function imageFileFromResponse(response, name) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 10_000_000) throw clientError('The reference image must be 10MB or smaller.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 10_000_000) throw clientError('The reference image must be 10MB or smaller.');
  const metadata = await sharp(buffer, { failOn: 'warning' }).metadata();
  if (!metadata.width || !metadata.height) throw clientError('The reference link did not contain a readable image.');
  const mimetype = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  const extension = mimetype.includes('png') ? 'png' : mimetype.includes('webp') ? 'webp' : 'jpg';
  return { buffer, size: buffer.length, mimetype, originalname: `${name}.${extension}` };
}

async function safeFetch(input, redirects = 0) {
  if (redirects > 4) throw clientError('The shared link redirected too many times.');
  const url = new URL(input);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) throw clientError('Use a public HTTPS image or product link.');
  await assertPublicHost(url.hostname);
  const response = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'LukuPreviewBot/1.0', Accept: 'image/*,text/html;q=0.8' }, signal: AbortSignal.timeout(15_000) });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw clientError('The shared link redirected without a destination.');
    return safeFetch(new URL(location, url).toString(), redirects + 1);
  }
  return response;
}

async function assertPublicHost(hostname) {
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw clientError('Use a publicly reachable image or product link.');
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
    || /^0\./.test(normalized) || /^127\./.test(normalized) || /^10\./.test(normalized) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized)
    || /^169\.254\./.test(normalized) || /^192\.168\./.test(normalized) || /^198\.(1[89])\./.test(normalized)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.')
    || normalized.startsWith('::ffff:169.254.') || normalized.startsWith('::ffff:192.168.') || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized);
}

async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw clientError('The shared product page is too large.');
  const text = await response.text();
  if (text.length > limit) throw clientError('The shared product page is too large.');
  return text;
}

function clientError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function pinterestImageUrl(pin) {
  const images = pin?.media?.images || {};
  return images.originals?.url || images['1200x']?.url || images['600x']?.url || images['400x300']?.url || images['150x150']?.url || '';
}

function pinterestThumbnailUrl(pin) {
  const images = pin?.media?.images || {};
  return images['400x300']?.url || images['600x']?.url || images['150x150']?.url || pinterestImageUrl(pin);
}

function clientAddress(request) {
  const direct = request.socket.remoteAddress || 'unknown';
  if (direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1') {
    const cloudflareAddress = String(request.headers['cf-connecting-ip'] || '');
    if (isIP(cloudflareAddress)) return cloudflareAddress;
  }
  return direct;
}

function allowGeneration(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const previous = generationWindows.get(key);
  if (!previous || now - previous.startedAt > 60 * 60 * 1000) {
    generationWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (previous.count >= 20) return false;
  previous.count += 1;
  return true;
}
