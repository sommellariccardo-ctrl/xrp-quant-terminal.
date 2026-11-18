XRP QUANT TERMINAL BUILD 0.8.1 — PWA AUTO-UPDATE

Include:
- Tutte le funzioni della build 0.8.0 (Adaptive Signal Engine, Capital Manager e Fee Engine in simulazione).
- Service Worker aggiornato: skipWaiting + clients.claim per attivare la nuova versione senza richiedere la chiusura manuale delle schede.
- Controllo aggiornamenti all'avvio e quando la PWA/Safari torna in primo piano.
- Cache versionata xrp-quant-v081 e strategia network-first: online, la navigazione recupera la versione pubblicata su GitHub Pages; offline usa la copia locale.
- Pulizia limitata alle vecchie cache con prefisso xrp-quant-. Il localStorage (journal e impostazioni) NON viene cancellato.

INSTALLAZIONE AGGIORNAMENTO:
1. Nel repository GitHub sostituire SOLO index.html e sw.js nella root con quelli di questo pacchetto.
2. Commit e attendere GitHub Actions / GitHub Pages completato.
3. Aprire normalmente l'app già installata oppure il link GitHub Pages. All'avvio viene verificato il nuovo Service Worker; quando si attiva, la pagina si ricarica una volta.
4. Per verificare la build, controllare il footer BUILD 0.8.1.

NOTA:
- L'aggiornamento automatico richiede che il dispositivo sia online e che l'app venga aperta o riportata in primo piano. Una PWA chiusa/non in esecuzione non può aggiornarsi istantaneamente in background.
- Non disinstallare la PWA e non cancellare i dati del sito.
- Resta una build di simulazione: nessun accesso privato Bybit e nessun ordine reale.
