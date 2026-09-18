// Groq API wrapper: one place that knows how to call the model, strip its
// thinking output, and parse JSON back out of it.
//
// FROZEN FILE — see CONTRACTS.md. Do not edit while parallel work is in
// progress; ask the repo owner if you need a change here.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Vision work (describing a photo) and text work (picking a bouquet) can use
// different models: the picker never needs to look at an image, so it can run
// on something cheaper and faster.
function visionModel() {
  return process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
}

function textModel() {
  return process.env.GROQ_TEXT_MODEL || visionModel();
}

function hasApiKey() {
  return Boolean(process.env.GROQ_API_KEY);
}

// Qwen emits a <think> block before its real answer. reasoning_format:
// 'hidden' usually suppresses it, but not reliably, so strip it here too.
function stripThinking(raw) {
  return String(raw || '').replace(/^[\s\S]*<\/think>/, '').trim();
}

// Pull a JSON object out of a model response. Models wrap JSON in ```json
// fences, add a sentence before it, or both. Returns null rather than
// throwing; callers decide what an unparseable response means.
function parseJson(text) {
  if (!text) {
    return null;
  }

  let cleaned = String(text).trim();

  // Strip a surrounding code fence, with or without a language tag.
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) {
    cleaned = fence[1].trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Fall back to the outermost {...} in the text.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
}

// Call Groq and return the response text with thinking stripped.
//
// Throws on a missing key, a non-OK response, or a network failure. The
// thrown Error carries a `status` for the HTTP status code the caller should
// return, so route handlers can rethrow without classifying errors
// themselves.
async function complete({ messages, model, maxTokens = 300, temperature = 0.3 }) {
  if (!hasApiKey()) {
    const error = new Error('Server not configured with Groq API key');
    error.status = 500;
    throw error;
  }

  let response;
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || textModel(),
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    });
  } catch (networkError) {
    const error = new Error('Could not reach the Groq API');
    error.status = 502;
    throw error;
  }

  if (!response.ok) {
    let detail = 'Unknown error';
    try {
      const errorData = await response.json();
      detail = errorData.error?.message || detail;
    } catch (parseError) {
      // Response body was not JSON; keep the generic message.
    }
    console.error('Groq API error:', detail);
    const error = new Error('Groq API error: ' + detail);
    error.status = 502;
    throw error;
  }

  const data = await response.json();
  return stripThinking(data.choices?.[0]?.message?.content || '');
}

// Convenience wrapper for prompts that must come back as JSON.
// Returns null if the model's response could not be parsed.
async function completeJson(options) {
  return parseJson(await complete(options));
}

module.exports = {
  GROQ_URL,
  visionModel,
  textModel,
  hasApiKey,
  stripThinking,
  parseJson,
  complete,
  completeJson,
};
