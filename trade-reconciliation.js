/* XRP Quant Terminal — Trade Journal & Offline Recovery v0.9.6
 * Pure, deterministic candle replay helpers. No exchange order routing.
 * Recovery uses confirmed 1m OHLC candles; when SL and target touch in the
 * same minute, SL is assumed first (conservative ambiguity resolution).
 */
(function (root) {
  'use strict';

  const MINUTE_MS = 60_000;
  const EPS = 1e-9;

  function finitePositive(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  }

  function normaliseMinuteCandle(raw) {
    if (!raw) return null;
    let startMs, open, high, low, close, volume, confirmed;
    if (Array.isArray(raw)) {
      startMs = Number(raw[0]);
      open = Number(raw[1]); high = Number(raw[2]); low = Number(raw[3]);
      close = Number(raw[4]); volume = Number(raw[5] || 0);
      // REST does not include a confirm flag. Caller must also apply throughMs.
      confirmed = raw[6] === true;
    } else {
      const timeValue = raw.startMs ?? raw.start ?? raw.time;
      startMs = Number(timeValue);
      if (raw.time !== undefined && raw.start === undefined && startMs < 10_000_000_000) startMs *= 1000;
      open = Number(raw.open); high = Number(raw.high); low = Number(raw.low);
      close = Number(raw.close); volume = Number(raw.volume || 0);
      confirmed = raw.confirm === true || raw.confirmed === true;
    }
    if (!(Number.isFinite(startMs) && startMs > 0)) return null;
    startMs = Math.floor(startMs / MINUTE_MS) * MINUTE_MS;
    if (![open, high, low, close].every(Number.isFinite) || !(high >= low) || volume < 0) return null;
    return { startMs, open, high, low, close, volume, confirmed };
  }

  function initialReplayCursor(entryTime, origin) {
    const t = Number(entryTime);
    if (!(Number.isFinite(t) && t > 0)) return null;
    const minute = Math.floor(t / MINUTE_MS) * MINUTE_MS;
    // Bot entries are stamped at a completed 5m close, so the following 1m
    // candle starts exactly at entryTime and must be included. Manual entries
    // can happen inside a minute: skip that partially pre-entry candle.
    return String(origin || '').startsWith('BOT_') ? minute - MINUTE_MS : minute;
  }

  function favourableBps(side, entry, price) {
    const raw = (Number(price) - Number(entry)) / Number(entry) * 10_000;
    return String(side).toUpperCase() === 'SHORT' ? -raw : raw;
  }

  function resolveMinute(position, rawCandle, options = {}) {
    const candle = normaliseMinuteCandle(rawCandle);
    if (!candle) return { accepted: false, reason: 'INVALID_CANDLE' };
    const p = position || {};
    const side = String(p.side || '').toUpperCase();
    const entry = finitePositive(p.entry);
    const stop = finitePositive(p.stop);
    const target = finitePositive(p.target);
    if (!['LONG', 'SHORT'].includes(side) || !Number.isFinite(entry) || !Number.isFinite(stop)) {
      return { accepted: false, reason: 'INVALID_POSITION' };
    }

    const cursor = Number.isFinite(Number(p.lastProcessedMinuteStart))
      ? Number(p.lastProcessedMinuteStart)
      : initialReplayCursor(p.entryTime, p.origin);
    if (!Number.isFinite(cursor) || candle.startMs <= cursor) return { accepted: false, reason: 'ALREADY_PROCESSED' };
    if (Number.isFinite(Number(options.throughMs)) && candle.startMs + MINUTE_MS > Number(options.throughMs)) {
      return { accepted: false, reason: 'CANDLE_NOT_CLOSED' };
    }
    const expected = cursor + MINUTE_MS;
    if (candle.startMs > expected) {
      return { accepted: false, reason: 'DATA_GAP', expectedStartMs: expected, actualStartMs: candle.startMs };
    }
    if (candle.startMs < expected) return { accepted: false, reason: 'OUT_OF_ORDER' };
    if (Number.isFinite(Number(p.entryTime)) && candle.startMs + MINUTE_MS <= Number(p.entryTime)) {
      return { accepted: false, reason: 'BEFORE_ENTRY' };
    }

    const next = { ...p };
    const highFavourable = favourableBps(side, entry, candle.high);
    const lowFavourable = favourableBps(side, entry, candle.low);
    next.mfeBps = Math.max(Number(next.mfeBps) || 0, highFavourable, lowFavourable);
    // For adverse excursion, take the negative of the least favourable extreme.
    const adverseExtreme = side === 'LONG' ? candle.low : candle.high;
    next.maeBps = Math.max(Number(next.maeBps) || 0, -favourableBps(side, entry, adverseExtreme));
    if (side === 'LONG') next.peakPrice = Math.max(finitePositive(next.peakPrice) || entry, candle.high);
    else next.peakPrice = Math.min(finitePositive(next.peakPrice) || entry, candle.low);
    next.lastProcessedMinuteStart = candle.startMs;
    next.lastProcessedCandleClose = candle.close;

    const stopTouched = side === 'LONG' ? candle.low <= stop : candle.high >= stop;
    const operatorManaged = p.managementMode === 'OPERATOR' || p.origin === 'OPERATOR_MANUAL';
    let action = null;

    // Ambiguous bar: when both SL and target are inside its range, choose SL first.
    if (stopTouched) {
      const gapThrough = side === 'LONG' ? candle.open < stop : candle.open > stop;
      const fillPrice = gapThrough ? candle.open : stop;
      action = {
        type: 'CLOSE_ALL', reason: operatorManaged ? 'RECOVERY_STOP_LOSS_OPERATOR' : 'RECOVERY_STOP_LOSS_AUTO',
        fillPrice, candleStartMs: candle.startMs, candleCloseMs: candle.startMs + MINUTE_MS,
        conservativeResolution: side === 'LONG' ? 'STOP_FIRST_IF_STOP_AND_TARGET_BOTH_TOUCHED' : 'STOP_FIRST_IF_STOP_AND_TARGET_BOTH_TOUCHED',
        gapThroughStop: gapThrough
      };
      next.remaining = 0;
      next.recoveryClosed = true;
    } else if (operatorManaged && Number.isFinite(target)) {
      const targetTouched = side === 'LONG' ? candle.high >= target : candle.low <= target;
      if (targetTouched) {
        action = {
          type: 'CLOSE_ALL', reason: 'RECOVERY_TAKE_PROFIT_OPERATOR', fillPrice: target,
          candleStartMs: candle.startMs, candleCloseMs: candle.startMs + MINUTE_MS,
          conservativeResolution: 'TARGET_LIMIT_ASSUMED_AT_TARGET'
        };
        next.remaining = 0;
        next.recoveryClosed = true;
      }
    } else if (!operatorManaged && !next.partialTarget && Number.isFinite(target)) {
      const atr = finitePositive(p.atrAtEntry) || finitePositive(options.atrFallback);
      const threshold = atr
        ? (side === 'LONG' ? target - atr * 0.20 : target + atr * 0.20)
        : target;
      const reached = side === 'LONG' ? candle.high >= threshold : candle.low <= threshold;
      if (reached) {
        const currentRemaining = Math.max(0, Number(p.remaining) || 0);
        const quantityFraction = currentRemaining * 0.5;
        action = {
          type: 'PARTIAL_CLOSE', reason: 'RECOVERY_NEAR_TARGET_PARTIAL_50_AUTO',
          fillPrice: threshold, quantityFraction, candleStartMs: candle.startMs,
          candleCloseMs: candle.startMs + MINUTE_MS,
          targetThreshold: threshold,
          conservativeResolution: 'NEAR_TARGET_THRESHOLD_ASSUMED'
        };
        next.partialTarget = true;
        next.remaining = Math.max(0, currentRemaining - quantityFraction);
      }
    }

    next.recoveryStatus = 'REPLAYED_CANDLE';
    return { accepted: true, candle, position: next, action, reason: action ? action.reason : 'CANDLE_REPLAYED' };
  }

  function replayPosition(position, candles, options = {}) {
    let working = { ...(position || {}) };
    const list = (Array.isArray(candles) ? candles : [])
      .map(normaliseMinuteCandle).filter(Boolean).sort((a, b) => a.startMs - b.startMs);
    const throughMs = Number(options.throughMs);
    const actions = [];
    let processed = 0, gapAtMs = null, lastProcessed = Number(working.lastProcessedMinuteStart);
    if (!Number.isFinite(lastProcessed)) lastProcessed = initialReplayCursor(working.entryTime, working.origin);
    working.lastProcessedMinuteStart = lastProcessed;

    for (const candle of list) {
      if (Number.isFinite(throughMs) && candle.startMs + MINUTE_MS > throughMs) continue;
      if (candle.startMs <= working.lastProcessedMinuteStart) continue;
      const result = resolveMinute(working, candle, { throughMs, atrFallback: options.atrFallback });
      if (!result.accepted) {
        if (result.reason === 'DATA_GAP') gapAtMs = result.expectedStartMs;
        if (result.reason === 'DATA_GAP' || result.reason === 'OUT_OF_ORDER') break;
        continue;
      }
      working = result.position;
      processed++;
      if (result.action) {
        actions.push(result.action);
        if (result.action.type === 'CLOSE_ALL') break;
      }
    }

    const expectedLastClosed = Number.isFinite(throughMs) ? throughMs - MINUTE_MS : null;
    const closedDuringReplay = working.recoveryClosed === true;
    const incomplete = !closedDuringReplay && (gapAtMs !== null || (
      Number.isFinite(expectedLastClosed) && working.lastProcessedMinuteStart < expectedLastClosed
    ));
    return {
      position: working,
      actions,
      processedCandles: processed,
      firstExpectedStartMs: Number.isFinite(lastProcessed) ? lastProcessed + MINUTE_MS : null,
      lastProcessedMinuteStart: working.lastProcessedMinuteStart,
      expectedLastClosedStartMs: expectedLastClosed,
      incomplete,
      closedDuringReplay,
      gapAtMs
    };
  }

  root.TradeRecovery = Object.freeze({
    MINUTE_MS,
    normaliseMinuteCandle,
    initialReplayCursor,
    resolveMinute,
    replayPosition
  });
})(typeof window !== 'undefined' ? window : globalThis);
