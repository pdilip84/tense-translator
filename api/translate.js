// Vercel serverless function: /api/translate
// Holds the Gemini API key privately (server-side env var) so it is never
// shipped to the browser. The page calls this endpoint instead of Gemini
// directly.

const TENSE_ROWS = [
  { tense: "Simple Present", active_formula: "Subject + V1(s/es)", passive_formula: "Object + am/is/are + V3" },
  { tense: "Present Continuous", active_formula: "Subject + am/is/are + V-ing", passive_formula: "Object + am/is/are + being + V3" },
  { tense: "Present Perfect", active_formula: "Subject + has/have + V3", passive_formula: "Object + has/have + been + V3" },
  { tense: "Simple Past", active_formula: "Subject + V2", passive_formula: "Object + was/were + V3" },
  { tense: "Past Continuous", active_formula: "Subject + was/were + V-ing", passive_formula: "Object + was/were + being + V3" },
  { tense: "Past Perfect", active_formula: "Subject + had + V3", passive_formula: "Object + had + been + V3" },
  { tense: "Simple Future", active_formula: "Subject + will + V1", passive_formula: "Object + will be + V3" },
  { tense: "Future Perfect", active_formula: "Subject + will have + V3", passive_formula: "Object + will have + been + V3" },
  { tense: "Basic Modals (can/should/must/may)", active_formula: "Subject + modal + V1", passive_formula: "Object + modal + be + V3" },
  { tense: "Past Modals (should have/could have)", active_formula: "Subject + modal + have + V3", passive_formula: "Object + modal + have + been + V3" },
  { tense: "Future Compulsion (will have to)", active_formula: "Subject + will have to + V1", passive_formula: "Object + will have to be + V3" }
];

const ALLOWED_MODELS = new Set([
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-2.0-flash"
]);

function buildPrompt(sentence) {
  const rowsDesc = TENSE_ROWS.map(function (r, i) {
    return (i + 1) + ". " + r.tense + " | Active formula: " + r.active_formula + " | Passive formula: " + r.passive_formula;
  }).join('\n');

  const schema = {
    original_input: "string, the exact original user input",
    base_translation: "string, the sentence translated to clear standard English if needed, or cleaned up if it was already broken English",
    rows: TENSE_ROWS.map(function (r) {
      return {
        tense: r.tense,
        active_formula: r.active_formula,
        active_example: "string",
        passive_formula: r.passive_formula,
        passive_example: "string"
      };
    })
  };

  return "You are a grammar engine. The user will give you a single sentence, possibly written in Gujarati script or in broken/basic English.\n" +
    "Step 1: Silently determine the correct intended meaning of the sentence. If it is in Gujarati script, translate it into clear, natural, standard English. If it is already broken/basic English, clean it up into a clear standard English sentence with the same meaning. Keep the core subject/object/action intact.\n" +
    "Step 2: Using that base English meaning, produce the same meaning rewritten in EACH of the following 11 tense/voice structures, in this exact order, for BOTH active and passive voice, strictly following the given formula pattern for each row. If a structure does not naturally fit the original meaning, still produce the best-effort grammatically correct sentence for that structure (never skip or leave blank).\n\n" +
    rowsDesc + "\n\n" +
    "Return ONLY valid JSON, no markdown code fences, no explanations, no extra text, matching EXACTLY this schema (keep the same 11 tense names, in the same order, and keep the formula strings exactly as given):\n" +
    JSON.stringify(schema, null, 2) + "\n\n" +
    "The user's sentence is:\n\"\"\"\n" + sentence + "\n\"\"\"";
}

function extractJson(rawText) {
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function fetchWithRetry(url, options, maxAttempts) {
  let lastRes = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, options);
    if (res.ok || (res.status !== 429 && res.status !== 503)) return res;
    lastRes = res;
    if (attempt < maxAttempts) {
      await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s, 4s...
    }
  }
  return lastRes;
}

// Best-effort in-memory rate limit. Resets whenever the serverless instance
// cold-starts, and each Vercel region/instance keeps its own counter, so this
// is NOT a hard cap — it just blunts casual abuse of a link that shouldn't be
// public in the first place. Good enough for family/small-group use.
const rateLimitStore = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 12;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + WINDOW_MS;
  }
  entry.count += 1;
  rateLimitStore.set(ip, entry);
  return entry.count > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Set it in the Vercel project\'s Environment Variables.' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many requests from this connection. Please wait a minute and try again.' });
    return;
  }

  const body = req.body || {};
  const sentence = typeof body.sentence === 'string' ? body.sentence.trim() : '';
  if (!sentence) {
    res.status(400).json({ error: 'Missing "sentence" in request body.' });
    return;
  }
  if (sentence.length > 2000) {
    res.status(400).json({ error: 'Sentence is too long.' });
    return;
  }

  const model = ALLOWED_MODELS.has(body.model) ? body.model : 'gemini-3.8-flash';

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

  const upstreamBody = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(sentence) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
  };

  try {
    const upstream = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody)
    }, 4);

    const data = await upstream.json();

    if (!upstream.ok) {
      const detail = (data && data.error && data.error.message) ? data.error.message : JSON.stringify(data);
      res.status(upstream.status).json({ error: detail });
      return;
    }

    const candidate = data && data.candidates && data.candidates[0];
    const rawText = candidate && candidate.content && candidate.content.parts && candidate.content.parts.map(function (p) { return p.text || ''; }).join('');

    if (!rawText) {
      res.status(502).json({ error: 'Gemini returned an empty or unexpected response.' });
      return;
    }

    let parsed;
    try {
      parsed = extractJson(rawText);
    } catch (parseErr) {
      res.status(502).json({ error: 'Could not parse Gemini\'s response as JSON.', raw: rawText.slice(0, 1000) });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
}
