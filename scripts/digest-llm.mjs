function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function getOllamaConfig() {
  return {
    baseUrl: requireEnv('OLLAMA_BASE_URL').replace(/\/$/, ''),
    apiKey: requireEnv('OLLAMA_API_KEY'),
    model: requireEnv('OLLAMA_MODEL'),
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000),
    maxTokens: Math.max(1, Math.min(65536, Number(process.env.OLLAMA_MAX_TOKENS ?? 10240))),
  };
}

async function callOllamaAPI(prompt) {
  const config = getOllamaConfig();
  if (!config.apiKey) {
    throw new Error('Missing OLLAMA_API_KEY.');
  }

  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: config.maxTokens,
        messages: [
          { role: 'system', content: 'Always output valid minified JSON and nothing else.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? 'UNKNOWN';
    throw new Error(`Ollama request failed (${code}). ${error?.message ?? ''}`.trim());
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Ollama returned empty content.');
  }

  return content;
}

async function callGroqAPI(prompt) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured for fallback.');
  }
  const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS ?? process.env.OLLAMA_TIMEOUT_MS ?? 60000);
  const maxTokens = Math.max(1, Math.min(65536, Number(process.env.OLLAMA_MAX_TOKENS ?? 10240)));

  console.log(`[llm] Ollama unavailable, falling back to Groq model=${GROQ_MODEL}`);

  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: 'Always output valid minified JSON and nothing else.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? 'UNKNOWN';
    throw new Error(`Groq fallback request failed (${code}). ${error?.message ?? ''}`.trim());
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Groq fallback failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Groq fallback returned empty content.');
  }

  return content;
}

export function stripCodeFence(content) {
  let cleaned = (content ?? '').trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

export async function askLLM(prompt, fallbackPrompt = prompt) {
  try {
    const content = await callOllamaAPI(prompt);
    console.log('[llm] Ollama succeeded');
    return content;
  } catch (error) {
    console.warn(`[llm] Ollama failed: ${error.message}`);
  }

  const content = await callGroqAPI(fallbackPrompt);
  console.log('[llm] Groq fallback succeeded');
  return content;
}