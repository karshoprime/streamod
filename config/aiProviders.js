module.exports = {
  google: {
    name: 'Google Cloud Translation API',
    keyLabel: 'API Key (Cloud Translation)',
    keyHelp: 'Google Cloud Console → APIs & Services → Credentials → API key (restrict to Cloud Translation API).',
    models: []
  },
  openai: {
    name: 'OpenAI',
    keyLabel: 'API Key',
    keyHelp: 'platform.openai.com → API keys',
    models: [
      'gpt-4o-mini',
      'gpt-4.1-mini',
      'gpt-4.1',
      'gpt-4o'
    ]
  },
  gemini: {
    name: 'Google Gemini',
    keyLabel: 'API Key',
    keyHelp: 'aistudio.google.com → Get API key',
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-3.1-pro-preview'
    ]
  }
};
