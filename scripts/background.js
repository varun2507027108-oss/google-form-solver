/**
 * FORM SOLVER v3.5 — Background Service Worker
 * Dual-provider: Gemini (priority) → Groq (fallback)
 * Handles both image-based and text-only questions.
 * Parallel image fetching for speed.
 */

const GEMINI_MODEL = 'gemini-2.5-flash';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const TIMEOUT_MS = 45000;

// Rate-limit tracking: avoid hammering Gemini if it's overloaded
let geminiBackoffUntil = 0;

// ── Listen for messages ──
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'solveQuestions') {
    handleSolve(request.questions)
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('[FormSolver BG] Error:', err);
        sendResponse({ error: err.message || 'Unknown error' });
      });
    return true;
  }
});

async function handleSolve(questions) {
  const data = await chrome.storage.local.get(['apiKey', 'groqApiKey']);
  const hasGemini = !!data.apiKey;
  const hasGroq = !!data.groqApiKey;

  if (!hasGemini && !hasGroq) {
    throw new Error('No API keys configured. Open extension popup and save at least one key.');
  }

  // Strategy: Try Gemini first (unless in backoff), fall back to Groq
  const now = Date.now();
  const geminiInBackoff = now < geminiBackoffUntil;

  if (hasGemini && !geminiInBackoff) {
    try {
      console.log('[FormSolver BG] Attempting Gemini (primary)...');
      const answers = await solveWithGemini(data.apiKey, questions);
      return { answers, provider: 'gemini' };
    } catch (err) {
      console.warn('[FormSolver BG] Gemini failed:', err.message);

      // If rate-limited or overloaded, set backoff (60s)
      if (isOverloadError(err)) {
        geminiBackoffUntil = Date.now() + 60000;
        console.log('[FormSolver BG] Gemini backoff set for 60s');
      }

      // Fall through to Groq if available
      if (hasGroq) {
        console.log('[FormSolver BG] Falling back to Groq...');
        const answers = await solveWithGroq(data.groqApiKey, questions);
        return { answers, provider: 'groq', fallback: true, geminiError: err.message };
      }

      throw err; // No fallback available
    }
  }

  if (hasGroq) {
    console.log(`[FormSolver BG] Using Groq ${geminiInBackoff ? '(Gemini in backoff)' : '(no Gemini key)'}...`);
    const answers = await solveWithGroq(data.groqApiKey, questions);
    return { answers, provider: 'groq' };
  }

  // Gemini is in backoff and no Groq key
  throw new Error('Gemini is rate-limited and no Groq fallback key is set. Wait a minute or add a Groq key.');
}

function isOverloadError(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('429') || msg.includes('503') || msg.includes('overloaded')
    || msg.includes('resource exhausted') || msg.includes('rate limit')
    || msg.includes('quota') || msg.includes('too many requests');
}

// ── Fetch image as base64 from background (has host_permissions) ──
async function fetchImageBase64(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { base64: btoa(binary), mimeType: blob.type || 'image/png' };
  } catch (err) {
    console.error('[FormSolver BG] Image fetch error:', err);
    return null;
  }
}

// ── Build prompt — adapts to whether images are present ──
function buildPrompt(questions, hasAnyImages) {
  const totalQ = questions.length;
  let prompt;

  if (hasAnyImages) {
    prompt = `You are solving an Engineering quiz (Physics, Chemistry, Mathematics, Python, Computer Science).

There are ${totalQ} questions below. You MUST answer ALL ${totalQ} of them.

CONTEXT:
- Some questions have an IMAGE attached showing the ACTUAL question text and answer options from an exam platform.
- The Google Form may only have generic labels like "Option 1", "Option 2", etc.
- For image questions: the image shows what each Option number corresponds to.
- For text-only questions: the question and options are provided directly in text below.

YOUR TASK for EACH question:
1. If an image is attached, READ the image to get the real question and options.
2. If no image, use the text question and DOM options provided.
3. SOLVE the question step by step.
4. Return the correct option label exactly as shown (e.g. "Option 1" or the actual text label).

CRITICAL RULES:
- You MUST return exactly ${totalQ} answer objects — one for each question.
- Return ONLY ONE answer per radio question.
- For checkbox questions, return ONLY the correct option(s) — comma-separated if multiple.
- Your answer MUST match one of the provided option labels exactly.
- Do NOT generate names, emails, or personal information. Only answer academic questions.

RESPONSE FORMAT — strict JSON array, no markdown:
[{"index": 0, "answer": "Option 3"}, {"index": 1, "answer": "Option 1"}]

QUESTIONS:
`;
  } else {
    prompt = `You are solving an Engineering quiz (Physics, Chemistry, Mathematics, Python, Computer Science).

There are ${totalQ} questions below. You MUST answer ALL ${totalQ} of them.

RULES:
- You MUST return exactly ${totalQ} answer objects — one for each question.
- One answer per radio question. Your answer must exactly match one of the listed options.
- For checkbox questions return correct option(s) comma-separated.
- For text/short-answer questions, provide the correct answer.
- Do NOT generate names, emails, or any personal information.

FORMAT — strict JSON, no markdown:
[{"index": 0, "answer": "the correct option text"}, {"index": 1, "answer": "the correct option text"}]

QUESTIONS:
`;
  }

  questions.forEach((q, i) => {
    prompt += `\n---\nQuestion ${i + 1} of ${totalQ} (ID: ${q.index})\nType: ${q.type}\nTitle: ${q.question}\n`;
    if (q.options && q.options.length > 0) {
      prompt += `Options: ${q.options.join(' | ')}\n`;
    }
    if (q.imageUrl) {
      prompt += `[Image ${i + 1} attached — use it to read the real question & options]\n`;
    }
  });

  prompt += `\n---\nREMINDER: Return exactly ${totalQ} answers in a JSON array. Do not skip any question.\n`;

  return prompt;
}

// ── Build text-only prompt for Groq (no image support) ──
function buildTextOnlyPrompt(questions) {
  const totalQ = questions.length;
  let prompt = `You are solving an Engineering quiz (Physics, Chemistry, Mathematics, Python, Computer Science).

There are ${totalQ} questions. You MUST answer ALL ${totalQ} of them.

RULES:
- You MUST return exactly ${totalQ} answer objects — one for each question.
- One answer per radio question. Your answer must exactly match one of the listed options.
- For checkbox questions return correct option(s) comma-separated.
- Do NOT generate names, emails, or personal information.
- IMPORTANT: Return ONLY a JSON array, no explanation, no markdown fences.

FORMAT — strict JSON:
[{"index": 0, "answer": "the correct option text"}, {"index": 1, "answer": "the correct option text"}]

QUESTIONS:
`;

  questions.forEach((q, i) => {
    prompt += `\n---\nQuestion ${i + 1} of ${totalQ} (ID: ${q.index})\nType: ${q.type}\nTitle: ${q.question}\n`;
    if (q.options && q.options.length > 0) {
      prompt += `Options: ${q.options.join(' | ')}\n`;
    }
    if (q.imageUrl) {
      prompt += `[Note: An image was attached but cannot be processed by this model. Answer based on text only.]\n`;
    }
  });

  prompt += `\n---\nREMINDER: Return exactly ${totalQ} answers. Do not skip any.\n`;

  return prompt;
}

// ── Fetch with timeout ──
async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════
//  GEMINI PROVIDER
// ══════════════════════════════════════════════════

async function solveWithGemini(apiKey, questions) {
  const hasAnyImages = questions.some(q => q.imageUrl);
  const promptText = buildPrompt(questions, hasAnyImages);
  const parts = [{ text: promptText }];

  // Fetch ALL images in parallel (not one-by-one)
  if (hasAnyImages) {
    const imagePromises = questions
      .filter(q => q.imageUrl)
      .map(q => fetchImageBase64(q.imageUrl));

    const imageResults = await Promise.all(imagePromises);
    let imgCount = 0;
    for (const imgData of imageResults) {
      if (imgData) {
        parts.push({
          inline_data: { mime_type: imgData.mimeType, data: imgData.base64 }
        });
        imgCount++;
      }
    }
    console.log(`[FormSolver BG] ${imgCount} images fetched in parallel`);
  }

  console.log(`[FormSolver BG] Sending ${questions.length} Qs (images: ${hasAnyImages}) to ${GEMINI_MODEL}`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            index: { type: 'INTEGER' },
            answer: { type: 'STRING' }
          },
          required: ['index', 'answer']
        }
      }
    }
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, TIMEOUT_MS);

  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error('Gemini API: ' + (e?.error?.message || `HTTP ${resp.status}`));
  }

  const data = await resp.json();
  console.log('[FormSolver BG] Gemini response received');

  return parseGeminiResponse(data);
}

function parseGeminiResponse(data) {
  const allParts = data?.candidates?.[0]?.content?.parts || [];
  let raw = null;
  for (const p of allParts) {
    if (p.text && p.text.includes('"index"')) { raw = p.text; break; }
  }
  if (!raw) {
    for (let i = allParts.length - 1; i >= 0; i--) {
      if (allParts[i].text) { raw = allParts[i].text; break; }
    }
  }
  if (!raw) throw new Error('Gemini returned empty response.');

  console.log('[FormSolver BG] Raw:', raw.substring(0, 300));
  return cleanAndParseJSON(raw);
}

// ══════════════════════════════════════════════════
//  GROQ PROVIDER
// ══════════════════════════════════════════════════

async function solveWithGroq(apiKey, questions) {
  const promptText = buildTextOnlyPrompt(questions);

  console.log(`[FormSolver BG] Sending ${questions.length} Qs to Groq (${GROQ_MODEL})`);

  const url = 'https://api.groq.com/openai/v1/chat/completions';

  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are an expert professor. Return ONLY valid JSON arrays. No markdown, no explanation, no code fences.'
      },
      {
        role: 'user',
        content: promptText
      }
    ],
    temperature: 0.1,
    max_tokens: 4096,
    response_format: { type: 'json_object' }
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  }, TIMEOUT_MS);

  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error('Groq API: ' + (e?.error?.message || `HTTP ${resp.status}`));
  }

  const data = await resp.json();
  console.log('[FormSolver BG] Groq response received');

  return parseGroqResponse(data);
}

function parseGroqResponse(data) {
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Groq returned empty response.');

  console.log('[FormSolver BG] Groq raw:', raw.substring(0, 300));

  // Groq with json_object mode may wrap in { "answers": [...] } or return bare array
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    // Try to extract JSON array from the response
    return cleanAndParseJSON(raw);
  }

  // Handle wrapped format: { "answers": [...] } or { "results": [...] }
  if (Array.isArray(parsed)) return parsed;
  if (parsed.answers && Array.isArray(parsed.answers)) return parsed.answers;
  if (parsed.results && Array.isArray(parsed.results)) return parsed.results;

  // Look for the first array value in the object
  for (const val of Object.values(parsed)) {
    if (Array.isArray(val) && val.length > 0 && val[0].index !== undefined) return val;
  }

  throw new Error('Groq response format unexpected. Got: ' + raw.substring(0, 200));
}

// ══════════════════════════════════════════════════
//  SHARED UTILITIES
// ══════════════════════════════════════════════════

function cleanAndParseJSON(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  }
  if (!cleaned.startsWith('[')) {
    const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
    if (s !== -1 && e > s) cleaned = cleaned.substring(s, e + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[FormSolver BG] Parse failed:', err.message, '\nCleaned:', cleaned.substring(0, 500));
    throw new Error('AI returned malformed data. Please try again.');
  }
}
