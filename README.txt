XRP Quant Terminal BUILD 0.7.0 — HYBRID SIGNAL GATE

Cosa cambia:
- Preview intrabar: mostra il lato candidato durante la formazione della candela XRP 5m.
- Early trigger sperimentale: richiede soglia adattiva +10, margine direzionale >=10, BTC 15m concorde, spread <=15 bps e 3 aggiornamenti consecutivi del flusso kline XRP.
- Il contatore di persistenza avanza solo sugli eventi kline XRP, non su ticker/orderbook.
- Alla conferma della candela viene mostrato il lato calcolato alla chiusura.
- Il trigger si azzera a ogni nuova candela; non viene mantenuto se le condizioni decadono.

IMPORTANTE:
- È solo un motore di segnalazione/validazione. NON invia ordini e NON contiene API private.
- Tre aggiornamenti kline non equivalgono a tre secondi: sono tre messaggi WebSocket distinti.
- La logica intrabar è sperimentale e non è stata validata su dati storici; può oscillare durante la candela.
- Il gate spread usa il best bid/ask del book pubblico e blocca se il book non è disponibile.
- Nessuna garanzia di latenza o riempimento. Il browser resta un processo non garantito e può sospendersi.
- Non usare il trigger come autorizzazione a operare manualmente o automaticamente con denaro reale.

Installazione:
Sostituire index.html e sw.js nella root del repository GitHub Pages; commit; attendere il deploy; aprire il sito con ?v=070.
