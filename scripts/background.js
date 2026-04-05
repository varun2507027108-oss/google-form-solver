/**
 * FORM SOLVER v3.1 — Background Service Worker
 * Fetches images from Google CDN using extension permissions.
 * Sends multimodal payload to Gemini.
 */

const GEMINI_MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 90000;

// ── Listen for messages ──
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'solveQuestions') {
    handleSolve(request.questions)
      .then(answers => sendResponse({ answers }))
      .catch(err => {
        console.error('[FormSolver BG] Error:', err);
        sendResponse({ error: err.message || 'Unknown error' });
      });
    return true;
  }
});

async function handleSolve(questions) {
  const data = await chrome.storage.local.get(['apiKey']);
  if (!data.apiKey) throw new Error('No API key. Open extension popup and save your Gemini API Key.');
  return await solveWithGemini(data.apiKey, questions);
}

// ── Fetch image as base64 from background (has host_permissions) ──
async function fetchImageBase64(url) {
  try {
    console.log('[FormSolver BG] Fetching image:', url.substring(0, 100));
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn('[FormSolver BG] Image fetch failed:', resp.status);
      return null;
    }
    const blob = await resp.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Convert to base64 manually (no FileReader in service workers)
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const mimeType = blob.type || 'image/png';

    console.log('[FormSolver BG] Image converted: mime=' + mimeType + ' base64Length=' + base64.length);
    return { base64, mimeType };
  } catch (err) {
    console.error('[FormSolver BG] Image fetch error:', err);
    return null;
  }
}

// ── Build prompt ──
function buildPrompt(questions) {
  let prompt = `You are an expert professor in Engineering (Physics, Chemistry, Mathematics, Python, Computer Science) at Mumbai University. You are solving a quiz for a first-year student.

IMPORTANT CONTEXT:
- Each question has an IMAGE attached showing the ACTUAL question text and answer options from an exam platform.
- The Google Form only has generic clickable labels: "Option 1", "Option 2", "Option 3", "Option 4".
- The image shows which answer each Option number corresponds to.

YOUR TASK (follow step by step for EACH question):
1. READ the image carefully — identify the subject (Math, Physics, Chemistry, Python, etc.)
2. READ the full question text from the image.
3. READ all answer choices shown next to Option 1, Option 2, Option 3, Option 4 in the image.
4. SOLVE the question using your expert knowledge. Think step by step.
5. DETERMINE which Option number has the correct answer.
6. Return ONLY that "Option X" string.

CRITICAL RULES:
- Return ONLY ONE correct option per radio question — never return all options.
- For checkbox questions, return ONLY the correct option(s) as an array.
- Your answer MUST be one of: "Option 1", "Option 2", "Option 3", or "Option 4".

RESPONSE FORMAT:
Return strictly valid JSON only. You must use double quotes for all keys (e.g., "index" and "answer"). No trailing commas. No markdown formatting.
Example: [{"index": 0, "answer": "Option 3"}, {"index": 1, "answer": "Option 1"}]

QUESTIONS:
`;

  questions.forEach((q, i) => {
    prompt += `\n---\nQuestion ID: ${q.index}\nType: ${q.type}\nTitle: ${q.question}\n`;
    if (q.options && q.options.length > 0) {
      prompt += `DOM Options: ${q.options.join(' | ')}\n`;
    }
    if (q.imageUrl) {
      prompt += `[Image ${i + 1} is attached — analyze it to find the answer]\n`;
    }
  });

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

// ── Call Gemini ──
async function solveWithGemini(apiKey, questions) {
  const promptText = buildPrompt(questions);
  const parts = [{ text: promptText }];

  // Fetch all images from background (we have host_permissions)
  let imgCount = 0;
  for (const q of questions) {
    if (q.imageUrl) {
      const imgData = await fetchImageBase64(q.imageUrl);
      if (imgData) {
        parts.push({
          inline_data: {
            mime_type: imgData.mimeType,
            data: imgData.base64
          }
        });
        imgCount++;
      }
    }
  }

  console.log(`[FormSolver BG] Sending ${questions.length} questions with ${imgCount} images to Gemini`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
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

  // Find the JSON part (Gemini 2.5 may have thinking parts)
  const allParts = data?.candidates?.[0]?.content?.parts || [];
  let raw = null;

  // Look for the part containing JSON
  for (const p of allParts) {
    if (p.text && p.text.includes('"index"')) {
      raw = p.text;
      break;
    }
  }
  // Fallback: last text part
  if (!raw) {
    for (let i = allParts.length - 1; i >= 0; i--) {
      if (allParts[i].text) { raw = allParts[i].text; break; }
    }
  }

  if (!raw) throw new Error('Gemini returned empty response.');

  console.log('[FormSolver BG] Raw text:', raw.substring(0, 400));

  // Extract JSON array
  let cleaned = raw.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) {
    cleaned = cleaned.substring(start, end + 1);
  }

  // Safety net: force double quotes around keys if AI forgot them
  cleaned = cleaned.replace(/([{,]\s*)(index|answer)(\s*:)/g, '$1"$2"$3');

  return JSON.parse(cleaned);
}
