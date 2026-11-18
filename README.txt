XRP Quant Terminal BUILD 0.8.0 — CAPITAL MANAGER + FEE ENGINE (SIMULATION)

Include:
- Capital Manager: equity modificabile, allocazione dinamica 25%, reserve 75%, compounding rappresentato aggiornando l’equity con il saldo aggiornato.
- Risk budget adattivo: 1% della trading allocation, ridotto in base all’ATR 5m (fattori 1.00x / 0.75x / 0.50x). Soglie sperimentali e configurazione da validare; non sono una raccomandazione di rischio.
- Fee Engine VIP 0: Maker 0,020%, Taker 0,055%, stima round-trip, spread dal book pubblico e slippage configurabile.
- Break-even stimato in percentuale e basis point.
- Parametri simulazione salvati nel localStorage del browser/dispositivo.

LIMITI IMPORTANTI:
- Il terminale resta solo pubblico: non legge saldo, commissioni personalizzate, funding o posizioni private. L’equity deve essere aggiornata manualmente.
- Il funding è escluso dal calcolo finché non sarà integrato. Il costo spread/slippage è una stima e può essere parziale se il book non è disponibile.
- Nessuna API Key, nessun ordine reale, nessuna esecuzione automatica.
- Il risk budget è una regola di simulazione: non è ancora collegato a stop distance, min qty, leva o ordine.
- Non usare per trading reale. Prima di abilitare ordini serviranno backend sicuro, riconciliazione conto, validazione strumenti, stop exchange-side, kill switch e test estesi.

INSTALLAZIONE:
Sostituire index.html e sw.js nella root GitHub Pages, commit e attendere Actions verdi. Aprire il sito con ?v=080.
