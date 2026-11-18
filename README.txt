XRP QUANT TERMINAL 0.9.0

Contenuto: index.html, sw.js, manifest.webmanifest, icone PWA.

Novita 0.9.0: Adaptive Exit Engine in Shadow Mode. Le posizioni simulate vengono aperte automaticamente sulle conferme chiuse della variante C, con una posizione shadow alla volta. Gestisce momentum/swing, trailing stop, presa parziale al target swing, riduzione su segnale opposto in avvicinamento e chiusura del residuo su segnale opposto confermato. Registra MFE, MAE, P&L stimato e capture ratio in localStorage separato dal Signal Journal.

Nessun ordine reale, nessuna API privata, nessuna modifica o cancellazione del Signal Journal esistente.

Installazione: sostituire index.html e sw.js nella root GitHub Pages. Non eliminare gli altri file. Dopo commit, attendere GitHub Actions e aprire/riaprire la PWA online.

Nota: le regole e le soglie dell'Exit Engine sono euristiche sperimentali, da validare. Il simulatore assume fee Taker VIP0 0,055% per lato (11 bps round trip), non include ancora funding né slippage effettivo e non rappresenta risultati di trading reali.
