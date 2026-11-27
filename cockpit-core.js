/* XRP Quant Terminal — Cockpit Core v0.9.1
 * Local-only IndexedDB event journal, operator feedback, and leverage-aware risk gate.
 * No exchange private API, no order routing, no live strategy mutation.
 */
(function (root) {
  'use strict';

  const DB_NAME = 'xrpQuantCockpitDB';
  const DB_VERSION = 1;
  const EVENT_STORE = 'events';
  const FEEDBACK_STORE = 'feedback';
  const EVENT_FALLBACK_KEY = 'xrpQuantCockpitEventsV091';
  const FEEDBACK_FALLBACK_KEY = 'xrpQuantCockpitFeedbackV091';
  let dbPromise = null;
  let storageMode = 'INDEXED_DB';

  function makeId(prefix) {
    let token;
    try {
      token = root.crypto && typeof root.crypto.randomUUID === 'function'
        ? root.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    } catch (_) {
      token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }
    return `${prefix}-${token}`;
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('IndexedDB non disponibile'));
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(EVENT_STORE)) {
          const events = db.createObjectStore(EVENT_STORE, { keyPath: 'eventId' });
          events.createIndex('createdAt', 'createdAt', { unique: false });
          events.createIndex('eventType', 'eventType', { unique: false });
        }
        if (!db.objectStoreNames.contains(FEEDBACK_STORE)) {
          const feedback = db.createObjectStore(FEEDBACK_STORE, { keyPath: 'feedbackId' });
          feedback.createIndex('createdAt', 'createdAt', { unique: false });
          feedback.createIndex('eventId', 'eventId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Apertura IndexedDB fallita'));
      request.onblocked = () => reject(new Error('IndexedDB bloccato da un’altra versione aperta'));
    });
    return dbPromise;
  }

  function fallbackRead(key) {
    try {
      const value = JSON.parse(root.localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }

  function fallbackWrite(key, value, max) {
    try {
      root.localStorage.setItem(key, JSON.stringify(value.slice(-max)));
      storageMode = 'LOCAL_FALLBACK';
      return true;
    } catch (_) {
      storageMode = 'STORAGE_ERROR';
      return false;
    }
  }

  async function putRecord(storeName, record, fallbackKey, max) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Scrittura IndexedDB fallita'));
        tx.onabort = () => reject(tx.error || new Error('Transazione IndexedDB annullata'));
      });
      storageMode = 'INDEXED_DB';
      return true;
    } catch (error) {
      const list = fallbackRead(fallbackKey).filter(x =>
        (x.eventId || x.feedbackId) !== (record.eventId || record.feedbackId));
      list.push(record);
      if (!fallbackWrite(fallbackKey, list, max)) throw error;
      return true;
    }
  }

  async function getAllRecords(storeName, fallbackKey) {
    try {
      const db = await openDB();
      const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Lettura IndexedDB fallita'));
      });
      storageMode = 'INDEXED_DB';
      return records;
    } catch (_) {
      storageMode = 'LOCAL_FALLBACK';
      return fallbackRead(fallbackKey);
    }
  }

  async function logEvent(event) {
    const record = {
      schemaVersion: 1,
      eventId: event.eventId || makeId('EVT'),
      createdAt: Number(event.createdAt) || Date.now(),
      eventType: event.eventType || 'UNCLASSIFIED',
      source: event.source || 'xrp-quant-terminal',
      engineVersion: event.engineVersion || '0.9.1-shadow-cockpit',
      ...event
    };
    await putRecord(EVENT_STORE, record, EVENT_FALLBACK_KEY, 10000);
    return record;
  }

  async function saveFeedback(feedback) {
    const record = {
      schemaVersion: 1,
      feedbackId: feedback.feedbackId || makeId('FB'),
      createdAt: Number(feedback.createdAt) || Date.now(),
      status: feedback.status || 'PENDING_VALIDATION',
      validationMode: 'OFFLINE_ONLY',
      ...feedback
    };
    await putRecord(FEEDBACK_STORE, record, FEEDBACK_FALLBACK_KEY, 5000);
    await logEvent({
      eventType: 'OPERATOR_FEEDBACK',
      feedbackId: record.feedbackId,
      linkedEventId: record.eventId || null,
      category: record.category,
      label: record.label,
      rationale: record.rationale,
      expectedAction: record.expectedAction,
      status: record.status
    });
    return record;
  }

  async function seedInitialFeedback() {
    const all = await getAllRecords(FEEDBACK_STORE, FEEDBACK_FALLBACK_KEY);
    if (all.some(x => x.feedbackId === 'FB-000001')) return false;
    await putRecord(FEEDBACK_STORE, {
      schemaVersion: 1,
      feedbackId: 'FB-000001',
      createdAt: Date.now(),
      eventId: null,
      source: 'conversation_seed',
      category: 'entry_location',
      label: 'LONG_TOO_CLOSE_TO_UPPER_EDGE',
      rationale: 'Prezzo troppo vicino al bordo superiore; attendere pullback verso il supporto.',
      expectedAction: 'WAIT_FOR_SUPPORT_PULLBACK',
      status: 'PENDING_VALIDATION',
      validationMode: 'OFFLINE_ONLY',
      validationNote: 'Esempio iniziale non ancora collegato a uno snapshot di mercato specifico.'
    }, FEEDBACK_FALLBACK_KEY, 5000);
    return true;
  }

  async function recentEvents(limit = 50) {
    try {
      const db = await openDB();
      const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(EVENT_STORE, 'readonly');
        const index = tx.objectStore(EVENT_STORE).index('createdAt');
        const result = [];
        const request = index.openCursor(null, 'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || result.length >= limit) return resolve(result);
          result.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('Lettura eventi recenti fallita'));
      });
      storageMode = 'INDEXED_DB';
      return records;
    } catch (_) {
      storageMode = 'LOCAL_FALLBACK';
      return fallbackRead(EVENT_FALLBACK_KEY).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    }
  }

  async function recordCounts() {
    try {
      const db = await openDB();
      const [events, feedback] = await new Promise((resolve, reject) => {
        const tx = db.transaction([EVENT_STORE, FEEDBACK_STORE], 'readonly');
        const eventReq = tx.objectStore(EVENT_STORE).count();
        const feedbackReq = tx.objectStore(FEEDBACK_STORE).count();
        let a, b;
        const done = () => { if (a !== undefined && b !== undefined) resolve([a, b]); };
        eventReq.onsuccess = () => { a = eventReq.result; done(); };
        feedbackReq.onsuccess = () => { b = feedbackReq.result; done(); };
        eventReq.onerror = feedbackReq.onerror = () => reject(tx.error || new Error('Conteggio audit fallito'));
      });
      storageMode = 'INDEXED_DB';
      return { events, feedback };
    } catch (_) {
      storageMode = 'LOCAL_FALLBACK';
      return { events: fallbackRead(EVENT_FALLBACK_KEY).length, feedback: fallbackRead(FEEDBACK_FALLBACK_KEY).length };
    }
  }

  async function allEvents() {
    const all = await getAllRecords(EVENT_STORE, EVENT_FALLBACK_KEY);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function allFeedback() {
    const all = await getAllRecords(FEEDBACK_STORE, FEEDBACK_FALLBACK_KEY);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  function riskCapForLeverage(leverage) {
    if (leverage <= 30) return 20;
    if (leverage <= 60) return 30;
    return 40;
  }

  function volatilityLeverageCap(atrPct) {
    if (!Number.isFinite(atrPct) || atrPct < 0) return 0;
    if (atrPct <= 0.20) return 100;
    if (atrPct <= 0.35) return 70;
    if (atrPct <= 0.50) return 30;
    return 10;
  }

  function volatilityRiskFactor(atrPct) {
    if (!Number.isFinite(atrPct) || atrPct < 0) return 0;
    if (atrPct > 0.50) return 0.50;
    if (atrPct > 0.35) return 0.75;
    return 1.00;
  }

  function computeLeveragePlan(input) {
    const equity = Number(input.equity);
    const entry = Number(input.entry);
    const stopDistancePct = Number(input.stopDistancePct);
    const atrPct = Number(input.atrPct);
    const requested = Number(input.requestedLeverage);
    const spreadBps = Number(input.spreadBps);
    const slippagePerSideBps = Number(input.slippagePerSideBps);
    const fundingBufferBps = Number(input.fundingBufferBps);
    const feePerSideBps = input.feeType === 'maker' ? 2.0 : 5.5;

    const base = {
      accepted: false,
      reason: 'INVALID_INPUT',
      requestedLeverage: requested,
      selectedLeverage: null,
      leverageCapByVolatility: volatilityLeverageCap(atrPct),
      riskCapPct: null,
      stopDistancePct,
      atrPct,
      volatilityFactor: volatilityRiskFactor(atrPct),
      feeRoundTripBps: feePerSideBps * 2,
      slippageRoundTripBps: Number.isFinite(slippagePerSideBps) ? slippagePerSideBps * 2 : null,
      spreadBps: Number.isFinite(spreadBps) ? spreadBps : null,
      fundingBufferBps: Number.isFinite(fundingBufferBps) ? fundingBufferBps : null,
      totalCostBps: null,
      totalLossPctNotional: null,
      riskOnPositionMarginPct: null,
      riskBudgetUsdt: null,
      positionMarginUsdt: null,
      notionalUsdt: null,
      estimatedLossUsdt: null,
      contractMinimums: 'NOT_VERIFIED',
      liquidationCheck: 'NOT_VERIFIED_CROSS_MARGIN'
    };

    if (!(equity > 0) || !(entry > 0) || !(stopDistancePct > 0) ||
        !(requested >= 10 && requested <= 100) || !Number.isFinite(atrPct)) {
      return { ...base, reason: 'MISSING_OR_INVALID_RISK_INPUT' };
    }
    if (![spreadBps, slippagePerSideBps, fundingBufferBps].every(Number.isFinite) ||
        spreadBps < 0 || slippagePerSideBps < 0 || fundingBufferBps < 0) {
      return { ...base, reason: 'COST_INPUT_UNAVAILABLE' };
    }
    if (spreadBps > 15) {
      return { ...base, reason: 'SPREAD_TOO_WIDE', spreadBps, leverageCapByVolatility: volatilityLeverageCap(atrPct) };
    }

    const agentAllocation = equity * 0.25;
    const volatilityFactor = volatilityRiskFactor(atrPct);
    const riskBudgetUsdt = agentAllocation * 0.01 * volatilityFactor;
    const totalCostBps = feePerSideBps * 2 + slippagePerSideBps * 2 + spreadBps + fundingBufferBps;
    const totalLossPctNotional = stopDistancePct + totalCostBps / 100;
    const volCap = volatilityLeverageCap(atrPct);
    const levels = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10]
      .filter(level => level <= Math.min(requested, volCap));

    let selected = null;
    let riskOnPositionMarginPct = null;
    let riskCapPct = null;
    for (const level of levels) {
      const riskPct = totalLossPctNotional * level;
      const cap = riskCapForLeverage(level);
      if (riskPct <= cap) {
        selected = level;
        riskOnPositionMarginPct = riskPct;
        riskCapPct = cap;
        break;
      }
    }
    if (selected === null) {
      return {
        ...base,
        reason: 'STOP_TOO_WIDE_FOR_LEVERAGE_RISK_CAP',
        leverageCapByVolatility: volCap,
        totalCostBps,
        totalLossPctNotional,
        riskBudgetUsdt,
        agentAllocationUsdt: agentAllocation
      };
    }

    const requiredMarginUsdt = riskBudgetUsdt / (riskOnPositionMarginPct / 100);
    if (!(requiredMarginUsdt > 0)) {
      return { ...base, reason: 'INVALID_POSITION_MARGIN', selectedLeverage: selected };
    }
    // Never use more than the existing 25% agent allocation. When the risk
    // budget would require more margin, use the capped margin; loss stays below budget.
    const positionMarginUsdt = Math.min(agentAllocation, requiredMarginUsdt);
    const notionalUsdt = positionMarginUsdt * selected;
    const estimatedLossUsdt = notionalUsdt * totalLossPctNotional / 100;
    const actualRiskOnMarginPct = estimatedLossUsdt / positionMarginUsdt * 100;
    return {
      ...base,
      accepted: true,
      reason: selected < requested ? 'LEVERAGE_REDUCED_BY_VOLATILITY_OR_RISK' : 'RISK_GATE_PASSED',
      selectedLeverage: selected,
      riskCapPct,
      leverageCapByVolatility: volCap,
      volatilityFactor,
      feeRoundTripBps: feePerSideBps * 2,
      slippageRoundTripBps: slippagePerSideBps * 2,
      spreadBps,
      fundingBufferBps,
      totalCostBps,
      totalLossPctNotional,
      riskOnPositionMarginPct: actualRiskOnMarginPct,
      requiredMarginUsdt,
      riskBudgetUsdt,
      positionMarginUsdt,
      notionalUsdt,
      estimatedLossUsdt,
      agentAllocationUsdt: agentAllocation,
      quantityXrp: notionalUsdt / entry,
      requestedLeverage: requested,
      selectedLeverage: selected
    };
  }

  async function exportJSONL() {
    const [events, feedback] = await Promise.all([allEvents(), allFeedback()]);
    const lines = [];
    for (const event of events) lines.push(JSON.stringify({ recordType: 'EVENT', ...event }));
    for (const item of feedback) lines.push(JSON.stringify({ recordType: 'FEEDBACK', ...item }));
    return lines.join('\n') + (lines.length ? '\n' : '');
  }

  root.CockpitCore = {
    makeId,
    logEvent,
    saveFeedback,
    seedInitialFeedback,
    recentEvents,
    recordCounts,
    allEvents,
    allFeedback,
    exportJSONL,
    computeLeveragePlan,
    riskCapForLeverage,
    volatilityLeverageCap,
    volatilityRiskFactor,
    getStorageMode: () => storageMode
  };
})(window);
