# WEN AZULEJO

Un gioco di THE WALL ARCADE. Lisbona, NFC Summit. Un muro di 6 × 7 azulejos, ognuno con quattro angoli colorati: un
quarto di cerchio ciascuno, come nei veri azulejos a modulo 2 × 2. **Tocca una piastrella per ruotarla di un quarto.**
Dove quattro piastrelle si incontrano e i loro quattro angoli hanno lo stesso colore, il cerchio si chiude: una
**rosetta** (rosácea).

| Cosa | Regola |
| --- | --- |
| Rosetta | +100, × il moltiplicatore. Le sue quattro piastrelle vengono riposate nuove mezzo secondo dopo; se le nuove chiudono una rosetta da sole è una cascata (conta) |
| Serie | rosette a meno di 3 s l'una dall'altra: ×2 dalla 4ª, ×3 dalla 7ª, ×4 dalla 10ª |
| Rotazioni | ogni piastrella regge 3 rotazioni; una 4ª che non chiude niente la crepa: −30 e una crepa |
| SOS Azulejo | ogni tanto una piastrella si stacca e trema: mettila in una rosetta prima che cada (+50), altrimenti cade: −30 e una crepa |
| Piastrella dorata | porta un nome del muro: una rosetta che la include DIPINGE il nome (+200, ripara una crepa). Ogni nome una volta per partita, al massimo 3 sul muro |
| Crepe | 12 e il muro crolla: fine, niente bonus |
| Sopravvivenza | muro in piedi per 90 s: +2000 e +150 per ogni crepa rimasta |

- 3 s di countdown, poi 90 s. **La pressione sale in modo continuo dal primo all'ultimo secondo**: una piastrella si
  stacca ogni 2,4–3,6 s all'inizio e ogni 0,7–1 s alla fine, e resiste 7,5 s all'inizio e 3,3 s alla fine (SOS
  nell'HUD). Ogni 22,5 s il muro si complica: le piastrelle nuove hanno 3 smalti, poi 4 (MANGANÊS), 4, poi 5
  (TERRACOTA). Il muro iniziale non ha rosette già chiuse.
- Il punteggio non scende mai sotto zero. Ogni smalto ha anche un suo segno (punto, rombo, foglia, anello, triangolo):
  il colore non è mai l'unico indizio. Un cerchio tratteggiato segna un incrocio a cui manca un solo angolo.
- I nomi dipinti diventano targhe di strada di Lisbona (RUA …) e le loro persone camminano sulla calçada sotto il muro
  (lo sprite di people.json, o un omino pixel). Solo grafica.
- La fine mostra la card con il motivo creato (tutte le rosette, in ordine), il punteggio, la posizione della
  settimana, il record, le piastrelle salvate e i nomi dipinti; POST ON X li tagga.

Pratica gratuita con le stesse regole nel browser, niente registrato. Calibrazione (giocatore simulato che vede tutto il
muro, 30 partite): con un tocco ogni 0,2 s tiene il muro 29 volte su 30, ogni 0,35 s 26 su 30, ogni 0,55 s 2 su 30,
ogni 0,8 s mai; chi non fa niente crolla in circa 38 s. Un giocatore vero, che deve cercare le rosette con gli occhi,
sta più in basso di questa scala.

## Pubblicare da Windows

Il gioco e' online su https://34s8u757.srstudio.dev (App ID `a592b9f0-9096-4c3f-a9f4-325aa7c349ef`).

Doppio clic su `PUBBLICA.cmd`. Fa tutto `PUBBLICA.ps1`: controlla Node.js, installa la riga di comando di SuperRare e
le dipendenze, aggiorna i nomi del muro, lancia i test, fa il login se serve, costruisce lo ZIP e aggiorna l'app; alla
fine stampa i dati per il modulo di invio e apre il gioco e la pagina di invio.

- La scheda dell'app e' `deploy/wen-azulejo.config.json` (App ID e indirizzo, niente di segreto): con quella lo script
  aggiorna sempre la stessa app.
- In una copia nuova del progetto che non ce l'ha, lo script cerca sul tuo account le app con WEN AZULEJO nel titolo,
  le elenca con indirizzo e App ID e ti fa scegliere quale aggiornare. Ne crea una nuova solo se non ce n'e' nessuna,
  o se scrivi NUOVA. Le app con un altro titolo (GATE RUSH) non vengono mai toccate.
- Prima di pubblicare stampa quale codice gira online e quale sta per andarci: ogni build scrive in `index.html`
  `<meta name="game-code" content="wen-azulejo@…">`, l'impronta del codice del gioco (tutti i sorgenti tranne i nomi
  del muro). Stessa impronta, stesso gioco. Le versioni pubblicate prima del timbro non ce l'hanno.

## Dove sta

| Parte | File |
| --- | --- |
| Regole deterministiche (motore, lo stesso modulo nel browser e nel verificatore) | `src/games/wen-azulejo/core.ts` |
| Schemi della pagina (sono i controlli di `core.ts`) | `src/games/wen-azulejo/engine.ts` |
| Client: muro, rotazioni, rosette, targhe, calçada, card finale | `src/games/wen-azulejo/client.ts` |
| Verificatore (`POST /v1`, senza zod) | `src/verifiers/wen-azulejo.ts` |
| Ingresso della pagina | `src/entries/wen-azulejo.ts` |
| Config pubblica, scritta dallo script | `deploy/wen-azulejo.config.json`, `scripts/wen-azulejo-config.ts` |
| Test (regole, latenza, input falsificati, stati manomessi, replay, verificatore compilato) | `tests/wen-azulejo.test.ts` |

L'unico input di gioco è `{ "action": "turn", "cell": 0–41, "id": <la piastrella che c'è> }`, più
`{ "action": "start" }`: mai un punteggio, un tempo o uno stato. Il tocco porta anche l'id della piastrella: se nel
frattempo quella piastrella ha lasciato la casella (una rosetta, una caduta), il tocco non fa niente invece di ruotare
quella nuova. Un input prima dell'inizio, dopo la
fine o malformato non cambia nulla. I nomi vengono dallo snapshot del muro incluso nella build
(`src/generated/wall.json`, aggiornabile con `node --import tsx scripts/snapshot-wall.ts`); gli sprite da people.json,
solo grafica.

Input automatici perfettamente legali sono accettati da queste regole: il gioco non è a prova di bot.
