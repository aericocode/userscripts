// ==UserScript==
// @name         Beat Bar
// @namespace    https://github.com/Aericocode/userscripts
// @version      2.4.0
// @description  Detect & visualize beats on direct-MP4 OR HLS-streaming videos. Sniffs m3u8 playlists, fetches lowest-quality variant, transmuxes TS→fMP4 audio, runs offline beat detection, overlays scrolling beat bar synced to playback.
// @author       Aericocode
// @match        https://pmvhaven.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @require      https://cdn.jsdelivr.net/npm/mux.js@7.0.3/dist/mux.min.js
// @run-at       document-start
// @noframes
// ==/UserScript==

(function() {
  'use strict';

  // ── Constants & Config ──────────────────────────────────
  const SCRIPT_NAME = 'BeatBar';
  const DB_NAME = 'beatbar-cache';
  const DB_STORE = 'beats';
  const DB_VERSION = 1;
  const MAX_FETCH_BYTES = 250 * 1024 * 1024;
  const PLAYHEAD_X_FRAC = 0.5;
  const PLAYBACK_BAR_OFFSET = 70; // raise above native playback controls
  const HLS_SEG_CONCURRENCY = 4;
  const PREFERRED_HLS_QUALITY = '240p';
  const FALLBACK_QUALITY_ORDER = ['240p', '360p', '480p', '720p', '1080p'];
  const MIN_VIDEO_AREA = 556 * 312;

  const SIZE_HEIGHTS = { small: 60, medium: 90, large: 130 };

  const PRESETS = {
    kick: { bandLow: 40, bandHigh: 120, minBpm: 80, maxBpm: 180, sensitivity: 1.5, avgWindow: 1.0, q: 1.5 },
    snare: { bandLow: 150, bandHigh: 300, minBpm: 60, maxBpm: 160, sensitivity: 1.6, avgWindow: 0.8, q: 1.5 },
    broad: { bandLow: 30, bandHigh: 500, minBpm: 100, maxBpm: 280, sensitivity: 1.35, avgWindow: 0.4, q: 1.0 },
  };

  const DEFAULT_CONFIG = {
    enabled: true,            // page-level on/off, persists across reloads
    preset: 'kick',
    lookahead: 5,
    showOverlay: true,
    tickEnabled: false,
    autoMaxSizeMB: 100,
    hlsQuality: PREFERRED_HLS_QUALITY,
    onlyLargest: true,
    minVideoArea: MIN_VIDEO_AREA,
    tickLeadMs: 30,           // VISUAL lead — fires pulse/tick N ms before beat (latency comp)
    beatOffsetMs: 0,          // TIMING shift — moves the actual beat marker by N ms (negative = earlier)
    sensitivity: 1.0,         // multiplier on preset sensitivity, 0.5–3.0
    size: 'medium',
  };

  // ── Utilities ───────────────────────────────────────────
  const log = (...args) => console.log(`[${SCRIPT_NAME}]`, ...args);
  const warn = (...args) => console.warn(`[${SCRIPT_NAME}]`, ...args);
  const err = (...args) => console.error(`[${SCRIPT_NAME}]`, ...args);

  function getConfig() {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(GM_getValue('config', '{}')) };
    } catch { return { ...DEFAULT_CONFIG }; }
  }
  function saveConfig(cfg) { GM_setValue('config', JSON.stringify(cfg)); }
  let config = getConfig();

  // Cache key params — anything that affects detection output goes here.
  // Stored on the cache entry; we recompute when this string differs.
  function cacheParams() {
    return `${config.preset}@s${(config.sensitivity || 1).toFixed(2)}`;
  }

  function currentOverlayHeight() {
    return SIZE_HEIGHTS[config.size] || SIZE_HEIGHTS.medium;
  }

  // ── State ───────────────────────────────────────────────
  const videoStates = new WeakMap();
  let pageEnabled = config.enabled !== false;

  const sniffedM3u8s = [];
  const M3U8_BUFFER_MAX = 50;

  // ═══════════════════════════════════════════════════════
  //   NETWORK SNIFFER (document-start)
  // ═══════════════════════════════════════════════════════
  (function installSniffer() {
    function recordIfM3u8(url) {
      if (!url || typeof url !== 'string') return;
      if (!/\.m3u8(\?|$)/i.test(url)) return;
      let abs;
      try { abs = new URL(url, location.href).href; } catch { return; }
      if (sniffedM3u8s.some(e => e.url === abs)) return;
      const entry = { url: abs, ts: Date.now(), host: location.hostname, used: false };
      sniffedM3u8s.push(entry);
      if (sniffedM3u8s.length > M3U8_BUFFER_MAX) sniffedM3u8s.shift();
      log('m3u8 sniffed:', abs);
      onM3u8Sniffed(entry);
    }

    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const req = args[0];
      const url = (typeof req === 'string') ? req : (req && req.url);
      recordIfM3u8(url);
      return origFetch.apply(this, args);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      try { recordIfM3u8(url); } catch {}
      return origOpen.call(this, method, url, ...rest);
    };

    log('Network sniffer installed at', document.readyState);
  })();

  function onM3u8Sniffed(entry) {
    if (!pageEnabled) return;
    document.querySelectorAll('video').forEach(v => {
      const state = videoStates.get(v);
      if (state && state.waitingForM3u8 && !state.m3u8Url) {
        attachM3u8ToVideo(state, entry);
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  //   IndexedDB cache
  // ═══════════════════════════════════════════════════════
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'url' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function cacheGet(url) {
    try {
      const db = await openDb();
      return new Promise((resolve) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(url);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  }
  async function cacheSet(url, beats, bpm, params) {
    try {
      const db = await openDb();
      return new Promise((resolve) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put({ url, beats, bpm, params, savedAt: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch { return false; }
  }

  // ═══════════════════════════════════════════════════════
  //   GM-based fetch (CORS bypass)
  // ═══════════════════════════════════════════════════════
  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: opts.responseType || 'arraybuffer',
        onprogress: opts.onProgress ? (e) => {
          if (e.lengthComputable) opts.onProgress(e.loaded, e.total);
        } : undefined,
        onload: (resp) => {
          if (resp.status >= 200 && resp.status < 300) {
            resolve(opts.responseType === 'text' ? resp.responseText : resp.response);
          } else {
            reject(new Error(`HTTP ${resp.status}`));
          }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  // ═══════════════════════════════════════════════════════
  //   HLS pipeline
  // ═══════════════════════════════════════════════════════
  function buildLowQualityVariantUrl(originalUrl, preferredQuality) {
    const filenameMatch = originalUrl.match(/\/([^\/?]+\.m3u8)(\?|$)/i);
    if (!filenameMatch) return null;
    const filename = filenameMatch[1];
    const qualityMatch = filename.match(/^(\d+p)\.m3u8$/i);
    if (qualityMatch) {
      const swapped = filename.replace(/^\d+p\.m3u8$/i, `${preferredQuality}.m3u8`);
      return originalUrl.replace(filename, swapped);
    }
    return null;
  }

  async function fetchAndParseM3u8(url) {
    const text = await gmFetch(url, { responseType: 'text' });
    return parseM3u8(text, url);
  }

  function parseM3u8(text, baseUrl) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
    if (isMaster) {
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const info = parseAttrList(lines[i]);
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) j++;
          if (j < lines.length) {
            variants.push({
              bandwidth: parseInt(info.BANDWIDTH || '0', 10),
              resolution: info.RESOLUTION || '',
              url: new URL(lines[j], baseUrl).href,
            });
          }
        }
      }
      return { kind: 'master', variants };
    } else {
      const segments = [];
      let lastDuration = null;
      for (const line of lines) {
        if (line.startsWith('#EXTINF:')) {
          lastDuration = parseFloat(line.slice(8).split(',')[0]);
        } else if (!line.startsWith('#')) {
          segments.push({
            url: new URL(line, baseUrl).href,
            duration: lastDuration || 0,
          });
          lastDuration = null;
        }
      }
      return { kind: 'media', segments };
    }
  }

  function parseAttrList(line) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return {};
    const attrStr = line.slice(colonIdx + 1);
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
    let m;
    while ((m = re.exec(attrStr)) !== null) {
      out[m[1]] = m[3] !== undefined ? m[3] : m[4];
    }
    return out;
  }

  async function resolveToMediaPlaylist(m3u8Url) {
    const shortcut = buildLowQualityVariantUrl(m3u8Url, config.hlsQuality);
    if (shortcut && shortcut !== m3u8Url) {
      try {
        const result = await fetchAndParseM3u8(shortcut);
        if (result.kind === 'media') {
          log('HLS: using URL-substitution shortcut →', shortcut);
          return { mediaUrl: shortcut, segments: result.segments };
        }
      } catch (e) {
        log('HLS shortcut failed, falling back to parsing original:', e.message);
      }
    }

    const parsed = await fetchAndParseM3u8(m3u8Url);
    if (parsed.kind === 'media') {
      return { mediaUrl: m3u8Url, segments: parsed.segments };
    }
    if (!parsed.variants.length) throw new Error('Master playlist has no variants');
    const lowest = parsed.variants
      .slice()
      .sort((a, b) => a.bandwidth - b.bandwidth)[0];
    log('HLS: master playlist, picking lowest bandwidth variant', lowest);
    const sub = await fetchAndParseM3u8(lowest.url);
    if (sub.kind !== 'media') throw new Error('Variant is not a media playlist');
    return { mediaUrl: lowest.url, segments: sub.segments };
  }

  async function fetchAllSegments(segments, onProgress) {
    const results = new Array(segments.length);
    let nextIdx = 0;
    let completed = 0;
    let bytesLoaded = 0;

    async function worker() {
      while (true) {
        const idx = nextIdx++;
        if (idx >= segments.length) return;
        const seg = segments[idx];
        const buf = await gmFetch(seg.url);
        results[idx] = new Uint8Array(buf);
        bytesLoaded += buf.byteLength;
        completed++;
        onProgress && onProgress(completed, segments.length, bytesLoaded);
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(HLS_SEG_CONCURRENCY, segments.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  async function transmuxTsToFmp4Audio(tsSegments) {
    if (!window.muxjs) throw new Error('mux.js not available');
    return new Promise((resolve, reject) => {
      const transmuxer = new window.muxjs.mp4.Transmuxer({ remux: false });
      const collected = [];
      let initSeg = null;

      transmuxer.on('data', (segment) => {
        if (segment.type === 'video') return;
        if (!initSeg && segment.initSegment) initSeg = segment.initSegment;
        if (segment.data) collected.push(segment.data);
      });

      transmuxer.on('done', () => {
        if (!initSeg || !collected.length) {
          reject(new Error('Transmuxer produced no audio data'));
          return;
        }
        let totalLen = initSeg.byteLength;
        for (const d of collected) totalLen += d.byteLength;
        const out = new Uint8Array(totalLen);
        out.set(initSeg, 0);
        let offset = initSeg.byteLength;
        for (const d of collected) {
          out.set(d, offset);
          offset += d.byteLength;
        }
        resolve(out.buffer);
      });

      try {
        for (const ts of tsSegments) transmuxer.push(ts);
        transmuxer.flush();
      } catch (e) { reject(e); }
    });
  }

  // ═══════════════════════════════════════════════════════
  //   Beat detection
  // ═══════════════════════════════════════════════════════
  function detectBeats(audioBuffer, opts) {
    const { sensitivity, minGapMs, avgWindowSec } = opts;
    const sr = audioBuffer.sampleRate;
    const data = audioBuffer.getChannelData(0);
    const frameSize = 1024, hop = 512;
    const numFrames = Math.floor((data.length - frameSize) / hop);
    const energy = new Float32Array(numFrames);

    for (let i = 0; i < numFrames; i++) {
      let sum = 0;
      const start = i * hop;
      for (let j = 0; j < frameSize; j++) {
        const v = data[start + j];
        sum += v * v;
      }
      energy[i] = Math.sqrt(sum / frameSize);
    }

    const onset = new Float32Array(numFrames);
    for (let i = 1; i < numFrames; i++) {
      const d = energy[i] - energy[i - 1];
      onset[i] = d > 0 ? d : 0;
    }

    const windowFrames = Math.round((sr / hop) * avgWindowSec);
    const minGapFrames = Math.round((minGapMs / 1000) * (sr / hop));
    const beats = [];
    let lastBeat = -Infinity;

    for (let i = 1; i < numFrames - 1; i++) {
      const w0 = Math.max(0, i - windowFrames);
      const w1 = Math.min(numFrames, i + windowFrames);
      let avg = 0;
      for (let k = w0; k < w1; k++) avg += energy[k];
      avg /= (w1 - w0);

      const e = energy[i];
      if (
        e > avg * sensitivity &&
        e > energy[i - 1] &&
        e >= energy[i + 1] &&
        onset[i] > 0 &&
        i - lastBeat > minGapFrames
      ) {
        beats.push((i * hop) / sr);
        lastBeat = i;
      }
    }
    return beats;
  }

  function estimateBpm(beats) {
    if (beats.length < 4) return 0;
    const ivs = [];
    for (let i = 1; i < beats.length; i++) ivs.push(beats[i] - beats[i - 1]);
    ivs.sort((a, b) => a - b);
    const med = ivs[Math.floor(ivs.length / 2)];
    return med ? 60 / med : 0;
  }

  async function analyzeAudioBuffer(arrayBuffer, presetKey) {
    const p = PRESETS[presetKey] || PRESETS.kick;
    const sensMult = config.sensitivity || 1.0;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(arrayBuffer);
    } finally {
      ctx.close();
    }

    const offline = new OfflineAudioContext(1, decoded.length, decoded.sampleRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    const hp1 = offline.createBiquadFilter(); hp1.type='highpass'; hp1.frequency.value=p.bandLow; hp1.Q.value=p.q;
    const hp2 = offline.createBiquadFilter(); hp2.type='highpass'; hp2.frequency.value=p.bandLow; hp2.Q.value=p.q;
    const lp1 = offline.createBiquadFilter(); lp1.type='lowpass';  lp1.frequency.value=p.bandHigh; lp1.Q.value=p.q;
    const lp2 = offline.createBiquadFilter(); lp2.type='lowpass';  lp2.frequency.value=p.bandHigh; lp2.Q.value=p.q;
    src.connect(hp1).connect(hp2).connect(lp1).connect(lp2).connect(offline.destination);
    src.start(0);
    const filtered = await offline.startRendering();

    const minGapMs = (60 / p.maxBpm) * 1000;
    // Lower sensitivity-multiplier value = MORE beats (lower threshold). We want
    // the user-facing slider to feel intuitive: higher = more sensitive = more beats.
    // So divide the preset's sensitivity by the user multiplier.
    const effectiveSensitivity = p.sensitivity / sensMult;
    const beats = detectBeats(filtered, {
      sensitivity: effectiveSensitivity,
      minGapMs,
      avgWindowSec: p.avgWindow,
    });
    return { beats, bpm: estimateBpm(beats) };
  }

  // ═══════════════════════════════════════════════════════
  //   Video discovery & lifecycle
  // ═══════════════════════════════════════════════════════
  function videoSrcKind(video) {
    const src = video.currentSrc || video.src || '';
    if (!src) return 'none';
    if (src.startsWith('blob:')) return 'blob';
    if (src.startsWith('data:')) return 'data';
    if (/^https?:/i.test(src)) return 'http';
    return 'other';
  }

  function isPotentiallyAnalyzable(video) {
    const kind = videoSrcKind(video);
    return kind === 'http' || kind === 'blob';
  }

  function getDirectVideoSrc(video) { return video.currentSrc || video.src; }

  async function attachToVideo(video) {
    if (videoStates.has(video)) return;
    if (!isPotentiallyAnalyzable(video)) return;

    const state = {
      video,
      kind: videoSrcKind(video),
      sourceUrl: null,
      m3u8Url: null,
      beats: [],
      bpm: 0,
      lastBeatIdx: -1,
      pulses: new Map(),
      lastVideoTime: 0,
      lastVideoTimeAt: 0,
      smoothTime: 0,
      audioCtx: null,
      overlay: null,
      canvas: null,
      ctx: null,
      statusEl: null,
      rafId: null,
      analyzing: false,
      destroyed: false,
      ro: null,
      waitingForM3u8: false,
    };
    videoStates.set(video, state);

    createOverlay(state);
    bindVideoEvents(state);
    startRenderLoop(state);

    if (state.kind === 'http') {
      state.sourceUrl = getDirectVideoSrc(video);
      const cached = await cacheGet(state.sourceUrl);
      if (cached && cached.params === cacheParams()) {
        state.beats = cached.beats; state.bpm = cached.bpm;
        setStatus(state, `${cached.beats.length} beats · ${cached.bpm.toFixed(1)} BPM (cached)`, 'ok');
        scheduleStatusClear(state);
        return;
      }
      analyzeMp4Video(state);
      return;
    }

    if (state.kind === 'blob') {
      const candidate = pickM3u8ForVideo(video);
      if (candidate) {
        attachM3u8ToVideo(state, candidate);
      } else {
        state.waitingForM3u8 = true;
        setStatus(state, 'Waiting for HLS playlist…', 'busy');
      }
    }
  }

  function pickM3u8ForVideo(video) {
    for (let i = sniffedM3u8s.length - 1; i >= 0; i--) {
      if (!sniffedM3u8s[i].used) return sniffedM3u8s[i];
    }
    return sniffedM3u8s[sniffedM3u8s.length - 1] || null;
  }

  async function attachM3u8ToVideo(state, m3u8Entry) {
    if (state.destroyed) return;
    state.waitingForM3u8 = false;
    state.m3u8Url = m3u8Entry.url;
    state.sourceUrl = m3u8Entry.url;
    m3u8Entry.used = true;

    const cached = await cacheGet(state.sourceUrl);
    if (cached && cached.params === cacheParams()) {
      state.beats = cached.beats; state.bpm = cached.bpm;
      setStatus(state, `${cached.beats.length} beats · ${cached.bpm.toFixed(1)} BPM (cached)`, 'ok');
      scheduleStatusClear(state);
      return;
    }
    analyzeHlsVideo(state);
  }

  function scheduleStatusClear(state) {
    setTimeout(() => !state.destroyed && setStatus(state, '', 'idle'), 2500);
  }

  async function analyzeMp4Video(state) {
    if (state.analyzing || state.destroyed) return;
    state.analyzing = true;
    setStatus(state, 'Fetching audio…', 'busy');
    try {
      const ab = await gmFetch(state.sourceUrl, {
        onProgress: (loaded, total) => {
          if (state.destroyed) return;
          if (total && total > MAX_FETCH_BYTES) throw new Error(`File too large (${(total/1e6).toFixed(0)} MB)`);
          const pct = total ? Math.round(loaded / total * 100) : null;
          setStatus(state, pct !== null ? `Fetching… ${pct}%` : `Fetching… ${(loaded/1e6).toFixed(1)} MB`, 'busy');
        },
      });
      if (state.destroyed) return;
      setStatus(state, 'Analyzing…', 'busy');
      await new Promise(r => setTimeout(r, 16));
      const { beats, bpm } = await analyzeAudioBuffer(ab, config.preset);
      if (state.destroyed) return;
      finalizeBeats(state, beats, bpm);
    } catch (e) {
      err('MP4 analysis failed:', e);
      setStatus(state, `Failed: ${e.message}`, 'err');
    } finally {
      state.analyzing = false;
    }
  }

  async function analyzeHlsVideo(state) {
    if (state.analyzing || state.destroyed) return;
    state.analyzing = true;
    setStatus(state, 'Loading HLS playlist…', 'busy');
    try {
      const { mediaUrl, segments } = await resolveToMediaPlaylist(state.m3u8Url);
      log('HLS:', segments.length, 'segments via', mediaUrl);
      if (state.destroyed) return;
      if (!segments.length) throw new Error('Empty playlist');

      setStatus(state, `Fetching ${segments.length} segments…`, 'busy');
      const tsSegments = await fetchAllSegments(segments, (done, total, bytes) => {
        if (state.destroyed) return;
        setStatus(state, `Fetching… ${done}/${total} segments (${(bytes/1e6).toFixed(1)} MB)`, 'busy');
      });
      if (state.destroyed) return;

      setStatus(state, 'Transmuxing audio…', 'busy');
      await new Promise(r => setTimeout(r, 16));
      const fmp4 = await transmuxTsToFmp4Audio(tsSegments);
      if (state.destroyed) return;

      setStatus(state, 'Analyzing…', 'busy');
      await new Promise(r => setTimeout(r, 16));
      const { beats, bpm } = await analyzeAudioBuffer(fmp4, config.preset);
      if (state.destroyed) return;
      finalizeBeats(state, beats, bpm);
    } catch (e) {
      err('HLS analysis failed:', e);
      setStatus(state, `HLS failed: ${e.message}`, 'err');
    } finally {
      state.analyzing = false;
    }
  }

  function finalizeBeats(state, beats, bpm) {
    state.beats = beats;
    state.bpm = bpm;
    state.lastBeatIdx = -1;
    state.pulses.clear();
    cacheSet(state.sourceUrl, beats, bpm, cacheParams());
    setStatus(state, `${beats.length} beats · ${bpm.toFixed(1)} BPM`, 'ok');
    scheduleStatusClear(state);
  }

  // Re-analyze the currently-attached main video with whatever the
  // current preset is. Used when the user changes detection from the inline UI.
  function reanalyzeAttached() {
    document.querySelectorAll('video').forEach(v => {
      const state = videoStates.get(v);
      if (!state) return;
      state.beats = []; state.bpm = 0; state.lastBeatIdx = -1; state.pulses.clear();
      if (state.kind === 'http' && state.sourceUrl) {
        cacheGet(state.sourceUrl).then(cached => {
          if (state.destroyed) return;
          if (cached && cached.params === cacheParams()) {
            state.beats = cached.beats; state.bpm = cached.bpm;
            setStatus(state, `${cached.beats.length} beats · ${cached.bpm.toFixed(1)} BPM (cached)`, 'ok');
            scheduleStatusClear(state);
          } else {
            analyzeMp4Video(state);
          }
        });
      } else if (state.m3u8Url) {
        cacheGet(state.sourceUrl).then(cached => {
          if (state.destroyed) return;
          if (cached && cached.params === cacheParams()) {
            state.beats = cached.beats; state.bpm = cached.bpm;
            setStatus(state, `${cached.beats.length} beats · ${cached.bpm.toFixed(1)} BPM (cached)`, 'ok');
            scheduleStatusClear(state);
          } else {
            analyzeHlsVideo(state);
          }
        });
      }
    });
  }

  function detachFromVideo(video) {
    const state = videoStates.get(video);
    if (!state) return;
    state.destroyed = true;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    if (state.ro) state.ro.disconnect();
    if (state._posInterval) clearInterval(state._posInterval);
    if (state.overlay && state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
    if (state.audioCtx) { try { state.audioCtx.close(); } catch {} }
    videoStates.delete(video);
  }

  // ═══════════════════════════════════════════════════════
  //   Overlay creation
  // ═══════════════════════════════════════════════════════
  function createOverlay(state) {
    const overlay = document.createElement('div');
    overlay.className = 'beatbar-overlay';
    overlay.innerHTML = `
      <canvas class="beatbar-canvas"></canvas>
      <div class="beatbar-status"></div>
      <div class="beatbar-actions">
        <button class="beatbar-btn" data-act="reanalyze" title="Re-analyze with current preset">↻</button>
        <button class="beatbar-btn" data-act="hide" title="Hide bar (per-video)">×</button>
      </div>
    `;
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.canvas = overlay.querySelector('.beatbar-canvas');
    state.ctx = state.canvas.getContext('2d');
    state.statusEl = overlay.querySelector('.beatbar-status');

    overlay.addEventListener('click', (e) => {
      const btn = e.target.closest('.beatbar-btn');
      if (!btn) return;
      e.stopPropagation();
      if (btn.dataset.act === 'reanalyze') {
        if (state.kind === 'http') analyzeMp4Video(state);
        else if (state.m3u8Url) analyzeHlsVideo(state);
        else setStatus(state, 'No source resolved yet', 'err');
      }
      if (btn.dataset.act === 'hide') overlay.style.display = 'none';
    });

    const updatePos = () => {
      if (state.destroyed) return;
      const v = state.video;
      if (!v.isConnected) { detachFromVideo(v); return; }
      const rect = v.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) {
        overlay.style.display = 'none';
        return;
      }
      const h = currentOverlayHeight();
      overlay.style.display = config.showOverlay ? '' : 'none';
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.bottom - h - PLAYBACK_BAR_OFFSET}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${h}px`;
      overlay.style.paddingBottom = `2rem`;
      resizeCanvas(state);
    };
    state._updatePos = updatePos;
    updatePos();
    state.ro = new ResizeObserver(updatePos);
    try { state.ro.observe(state.video); } catch {}
    window.addEventListener('scroll', updatePos, { passive: true, capture: true });
    window.addEventListener('resize', updatePos, { passive: true });
    document.addEventListener('fullscreenchange', () => {
      const fsEl = document.fullscreenElement;
      if (fsEl && (fsEl === state.video || fsEl.contains(state.video))) {
        fsEl.appendChild(overlay);
        overlay.classList.add('beatbar-fs');
      } else {
        document.body.appendChild(overlay);
        overlay.classList.remove('beatbar-fs');
      }
      requestAnimationFrame(updatePos);
    });
    state._posInterval = setInterval(updatePos, 1000);
  }

  // Reposition all attached overlays — call after size/lookahead changes.
  function repositionAll() {
    document.querySelectorAll('video').forEach(v => {
      const s = videoStates.get(v);
      if (s && s._updatePos) s._updatePos();
    });
  }

  function resizeCanvas(state) {
    if (!state.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = state.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (state.canvas.width !== w || state.canvas.height !== h) {
      state.canvas.width = w;
      state.canvas.height = h;
      state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function setStatus(state, text, kind) {
    if (!state.statusEl) return;
    state.statusEl.textContent = text;
    state.statusEl.className = 'beatbar-status' + (kind ? ` beatbar-status--${kind}` : '');
  }

  // ═══════════════════════════════════════════════════════
  //   Inline controls injected into PMVHaven's video info bar
  //
  //   The page's info row uses Tailwind classes:
  //     .pb-4.border-b.border-[#2A2A2A]  → outer wrapper
  //       > div.grid                      → row 1: stats (left) + actions (right)
  //         > div.flex…text-gray-400      → stats (views, date, duration)
  //   We append a controls strip into that .flex.text-gray-400 row, pushed
  //   right with margin-left:auto, sitting opposite the duration.
  //   Vue may re-render this section, so we re-inject on every scan tick.
  // ═══════════════════════════════════════════════════════
  function findInfoStatsRow() {
    // The stats row containing views/date/duration spans
    const candidates = document.querySelectorAll('.pb-4.border-b div.flex');
    for (const el of candidates) {
      // Heuristic: it has children with the lucide icons + small text
      if (el.querySelector('span') && el.children.length >= 2 &&
          /views|view/i.test(el.textContent)) {
        return el;
      }
    }
    return null;
  }

  function ensureInlineControls() {
    // Always inject controls — the toggle lives inside them, so users need
    // access even when Beats are off.
    const row = findInfoStatsRow();
    if (!row) return;
    if (row.querySelector('.beatbar-inline')) return;

    const wrap = document.createElement('div');
    wrap.className = 'beatbar-inline';
    wrap.innerHTML = `
      <button class="beatbar-pill beatbar-pill--toggle" data-bb="toggle" title="Enable / disable Beat Bar on this page">
        <span class="beatbar-pill-dot"></span>
        <span class="beatbar-pill-label">Beats</span>
      </button>
      <select class="beatbar-pill beatbar-pill--select" data-bb="preset" title="Detection method">
        <option value="broad">Broad</option>
        <option value="kick">Kick</option>
        <option value="snare">Snare</option>
      </select>
      <select class="beatbar-pill beatbar-pill--select" data-bb="size" title="Bar size">
        <option value="small">S</option>
        <option value="medium">M</option>
        <option value="large">L</option>
      </select>
      <div class="beatbar-pill beatbar-pill--range" title="Lookahead — how many seconds of upcoming beats to show">
        <span class="beatbar-range-label">Speed</span>
        <input type="range" data-bb="lookahead" min="2.5" max="7.5" step="0.5">
        <span class="beatbar-range-val" data-bb="lookahead-val"></span>
      </div>
      <div class="beatbar-pill beatbar-pill--range" title="Sensitivity — higher = more beats detected. Re-runs detection.">
        <span class="beatbar-range-label">Sens</span>
        <input type="range" data-bb="sensitivity" min="0.5" max="3" step="0.1">
        <span class="beatbar-range-val" data-bb="sensitivity-val"></span>
      </div>
      <button class="beatbar-pill beatbar-pill--icon" data-bb="settings" title="Beat Bar settings">⚙</button>
    `;

    // Reflect current config
    wrap.querySelector('[data-bb="preset"]').value = config.preset;
    wrap.querySelector('[data-bb="size"]').value = config.size;
    const lookInput = wrap.querySelector('[data-bb="lookahead"]');
    const lookVal = wrap.querySelector('[data-bb="lookahead-val"]');
    lookInput.value = config.lookahead;
    lookVal.textContent = `${config.lookahead}s`;
    const sensInput = wrap.querySelector('[data-bb="sensitivity"]');
    const sensVal = wrap.querySelector('[data-bb="sensitivity-val"]');
    sensInput.value = config.sensitivity;
    sensVal.textContent = `${config.sensitivity.toFixed(1)}×`;
    if (pageEnabled) wrap.querySelector('[data-bb="toggle"]').classList.add('on');

    // Wire events
    wrap.querySelector('[data-bb="toggle"]').addEventListener('click', () => {
      pageEnabled = !pageEnabled;
      config.enabled = pageEnabled;
      saveConfig(config);
      wrap.querySelector('[data-bb="toggle"]').classList.toggle('on', pageEnabled);
      if (pageEnabled) scanForVideos();
      else detachAll();
    });

    wrap.querySelector('[data-bb="preset"]').addEventListener('change', (e) => {
      config.preset = e.target.value;
      saveConfig(config);
      reanalyzeAttached();
    });

    wrap.querySelector('[data-bb="size"]').addEventListener('change', (e) => {
      config.size = e.target.value;
      saveConfig(config);
      repositionAll();
    });

    lookInput.addEventListener('input', (e) => {
      config.lookahead = parseFloat(e.target.value);
      lookVal.textContent = `${config.lookahead}s`;
      saveConfig(config);
    });

    // Sensitivity: changes during slide are cheap (just save + label),
    // re-analysis only fires on `change` (release) to avoid thrashing.
    sensInput.addEventListener('input', (e) => {
      config.sensitivity = parseFloat(e.target.value);
      sensVal.textContent = `${config.sensitivity.toFixed(1)}×`;
      saveConfig(config);
    });
    sensInput.addEventListener('change', () => {
      reanalyzeAttached();
    });

    wrap.querySelector('[data-bb="settings"]').addEventListener('click', openSettings);

    row.appendChild(wrap);
  }

  // ═══════════════════════════════════════════════════════
  //   Video events / smooth time / render
  // ═══════════════════════════════════════════════════════
  function bindVideoEvents(state) {
    const v = state.video;
    const onTimeUpdate = () => {
      state.lastVideoTime = v.currentTime;
      state.lastVideoTimeAt = performance.now();
    };
    const onSeeking = () => {
      state.lastBeatIdx = -1;
      state.pulses.clear();
    };
    const onSrcChange = () => {
      const newKind = videoSrcKind(v);
      if (newKind === 'http') {
        const newUrl = getDirectVideoSrc(v);
        if (newUrl !== state.sourceUrl) {
          state.kind = 'http'; state.sourceUrl = newUrl; state.m3u8Url = null;
          state.beats = []; state.bpm = 0; state.lastBeatIdx = -1; state.pulses.clear();
          cacheGet(newUrl).then(cached => {
            if (state.destroyed) return;
            if (cached && cached.params === cacheParams()) {
              state.beats = cached.beats; state.bpm = cached.bpm;
              setStatus(state, `${cached.beats.length} beats · ${cached.bpm.toFixed(1)} BPM (cached)`, 'ok');
              scheduleStatusClear(state);
            } else { analyzeMp4Video(state); }
          });
        }
      } else if (newKind === 'blob' && state.kind !== 'blob') {
        state.kind = 'blob'; state.m3u8Url = null; state.sourceUrl = null;
        state.beats = []; state.bpm = 0;
        const candidate = pickM3u8ForVideo(v);
        if (candidate) attachM3u8ToVideo(state, candidate);
        else { state.waitingForM3u8 = true; setStatus(state, 'Waiting for HLS playlist…', 'busy'); }
      }
    };

    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('seeking', onSeeking);
    v.addEventListener('loadeddata', onSrcChange);
    v.addEventListener('emptied', onSrcChange);
  }

  function startRenderLoop(state) {
    const tick = (now) => {
      if (state.destroyed) return;
      updateSmoothTime(state, now);
      checkBeatsPassed(state);
      drawBar(state, now);
      state.rafId = requestAnimationFrame(tick);
    };
    state.rafId = requestAnimationFrame(tick);
  }

  function updateSmoothTime(state, nowPerf) {
    const v = state.video;
    if (v.paused || v.seeking) {
      state.smoothTime = v.currentTime;
      state.lastVideoTime = v.currentTime;
      state.lastVideoTimeAt = nowPerf;
      return;
    }
    if (v.currentTime !== state.lastVideoTime) {
      state.lastVideoTime = v.currentTime;
      state.lastVideoTimeAt = nowPerf;
    }
    const dt = (nowPerf - state.lastVideoTimeAt) / 1000;
    const rate = v.playbackRate || 1;
    state.smoothTime = state.lastVideoTime + dt * rate;
    if (v.duration && state.smoothTime > v.duration) state.smoothTime = v.duration;
  }

  function checkBeatsPassed(state) {
    // beatOffsetMs shifts WHEN a beat is considered to occur (positive = later).
    // tickLeadMs makes us fire the pulse N ms before that effective time.
    const offset = (config.beatOffsetMs || 0) / 1000;
    const lead = (config.tickLeadMs || 0) / 1000;
    // We want to fire when (effectiveBeat = beat + offset) reaches (smoothTime + lead).
    // Equivalently: fire when beat <= smoothTime + lead - offset.
    const t = state.smoothTime + lead - offset;

    if (state.lastBeatIdx >= 0 && state.beats[state.lastBeatIdx] > t + 0.1) {
      let lo = 0, hi = state.beats.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (state.beats[mid] <= t) lo = mid + 1; else hi = mid;
      }
      state.lastBeatIdx = lo - 1;
    }
    let idx = state.lastBeatIdx + 1;
    while (idx < state.beats.length && state.beats[idx] <= t) {
      state.pulses.set(idx, { startTime: performance.now() });
      if (config.tickEnabled && !state.video.paused) playTick(state);
      idx++;
    }
    state.lastBeatIdx = idx - 1;
  }

  function playTick(state) {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ac = state.audioCtx;
    const now = ac.currentTime;

    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(155, now);
    osc.frequency.exponentialRampToValueAtTime(65, now + 0.025);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.038);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.048);

    const bufLen = Math.ceil(0.008 * ac.sampleRate);
    const noise = ac.createBuffer(1, bufLen, ac.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const noiseSrc = ac.createBufferSource();
    noiseSrc.buffer = noise;
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 1800;
    filt.Q.value = 1;
    const noiseGain = ac.createGain();
    noiseGain.gain.setValueAtTime(0.08, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.008);
    noiseSrc.connect(filt).connect(noiseGain).connect(ac.destination);
    noiseSrc.start(now);
    noiseSrc.stop(now + 0.018);
  }

  function drawBar(state, now) {
    const ctx = state.ctx;
    const canvas = state.canvas;
    if (!ctx || !canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    ctx.clearRect(0, 0, w, h);

    const pad = 4;
    const radius = 8;
    const cardX = pad, cardY = pad;
    const cardW = w - pad * 2, cardH = h - pad * 2;

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, radius);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cardX + 8, h / 2);
    ctx.lineTo(cardX + cardW - 8, h / 2);
    ctx.stroke();

    if (!state.beats.length) return;

    // beatOffsetMs shifts where beats sit on the bar. Subtracting from `t`
    // is equivalent to adding the offset to every beat's effective time.
    const offset = (config.beatOffsetMs || 0) / 1000;
    const t = state.smoothTime - offset;
    const lookahead = config.lookahead;
    const playheadX = w * PLAYHEAD_X_FRAC;
    const lookbehind = lookahead * (PLAYHEAD_X_FRAC / (1 - PLAYHEAD_X_FRAC));
    const pxPerSec = (w - playheadX) / lookahead;

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(playheadX, 6); ctx.lineTo(playheadX, h - 6); ctx.stroke();

    const baseR = Math.max(7, Math.min(11, h * 0.1));
    const pulseR = baseR + 12;

    const firstT = t - lookbehind - 0.2;
    let lo = 0, hi = state.beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (state.beats[mid] < firstT) lo = mid + 1; else hi = mid;
    }

    for (let i = lo; i < state.beats.length; i++) {
      const bt = state.beats[i];
      const dt = bt - t;
      if (dt > lookahead + 0.2) break;

      const x = playheadX + dt * pxPerSec;
      const y = h / 2;

      const pulse = state.pulses.get(i);
      let radius = baseR;
      let glow = 0;
      if (pulse) {
        const age = (now - pulse.startTime) / 1000;
        const LIFE = 0.4;
        if (age > LIFE) state.pulses.delete(i);
        else {
          const k = 1 - (age / LIFE);
          radius = baseR + k * (pulseR - baseR);
          glow = k;
        }
      }

      if (glow > 0) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, radius + 18);
        g.addColorStop(0, `rgba(122,168,255,${glow * 0.55})`);
        g.addColorStop(1, 'rgba(122,168,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, radius + 18, 0, Math.PI * 2); ctx.fill();
      }

      const isPast = dt < -0.02;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.arc(x, y, radius + 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isPast ? '#9ef0df' : '#7aa8ff';
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = isPast ? 'rgba(158,240,223,0.4)' : 'rgba(122,168,255,0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y + radius + 3); ctx.lineTo(x, h - 6); ctx.stroke();
    }
  }

  // ═══════════════════════════════════════════════════════
  //   DOM observation
  // ═══════════════════════════════════════════════════════
  function videoOnScreenArea(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return 0;
    if (r.bottom < 0 || r.top > window.innerHeight) return 0;
    if (r.right < 0 || r.left > window.innerWidth) return 0;
    return r.width * r.height;
  }

  function pickMainVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!isPotentiallyAnalyzable(v)) continue;
      const area = videoOnScreenArea(v);
      if (area < config.minVideoArea) continue;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function scanForVideos() {
    // Inline controls live in the page chrome, attempt to ensure them every scan
    ensureInlineControls();

    if (!pageEnabled) return;

    if (!config.onlyLargest) {
      document.querySelectorAll('video').forEach(v => {
        if (videoStates.has(v)) return;
        if (!isPotentiallyAnalyzable(v)) {
          const onMeta = () => {
            if (isPotentiallyAnalyzable(v)) attachToVideo(v);
            v.removeEventListener('loadedmetadata', onMeta);
            v.removeEventListener('loadeddata', onMeta);
          };
          v.addEventListener('loadedmetadata', onMeta);
          v.addEventListener('loadeddata', onMeta);
          return;
        }
        if (videoOnScreenArea(v) >= config.minVideoArea) attachToVideo(v);
      });
      return;
    }

    const main = pickMainVideo();

    if (!main) {
      for (const v of document.querySelectorAll('video')) {
        if (v.__beatbarMetaListening) continue;
        v.__beatbarMetaListening = true;
        const onMeta = () => debouncedScan();
        v.addEventListener('loadedmetadata', onMeta);
        v.addEventListener('loadeddata', onMeta);
        v.addEventListener('resize', onMeta);
      }
      return;
    }

    for (const v of document.querySelectorAll('video')) {
      if (v !== main && videoStates.has(v)) {
        log('Detaching from non-main video');
        detachFromVideo(v);
      }
    }

    if (!videoStates.has(main)) {
      log('Attaching to main video, area=' + Math.round(videoOnScreenArea(main)));
      attachToVideo(main);
    }
  }

  function debounce(fn, delay = 200) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }
  const debouncedScan = debounce(scanForVideos, 250);

  // ═══════════════════════════════════════════════════════
  //   Settings modal
  // ═══════════════════════════════════════════════════════
  function openSettings() {
    const existing = document.getElementById('beatbar-settings');
    if (existing) { existing.remove(); return; }
    const cfg = getConfig();
    const modal = document.createElement('div');
    modal.id = 'beatbar-settings';
    modal.className = 'beatbar-modal';
    modal.innerHTML = `
      <div class="beatbar-modal-box">
        <div class="beatbar-modal-head">
          <h3>Beat Bar Settings</h3>
          <button class="beatbar-btn" data-act="close">×</button>
        </div>
        <div class="beatbar-modal-body">
          <label class="beatbar-row">
            <span>Detection preset</span>
            <select data-key="preset">
              <option value="kick" ${cfg.preset==='kick'?'selected':''}>Kick (steady pulse)</option>
              <option value="snare" ${cfg.preset==='snare'?'selected':''}>Snare / backbeat</option>
              <option value="broad" ${cfg.preset==='broad'?'selected':''}>Broad</option>
            </select>
          </label>
          <label class="beatbar-row">
            <span>Bar size</span>
            <select data-key="size">
              <option value="small" ${cfg.size==='small'?'selected':''}>Small</option>
              <option value="medium" ${cfg.size==='medium'?'selected':''}>Medium</option>
              <option value="large" ${cfg.size==='large'?'selected':''}>Large</option>
            </select>
          </label>
          <label class="beatbar-row">
            <span>HLS quality (lowest = fastest)</span>
            <select data-key="hlsQuality">
              <option value="240p" ${cfg.hlsQuality==='240p'?'selected':''}>240p</option>
              <option value="360p" ${cfg.hlsQuality==='360p'?'selected':''}>360p</option>
              <option value="480p" ${cfg.hlsQuality==='480p'?'selected':''}>480p</option>
              <option value="720p" ${cfg.hlsQuality==='720p'?'selected':''}>720p</option>
            </select>
          </label>
          <label class="beatbar-row">
            <span>Lookahead (sec)</span>
            <input type="number" data-key="lookahead" min="2.5" max="7.5" step="0.5" value="${cfg.lookahead}">
          </label>
          <label class="beatbar-row">
            <span>Sens (×) <span class="beatbar-faint" title="Detection sensitivity multiplier. Higher = more beats detected. Re-runs detection on save.">ⓘ</span></span>
            <input type="number" data-key="sensitivity" min="0.5" max="3" step="0.1" value="${cfg.sensitivity}">
          </label>
          <label class="beatbar-row">
            <span>Beat offset (ms) <span class="beatbar-faint" title="Shift detected beats by N ms. Positive = later, negative = earlier. Adjust if beat markers consistently miss the centerline.">ⓘ</span></span>
            <input type="number" data-key="beatOffsetMs" min="-500" max="500" step="5" value="${cfg.beatOffsetMs}">
          </label>
          <label class="beatbar-row">
            <span>Audio tick on beat</span>
            <input type="checkbox" data-key="tickEnabled" ${cfg.tickEnabled?'checked':''}>
          </label>
          <label class="beatbar-row">
            <span>Tick lead (ms) <span class="beatbar-faint" title="Visual lead — fire pulse & tick this many ms before the beat. Compensates for audio output latency. Independent of beat offset.">ⓘ</span></span>
            <input type="number" data-key="tickLeadMs" min="0" max="200" step="5" value="${cfg.tickLeadMs}">
          </label>
          <label class="beatbar-row">
            <span>Show beat bar</span>
            <input type="checkbox" data-key="showOverlay" ${cfg.showOverlay?'checked':''}>
          </label>
          <hr>
          <label class="beatbar-row">
            <span>Main video only</span>
            <input type="checkbox" data-key="onlyLargest" ${cfg.onlyLargest?'checked':''}>
          </label>
          <label class="beatbar-row">
            <span>Min video area (px²)</span>
            <input type="number" data-key="minVideoArea" min="1000" max="500000" step="1000" value="${cfg.minVideoArea}">
          </label>
          <hr>
          <div class="beatbar-faint" style="font-size:11px;line-height:1.5">
            Press <b>Alt+B</b> to toggle Beat Bar on this page.
          </div>
          <div class="beatbar-faint" style="font-size:11px">
            Sniffed m3u8s on this page: <b>${sniffedM3u8s.length}</b>
          </div>
        </div>
        <div class="beatbar-modal-foot">
          <button class="beatbar-btn beatbar-btn--primary" data-act="save">Save</button>
          <button class="beatbar-btn" data-act="clear-cache">Clear cache</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn && e.target !== modal) return;
      if (e.target === modal) { modal.remove(); return; }
      if (btn.dataset.act === 'close') { modal.remove(); return; }
      if (btn.dataset.act === 'save') {
        const next = { ...cfg };
        next.preset = modal.querySelector('[data-key="preset"]').value;
        next.size = modal.querySelector('[data-key="size"]').value;
        next.hlsQuality = modal.querySelector('[data-key="hlsQuality"]').value;
        next.lookahead = parseFloat(modal.querySelector('[data-key="lookahead"]').value);
        next.sensitivity = parseFloat(modal.querySelector('[data-key="sensitivity"]').value) || 1.0;
        next.beatOffsetMs = parseFloat(modal.querySelector('[data-key="beatOffsetMs"]').value) || 0;
        next.tickEnabled = modal.querySelector('[data-key="tickEnabled"]').checked;
        next.tickLeadMs = parseFloat(modal.querySelector('[data-key="tickLeadMs"]').value) || 0;
        next.showOverlay = modal.querySelector('[data-key="showOverlay"]').checked;
        next.onlyLargest = modal.querySelector('[data-key="onlyLargest"]').checked;
        next.minVideoArea = parseInt(modal.querySelector('[data-key="minVideoArea"]').value, 10) || MIN_VIDEO_AREA;
        // Detection-affecting fields — only re-analyze if these changed
        const detectionChanged = next.preset !== cfg.preset || next.sensitivity !== cfg.sensitivity;
        saveConfig(next);
        config = next;
        modal.remove();
        // Sync the inline controls
        const row = document.querySelector('.beatbar-inline');
        if (row) row.remove();
        ensureInlineControls();
        if (pageEnabled) {
          repositionAll();
          if (detectionChanged) reanalyzeAttached();
        } else detachAll();
      }
      if (btn.dataset.act === 'clear-cache') {
        try {
          const db = await openDb();
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).clear();
          tx.oncomplete = () => alert('Beat Bar cache cleared.');
        } catch (e) { alert('Clear failed: ' + e.message); }
      }
    });
  }

  function detachAll() {
    document.querySelectorAll('video').forEach(v => detachFromVideo(v));
  }

  // ═══════════════════════════════════════════════════════
  //   Styles
  // ═══════════════════════════════════════════════════════
  function injectStyles() {
    if (typeof GM_addStyle !== 'function') return;
    GM_addStyle(`
      .beatbar-overlay {
        position: fixed;
        z-index: 2147483600;
        pointer-events: none;
        transition: opacity .15s;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .beatbar-overlay.beatbar-fs { position: absolute; }
      .beatbar-canvas { width: 100%; height: 100%; display: block; pointer-events: none; }
      .beatbar-status {
        position: absolute; top: 6px; left: 8px;
        font-size: 11px; color: #fff; background: rgba(0,0,0,0.55);
        padding: 2px 8px; border-radius: 3px; pointer-events: none;
        opacity: 0; transition: opacity .15s;
        max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .beatbar-status:not(:empty) { opacity: 1; }
      .beatbar-status--err { color: #f9a; background: rgba(60,0,0,0.7); }
      .beatbar-status--ok  { color: #9ef0df; }
      .beatbar-status--busy { color: #ffd; }
      .beatbar-actions {
        position: absolute; top: 6px; right: 8px;
        display: flex; gap: 4px; pointer-events: auto;
        opacity: 0; transition: opacity .15s;
      }
      .beatbar-overlay:hover .beatbar-actions { opacity: 1; }
      .beatbar-btn {
        background: rgba(0,0,0,0.6); color: #fff;
        border: 1px solid rgba(255,255,255,0.2); border-radius: 3px;
        padding: 2px 8px; font-size: 12px; cursor: pointer; font-family: inherit;
      }
      .beatbar-btn:hover { background: rgba(0,0,0,0.85); border-color: rgba(255,255,255,0.4); }
      .beatbar-btn--primary { background: #5385f1; border-color: #5385f1; }
      .beatbar-btn--primary:hover { background: #4077EF; }

      /* Inline controls — match PMVHaven info-bar pill style */
      .beatbar-inline {
        display: inline-flex; align-items: center; gap: 6px;
        margin-left: auto;
        font-size: 12px;
      }
      .beatbar-pill {
        display: inline-flex; align-items: center; gap: 6px;
        background: #2A2A2A; color: #9ca3af;
        border: none; outline: none;
        padding: 4px 10px; height: 28px;
        border-radius: 8px;
        font-size: 12px; font-family: inherit;
        cursor: pointer; transition: background .12s, color .12s;
        line-height: 1;
      }
      .beatbar-pill:hover { background: #3A3A3A; color: #fff; }
      .beatbar-pill--select {
        appearance: none;
        padding-right: 22px;
        background-image:
          linear-gradient(45deg, transparent 50%, currentColor 50%),
          linear-gradient(135deg, currentColor 50%, transparent 50%);
        background-position:
          calc(100% - 12px) 12px,
          calc(100% - 8px) 12px;
        background-size: 4px 4px, 4px 4px;
        background-repeat: no-repeat;
      }
      .beatbar-pill--select option { background: #1f1f1f; color: #fff; }
      .beatbar-pill--toggle .beatbar-pill-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #555; transition: background .15s, box-shadow .15s;
      }
      .beatbar-pill--toggle.on { color: #fff; background: #2f3a30; }
      .beatbar-pill--toggle.on .beatbar-pill-dot {
        background: #9ef0df; box-shadow: 0 0 6px rgba(158,240,223,0.6);
      }
      .beatbar-pill--toggle.on:hover { background: #3a4a3a; }
      .beatbar-pill--range { padding: 4px 10px; gap: 6px; }
      .beatbar-pill--range .beatbar-range-label { color: #9ca3af; }
      .beatbar-pill--range input[type="range"] {
        -webkit-appearance: none; appearance: none;
        width: 70px; height: 4px;
        background: #3A3A3A; border-radius: 2px;
        outline: none; padding: 0; margin: 0;
        cursor: pointer;
      }
      .beatbar-pill--range input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 12px; height: 12px; border-radius: 50%;
        background: #9ef0df; cursor: pointer; border: none;
      }
      .beatbar-pill--range input[type="range"]::-moz-range-thumb {
        width: 12px; height: 12px; border-radius: 50%;
        background: #9ef0df; cursor: pointer; border: none;
      }
      .beatbar-range-val {
        color: #fff; font-variant-numeric: tabular-nums;
        min-width: 28px; text-align: right;
      }
      .beatbar-pill--icon { padding: 4px 8px; font-size: 14px; }

      /* Settings modal */
      .beatbar-modal {
        position: fixed; inset: 0; background: rgba(0,0,0,0.6);
        z-index: 2147483647; display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .beatbar-modal-box {
        background: #1e1f22; color: #dbdee1;
        border: 1px solid #3f4147; border-radius: 9px;
        width: 420px; max-width: calc(100vw - 32px);
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      }
      .beatbar-modal-head {
        padding: 14px 16px; border-bottom: 1px solid #3f4147;
        display: flex; justify-content: space-between; align-items: center;
      }
      .beatbar-modal-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
      .beatbar-modal-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
      .beatbar-modal-body hr { border: none; border-top: 1px solid #3f4147; margin: 6px 0; }
      .beatbar-modal-foot {
        padding: 12px 16px; border-top: 1px solid #3f4147;
        display: flex; gap: 8px; justify-content: flex-end;
      }
      .beatbar-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; font-size: 13px;
      }
      .beatbar-row select, .beatbar-row input[type="number"] {
        background: #2b2d31; color: #dbdee1;
        border: 1px solid #3f4147; border-radius: 4px;
        padding: 4px 8px; font-family: inherit; font-size: 12px;
        min-width: 140px;
      }
      .beatbar-faint { color: #949ba4; font-size: 11px; }
    `);
  }

  // ═══════════════════════════════════════════════════════
  //   Keyboard shortcut
  // ═══════════════════════════════════════════════════════
  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey) {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
        e.preventDefault();
        pageEnabled = !pageEnabled;
        config.enabled = pageEnabled;
        saveConfig(config);
        log('Page enabled:', pageEnabled);
        const toggle = document.querySelector('[data-bb="toggle"]');
        if (toggle) toggle.classList.toggle('on', pageEnabled);
        if (pageEnabled) scanForVideos();
        else detachAll();
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  //   Init
  // ═══════════════════════════════════════════════════════
  function init() {
    log('Init on', location.hostname, '— enabled:', pageEnabled, '— mux.js:', !!window.muxjs);

    injectStyles();
    bindKeyboard();

    const mo = new MutationObserver(() => debouncedScan());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('resize', debouncedScan, { passive: true });

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        config = getConfig();
        debouncedScan();
      }
    }, 500);

    if (pageEnabled) scanForVideos();

    GM_registerMenuCommand('Beat Bar — Settings', openSettings);
    GM_registerMenuCommand('Beat Bar — Toggle on this page', () => {
      pageEnabled = !pageEnabled;
      config.enabled = pageEnabled;
      saveConfig(config);
      const toggle = document.querySelector('[data-bb="toggle"]');
      if (toggle) toggle.classList.toggle('on', pageEnabled);
      if (pageEnabled) scanForVideos();
      else detachAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
