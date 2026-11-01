# WEN AZULEJO

Un gioco di THE WALL ARCADE. Lisbona, NFC Summit. Frammenti di azulejos arrivano su un muro di 6 × 7 caselle vuote, a
piccoli gruppi collegati dello stesso motivo. **Trascina** sui frammenti dello stesso motivo (ognuno accanto al
precedente, di lato o in diagonale) **o toccali uno dopo l'altro**: abbastanza frammenti completano un azulejo.

| Cosa | Regola |
| --- | --- |
| Azulejo | 3 uguali nei primi 45 s, 4 uguali dopo; fino a 6 in una catena. 50 a frammento + 50 × (frammenti in più)², × il moltiplicatore |
| Serie | azulejos a meno di 3 s l'uno dall'altro: ×2 dal 4°, ×3 dal 7°, ×4 dal 10° |
| Frammento dorato | porta un nome del muro: completarlo DIPINGE il nome sul muro (+200, ripara una crepa). Ogni nome una volta per partita |
| Caduta | un frammento lasciato troppo a lungo cade: −20 e una crepa |
| Errore | una catena che finisce su un altro motivo, salta una casella o è troppo corta: −50, una crepa, la serie finisce |
| Crepe | 12 e il muro crolla: fine, niente bonus |
| Sopravvivenza | muro in piedi per 90 s: +2000 e +150 per ogni crepa rimasta |

- 3 s di countdown, poi 90 s. **Il ritmo sale in modo continuo dal primo all'ultimo secondo**: un gruppo ogni 1,6–2,4 s
  all'inizio, ogni 0,8–1,2 s alla fine; un frammento vive 12 s all'inizio, 7 s alla fine (SPEED nell'HUD). Ogni 22,5 s
  i motivi si complicano: 3 motivi, poi 4 (LAÇO), poi azulejos da 4 frammenti, poi 5 motivi (SOL).
- Il punteggio non scende mai sotto zero.
- I nomi dipinti diventano targhe di strada di Lisbona (RUA …) e le loro persone camminano sulla calçada sotto il muro
  (lo sprite di people.json, o un omino pixel). Solo grafica.
- La fine mostra la card con il motivo creato (tutti gli azulejos, in ordine), il punteggio, la posizione della
  settimana, il record e i nomi dipinti; POST ON X li tagga.

Pratica gratuita con le stesse regole nel browser, niente registrato. Calibrazione (giocatore simulato che vede tutto,
30 partite): chi chiude una catena ogni 1,5 s tiene il muro 3 volte su 30, ogni 1 s 17 su 30, ogni 0,75 s 27 su 30;
chi non fa niente crolla in circa 22 s.

## Pubblicare da Windows

Doppio clic su `PUBBLICA.cmd` (la prima volta e ogni volta che il gioco cambia). Fa tutto `PUBBLICA.ps1`: controlla
Node.js, installa la riga di comando di SuperRare e le dipendenze, aggiorna i nomi del muro, lancia i test, fa il login
se serve, crea l'app una volta sola (un'app nuova, separata da GATE RUSH: la risposta resta in
`deploy/wen-azulejo.app.json`, la config in `deploy/wen-azulejo.config.json`), costruisce lo ZIP e aggiorna la stessa
app; alla fine stampa i dati per il modulo di invio e apre il gioco e la pagina di invio.

## Dove sta

| Parte | File |
| --- | --- |
| Regole deterministiche (motore, lo stesso modulo nel browser e nel verificatore) | `src/games/wen-azulejo/core.ts` |
| Schemi della pagina (sono i controlli di `core.ts`) | `src/games/wen-azulejo/engine.ts` |
| Client: muro, collegamenti, targhe, calçada, card finale | `src/games/wen-azulejo/client.ts` |
| Verificatore (`POST /v1`, senza zod) | `src/verifiers/wen-azulejo.ts` |
| Ingresso della pagina | `src/entries/wen-azulejo.ts` |
| Config pubblica, scritta dallo script | `deploy/wen-azulejo.config.json`, `scripts/wen-azulejo-config.ts` |
| Test (regole, latenza, input falsificati, stati manomessi, replay, verificatore compilato) | `tests/wen-azulejo.test.ts` |

L'unico input di gioco è `{ "action": "join", "cells": [casella, …] }` (da 2 a 6 caselle diverse, 0–41), più
`{ "action": "start" }`: mai un punteggio, un tempo o uno stato. Una catena che passa da una casella appena svuotata (il
frammento è caduto un attimo prima che la catena arrivasse al server) non fa niente: né punti né crepe; una casella
liberata resta vuota 1 s, così nessun nuovo frammento finisce in una catena in volo. Un input prima dell'inizio, dopo la
fine o malformato non cambia nulla. I nomi vengono dallo snapshot del muro incluso nella build
(`src/generated/wall.json`, aggiornabile con `node --import tsx scripts/snapshot-wall.ts`); gli sprite da people.json,
solo grafica.

Input automatici perfettamente legali sono accettati da queste regole: il gioco non è a prova di bot.
