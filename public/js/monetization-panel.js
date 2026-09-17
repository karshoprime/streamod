/**
 * Shared UI widgets:
 *   StreamodAds        – YouTube Studio-style monetization panel (create/edit forms, rotations, live modal)
 *   StreamodLang       – language picker for YouTube localizations (translate title & description)
 *   StreamodLiveMonetization – "Live Control Room" modal: live status, ad settings, Run ad break, Translate now
 *
 * Everything is vanilla JS + Tailwind classes (Tailwind CDN JIT compiles them at runtime).
 */
(function () {
  'use strict';

  const AD_DEFAULTS = {
    enabled: false,
    autoAds: true,
    frequency: 'MEDIUM',
    intervalMinutes: 12,
    strategy: 'CONCURRENT',
    delayMinutes: 0,
    adBreakDuration: 60
  };

  const INTERVALS = [6, 12, 18, 24, 30];
  const AD_BREAK_DURATIONS = [30, 60, 90, 120, 150, 180];

  function csrfHeaders(extra) {
    const token = document.querySelector('input[name="_csrf"]')?.value;
    return Object.assign({}, extra || {}, token ? { 'X-CSRF-Token': token } : {});
  }

  function toast(type, message) {
    if (typeof window.showToast === 'function') {
      window.showToast(type, message);
    } else {
      alert(message);
    }
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function normalize(settings) {
    let s = settings;
    if (typeof s === 'string') {
      try { s = s ? JSON.parse(s) : null; } catch (e) { s = null; }
    }
    if (typeof s === 'boolean') s = { enabled: s };
    s = Object.assign({}, AD_DEFAULTS, s || {});
    s.enabled = !!s.enabled;
    s.autoAds = s.autoAds !== false;
    s.frequency = ['LOW', 'MEDIUM', 'HIGH', 'CUSTOM'].includes(String(s.frequency).toUpperCase()) ? String(s.frequency).toUpperCase() : 'MEDIUM';
    s.strategy = String(s.strategy).toUpperCase() === 'NON_CONCURRENT' ? 'NON_CONCURRENT' : 'CONCURRENT';
    s.intervalMinutes = INTERVALS.includes(parseInt(s.intervalMinutes, 10)) ? parseInt(s.intervalMinutes, 10) : 12;
    s.delayMinutes = Math.max(0, parseInt(s.delayMinutes, 10) || 0);
    s.adBreakDuration = AD_BREAK_DURATIONS.includes(parseInt(s.adBreakDuration, 10)) ? parseInt(s.adBreakDuration, 10) : 60;
    return s;
  }

  /* ================================================================ */
  /* Monetization panel                                               */
  /* ================================================================ */

  const StreamodAds = {
    defaults: AD_DEFAULTS,
    normalize,

    /**
     * Renders the panel into `container` (element or id). All inputs are prefixed with `prefix`.
     */
    render(container, prefix, settings) {
      const el = typeof container === 'string' ? document.getElementById(container) : container;
      if (!el) return;
      const s = normalize(settings);
      const p = prefix;

      const toggle = (id, checked, label, help) => `
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-sm text-gray-200">${label}</div>
            ${help ? `<div class="text-xs text-gray-500">${help}</div>` : ''}
          </div>
          <label class="relative inline-flex items-center cursor-pointer flex-shrink-0">
            <input type="checkbox" id="${id}" class="sr-only peer" ${checked ? 'checked' : ''}>
            <div class="w-11 h-6 bg-dark-900 border border-gray-600 rounded-full peer peer-checked:bg-primary peer-checked:border-primary"></div>
            <div class="absolute left-[2px] top-[2px] w-5 h-5 bg-white rounded-full transition-all peer-checked:translate-x-5"></div>
          </label>
        </div>`;

      const freqBtn = (value, title, sub) => `
        <button type="button" data-ad-freq="${value}"
          class="ad-freq-btn text-left px-3 py-2 rounded-lg border transition-colors ${s.frequency === value ? 'border-primary bg-primary/10 text-white' : 'border-gray-600 bg-dark-900 text-gray-300 hover:border-gray-500'}">
          <div class="text-sm font-medium">${title}</div>
          <div class="text-[11px] text-gray-500 leading-tight">${sub}</div>
        </button>`;

      el.innerHTML = `
        <div class="ad-panel bg-dark-800/60 border border-gray-700 rounded-lg p-4 space-y-4" data-ad-prefix="${p}">
          <div class="flex items-center gap-2 text-white">
            <i class="ti ti-coin text-yellow-400"></i>
            <span class="text-sm font-semibold">Monetization</span>
            <span class="text-[11px] text-gray-500 ml-auto">Same controls as YouTube Studio · Live</span>
          </div>

          ${toggle(`${p}AdsEnabled`, s.enabled, 'Ads', 'Show ads on this live stream (pre-roll + mid-roll)')}

          <div id="${p}AdsBody" class="space-y-4 ${s.enabled ? '' : 'hidden'}">
            ${toggle(`${p}AutoAds`, s.autoAds, 'Auto ad breaks', 'YouTube inserts mid-roll ad breaks automatically')}

            <div id="${p}AutoBody" class="space-y-4 ${s.autoAds ? '' : 'hidden'}">
              <div>
                <div class="text-xs text-gray-400 mb-2">Ad break frequency</div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  ${freqBtn('LOW', 'Low', 'Fewer ads · less interruption')}
                  ${freqBtn('MEDIUM', 'Medium', 'Balanced (recommended)')}
                  ${freqBtn('HIGH', 'High', 'More ads · higher revenue')}
                  ${freqBtn('CUSTOM', 'Custom', 'Fixed interval you choose')}
                </div>
                <input type="hidden" id="${p}AdFrequency" value="${s.frequency}">
              </div>

              <div id="${p}CustomBody" class="grid grid-cols-1 sm:grid-cols-2 gap-3 ${s.frequency === 'CUSTOM' ? '' : 'hidden'}">
                <div>
                  <label class="text-xs text-gray-400 block mb-1">Run an ad break every</label>
                  <select id="${p}AdInterval" class="w-full px-3 py-2 bg-dark-900 border border-gray-600 rounded-lg text-sm text-white">
                    ${INTERVALS.map(m => `<option value="${m}" ${s.intervalMinutes === m ? 'selected' : ''}>${m} minutes</option>`).join('')}
                  </select>
                </div>
                <div>
                  <label class="text-xs text-gray-400 block mb-1">Viewers</label>
                  <select id="${p}AdStrategy" class="w-full px-3 py-2 bg-dark-900 border border-gray-600 rounded-lg text-sm text-white">
                    <option value="CONCURRENT" ${s.strategy === 'CONCURRENT' ? 'selected' : ''}>Same time for all viewers</option>
                    <option value="NON_CONCURRENT" ${s.strategy === 'NON_CONCURRENT' ? 'selected' : ''}>Staggered per viewer</option>
                  </select>
                </div>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs text-gray-400 block mb-1">Delay ads at start</label>
                  <div class="flex items-center gap-2">
                    <input type="number" id="${p}AdDelay" min="0" max="1440" step="1" value="${s.delayMinutes}"
                      class="w-full px-3 py-2 bg-dark-900 border border-gray-600 rounded-lg text-sm text-white">
                    <span class="text-xs text-gray-500 whitespace-nowrap">min after start</span>
                  </div>
                  <div class="text-[11px] text-gray-500 mt-1">0 = ads can run right away</div>
                </div>
                <div>
                  <label class="text-xs text-gray-400 block mb-1">Default ad break length</label>
                  <select id="${p}AdBreakDuration" class="w-full px-3 py-2 bg-dark-900 border border-gray-600 rounded-lg text-sm text-white">
                    ${AD_BREAK_DURATIONS.map(d => `<option value="${d}" ${s.adBreakDuration === d ? 'selected' : ''}>${d} seconds</option>`).join('')}
                  </select>
                  <div class="text-[11px] text-gray-500 mt-1">Used by "Run ad break" while live</div>
                </div>
              </div>
            </div>

            <div id="${p}ManualNote" class="text-xs text-gray-500 ${s.autoAds ? 'hidden' : ''}">
              Auto ad breaks are off. Ads only run when you press <b>Run ad break</b> in the live monetization panel.
            </div>
          </div>

          <div id="${p}AdSummary" class="text-xs text-gray-400 border-t border-gray-700 pt-3">${esc(StreamodAds.describe(s))}</div>
        </div>`;

      // Wiring
      const q = id => document.getElementById(id);
      const refresh = () => {
        const cur = StreamodAds.read(p);
        q(`${p}AdsBody`).classList.toggle('hidden', !cur.enabled);
        q(`${p}AutoBody`).classList.toggle('hidden', !cur.autoAds);
        q(`${p}ManualNote`).classList.toggle('hidden', cur.autoAds);
        q(`${p}CustomBody`).classList.toggle('hidden', cur.frequency !== 'CUSTOM');
        el.querySelectorAll('.ad-freq-btn').forEach(btn => {
          const active = btn.dataset.adFreq === cur.frequency;
          btn.className = `ad-freq-btn text-left px-3 py-2 rounded-lg border transition-colors ${active ? 'border-primary bg-primary/10 text-white' : 'border-gray-600 bg-dark-900 text-gray-300 hover:border-gray-500'}`;
        });
        q(`${p}AdSummary`).textContent = StreamodAds.describe(cur);
        el.dispatchEvent(new CustomEvent('adsettingschange', { detail: cur, bubbles: true }));
      };

      el.querySelectorAll('.ad-freq-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          q(`${p}AdFrequency`).value = btn.dataset.adFreq;
          refresh();
        });
      });
      [`${p}AdsEnabled`, `${p}AutoAds`, `${p}AdInterval`, `${p}AdStrategy`, `${p}AdDelay`, `${p}AdBreakDuration`].forEach(id => {
        const node = q(id);
        if (node) node.addEventListener('change', refresh);
      });
    },

    read(prefix) {
      const q = id => document.getElementById(id);
      const p = prefix;
      if (!q(`${p}AdsEnabled`)) return normalize(null);
      return normalize({
        enabled: q(`${p}AdsEnabled`).checked,
        autoAds: q(`${p}AutoAds`).checked,
        frequency: q(`${p}AdFrequency`).value,
        intervalMinutes: q(`${p}AdInterval`).value,
        strategy: q(`${p}AdStrategy`).value,
        delayMinutes: q(`${p}AdDelay`).value,
        adBreakDuration: q(`${p}AdBreakDuration`).value
      });
    },

    set(prefix, settings) {
      const container = document.querySelector(`[data-ad-prefix="${prefix}"]`)?.parentElement;
      if (container) StreamodAds.render(container, prefix, settings);
    },

    describe(settings) {
      const s = normalize(settings);
      if (!s.enabled) return 'Ads off';
      if (!s.autoAds) return 'Ads on · manual ad breaks only';
      const freq = s.frequency === 'CUSTOM'
        ? `every ${s.intervalMinutes} min (${s.strategy === 'CONCURRENT' ? 'same time for all' : 'staggered'})`
        : `${s.frequency.charAt(0)}${s.frequency.slice(1).toLowerCase()} frequency`;
      const delay = s.delayMinutes > 0 ? ` · first ad after ${s.delayMinutes} min` : '';
      return `Ads on · auto ad breaks ${freq}${delay}`;
    }
  };

  /* ================================================================ */
  /* Language picker                                                  */
  /* ================================================================ */

  let languageCache = null;

  const StreamodLang = {
    async load() {
      if (languageCache) return languageCache;
      const res = await fetch('/api/languages');
      const data = await res.json();
      languageCache = { languages: data.languages || [], presets: data.presets || [] };
      return languageCache;
    },

    /**
     * opts: { selected: [], sourceLanguage: 'en', showSource: true, enabled: bool, title }
     */
    async render(container, prefix, opts) {
      const el = typeof container === 'string' ? document.getElementById(container) : container;
      if (!el) return;
      const { languages, presets } = await StreamodLang.load();
      const o = Object.assign({ selected: [], sourceLanguage: 'en', showSource: true, enabled: null, title: 'Translate title & description' }, opts || {});
      const selected = new Set(o.selected || []);
      const enabled = o.enabled === null ? selected.size > 0 : !!o.enabled;
      const p = prefix;

      el.innerHTML = `
        <div class="lang-panel bg-dark-800/60 border border-gray-700 rounded-lg p-4 space-y-3" data-lang-prefix="${p}">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 text-white">
              <i class="ti ti-language text-blue-400"></i>
              <span class="text-sm font-semibold">${esc(o.title)}</span>
            </div>
            <label class="relative inline-flex items-center cursor-pointer flex-shrink-0">
              <input type="checkbox" id="${p}LangEnabled" class="sr-only peer" ${enabled ? 'checked' : ''}>
              <div class="w-11 h-6 bg-dark-900 border border-gray-600 rounded-full peer peer-checked:bg-primary peer-checked:border-primary"></div>
              <div class="absolute left-[2px] top-[2px] w-5 h-5 bg-white rounded-full transition-all peer-checked:translate-x-5"></div>
            </label>
          </div>

          <div id="${p}LangBody" class="space-y-3 ${enabled ? '' : 'hidden'}">
            <div class="grid grid-cols-1 ${o.showSource ? 'sm:grid-cols-2' : ''} gap-3">
              ${o.showSource ? `
              <div>
                <label class="text-xs text-gray-400 block mb-1">Source language (what you wrote)</label>
                <select id="${p}LangSource" class="w-full px-3 py-2 bg-dark-900 border border-gray-600 rounded-lg text-sm text-white">
                  ${languages.map(l => `<option value="${l.code}" ${l.code === o.sourceLanguage ? 'selected' : ''}>${esc(l.name)} (${l.code})</option>`).join('')}
                </select>
              </div>` : ''}
              <div>
                <label class="text-xs text-gray-400 block mb-1">Search languages</label>
                <input type="text" id="${p}LangSearch" placeholder="Type to filter…" class="w-full px-3 py-2 bg-dark-900 border border-gray-600 rounded-lg text-sm text-white">
              </div>
            </div>

            <div class="flex flex-wrap gap-2 items-center">
              <span class="text-[11px] text-gray-500">Presets:</span>
              ${presets.map(pr => `<button type="button" data-lang-preset="${pr.key}" class="px-2.5 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-[11px] text-gray-200">${esc(pr.name)}</button>`).join('')}
              <button type="button" data-lang-clear class="px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-[11px] text-gray-400 ml-auto">Clear</button>
            </div>

            <div id="${p}LangGrid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5 max-h-56 overflow-y-auto pr-1">
              ${languages.map(l => `
                <label class="lang-item flex items-center gap-2 px-2 py-1.5 rounded-md bg-dark-900 hover:bg-gray-700 text-xs text-gray-200 cursor-pointer" data-lang-name="${esc(l.name.toLowerCase())} ${l.code.toLowerCase()}">
                  <input type="checkbox" value="${l.code}" class="accent-blue-500 lang-cb" ${selected.has(l.code) ? 'checked' : ''}>
                  <span class="truncate">${esc(l.name)} <span class="text-gray-500">(${l.code})</span></span>
                </label>`).join('')}
            </div>

            <div id="${p}LangSummary" class="text-xs text-gray-400"></div>
          </div>
        </div>`;

      const q = id => document.getElementById(id);
      const summary = () => {
        const n = StreamodLang.read(p).length;
        q(`${p}LangSummary`).textContent = n ? `${n} language(s) selected – YouTube shows viewers the title/description in their own language.` : 'No languages selected.';
      };
      q(`${p}LangEnabled`).addEventListener('change', () => {
        q(`${p}LangBody`).classList.toggle('hidden', !q(`${p}LangEnabled`).checked);
      });
      q(`${p}LangSearch`).addEventListener('input', () => {
        const term = q(`${p}LangSearch`).value.trim().toLowerCase();
        el.querySelectorAll('.lang-item').forEach(item => {
          item.classList.toggle('hidden', term && !item.dataset.langName.includes(term));
        });
      });
      el.querySelectorAll('[data-lang-preset]').forEach(btn => {
        btn.addEventListener('click', () => {
          const preset = presets.find(pr => pr.key === btn.dataset.langPreset);
          if (!preset) return;
          const codes = new Set(preset.codes);
          el.querySelectorAll('.lang-cb').forEach(cb => { cb.checked = codes.has(cb.value); });
          summary();
        });
      });
      el.querySelector('[data-lang-clear]').addEventListener('click', () => {
        el.querySelectorAll('.lang-cb').forEach(cb => { cb.checked = false; });
        summary();
      });
      el.querySelectorAll('.lang-cb').forEach(cb => cb.addEventListener('change', summary));
      summary();
    },

    /** Selected language codes ([] when the toggle is off). */
    read(prefix) {
      const enabled = document.getElementById(`${prefix}LangEnabled`);
      if (!enabled || !enabled.checked) return [];
      const panel = document.querySelector(`[data-lang-prefix="${prefix}"]`);
      if (!panel) return [];
      return Array.from(panel.querySelectorAll('.lang-cb:checked')).map(cb => cb.value);
    },

    readSource(prefix) {
      const sel = document.getElementById(`${prefix}LangSource`);
      return sel ? sel.value : 'en';
    }
  };

  /* ================================================================ */
  /* Live monetization modal ("Live Control Room")                    */
  /* ================================================================ */

  let modalEl = null;
  let currentStreamId = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'liveMonetizationModal';
    modalEl.className = 'fixed inset-0 z-[9990] hidden';
    modalEl.innerHTML = `
      <div class="absolute inset-0 bg-black/70" data-lm-close></div>
      <div class="absolute inset-x-3 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 top-4 sm:top-8 w-auto sm:w-[720px] max-w-full bg-dark-800 border border-gray-700 rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">
        <div class="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <div class="min-w-0">
            <h3 class="text-lg font-semibold text-white flex items-center gap-2"><i class="ti ti-coin text-yellow-400"></i> Live monetization</h3>
            <p id="lmTitle" class="text-xs text-gray-400 truncate"></p>
          </div>
          <button type="button" class="text-gray-400 hover:text-white" data-lm-close><i class="ti ti-x text-xl"></i></button>
        </div>

        <div class="p-5 space-y-5 overflow-y-auto">
          <div id="lmStatus" class="rounded-lg border border-gray-700 bg-dark-900 p-3 text-sm text-gray-300">Loading…</div>

          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-medium text-white">Ad settings</span>
              <button type="button" id="lmRefresh" class="text-xs text-blue-400 hover:underline"><i class="ti ti-refresh"></i> Refresh from YouTube</button>
            </div>
            <div id="lmAdPanel"></div>
            <div class="flex justify-end mt-3">
              <button type="button" id="lmSave" class="px-4 py-2 bg-primary hover:bg-blue-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
                <i class="ti ti-device-floppy mr-1"></i>Save & apply
              </button>
            </div>
          </div>

          <div id="lmAdBreakBox" class="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
            <div class="flex flex-col sm:flex-row sm:items-center gap-3">
              <div class="flex-1">
                <div class="text-sm font-medium text-white">Run ad break now</div>
                <div class="text-xs text-gray-400">Manual mid-roll, exactly like the button in YouTube Studio. Only works while the broadcast is live.</div>
              </div>
              <select id="lmAdBreakDuration" class="px-3 py-2 bg-dark-900 border border-gray-600 rounded-lg text-sm text-white">
                ${AD_BREAK_DURATIONS.map(d => `<option value="${d}">${d} sec</option>`).join('')}
              </select>
              <button type="button" id="lmRunAdBreak" class="px-4 py-2 bg-yellow-500 hover:bg-yellow-400 text-black text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
                <i class="ti ti-player-play mr-1"></i>Run ad break
              </button>
            </div>
          </div>

          <div>
            <div id="lmLangPanel"></div>
            <div class="flex items-center justify-between mt-3 gap-3">
              <div id="lmTranslateStatus" class="text-xs text-gray-400"></div>
              <button type="button" id="lmTranslate" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
                <i class="ti ti-language mr-1"></i>Translate now
              </button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modalEl);

    modalEl.querySelectorAll('[data-lm-close]').forEach(n => n.addEventListener('click', StreamodLiveMonetization.close));
    modalEl.querySelector('#lmRefresh').addEventListener('click', () => StreamodLiveMonetization.load(true));
    modalEl.querySelector('#lmSave').addEventListener('click', StreamodLiveMonetization.save);
    modalEl.querySelector('#lmRunAdBreak').addEventListener('click', StreamodLiveMonetization.runAdBreak);
    modalEl.querySelector('#lmTranslate').addEventListener('click', StreamodLiveMonetization.translateNow);
    return modalEl;
  }

  function statusHtml(data) {
    const live = data.live;
    const st = data.streamStatus;
    const pill = (text, cls) => `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${cls}">${text}</span>`;

    let rows = [];
    rows.push(`<div class="flex items-center gap-2"><span class="text-gray-500 w-28">Stream</span>${pill(st || 'offline', st === 'live' ? 'bg-red-500/20 text-red-300' : 'bg-gray-700 text-gray-300')}</div>`);

    if (!data.broadcastId) {
      rows.push(`<div class="text-xs text-gray-400 mt-1">The YouTube broadcast hasn't been created yet. Settings below are saved and applied automatically when the stream starts.</div>`);
      return rows.join('');
    }

    if (data.liveError) {
      rows.push(`<div class="text-xs text-red-300 mt-1">Could not read live state from YouTube: ${esc(data.liveError)}</div>`);
      return rows.join('');
    }

    if (live) {
      const elig = live.eligibleForAdsMonetization;
      const eligText = elig === true || String(elig).toLowerCase() === 'true'
        ? pill('Eligible for ads', 'bg-green-500/20 text-green-300')
        : (elig === undefined || elig === null ? pill('Eligibility unknown', 'bg-gray-700 text-gray-300') : pill('Not eligible for ads', 'bg-red-500/20 text-red-300'));
      rows.push(`<div class="flex items-center gap-2"><span class="text-gray-500 w-28">Broadcast</span>${pill(live.lifeCycleStatus || '-', 'bg-gray-700 text-gray-300')} <span class="text-[11px] text-gray-500">${esc(data.broadcastId)}</span></div>`);
      rows.push(`<div class="flex items-center gap-2"><span class="text-gray-500 w-28">Monetization</span>${eligText}${pill(`Ads ${String(live.adsMonetizationStatus || 'unknown').toUpperCase()}`, String(live.adsMonetizationStatus).toUpperCase() === 'ON' ? 'bg-yellow-500/20 text-yellow-300' : 'bg-gray-700 text-gray-300')}</div>`);
      if (live.cuepointSchedule) {
        const cs = live.cuepointSchedule;
        const parts = [];
        parts.push(cs.enabled ? 'auto ad breaks on' : 'auto ad breaks off');
        if (cs.ytOptimizedCuepointConfig) parts.push(`${String(cs.ytOptimizedCuepointConfig).toLowerCase()} frequency`);
        const cfg = cs.creatorCuepointConfig || cs;
        if (cfg.repeatIntervalSecs) parts.push(`every ${Math.round(cfg.repeatIntervalSecs / 60)} min`);
        if (cs.pauseAdsUntil && new Date(cs.pauseAdsUntil) > new Date()) parts.push(`paused until ${new Date(cs.pauseAdsUntil).toLocaleTimeString()}`);
        rows.push(`<div class="flex items-center gap-2"><span class="text-gray-500 w-28">On YouTube</span><span class="text-xs text-gray-300">${esc(parts.join(' · '))}</span></div>`);
      }
    }
    return rows.join('');
  }

  const StreamodLiveMonetization = {
    async open(streamId, opts) {
      ensureModal();
      currentStreamId = streamId;
      modalEl.querySelector('#lmTitle').textContent = (opts && opts.title) || '';
      modalEl.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      await StreamodLiveMonetization.load(false);
    },

    close() {
      if (!modalEl) return;
      modalEl.classList.add('hidden');
      document.body.style.overflow = '';
      currentStreamId = null;
    },

    async load(fromYoutube) {
      if (!currentStreamId) return;
      const status = modalEl.querySelector('#lmStatus');
      status.innerHTML = 'Loading…';
      try {
        const res = await fetch(`/api/streams/${currentStreamId}/monetization`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to load');

        status.innerHTML = statusHtml(data);
        // Prefer what YouTube reports when the broadcast exists and we could read it
        const settings = (fromYoutube && data.live && data.live.settings)
          ? Object.assign({}, data.settings, data.live.settings, { adBreakDuration: data.settings.adBreakDuration, delayMinutes: data.settings.delayMinutes })
          : data.settings;
        StreamodAds.render(modalEl.querySelector('#lmAdPanel'), 'lm', settings);
        modalEl.querySelector('#lmAdBreakDuration').value = String(settings.adBreakDuration || 60);

        const isLive = data.streamStatus === 'live' && !!data.broadcastId;
        modalEl.querySelector('#lmRunAdBreak').disabled = !isLive;
        modalEl.querySelector('#lmAdBreakBox').classList.toggle('opacity-60', !isLive);

        // Languages
        const streamRes = await fetch(`/api/streams/${currentStreamId}`);
        const streamData = await streamRes.json();
        let selected = [];
        try { selected = JSON.parse(streamData.stream?.youtube_localizations || '[]'); } catch (e) { selected = []; }
        await StreamodLang.render(modalEl.querySelector('#lmLangPanel'), 'lm', {
          selected,
          sourceLanguage: streamData.stream?.youtube_source_language || 'en',
          title: 'Translate title & description'
        });
        modalEl.querySelector('#lmTranslateStatus').textContent = data.broadcastId
          ? 'Translations are written to the broadcast as YouTube localizations.'
          : 'Languages are saved now and applied when the broadcast is created.';
      } catch (err) {
        status.innerHTML = `<span class="text-red-300">${esc(err.message)}</span>`;
      }
    },

    async save() {
      if (!currentStreamId) return;
      const btn = modalEl.querySelector('#lmSave');
      btn.disabled = true;
      try {
        const settings = StreamodAds.read('lm');
        const res = await fetch(`/api/streams/${currentStreamId}/monetization`, {
          method: 'PUT',
          headers: csrfHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ settings })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to save');
        toast(data.syncError ? 'warning' : 'success', data.message);

        // Save languages too (no translation yet unless the user presses Translate now)
        const languages = StreamodLang.read('lm');
        await fetch(`/api/streams/${currentStreamId}`, {
          method: 'PUT',
          headers: csrfHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ streamMode: 'youtube', ytLocalizations: languages, ytSourceLanguage: StreamodLang.readSource('lm') })
        }).catch(() => {});

        await StreamodLiveMonetization.load(false);
        if (typeof window.refreshStreamsView === 'function') window.refreshStreamsView();
      } catch (err) {
        toast('error', err.message);
      } finally {
        btn.disabled = false;
      }
    },

    async runAdBreak() {
      if (!currentStreamId) return;
      const btn = modalEl.querySelector('#lmRunAdBreak');
      const duration = modalEl.querySelector('#lmAdBreakDuration').value;
      btn.disabled = true;
      const original = btn.innerHTML;
      btn.innerHTML = '<i class="ti ti-loader animate-spin mr-1"></i>Inserting…';
      try {
        const res = await fetch(`/api/streams/${currentStreamId}/monetization/ad-break`, {
          method: 'POST',
          headers: csrfHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ durationSecs: duration })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        toast('success', data.message);
      } catch (err) {
        toast('error', err.message);
      } finally {
        btn.innerHTML = original;
        btn.disabled = false;
      }
    },

    async translateNow() {
      if (!currentStreamId) return;
      const btn = modalEl.querySelector('#lmTranslate');
      const statusEl = modalEl.querySelector('#lmTranslateStatus');
      const languages = StreamodLang.read('lm');
      if (!languages.length) {
        toast('error', 'Select at least one language first');
        return;
      }
      btn.disabled = true;
      const original = btn.innerHTML;
      btn.innerHTML = '<i class="ti ti-loader animate-spin mr-1"></i>Translating…';
      statusEl.textContent = `Translating into ${languages.length} language(s)… this can take a while.`;
      try {
        const res = await fetch(`/api/streams/${currentStreamId}/translate`, {
          method: 'POST',
          headers: csrfHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ languages, sourceLanguage: StreamodLang.readSource('lm') })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        statusEl.textContent = `${data.message}${data.failed && data.failed.length ? ` · failed: ${data.failed.join(', ')}` : ''}`;
        toast('success', data.message);
      } catch (err) {
        statusEl.textContent = err.message;
        toast('error', err.message);
      } finally {
        btn.innerHTML = original;
        btn.disabled = false;
      }
    }
  };

  window.StreamodAds = StreamodAds;
  window.StreamodLang = StreamodLang;
  window.StreamodLiveMonetization = StreamodLiveMonetization;
})();
