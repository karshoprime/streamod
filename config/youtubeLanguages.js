/**
 * Languages supported by YouTube localizations (i18nLanguages list).
 * `code`      – the code YouTube expects in `localizations`
 * `name`      – display name
 * `translate` – the code to send to the translation provider when it differs
 *               from the YouTube code (Google Cloud Translation / OpenAI / Gemini)
 */
const YOUTUBE_LANGUAGES = [
  { code: 'af', name: 'Afrikaans' },
  { code: 'am', name: 'Amharic' },
  { code: 'ar', name: 'Arabic' },
  { code: 'as', name: 'Assamese' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'be', name: 'Belarusian' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'bn', name: 'Bengali' },
  { code: 'bs', name: 'Bosnian' },
  { code: 'ca', name: 'Catalan' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'en', name: 'English' },
  { code: 'en-GB', name: 'English (UK)', translate: 'en' },
  { code: 'en-IN', name: 'English (India)', translate: 'en' },
  { code: 'es', name: 'Spanish (Spain)' },
  { code: 'es-419', name: 'Spanish (Latin America)', translate: 'es' },
  { code: 'es-US', name: 'Spanish (US)', translate: 'es' },
  { code: 'et', name: 'Estonian' },
  { code: 'eu', name: 'Basque' },
  { code: 'fa', name: 'Persian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fil', name: 'Filipino', translate: 'tl' },
  { code: 'fr', name: 'French' },
  { code: 'fr-CA', name: 'French (Canada)', translate: 'fr' },
  { code: 'gl', name: 'Galician' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hr', name: 'Croatian' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'hy', name: 'Armenian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'is', name: 'Icelandic' },
  { code: 'it', name: 'Italian' },
  { code: 'iw', name: 'Hebrew', translate: 'he' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ka', name: 'Georgian' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'km', name: 'Khmer' },
  { code: 'kn', name: 'Kannada' },
  { code: 'ko', name: 'Korean' },
  { code: 'ky', name: 'Kyrgyz' },
  { code: 'lo', name: 'Lao' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'lv', name: 'Latvian' },
  { code: 'mk', name: 'Macedonian' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'mn', name: 'Mongolian' },
  { code: 'mr', name: 'Marathi' },
  { code: 'ms', name: 'Malay' },
  { code: 'my', name: 'Burmese' },
  { code: 'ne', name: 'Nepali' },
  { code: 'nl', name: 'Dutch' },
  { code: 'no', name: 'Norwegian' },
  { code: 'or', name: 'Odia' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese (Brazil)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)', translate: 'pt-PT' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'si', name: 'Sinhala' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'sq', name: 'Albanian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sr-Latn', name: 'Serbian (Latin)', translate: 'sr' },
  { code: 'sv', name: 'Swedish' },
  { code: 'sw', name: 'Swahili' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'uz', name: 'Uzbek' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', translate: 'zh-CN' },
  { code: 'zh-HK', name: 'Chinese (Hong Kong)', translate: 'zh-TW' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', translate: 'zh-TW' },
  { code: 'zu', name: 'Zulu' }
];

/**
 * Handy presets shown in the UI. Order matters (shown as buttons).
 */
const LANGUAGE_PRESETS = [
  {
    key: 'top10',
    name: 'Top 10 global',
    codes: ['en', 'es', 'pt', 'hi', 'ar', 'id', 'ru', 'ja', 'de', 'fr']
  },
  {
    key: 'asia',
    name: 'Asia',
    codes: ['id', 'ms', 'th', 'vi', 'fil', 'ja', 'ko', 'zh-CN', 'zh-TW', 'hi', 'bn', 'ta', 'te', 'ur']
  },
  {
    key: 'europe',
    name: 'Europe',
    codes: ['en', 'de', 'fr', 'es', 'it', 'pt-PT', 'nl', 'pl', 'sv', 'da', 'no', 'fi', 'cs', 'ro', 'hu', 'el', 'uk', 'ru', 'tr']
  },
  {
    key: 'americas',
    name: 'Americas',
    codes: ['en', 'es-419', 'pt', 'fr-CA']
  },
  {
    key: 'all',
    name: 'All languages',
    codes: YOUTUBE_LANGUAGES.map(l => l.code)
  }
];

const LANGUAGE_MAP = new Map(YOUTUBE_LANGUAGES.map(l => [l.code, l]));

function isValidLanguage(code) {
  return LANGUAGE_MAP.has(code);
}

function getTranslateCode(code) {
  const lang = LANGUAGE_MAP.get(code);
  if (!lang) return code;
  return lang.translate || lang.code;
}

function getLanguageName(code) {
  const lang = LANGUAGE_MAP.get(code);
  return lang ? lang.name : code;
}

function sanitizeLanguageList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(code => typeof code === 'string' && isValidLanguage(code)))];
}

module.exports = {
  YOUTUBE_LANGUAGES,
  LANGUAGE_PRESETS,
  isValidLanguage,
  getTranslateCode,
  getLanguageName,
  sanitizeLanguageList
};
