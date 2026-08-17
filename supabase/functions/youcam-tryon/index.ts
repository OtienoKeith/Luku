const API = 'https://yce-api-01.makeupar.com/s2s/v2.0';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const token = Deno.env.get('YOUCAM_API_KEY');
  if (!token) return json({ error: 'YouCam server configuration is missing' }, 503);

  try {
    const incoming = await request.formData();
    const person = incoming.get('person');
    const referenceUrl = incoming.get('reference_url');
    const category = String(incoming.get('garment_category') ?? 'upper_body');
    if (!(person instanceof File)) return json({ error: 'A person image is required' }, 400);
    if (typeof referenceUrl !== 'string' || !referenceUrl.startsWith('https://')) return json({ error: 'A secure garment reference URL is required' }, 400);
    if (person.size > 10_000_000) return json({ error: 'The person image must be 10MB or smaller' }, 413);

    const resolvedReference = await resolveImageUrl(referenceUrl);

    // 1) Reserve a short-lived YouCam upload and receive its file_id.
    const reservation = await youcam(token, '/file/cloth-v3', 'POST', {
      files: [{ content_type: person.type || 'image/jpeg', file_name: person.name || 'person.jpg', file_size: person.size }],
    });
    const uploaded = reservation?.data?.files?.[0];
    const put = uploaded?.requests?.[0];
    if (!uploaded?.file_id || !put?.url) throw new Error('YouCam did not provide an upload URL');

    // 2) Upload directly to the signed URL exactly as instructed by the File API.
    const uploadResponse = await fetch(put.url, {
      method: 'PUT',
      headers: { 'Content-Type': person.type || 'image/jpeg', 'Content-Length': String(person.size) },
      body: person,
    });
    if (!uploadResponse.ok) throw new Error('The image upload failed');

    // 3) Create a Clothes V3 task using the uploaded shopper plus retailer garment URL.
    const task = await youcam(token, '/task/cloth-v3', 'POST', {
      src_file_id: uploaded.file_id,
      ref_file_url: resolvedReference,
      garment_category: category,
    });
    const taskId = task?.data?.task_id;
    if (!taskId) throw new Error('YouCam did not return a task ID');

    // 4) Poll within the request budget; the client receives a clean, stable contract.
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const status = await youcam(token, `/task/cloth-v3/${encodeURIComponent(taskId)}`, 'GET');
      if (status?.data?.task_status === 'success') return json({ task_id: taskId, result_url: status.data.results?.url });
      if (status?.data?.task_status === 'error') return json({ error: status.data.error ?? 'YouCam could not generate this preview', task_id: taskId }, 422);
    }
    return json({ error: 'The preview is still processing. Please retry shortly.', task_id: taskId }, 504);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The try-on service could not be reached';
    return json({ error: message }, 502);
  }
});

async function youcam(token: string, path: string, method: 'GET' | 'POST', body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || payload?.status >= 400) throw new Error(payload?.message ?? `YouCam request failed (${response.status})`);
  return payload;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function resolveImageUrl(input: string) {
  if (/\.(jpe?g|png|webp)(\?.*)?$/i.test(input)) return input;
  const response = await fetch(input, { headers: { 'User-Agent': 'LukuPreviewBot/1.0' }, redirect: 'follow' });
  if (!response.ok) throw new Error('The shared product page could not be opened');
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('image/')) return response.url;
  const html = await response.text();
  const match = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i);
  if (!match?.[1]) throw new Error('No public preview image was found on that page; paste a direct image link instead');
  return new URL(match[1], response.url).toString();
}
