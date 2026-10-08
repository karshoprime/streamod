// Google kadang menolak token yang sah dengan 401 "Invalid Credentials" selama
// beberapa detik. Ulangi otomatis panggilan yang ditolak sebelum dianggap gagal.
const { google } = require('googleapis');

google.options({
  retryConfig: {
    retry: 5,
    retryDelay: 1000,
    shouldRetry: (err) => {
      const cfg = (err.config && err.config.retryConfig) || {};
      const attempt = cfg.currentRetryAttempt || 0;
      if (attempt >= (cfg.retry || 0)) return false;
      const body = err.config && err.config.data;
      if (body && typeof body.pipe === 'function') return false; // upload stream tidak bisa diulang
      const status = err.response && err.response.status;
      const method = String((err.config && err.config.method) || 'GET').toUpperCase();
      if (status === 401) {
        console.warn(`[YouTubeRetry] 401 dari Google, mengulang (${attempt + 1}/${cfg.retry}): ${method} ${String(err.config.url || '').split('?')[0]}`);
        return true;
      }
      const idempotent = ['GET', 'HEAD', 'PUT', 'OPTIONS', 'DELETE'].includes(method);
      if (!err.response) return idempotent && attempt < 2;
      return idempotent && (status === 429 || status >= 500);
    }
  }
});
