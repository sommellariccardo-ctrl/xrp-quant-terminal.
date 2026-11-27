/*
 * XRP Quant Terminal — Operator Candlestick Cockpit
 * Native Canvas renderer + public Bybit V5 market data.
 * Operator annotations are machine-readable context labels; explicit approval is offline-only and never authorizes execution.
 */
(function () {
  'use strict';

  const SYMBOL = 'XRPUSDT';
  const CATEGORY = 'linear';
  const SCHEMA = 'xrp-quant-operator-markup/v1';
  const STORAGE_KEY = 'xrpQuantOperatorMarkupV1';
  const INTERVALS = ['1', '5', '15', '60'];
  const LIMIT = 300;
  const COLORS = {
    bg: '#0b1220', grid: '#1d2b3e', text: '#8093ad', textBright: '#e7eef8',
    green: '#35d49a', red: '#ff667d', amber: '#f4bd55', blue: '#79aef2',
    volumeUp: 'rgba(53,212,154,.38)', volumeDown: 'rgba(255,102,125,.38)',
    cross: 'rgba(193,211,232,.55)', panel: '#111c2d'
  };

  const state = {
    candles: { '1': [], '5': [], '15': [], '60': [] },
    activeTf: '5',
    viewCount: 75,
    panOffset: 0,
    drawMode: 'cursor',
    annotations: [],
    batchSending: false,
    tradeOverlay: null,
    crosshair: null,
    drag: null,
    pendingTrendAnchor: null,
    raf: 0,
    resizeObserver: null,
    lastRenderWidth: 0,
    livePrice: null
  };

  const $ = (id) => document.getElementById(id);
  const canvas = () => $('marketChartCanvas');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isFinitePositive = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
  const makeId = () => (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'ann-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  function normaliseCandle(raw) {
    if (!raw) return null;
    // REST tuple: [start, open, high, low, close, volume, turnover]
    // WebSocket object: {start, open, high, low, close, volume, confirm}
    let c;
    if (Array.isArray(raw)) {
      c = {
        time: Math.floor(Number(raw[0]) / 1000), open: Number(raw[1]), high: Number(raw[2]),
        low: Number(raw[3]), close: Number(raw[4]), volume: Number(raw[5]), confirmed: true
      };
    } else {
      const hasNormalisedTime = raw.time !== undefined && raw.start === undefined;
      c = {
        time: hasNormalisedTime ? Math.floor(Number(raw.time)) : Math.floor(Number(raw.start) / 1000),
        open: Number(raw.open), high: Number(raw.high), low: Number(raw.low),
        close: Number(raw.close), volume: Number(raw.volume),
        confirmed: hasNormalisedTime ? raw.confirmed === true : raw.confirm === true
      };
    }
    if (!Number.isFinite(c.time) || ![c.open, c.high, c.low, c.close].every(Number.isFinite)) return null;
    if (c.high < c.low || c.volume < 0) return null;
    return c;
  }

  function setStatus(message, good) {
    const el = $('chartFeedStatus');
    if (!el) return;
    el.textContent = message;
    el.style.color = good === false ? COLORS.red : good === true ? COLORS.green : COLORS.amber;
  }

  function setCandles(interval, data) {
    if (!INTERVALS.includes(String(interval))) return;
    const normalised = (data || []).map(normaliseCandle).filter(Boolean).sort((a, b) => a.time - b.time);
    // REST does not expose a `confirm` flag: conservatively treat the newest bar as still forming.
    if (normalised.length) normalised[normalised.length - 1].confirmed = false;
    const dedup = new Map();
    normalised.forEach(c => dedup.set(c.time, c));
    // A WebSocket update can arrive while the REST backfill is in flight. Keep
    // the live version of any overlapping candle instead of overwriting it.
    (state.candles[String(interval)] || []).forEach(c => dedup.set(c.time, c));
    state.candles[String(interval)] = Array.from(dedup.values()).sort((a, b) => a.time - b.time).slice(-1200);
    if (String(interval) === state.activeTf) scheduleRender();
    setStatus('REST + STREAM', true);
  }

  function update(interval, raw) {
    interval = String(interval);
    if (!INTERVALS.includes(interval)) return;
    const candle = normaliseCandle(raw);
    if (!candle) return;
    const arr = state.candles[interval];
    const index = arr.findIndex(c => c.time === candle.time);
    if (index >= 0) arr[index] = candle;
    else {
      arr.push(candle);
      arr.sort((a, b) => a.time - b.time);
    }
    if (arr.length > 1200) arr.splice(0, arr.length - 1200);
    if (interval === state.activeTf) scheduleRender();
    setStatus(candle.confirmed ? 'BYBIT · CANDLE CLOSED' : 'BYBIT · LIVE CANDLE', true);
  }

  function updateLivePrice(price, exchangeTimestampMs) {
    const value = Number(price);
    if (!(Number.isFinite(value) && value > 0)) return false;
    const ts = Number(exchangeTimestampMs) > 0 ? Number(exchangeTimestampMs) : Date.now();
    state.livePrice = {
      price: value,
      time: Math.floor(ts / 1000),
      receivedAt: Date.now(),
      exchangeTimestamp: ts
    };
    const el = $('chartLivePrice');
    if (el) el.textContent = `LAST ${value.toFixed(5)} · aggiornato`;
    if (state.panOffset === 0) scheduleRender();
    return true;
  }

  function setLiveAge(ageMs) {
    const el = $('chartLivePrice');
    if (!el) return;
    const live = state.livePrice;
    if (!live) { el.textContent = 'LAST — · in attesa'; return; }
    const age = Number.isFinite(Number(ageMs)) ? Math.max(0, Number(ageMs)) : Date.now() - live.receivedAt;
    const seconds = (age / 1000).toFixed(1);
    el.textContent = `LAST ${live.price.toFixed(5)} · ${age <= 3000 ? 'LIVE' : age <= 15000 ? 'RITARDO' : 'STALE'} ${seconds}s`;
  }

  async function loadHistory(intervals) {
    const list = (intervals || INTERVALS).map(String).filter(x => INTERVALS.includes(x));
    const results = await Promise.allSettled(list.map(async interval => {
      const url = `https://api.bybit.com/v5/market/kline?category=${CATEGORY}&symbol=${SYMBOL}&interval=${interval}&limit=${LIMIT}`;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status + ' · ' + interval);
      const payload = await response.json();
      if (payload.retCode !== 0 || !payload.result || !Array.isArray(payload.result.list)) {
        throw new Error((payload.retMsg || 'Bybit REST error') + ' · ' + interval);
      }
      setCandles(interval, payload.result.list.slice().reverse());
      return interval;
    }));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      const msg = failed.map(r => r.reason && r.reason.message || 'REST error').join('; ');
      setStatus('STORICO PARZIALE', false);
      const note = $('chartDrawingStatus');
      if (note) note.textContent = 'Storico non caricato per alcuni timeframe: ' + msg + '. Il feed WebSocket può comunque aggiornare i dati.';
    }
    return results;
  }

  function timeLabel(seconds, interval) {
    const d = new Date(seconds * 1000);
    if (interval === '60') return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    if (interval === '15') return d.toLocaleString('it-IT', { day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }

  function getVisible() {
    const arr = state.candles[state.activeTf] || [];
    const end = Math.max(0, arr.length - state.panOffset);
    const start = Math.max(0, end - state.viewCount);
    return { arr, start, end, data: arr.slice(start, end) };
  }

  function getLayout(width, height) {
    const left = 12, right = Math.max(left + 100, width - 72);
    const top = 18, bottom = Math.max(top + 80, height - 105);
    return { left, right, top, bottom, volumeTop: bottom + 17, volumeBottom: height - 31, width: right - left };
  }

  function nearestIndex(arr, time) {
    if (!arr.length) return -1;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time < time) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(arr[lo - 1].time - time) < Math.abs(arr[lo].time - time)) return lo - 1;
    return lo;
  }

  function scheduleRender() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => { state.raf = 0; render(); });
  }

  function resize() {
    const c = canvas();
    if (!c) return;
    const rect = c.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.lastRenderWidth = rect.width;
    scheduleRender();
  }

  function render() {
    const c = canvas();
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (!w || !h) return;
    const ctx = c.getContext('2d');
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, w, h);

    const { arr, start, end, data } = getVisible();
    const L = getLayout(w, h);
    if (!data.length) {
      ctx.fillStyle = COLORS.text; ctx.font = '13px -apple-system, sans-serif';
      ctx.fillText('In attesa delle candele Bybit…', 18, 34);
      return;
    }

    // The ticker is faster than the kline stream. Overlay its lastPrice onto the
    // currently forming candle for display only; stored OHLCV remains exchange kline data.
    const live = state.panOffset === 0 && state.livePrice && Date.now() - state.livePrice.receivedAt <= 15000
      ? state.livePrice : null;
    const visualData = data.slice();
    const intervalSeconds = Number(state.activeTf) * 60;
    if (live && arr.length) {
      const bucket = Math.floor(live.time / intervalSeconds) * intervalSeconds;
      const lastReal = arr[arr.length - 1];
      if (lastReal.time === bucket && !lastReal.confirmed) {
        const visibleIndex = visualData.findIndex(c => c.time === bucket);
        if (visibleIndex >= 0) {
          const candle = visualData[visibleIndex];
          visualData[visibleIndex] = { ...candle, high: Math.max(candle.high, live.price), low: Math.min(candle.low, live.price), close: live.price, liveOverlay: true };
        }
      }
    }

    let min = Math.min(...visualData.map(x => x.low));
    let max = Math.max(...visualData.map(x => x.high));
    if (live) { min = Math.min(min, live.price); max = Math.max(max, live.price); }
    const range = Math.max(max - min, Math.abs(max) * 0.0002, 0.000001);
    min -= range * 0.08; max += range * 0.08;
    const y = price => L.bottom - (price - min) / (max - min) * (L.bottom - L.top);
    const slot = L.width / Math.max(visualData.length, 1);
    const bodyW = Math.max(1.5, Math.min(12, slot * 0.66));
    const xForIndex = i => L.left + (i - start + 0.5) * slot;
    const timeToX = t => {
      const absoluteIndex = nearestIndex(arr, t);
      if (absoluteIndex < 0) return NaN;
      const seconds = Number(state.activeTf) * 60;
      const fractionalIndex = absoluteIndex + (Number(t) - arr[absoluteIndex].time) / Math.max(60, seconds);
      return xForIndex(fractionalIndex);
    };

    // Price grid and labels.
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const py = L.top + (L.bottom - L.top) * i / 5;
      const price = max - (max - min) * i / 5;
      ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L.left, py); ctx.lineTo(L.right, py); ctx.stroke();
      ctx.fillStyle = COLORS.text; ctx.fillText(price.toFixed(5), L.right + 7, py);
    }

    const maxVol = Math.max(1, ...visualData.map(x => x.volume || 0));
    // Volume bars.
    visualData.forEach((candle, j) => {
      const x = xForIndex(start + j);
      const vh = ((candle.volume || 0) / maxVol) * (L.volumeBottom - L.volumeTop);
      ctx.fillStyle = candle.close >= candle.open ? COLORS.volumeUp : COLORS.volumeDown;
      ctx.fillRect(x - bodyW / 2, L.volumeBottom - vh, bodyW, vh);
    });

    // Candlesticks.
    visualData.forEach((candle, j) => {
      const x = xForIndex(start + j), up = candle.close >= candle.open;
      const color = up ? COLORS.green : COLORS.red;
      const openY = y(candle.open), closeY = y(candle.close), highY = y(candle.high), lowY = y(candle.low);
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(1, Math.min(1.6, slot * 0.12));
      ctx.beginPath(); ctx.moveTo(x, highY); ctx.lineTo(x, lowY); ctx.stroke();
      const topBody = Math.min(openY, closeY), bodyH = Math.max(1, Math.abs(closeY - openY));
      ctx.fillRect(x - bodyW / 2, topBody, bodyW, bodyH);
      if (!candle.confirmed) {
        ctx.strokeStyle = COLORS.amber; ctx.setLineDash([2, 2]);
        ctx.strokeRect(x - bodyW / 2 - 1, topBody - 1, bodyW + 2, bodyH + 2); ctx.setLineDash([]);
      }
    });

    // Volume separator and time axis.
    ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(L.left, L.volumeTop - 5); ctx.lineTo(L.right, L.volumeTop - 5); ctx.stroke();
    ctx.fillStyle = COLORS.text; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    const labelEvery = Math.max(1, Math.floor(visualData.length / 6));
    for (let j = 0; j < visualData.length; j += labelEvery) {
      const x = xForIndex(start + j);
      ctx.fillText(timeLabel(visualData[j].time, state.activeTf), x, L.volumeBottom + 9);
    }

    // Live last-trade price marker follows the same public ticker as the header and paper P&L.
    if (live) {
      const py = y(live.price);
      ctx.save(); ctx.strokeStyle = COLORS.amber; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(L.left, py); ctx.lineTo(L.right, py); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#3b2d12'; ctx.fillRect(L.right + 2, py - 9, 68, 18);
      ctx.fillStyle = COLORS.amber; ctx.font = 'bold 10px -apple-system, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(live.price.toFixed(5), L.right + 5, py); ctx.restore();
    }

    // Active paper position is a separate overlay, not an operator drawing or strategy signal.
    if (state.tradeOverlay) drawTradeOverlay(ctx, state.tradeOverlay, L, y);

    // Operator drawings are time/price anchored and can be inspected on any timeframe.
    state.annotations.forEach(a => drawAnnotation(ctx, a, arr, start, end, L, y, timeToX));
    if (state.pendingTrendAnchor && state.crosshair && state.drawMode === 'trendline') {
      const x1 = timeToX(state.pendingTrendAnchor.time), y1 = y(state.pendingTrendAnchor.price);
      ctx.strokeStyle = COLORS.amber; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(state.crosshair.x, state.crosshair.y); ctx.stroke(); ctx.setLineDash([]);
    }

    // Crosshair.
    if (state.crosshair && state.crosshair.x >= L.left && state.crosshair.x <= L.right && state.crosshair.y >= L.top && state.crosshair.y <= L.bottom) {
      ctx.strokeStyle = COLORS.cross; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(state.crosshair.x, L.top); ctx.lineTo(state.crosshair.x, L.volumeBottom); ctx.moveTo(L.left, state.crosshair.y); ctx.lineTo(L.right, state.crosshair.y); ctx.stroke(); ctx.setLineDash([]);
      const price = max - ((state.crosshair.y - L.top) / (L.bottom - L.top)) * (max - min);
      ctx.fillStyle = '#22354c'; ctx.fillRect(L.right + 2, state.crosshair.y - 9, 68, 18);
      ctx.fillStyle = '#edf3fb'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(price.toFixed(5), L.right + 6, state.crosshair.y);
    }

    const last = visualData[visualData.length - 1];
    const selected = state.crosshair ? candleAtX(state.crosshair.x, arr, start, end, L) : last;
    updateOhlc(selected || last);
  }


  function drawTradeOverlay(ctx, trade, L, y) {
    const lines = [
      { key: 'entry', label: `${trade.side} ENTRY`, color: COLORS.blue, dash: [] },
      { key: 'stop', label: 'STOP LOSS', color: COLORS.red, dash: [6, 4] },
      { key: 'target', label: 'TAKE PROFIT', color: COLORS.green, dash: [6, 4] }
    ];
    ctx.save();
    ctx.font = 'bold 10px -apple-system, sans-serif';
    lines.forEach(line => {
      const value = Number(trade[line.key]);
      if (!(Number.isFinite(value) && value > 0)) return;
      const py = y(value);
      if (py < L.top || py > L.bottom) return;
      ctx.strokeStyle = line.color; ctx.lineWidth = line.key === 'entry' ? 1.7 : 1.2;
      ctx.setLineDash(line.dash); ctx.beginPath(); ctx.moveTo(L.left, py); ctx.lineTo(L.right, py); ctx.stroke(); ctx.setLineDash([]);
      const label = `${line.label} ${value.toFixed(5)}`;
      const width = ctx.measureText(label).width + 12;
      ctx.fillStyle = '#101a2a'; ctx.fillRect(Math.max(L.left, L.right - width), py - 9, width, 18);
      ctx.fillStyle = line.color; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(label, L.right - 6, py);
    });
    ctx.restore();
  }

  function drawAnnotation(ctx, a, arr, start, end, L, y, timeToX) {
    const anchor = a.anchors && a.anchors[0];
    if (!anchor) return;
    const x1 = timeToX(anchor.time), y1 = y(anchor.price);
    if (!Number.isFinite(x1) || !Number.isFinite(y1)) return;
    if (a.type === 'ENTRY_MARKER') {
      const isLong = a.side === 'LONG';
      const col = isLong ? COLORS.green : COLORS.red;
      ctx.fillStyle = col; ctx.strokeStyle = '#07101b'; ctx.lineWidth = 1;
      ctx.beginPath();
      if (isLong) { ctx.moveTo(x1, y1 - 13); ctx.lineTo(x1 - 7, y1); ctx.lineTo(x1 + 7, y1); }
      else { ctx.moveTo(x1, y1 + 13); ctx.lineTo(x1 - 7, y1); ctx.lineTo(x1 + 7, y1); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.font = 'bold 10px -apple-system, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const label = isLong ? 'LONG' : 'SHORT';
      ctx.fillStyle = col; ctx.fillText(label, x1 + 9, y1 + (isLong ? -8 : 8));
    } else if (a.type === 'TRENDLINE') {
      const b = a.anchors[1]; if (!b) return;
      const x2 = timeToX(b.time), y2 = y(b.price); if (!Number.isFinite(x2) || !Number.isFinite(y2)) return;
      ctx.strokeStyle = a.role === 'support' ? COLORS.green : a.role === 'resistance' ? COLORS.red : COLORS.blue;
      ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(x1, y1, 3, 0, Math.PI * 2); ctx.arc(x2, y2, 3, 0, Math.PI * 2); ctx.fill();
    } else if (a.type === 'HORIZONTAL_LEVEL') {
      ctx.strokeStyle = a.role === 'support' ? COLORS.green : a.role === 'resistance' ? COLORS.red : COLORS.amber;
      ctx.lineWidth = 1.3; ctx.setLineDash([7, 4]); ctx.beginPath(); ctx.moveTo(L.left, y1); ctx.lineTo(L.right, y1); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(a.role.toUpperCase() + ' ' + Number(anchor.price).toFixed(5), L.left + 5, y1 - 7);
    }
  }

  function candleAtX(x, arr, start, end, L) {
    if (end <= start) return null;
    const slot = L.width / Math.max(1, end - start);
    const index = clamp(Math.floor((x - L.left) / slot) + start, start, end - 1);
    return arr[index];
  }

  function updateOhlc(c) {
    if (!c) return;
    const o = $('chartOhlc'), v = $('chartVolume');
    if (o) o.innerHTML = `O <b>${c.open.toFixed(5)}</b> H <b>${c.high.toFixed(5)}</b> L <b>${c.low.toFixed(5)}</b> C <b>${c.close.toFixed(5)}</b> · ${c.confirmed ? 'CHIUSA' : 'IN FORMAZIONE'}`;
    if (v) v.innerHTML = `Volume <b>${Number(c.volume || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>`;
  }

  function canvasPoint(event) {
    const c = canvas(), rect = c.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function pointToMarket(point) {
    const { arr, start, end } = getVisible();
    if (!arr.length || end <= start) return null;
    const c = canvas(), w = c.getBoundingClientRect().width, h = c.getBoundingClientRect().height;
    const L = getLayout(w, h);
    const data = arr.slice(start, end);
    let min = Math.min(...data.map(x => x.low)), max = Math.max(...data.map(x => x.high));
    const range = Math.max(max - min, Math.abs(max) * 0.0002, 0.000001);
    min -= range * 0.08; max += range * 0.08;
    const slot = L.width / Math.max(1, end - start);
    const index = clamp(Math.floor((point.x - L.left) / slot) + start, start, end - 1);
    const price = max - ((point.y - L.top) / (L.bottom - L.top)) * (max - min);
    const candle = arr[index];
    return { time: candle.time, price: Math.max(0, price), candle, timeframe: state.activeTf };
  }

  function setDrawMode(mode) {
    state.drawMode = mode;
    state.pendingTrendAnchor = null;
    document.querySelectorAll('[data-draw-mode]').forEach(b => b.classList.toggle('active', b.dataset.drawMode === mode));
    const labels = {
      cursor: 'Cursore attivo: trascina il grafico per scorrere, rotella o pulsanti per zoom.',
      entry_long: 'LONG: tocca/clicca il prezzo e la candela in cui vuoi annotare un possibile ingresso.',
      entry_short: 'SHORT: tocca/clicca il prezzo e la candela in cui vuoi annotare un possibile ingresso.',
      trendline: 'Trendline: seleziona due punti del grafico per creare una linea ancorata a tempo e prezzo.',
      level: 'Livello: seleziona un prezzo per tracciare una linea orizzontale.',
      level_support: 'Supporto: seleziona il prezzo della zona di supporto.',
      level_resistance: 'Resistenza: seleziona il prezzo della zona di resistenza.'
    };
    if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = labels[mode] || '';
    scheduleRender();
  }

  function snapshotAnnotation(type, points, extras) {
    const note = ($('annotationNote')?.value || '').trim();
    const anchors = points.map(p => ({
      time: p.time, time_iso: new Date(p.time * 1000).toISOString(), price: Number(p.price),
      candle: { open: p.candle.open, high: p.candle.high, low: p.candle.low, close: p.candle.close, volume: p.candle.volume, confirmed: p.candle.confirmed }
    }));
    const ann = {
      annotation_id: makeId(), type, side: extras.side || null, role: extras.role || 'reference',
      symbol: SYMBOL, category: CATEGORY, timeframe: state.activeTf, anchors,
      note, feedback_category: type === 'ENTRY_MARKER' ? 'entry_location' : type === 'TRENDLINE' ? 'structure' : 'structure_level',
      label_status: 'OPERATOR_CANDIDATE', validation_status: 'PENDING_VALIDATION',
      decision_intent: 'MANUAL_REFERENCE_ONLY', execution_authorized: false,
      source: 'operator_manual_chart', exchange: 'BYBIT_PUBLIC_MARKET_DATA',
      created_at: new Date().toISOString(), imported: false
    };
    state.annotations.push(ann);
    state.annotations = state.annotations.slice(-1000);
    persistAnnotations(); renderAnnotationList(); scheduleRender();
    if ($('annotationNote')) $('annotationNote').value = '';
  }

  function handleDraw(point) {
    const market = pointToMarket(point);
    if (!market) return;
    if (state.drawMode === 'entry_long') snapshotAnnotation('ENTRY_MARKER', [market], { side: 'LONG' });
    else if (state.drawMode === 'entry_short') snapshotAnnotation('ENTRY_MARKER', [market], { side: 'SHORT' });
    else if (state.drawMode === 'level' || state.drawMode === 'level_support' || state.drawMode === 'level_resistance') {
      const role = state.drawMode === 'level_support' ? 'support' : state.drawMode === 'level_resistance' ? 'resistance' : 'reference';
      snapshotAnnotation('HORIZONTAL_LEVEL', [market], { role });
    } else if (state.drawMode === 'trendline') {
      if (!state.pendingTrendAnchor) {
        state.pendingTrendAnchor = market;
        if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Primo ancoraggio acquisito. Seleziona il secondo punto per completare la trendline.';
      } else {
        const first = state.pendingTrendAnchor;
        const deltaTime = market.time - first.time;
        const role = deltaTime === 0 ? 'reference' : ((market.price - first.price) / deltaTime > 0 ? 'support' : 'resistance');
        snapshotAnnotation('TRENDLINE', [first, market], { role });
        state.pendingTrendAnchor = null;
        if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Trendline salvata. Puoi continuare a disegnare o passare al cursore.';
      }
    }
  }

  function pointerDown(e) {
    const point = canvasPoint(e);
    if (state.drawMode !== 'cursor') {
      const c = canvas(), L = getLayout(c.clientWidth, c.clientHeight);
      if (point.x >= L.left && point.x <= L.right && point.y >= L.top && point.y <= L.bottom) handleDraw(point);
      e.preventDefault(); return;
    }
    state.drag = { x: point.x, pan: state.panOffset, moved: false };
    canvas().setPointerCapture?.(e.pointerId);
  }

  function pointerMove(e) {
    const point = canvasPoint(e); state.crosshair = point;
    if (state.drag && state.drawMode === 'cursor') {
      const c = canvas(), L = getLayout(c.clientWidth, c.clientHeight);
      const slot = L.width / Math.max(1, state.viewCount);
      const deltaBars = (state.drag.x - point.x) / Math.max(slot, 1);
      if (Math.abs(point.x - state.drag.x) > 2) state.drag.moved = true;
      if (state.drag.moved) {
        state.panOffset = clamp(Math.round(state.drag.pan + deltaBars), 0, Math.max(0, state.candles[state.activeTf].length - 10));
      }
    }
    const market = pointToMarket(point);
    const cross = $('chartCursor');
    if (cross && market) cross.innerHTML = `Crosshair <b>${market.price.toFixed(5)}</b> · ${timeLabel(market.time, state.activeTf)}`;
    scheduleRender();
  }

  function pointerUp() { state.drag = null; }

  function wheel(e) {
    e.preventDefault();
    state.viewCount = clamp(state.viewCount + (e.deltaY > 0 ? 8 : -8), 20, 240);
    state.panOffset = clamp(state.panOffset, 0, Math.max(0, state.candles[state.activeTf].length - 10));
    scheduleRender();
  }

  function setTimeframe(tf) {
    tf = String(tf);
    if (!INTERVALS.includes(tf)) return;
    state.activeTf = tf; state.panOffset = 0; state.pendingTrendAnchor = null;
    document.querySelectorAll('[data-tf]').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
    setStatus(state.candles[tf].length ? 'BYBIT · ' + tfLabel(tf) : 'CARICAMENTO ' + tfLabel(tf), !!state.candles[tf].length);
    scheduleRender();
  }

  function tfLabel(tf) { return ({ '1': '1m', '5': '5m', '15': '15m', '60': '1h' })[tf] || tf; }

  function persistAnnotations() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.annotations)); }
    catch (e) { if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Storage locale pieno: esporta le annotazioni e libera spazio.'; }
  }

  function loadAnnotations() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) state.annotations = saved.filter(validateAnnotation).slice(-1000);
    } catch (e) { state.annotations = []; }
    renderAnnotationList();
  }

  function validateAnnotation(a) {
    if (!a || !['ENTRY_MARKER', 'TRENDLINE', 'HORIZONTAL_LEVEL'].includes(a.type)) return false;
    if (a.symbol !== SYMBOL || a.category !== CATEGORY || !a.annotation_id || !INTERVALS.includes(String(a.timeframe)) || a.execution_authorized !== false || !Array.isArray(a.anchors)) return false;
    if (a.type === 'ENTRY_MARKER' && !['LONG', 'SHORT'].includes(a.side)) return false;
    if (a.anchors.length !== (a.type === 'TRENDLINE' ? 2 : 1)) return false;
    return a.anchors.every(p => Number.isFinite(Number(p.time)) && isFinitePositive(p.price));
  }

  function renderAnnotationList() {
    const list = $('annotationList'); if (!list) return;
    $('annotationCount').textContent = state.annotations.length;
    const pendingCount = state.annotations.filter(a => !a.machineSubmitted).length;
    const bulkButton = $('sendAllAnnotations');
    if (bulkButton) {
      bulkButton.textContent = state.batchSending
        ? 'Invio annotazioni…'
        : `Invia tutte le annotazioni ad AEE (${pendingCount})`;
      bulkButton.disabled = state.batchSending || pendingCount === 0;
      bulkButton.setAttribute?.('aria-label', `Invia ${pendingCount} annotazioni non ancora inviate ad AEE`);
    }
    list.replaceChildren();
    if (!state.annotations.length) {
      const empty = document.createElement('div'); empty.className = 'small'; empty.textContent = 'Nessuna annotazione manuale.'; list.appendChild(empty); return;
    }
    state.annotations.slice().reverse().slice(0, 20).forEach(a => {
      const row = document.createElement('div'); row.className = 'annotation-item';
      const left = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = a.type === 'ENTRY_MARKER' ? `${a.side} ENTRY` : a.type === 'TRENDLINE' ? `TRENDLINE · ${a.role}` : `LIVELLO · ${a.role}`;
      const meta = document.createElement('div'); meta.className = 'muted';
      meta.textContent = `${tfLabel(a.timeframe)} · ${a.anchors.map(p => Number(p.price).toFixed(5)).join(' → ')} · ${new Date(a.created_at).toLocaleString('it-IT')}`;
      left.append(title, meta);
      if (a.note) { const note = document.createElement('div'); note.className = 'muted'; note.textContent = a.note; left.appendChild(note); }
      const actions = document.createElement('div'); actions.className = 'annotation-actions';
      const status = document.createElement('div'); status.className = 'muted';
      status.textContent = a.machineSubmitted ? (a.trainingStatus === 'APPROVED_FOR_OFFLINE_VALIDATION' ? 'INVIATA · APPROVATA PER TEST OFFLINE' : a.trainingStatus === 'EXCLUDED' ? 'INVIATA · ESCLUSA DAL TRAINING' : 'CONTESTO INVIATO AD AEE') : 'NON ANCORA INVIATA';
      left.appendChild(status);
      if (!a.machineSubmitted) {
        const send = document.createElement('button'); send.type = 'button'; send.textContent = 'Invia ad AEE';
        send.addEventListener('click', () => sendAnnotationToMachine(a.annotation_id)); actions.appendChild(send);
      } else if (a.trainingStatus === 'PENDING_OPERATOR_APPROVAL' || !a.trainingStatus) {
        const approve = document.createElement('button'); approve.type = 'button'; approve.textContent = 'Approva per test offline';
        approve.addEventListener('click', () => approveAnnotationForLearning(a.annotation_id)); actions.appendChild(approve);
        const exclude = document.createElement('button'); exclude.type = 'button'; exclude.textContent = 'Non usare';
        exclude.addEventListener('click', () => excludeAnnotationFromLearning(a.annotation_id)); actions.appendChild(exclude);
      }
      const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Rimuovi'; del.addEventListener('click', () => removeAnnotation(a.annotation_id));
      actions.appendChild(del);
      row.append(left, actions); list.appendChild(row);
    });
  }

  function removeAnnotation(id) {
    state.annotations = state.annotations.filter(a => a.annotation_id !== id);
    persistAnnotations(); renderAnnotationList(); scheduleRender();
  }

  async function sendAnnotationToMachine(id) {
    const annotation = state.annotations.find(a => a.annotation_id === id);
    if (!annotation) return;
    if (annotation.machineSubmitted) return;
    if (!window.CockpitCore || typeof window.CockpitCore.registerOperatorStructure !== 'function') {
      if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Cockpit Core non disponibile: disegno non inviato.';
      return;
    }
    try {
      const record = await window.CockpitCore.registerOperatorStructure(annotation);
      annotation.machineSubmitted = true;
      annotation.machineRecordId = record.annotationId;
      annotation.machineSubmittedAt = new Date(record.receivedAt).toISOString();
      annotation.trainingStatus = record.trainingStatus;
      annotation.decision_intent = 'MACHINE_CONTEXT_REFERENCE_ONLY';
      annotation.execution_authorized = false;
      persistAnnotations(); renderAnnotationList(); scheduleRender();
      if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Disegno inviato ad AEE e registrato come contesto operatore. Non è una regola attiva.';
    } catch (error) {
      if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Invio ad AEE non riuscito: ' + error.message;
    }
  }

  async function sendAllPendingAnnotationsToMachine() {
    const pending = state.annotations.filter(a => !a.machineSubmitted);
    const status = $('bulkAnnotationStatus');
    if (!pending.length) {
      if (status) status.textContent = 'Non ci sono annotazioni nuove da inviare.';
      return { sent: 0, failed: 0, total: 0 };
    }
    if (!window.CockpitCore || typeof window.CockpitCore.registerOperatorStructure !== 'function') {
      if (status) status.textContent = 'Archivio AEE non disponibile: nessuna annotazione inviata.';
      return { sent: 0, failed: pending.length, total: pending.length };
    }
    if (!window.confirm(`Inviare tutte le ${pending.length} annotazioni non ancora inviate ad AEE come contesto?\n\nL’invio NON approva l’apprendimento offline e NON abilita ordini o modifiche alla strategia.`)) {
      return { sent: 0, failed: 0, total: pending.length, cancelled: true };
    }

    state.batchSending = true;
    renderAnnotationList();
    if (status) status.textContent = `Invio in corso: 0/${pending.length}…`;
    let sent = 0;
    const failures = [];
    try {
      // Sequential writes avoid racing IndexedDB transactions and provide a precise partial-failure report.
      for (let i = 0; i < pending.length; i++) {
        const annotation = pending[i];
        try {
          const record = await window.CockpitCore.registerOperatorStructure(annotation);
          annotation.machineSubmitted = true;
          annotation.machineRecordId = record.annotationId;
          annotation.machineSubmittedAt = new Date(record.receivedAt).toISOString();
          annotation.trainingStatus = record.trainingStatus || 'PENDING_OPERATOR_APPROVAL';
          annotation.decision_intent = 'MACHINE_CONTEXT_REFERENCE_ONLY';
          annotation.execution_authorized = false;
          sent++;
        } catch (error) {
          failures.push({ annotationId: annotation.annotation_id, error: error?.message || String(error) });
        }
        if (status) status.textContent = `Invio in corso: ${i + 1}/${pending.length} · ${sent} registrate`;
      }
    } finally {
      state.batchSending = false;
      persistAnnotations();
      renderAnnotationList();
      scheduleRender();
    }

    const failed = failures.length;
    const summary = `Batch completato: ${sent}/${pending.length} annotazioni registrate come contesto${failed ? ` · ${failed} errori` : ''}. Nessuna approvazione automatica per il test offline.`;
    if (status) status.textContent = summary + (failed ? ` Dettagli: ${failures.map(x => `${x.annotationId}: ${x.error}`).join(' | ')}` : '');
    if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = summary;
    return { sent, failed, total: pending.length, failures };
  }

  async function approveAnnotationForLearning(id) {
    const annotation = state.annotations.find(a => a.annotation_id === id);
    if (!annotation || !annotation.machineSubmitted) return;
    if (!window.confirm('Confermi l’uso di questo disegno come esempio per test e validazione OFFLINE? Non aggiornerà il modello live.')) return;
    try {
      const record = await window.CockpitCore.approveOperatorStructure(id);
      annotation.trainingStatus = record.trainingStatus;
      annotation.trainingApprovedAt = new Date(record.approvedAt).toISOString();
      persistAnnotations(); renderAnnotationList();
      if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Esempio approvato per replay/validazione offline. Nessun apprendimento live.';
    } catch (error) {
      if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Approvazione non riuscita: ' + error.message;
    }
  }

  async function excludeAnnotationFromLearning(id) {
    const annotation = state.annotations.find(a => a.annotation_id === id);
    if (!annotation || !annotation.machineSubmitted) return;
    try {
      const record = await window.CockpitCore.excludeOperatorStructure(id);
      annotation.trainingStatus = record.trainingStatus;
      persistAnnotations(); renderAnnotationList();
      if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Disegno mantenuto come contesto, escluso dagli esempi di apprendimento.';
    } catch (error) {
      if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = 'Esclusione non riuscita: ' + error.message;
    }
  }

  function exportAnnotations() {
    const payload = {
      schema: SCHEMA, schema_version: 1, exported_at: new Date().toISOString(),
      market: { exchange: 'BYBIT', category: CATEGORY, symbol: SYMBOL },
      safety: { reference_only: true, execution_authorized: false, training_status: 'OPERATOR_CONTROLLED_OFFLINE_ONLY' },
      semantics: {
        ENTRY_MARKER: 'Operator-labelled potential entry location; not an order or strategy signal.',
        TRENDLINE: 'Two time/price anchors representing a manually drawn structural line.',
        HORIZONTAL_LEVEL: 'Single time/price anchor representing a manually marked level.'
      },
      annotations: state.annotations
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `xrp-quant-operator-markup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importAnnotations(file) {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (payload.schema !== SCHEMA || payload.schema_version !== 1 || payload.market?.exchange !== 'BYBIT' || payload.market?.category !== CATEGORY || payload.market?.symbol !== SYMBOL || payload.safety?.execution_authorized !== false || !Array.isArray(payload.annotations)) {
      throw new Error('Formato non valido: atteso ' + SCHEMA + ' per ' + SYMBOL);
    }
    const existing = new Set(state.annotations.map(a => a.annotation_id));
    const valid = payload.annotations.filter(validateAnnotation).filter(a => !existing.has(a.annotation_id)).map(a => ({
      ...a,
      imported: true,
      imported_at: new Date().toISOString(),
      execution_authorized: false,
      machineSubmitted: false,
      machineRecordId: null,
      machineSubmittedAt: null,
      trainingStatus: 'NOT_SUBMITTED',
      trainingApprovedAt: null
    }));
    state.annotations = [...state.annotations, ...valid].slice(-1000);
    persistAnnotations(); renderAnnotationList(); scheduleRender();
    if ($('chartDrawingStatus')) $('chartDrawingStatus').textContent = `Importate ${valid.length} annotazioni valide. Restano etichette manuali non validate.`;
  }

  function undoLast() {
    if (!state.annotations.length) return;
    state.annotations.pop(); persistAnnotations(); renderAnnotationList(); scheduleRender();
  }

  function bindUi() {
    document.querySelectorAll('[data-tf]').forEach(b => b.addEventListener('click', () => setTimeframe(b.dataset.tf)));
    document.querySelectorAll('[data-draw-mode]').forEach(b => b.addEventListener('click', () => setDrawMode(b.dataset.drawMode)));
    $('chartZoomIn')?.addEventListener('click', () => { state.viewCount = clamp(state.viewCount - 10, 20, 240); scheduleRender(); });
    $('chartZoomOut')?.addEventListener('click', () => { state.viewCount = clamp(state.viewCount + 10, 20, 240); scheduleRender(); });
    $('chartReset')?.addEventListener('click', () => { state.panOffset = 0; state.viewCount = 75; setDrawMode('cursor'); scheduleRender(); });
    $('undoAnnotation')?.addEventListener('click', undoLast);
    $('sendAllAnnotations')?.addEventListener('click', sendAllPendingAnnotationsToMachine);
    $('exportAnnotations')?.addEventListener('click', exportAnnotations);
    $('clearAnnotations')?.addEventListener('click', () => {
      if (confirm('Cancellare tutte le annotazioni manuali salvate su questo dispositivo? Esporta prima il JSON se vuoi conservarle.')) {
        state.annotations = []; persistAnnotations(); renderAnnotationList(); scheduleRender();
      }
    });
    $('importAnnotationsButton')?.addEventListener('click', () => $('importAnnotationsFile')?.click());
    $('importAnnotationsFile')?.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0]; if (!file) return;
      try { await importAnnotations(file); }
      catch (err) { alert('Importazione non riuscita: ' + err.message); }
      e.target.value = '';
    });
    const c = canvas();
    if (c) {
      c.addEventListener('pointerdown', pointerDown);
      c.addEventListener('pointermove', pointerMove);
      c.addEventListener('pointerup', pointerUp);
      c.addEventListener('pointercancel', pointerUp);
      c.addEventListener('pointerleave', () => { if (!state.drag) { state.crosshair = null; scheduleRender(); } });
      c.addEventListener('wheel', wheel, { passive: false });
    }
    if (window.ResizeObserver && $('marketChartCanvas')) {
      state.resizeObserver = new ResizeObserver(resize);
      state.resizeObserver.observe($('marketChartCanvas'));
      state.resizeObserver.observe($('chart') || $('marketChartCanvas'));
    } else window.addEventListener('resize', resize);
  }

  function init() {
    loadAnnotations(); bindUi(); setTimeframe('5');
    setTimeout(resize, 40);
  }

  function setTradeOverlay(trade) {
    if (!trade) state.tradeOverlay = null;
    else {
      const side = String(trade.side || '').toUpperCase();
      const values = ['entry', 'stop', 'target'].map(k => Number(trade[k]));
      if ((side === 'LONG' || side === 'SHORT') && values.every(v => Number.isFinite(v) && v > 0)) {
        state.tradeOverlay = { side, entry: values[0], stop: values[1], target: values[2], origin: String(trade.origin || 'BOT_SIGNAL_C'), remaining: Number(trade.remaining) };
      } else state.tradeOverlay = null;
    }
    scheduleRender();
  }

  window.ChartCockpit = { init, setCandles, update, updateLivePrice, setLiveAge, loadHistory, resize, setTradeOverlay, exportAnnotations, sendAnnotationToMachine, sendAllPendingAnnotationsToMachine, approveAnnotationForLearning, excludeAnnotationFromLearning, getAnnotations: () => state.annotations.map(a => ({ ...a })), getCandles: (tf) => (state.candles[String(tf)] || []).map(c => ({ ...c })), getLivePrice: () => state.livePrice ? { ...state.livePrice } : null, setStatus, schema: SCHEMA };
})();
