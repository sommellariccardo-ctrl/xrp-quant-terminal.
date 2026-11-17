XRP QUANT TERMINAL — BUILD 0.1

Questa è una PWA (web app installabile sulla schermata Home iPhone), non un'app nativa App Store.

COSA FA:
- Interfaccia responsive in stile trading terminal.
- Navigazione Overview / Signals / Risk / History.
- Visualizza la struttura prevista per il progetto.

COSA NON FA:
- Non si collega a Bybit.
- Non legge prezzi o saldo reali.
- Non invia ordini.
- Non conserva API key o secret.
- Non esegue un bot in background.

INSTALLAZIONE SU IPHONE:
1. Pubblicare il contenuto della cartella su un hosting statico HTTPS.
2. Aprire l'URL pubblicato in Safari.
3. Toccare Condividi > Aggiungi alla schermata Home.
4. Aprire l'icona XRP Quant dalla Home.

IMPORTANTE:
Per collegare Bybit e inviare ordini servirà un backend sicuro. Non inserire mai API secret nel codice frontend o nell'app. Il bot deve verificare quantità minima, qtyStep, minNotionalValue, modalità One-Way, margine, fee, slippage e stop-loss accettato prima di abilitare il live.
