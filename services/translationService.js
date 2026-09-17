const axios = require('axios');
const { getTranslateCode, sanitizeLanguageList } = require('../config/youtubeLanguages');

const YOUTUBE_TITLE_LIMIT = 100;
const YOUTUBE_DESCRIPTION_LIMIT = 5000;

function truncate(text, limit) {
  if (!text) return '';
  const clean = String(text).replace(/[<>]/g, '');
  if (clean.length <= limit) return clean;
  // Cut on a word boundary when possible, then add an ellipsis.
  const cut = clean.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Google Cloud Translation API (v2, API key)                          */
/* ------------------------------------------------------------------ */

async function translateWithGoogle({ apiKey, title, description, sourceLanguage, targetLanguage }) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;

  const q = [title || ''];
  if (description) q.push(description);

  const body = {
    q,
    target: getTranslateCode(targetLanguage),
    format: 'text'
  };

  const source = getTranslateCode(sourceLanguage);
  if (source) body.source = source;

  const response = await axios.post(url, body, { timeout: 30000 });
  const translations = response.data?.data?.translations || [];

  return {
    title: translations[0]?.translatedText || '',
    description: description ? (translations[1]?.translatedText || '') : ''
  };
}

/* ------------------------------------------------------------------ */
/* LLM providers (OpenAI / Gemini)                                     */
/* ------------------------------------------------------------------ */

async function translateWithOpenAI({ apiKey, model, prompt }) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );

  return response.data.choices[0].message.content;
}

async function translateWithGemini({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`;

  const response = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }]
  }, { timeout: 60000 });

  return response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function buildPrompt({ title, description, sourceLanguage, targetLanguages, maxTitleLength }) {
  return `
Translate the following YouTube metadata.

Rules:
- Keep meaning natural and human
- Title MUST be <= ${maxTitleLength} characters
- If too long → rewrite shorter but keep meaning
- Keep line breaks, hashtags and URLs in the description
- Output JSON only, keys are exactly the target language codes given

Source Language: ${sourceLanguage}
Target Languages: ${targetLanguages.join(', ')}

Title: ${title}
Description: ${description}

Output format:
{
  "${targetLanguages[0]}": { "title": "...", "description": "..." }
}
`;
}

function parseLlmJson(raw) {
  let cleaned = String(raw || '').trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/i, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[AI] Failed parsing JSON:', raw);
    return {};
  }
}

async function translateWithLlm({ user, title, description, sourceLanguage, targetLanguages, maxTitleLength }) {
  const prompt = buildPrompt({ title, description, sourceLanguage, targetLanguages, maxTitleLength });

  const raw = user.ai_provider === 'gemini'
    ? await translateWithGemini({ apiKey: user.ai_api_key, model: user.ai_model, prompt })
    : await translateWithOpenAI({ apiKey: user.ai_api_key, model: user.ai_model, prompt });

  return parseLlmJson(raw);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Translates title + description into every language in `targetLanguages`.
 * Returns `{ [youtubeLanguageCode]: { title, description } }` – ready to be
 * sent to `videos.update` as `localizations`. Languages that fail are skipped.
 */
async function translateMetadata({
  title,
  description = '',
  sourceLanguage = 'en',
  targetLanguages = [],
  maxTitleLength = YOUTUBE_TITLE_LIMIT,
  user,
  onProgress
}) {
  const languages = sanitizeLanguageList(targetLanguages).filter(code => code !== sourceLanguage);
  const result = {};

  if (!user || !user.ai_api_key) {
    console.warn('[Translate] No translation API key configured');
    return result;
  }
  if (!languages.length || !title) return result;

  const titleLimit = Math.min(parseInt(maxTitleLength, 10) || YOUTUBE_TITLE_LIMIT, YOUTUBE_TITLE_LIMIT);
  const provider = user.ai_provider || 'openai';

  for (let i = 0; i < languages.length; i++) {
    const lang = languages[i];
    try {
      let translated;

      if (provider === 'google') {
        translated = await translateWithGoogle({
          apiKey: user.ai_api_key,
          title,
          description,
          sourceLanguage,
          targetLanguage: lang
        });
      } else {
        // LLMs are rate limited – pace the calls a little.
        if (i > 0) await sleep(1500);
        const parsed = await translateWithLlm({
          user,
          title,
          description,
          sourceLanguage,
          targetLanguages: [lang],
          maxTitleLength: titleLimit
        });
        translated = parsed[lang] || parsed[getTranslateCode(lang)] || null;
      }

      if (translated && translated.title) {
        result[lang] = {
          title: truncate(translated.title, titleLimit),
          description: truncate(translated.description || '', YOUTUBE_DESCRIPTION_LIMIT)
        };
      } else {
        console.warn(`[Translate] Empty result for ${lang}`);
      }
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      console.error(`[Translate] Failed for ${lang}: ${detail}`);
    }

    if (typeof onProgress === 'function') {
      onProgress({ index: i + 1, total: languages.length, language: lang, ok: !!result[lang] });
    }
  }

  return result;
}

/**
 * Backwards compatible wrapper used by older code paths.
 */
async function buildLocalizedMetadata({ title, description, sourceLanguage, targetLanguages, maxTitleLength, user }) {
  return translateMetadata({ title, description, sourceLanguage, targetLanguages, maxTitleLength, user });
}

/**
 * Quick connectivity test for the configured provider (used by Settings → Test).
 */
async function testTranslationProvider(user) {
  const result = await translateMetadata({
    title: 'Hello world',
    description: '',
    sourceLanguage: 'en',
    targetLanguages: ['id'],
    user
  });
  if (!result.id) throw new Error('Provider returned no translation');
  return result.id.title;
}

module.exports = {
  translateMetadata,
  buildLocalizedMetadata,
  testTranslationProvider,
  YOUTUBE_TITLE_LIMIT
};
