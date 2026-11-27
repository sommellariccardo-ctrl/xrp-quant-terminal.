/*
 * XRP Quant Terminal — Bybit V5 public live feed helpers.
 * Handles Bybit ticker snapshot/delta messages without discarding unchanged fields.
 * No private API credentials or order-routing functions are used here.
 */
(function (root) {
  'use strict';

  function mergeTicker(previous, message) {
    if (!message || !message.data) return null;
    const patch = Array.isArray(message.data) ? message.data[0] : message.data;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
    const isSnapshot = message.type === 'snapshot' || !previous;
    const ticker = { ...(isSnapshot ? {} : previous), ...patch };
    const lastPrice = Number(ticker.lastPrice);
    if (!(Number.isFinite(lastPrice) && lastPrice > 0)) return null;
    return {
      ticker,
      lastPrice,
      lastPriceInPatch: Object.prototype.hasOwnProperty.call(patch, 'lastPrice'),
      isSnapshot,
      exchangeTimestamp: Number(message.ts) > 0 ? Number(message.ts) : Date.now()
    };
  }

  function mergeTopOfBook(previous, message) {
    if (!message || !message.data || typeof message.data !== 'object') return previous || { bid: NaN, ask: NaN };
    const data = message.data;
    const next = { ...(previous || { bid: NaN, ask: NaN }) };

    function applySide(entries, key, isBid) {
      if (!Array.isArray(entries) || entries.length === 0) return;
      const valid = entries
        .filter(level => Array.isArray(level) && Number(level.length) >= 2)
        .map(level => ({ price: Number(level[0]), size: Number(level[1]) }))
        .filter(level => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0);
      if (!valid.length) {
        // A zero-size delta can remove the previous best level. Mark that side
        // unavailable until a replacement level arrives; never keep a stale quote.
        next[key] = NaN;
        return;
      }
      valid.sort((a, b) => isBid ? b.price - a.price : a.price - b.price);
      next[key] = valid[0].price;
    }

    applySide(data.b, 'bid', true);
    applySide(data.a, 'ask', false);
    return next;
  }

  root.BybitLiveFeed = Object.freeze({ mergeTicker, mergeTopOfBook });
})(typeof window !== 'undefined' ? window : globalThis);
