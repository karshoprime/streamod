const axios = require('axios');

async function translateWithOpenAI({ apiKey, model, prompt }) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: model || 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.choices[0].message.content;
}

async function translateWithGemini({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await axios.post(url, {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  });

  return response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function buildPrompt({ title, description, sourceLanguage, targetLanguages, maxTitleLength }) {
  return `
Translate the following YouTube metadata.

Rules:
- Keep meaning natural and human
- Title MUST be <= ${maxTitleLength} characters
- If too long → rewrite shorter but keep meaning
- Output JSON only

Source Language: ${sourceLanguage}
Target Languages: ${targetLanguages.join(', ')}

Title: ${title}
Description: ${description}

Output format:
{
  "fr": { "title": "...", "description": "..." },
  "de": { "title": "...", "description": "..." }
}
`;
}

async function buildLocalizedMetadata({
  title,
  description,
  sourceLanguage,
  targetLanguages,
  maxTitleLength,
  user
}) {
  if (!user.ai_api_key) {
    console.warn('[AI] No API key');
    return {};
  }

  const prompt = buildPrompt({
    title,
    description,
    sourceLanguage,
    targetLanguages,
    maxTitleLength
  });

  let raw;

  if (user.ai_provider === 'gemini') {
    raw = await translateWithGemini({
      apiKey: user.ai_api_key,
      model: user.ai_model,
      prompt
    });
  } else {
    raw = await translateWithOpenAI({
      apiKey: user.ai_api_key,
      model: user.ai_model,
      prompt
    });
  }

  try {
    let cleaned = raw.trim();

    // Hapus code fence markdown kalau ada
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/i, '').replace(/\s*```$/, '');
    }

    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[AI] Failed parsing JSON:', raw);
    return {};
  }
}

module.exports = {
  buildLocalizedMetadata
};
