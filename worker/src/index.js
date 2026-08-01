// Cloudflare Worker: proxies food-photo/description macro estimation to the
// Anthropic API. Exists ONLY so the Anthropic API key never has to live in
// the public static site's JS — the key stays server-side as a Worker secret.
//
// Deploy: see ../README.md

const ALLOWED_ORIGINS = [
  'https://rn-ftc.github.io',
  'http://localhost:8934', // local dev server used while testing this app
  'http://localhost:8935', // local mock-firebase test server
];

const MODEL = 'claude-haiku-4-5-20251001';

const MACRO_TOOL = {
  name: 'estimate_macros',
  description: 'Structured nutrition estimate for a food item or meal.',
  input_schema: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'Short name of the food/meal identified, e.g. "Grilled chicken breast (200g)"' },
      calories: { type: 'number', description: 'Estimated total calories (kcal)' },
      proteinG: { type: 'number', description: 'Estimated protein in grams' },
      carbG: { type: 'number', description: 'Estimated carbohydrates in grams' },
      fatG: { type: 'number', description: 'Estimated fat in grams' },
    },
    required: ['label', 'calories', 'proteinG', 'carbG', 'fatG'],
  },
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, origin);
    }

    const content = [];
    if (body.imageBase64) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: body.mimeType || 'image/jpeg', data: body.imageBase64 },
      });
      content.push({ type: 'text', text: 'Estimate the nutrition facts for the food shown in this photo. Use the estimate_macros tool.' });
    } else if (body.description && typeof body.description === 'string') {
      content.push({ type: 'text', text: `Estimate the nutrition facts for: "${body.description}". Use the estimate_macros tool.` });
    } else {
      return jsonResponse({ error: 'Provide either "description" or "imageBase64" in the request body' }, 400, origin);
    }

    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 512,
          tools: [MACRO_TOOL],
          tool_choice: { type: 'tool', name: 'estimate_macros' },
          messages: [{ role: 'user', content }],
        }),
      });
    } catch (err) {
      return jsonResponse({ error: 'Failed to reach Anthropic API', detail: String(err) }, 502, origin);
    }

    if (!anthropicRes.ok) {
      const detail = await anthropicRes.text();
      return jsonResponse({ error: 'AI request failed', detail }, 502, origin);
    }

    const data = await anthropicRes.json();
    const toolUse = (data.content || []).find(block => block.type === 'tool_use');
    if (!toolUse) {
      return jsonResponse({ error: 'No estimate returned' }, 502, origin);
    }

    return jsonResponse(toolUse.input, 200, origin);
  },
};
