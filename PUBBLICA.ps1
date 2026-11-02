# WEN AZULEJO: pubblica (o ripubblica) il gioco su SuperRare Studio, da Windows. Si avvia con doppio clic su PUBBLICA.cmd.
#
# La prima volta: installa cio' che manca, fa il login se serve, crea l'app (una sola volta: un'app NUOVA, separata da
# GATE RUSH, che non viene toccata; il suo indirizzo resta per sempre in deploy\wen-azulejo.config.json), poi costruisce
# e pubblica il gioco. Le volte dopo: aggiorna i nomi del muro, rifa' i test, costruisce e aggiorna la stessa app.
# Non tocca crediti, pagamenti o wallet.
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
$Config = Join-Path $PSScriptRoot 'deploy\wen-azulejo.config.json'
$Zip = Join-Path $PSScriptRoot 'dist\wen-azulejo.zip'

function Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail([string]$text) { Write-Host ''; Write-Host "STOP: $text" -ForegroundColor Red; exit 1 }
function Run([string]$exe, [string[]]$argList, [string]$what) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { Fail "$what non e' riuscito (codice $LASTEXITCODE). Il messaggio e' qui sopra." }
}
# rare-profile con --json: l'ultima riga JSON della risposta, come oggetto (o $null)
function Invoke-Rare([string[]]$argList) {
  $lines = @(& rare-profile @argList --json 2>&1 | ForEach-Object { "$_" })
  $script:CliRaw = ($lines -join "`n")
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $line = "$($lines[$i])".Trim()
    if ($line.StartsWith('{')) { try { return ($line | ConvertFrom-Json) } catch { } }
  }
  return $null
}
# gli oggetti con un id (e un nome) dentro una risposta, a qualsiasi profondita'
function Find-WithId($node) {
  $found = @()
  if ($null -eq $node) { return $found }
  if ($node -is [System.Array]) { foreach ($item in $node) { $found += Find-WithId $item }; return $found }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    $names = $node.PSObject.Properties.Name
    if ($names -contains 'id' -and (($names -contains 'name') -or ($names -contains 'slug') -or ($names -contains 'title'))) { $found += $node }
    foreach ($p in $node.PSObject.Properties) { if ($p.Name -ne 'id') { $found += Find-WithId $p.Value } }
  }
  return $found
}

Step 'Controllo Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Start-Process 'https://nodejs.org/'; Fail 'Node.js non e'' installato: installa la versione LTS (22 o piu'' recente) dalla pagina appena aperta, poi rilancia PUBBLICA.cmd.' }
$major = [int](((& node --version) -replace '^v', '').Split('.')[0])
if ($major -lt 22) { Start-Process 'https://nodejs.org/'; Fail "Node.js $major e' troppo vecchio: installa la versione LTS (22 o piu' recente), poi rilancia PUBBLICA.cmd." }

Step 'Controllo la riga di comando di SuperRare'
if (-not (Get-Command rare-profile -ErrorAction SilentlyContinue)) { Run 'npm' @('install', '--global', '@rareprotocol/rare-profile@0.1.0') 'L''installazione di rare-profile' }

Step 'Installo le dipendenze del gioco'
if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) { Run 'npm' @('ci') 'npm ci' } else { Write-Host 'gia'' installate.' }

Step 'Aggiorno i nomi del muro'
& node --import tsx scripts/snapshot-wall.ts
if ($LASTEXITCODE -ne 0) { Write-Host 'Il muro non risponde adesso: uso i nomi gia'' inclusi.' -ForegroundColor Yellow }

Step 'Provo il gioco (test delle regole e del verificatore, circa un minuto)'
Run 'npx' @('tsx', '--test', 'tests/wen-azulejo.test.ts') 'I test'

# la risposta della creazione dell'app, salvata appena arriva: se qualcosa si ferma dopo, non si crea una seconda app
$Answer = Join-Path $PSScriptRoot 'deploy\wen-azulejo.app.json'
if (-not (Test-Path $Config) -and (Test-Path $Answer)) {
  Step 'Riprendo la prima pubblicazione: l''app esiste gia'''
  Run 'npx' @('tsx', 'scripts/wen-azulejo-config.ts', $Answer) 'La scrittura della configurazione'
}
# senza la scheda dell'app in questa cartella (una copia nuova del progetto): prima cerco sul tuo account le app
# WEN AZULEJO gia' create e aggiorno una di quelle, mai una seconda. Una nuova app solo se lo chiedi scrivendo NUOVA.
# (GATE RUSH e le altre app hanno un altro titolo: non vengono mai toccate.)
function Find-Url($node) {
  if ($null -eq $node) { return $null }
  if ($node -is [string]) { if ($node -match 'https://[a-z0-9-]+\.srstudio\.dev') { return $Matches[0] } ; return $null }
  if ($node -is [System.Array]) { foreach ($item in $node) { $u = Find-Url $item; if ($u) { return $u } }; return $null }
  if ($node -is [System.Management.Automation.PSCustomObject]) { foreach ($p in $node.PSObject.Properties) { $u = Find-Url $p.Value; if ($u) { return $u } } }
  return $null
}
if (-not (Test-Path $Config)) {
  Step 'Cerco sul tuo account le app WEN AZULEJO gia'' create'
  $mine = Invoke-Rare @('product', 'list')
  if ($null -eq $mine -or -not $mine.ok) {
    Write-Host 'Serve il login: approva nel browser il codice che compare qui sotto.' -ForegroundColor Yellow
    Run 'rare-profile' @('login') 'Il login'
    $mine = Invoke-Rare @('product', 'list')
    if ($null -eq $mine -or -not $mine.ok) { Fail "Non riesco a leggere i tuoi prodotti su SuperRare Studio. Risposta: $script:CliRaw" }
  }
  $games = @(Find-WithId $mine.data | Where-Object {
    $label = "$($_.title) $($_.name) $($_.slug)"
    $label -match 'AZULEJO' -and "$($_.id)" -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  })
  if ($games.Count -gt 0) {
    Write-Host "Ho trovato $($games.Count) app WEN AZULEJO sul tuo account:"
    for ($i = 0; $i -lt $games.Count; $i++) {
      $g = $games[$i]; $title = @($g.title, $g.name, $g.slug) | Where-Object { $_ } | Select-Object -First 1
      $u = Find-Url $g; if (-not $u) { $u = '(indirizzo non indicato)' }
      Write-Host ("  {0}) {1}  |  {2}  |  App ID {3}" -f ($i + 1), $title, $u, $g.id)
    }
    Write-Host 'Scrivi il numero dell''app da aggiornare (quella con l''indirizzo del tuo gioco), oppure NUOVA per crearne un''altra.'
    while (-not (Test-Path $Config)) {
      $typed = "$(Read-Host 'Numero')".Trim()
      if ($typed -eq 'NUOVA') { break }
      $n = 0
      if (-not [int]::TryParse($typed, [ref]$n) -or $n -lt 1 -or $n -gt $games.Count) { Write-Host "Scrivi un numero da 1 a $($games.Count)." -ForegroundColor Yellow; continue }
      $chosen = $games[$n - 1]; $origin = Find-Url $chosen
      while (-not $origin) {
        $typedUrl = "$(Read-Host 'Indirizzo del gioco (https://xxxxxxxx.srstudio.dev)')".Trim().TrimEnd('/')
        if ($typedUrl -match '^https://[a-z0-9-]+\.srstudio\.dev$') { $origin = $typedUrl } else { Write-Host 'Non e'' un indirizzo srstudio.dev. Riprova.' -ForegroundColor Yellow }
      }
      Run 'npx' @('tsx', 'scripts/wen-azulejo-config.ts', '--app-id', "$($chosen.id)", '--origin', $origin) 'La scrittura della configurazione'
    }
  }
}
if (-not (Test-Path $Config)) {
  Step 'Prima pubblicazione: login e negozio'
  $stores = Invoke-Rare @('store', 'list')
  if ($null -eq $stores -or -not $stores.ok) {
    Write-Host 'Serve il login: approva nel browser il codice che compare qui sotto.' -ForegroundColor Yellow
    Run 'rare-profile' @('login') 'Il login'
    $stores = Invoke-Rare @('store', 'list')
    if ($null -eq $stores -or -not $stores.ok) { Fail "Non riesco a leggere i tuoi negozi su SuperRare Studio. Risposta: $script:CliRaw" }
  }
  $list = @(Find-WithId $stores.data | Where-Object { $_ })
  if ($list.Count -eq 0) {
    Write-Host 'Non hai ancora un negozio: ne creo uno, "WEN AZULEJO".'
    $created = Invoke-Rare @('store', 'create', 'WEN AZULEJO', '--description', 'WEN AZULEJO, a game of THE WALL ARCADE')
    if ($null -eq $created -or -not $created.ok) { Fail "La creazione del negozio non e' riuscita. Risposta: $script:CliRaw" }
    $list = @(Find-WithId $created.data | Where-Object { $_ })
    if ($list.Count -eq 0 -and $created.data.id) { $list = @($created.data) }
    if ($list.Count -eq 0) { Fail "Negozio creato, ma non trovo il suo id. Risposta: $script:CliRaw" }
  }
  $store = $list[0]
  $storeName = @($store.name, $store.title, $store.slug) | Where-Object { $_ } | Select-Object -First 1
  Write-Host "Negozio: $storeName ($($store.id))"

  Step 'Prima pubblicazione: creo l''app (una volta sola)'
  $tmp = Join-Path $env:TEMP 'wen-azulejo-bootstrap'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $page = Join-Path $tmp 'index.html'
  [System.IO.File]::WriteAllText($page, '<!doctype html><title>Integration test only</title><h1>Integration test only</h1>')
  $bootstrap = Join-Path $tmp 'bootstrap.zip'
  Compress-Archive -Path $page -DestinationPath $bootstrap -Force
  $deployed = Invoke-Rare @('app', 'deploy', '--store', "$($store.id)", '--title', 'WEN AZULEJO - integration test', '--price', '0', '--zip', $bootstrap)
  if ($null -eq $deployed -or -not $deployed.ok) { Fail "La creazione dell'app non e' riuscita. Risposta: $script:CliRaw" }
  [System.IO.File]::WriteAllText($Answer, $script:CliRaw)
  Run 'npx' @('tsx', 'scripts/wen-azulejo-config.ts', $Answer) 'La scrittura della configurazione'
}

$cfg = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
Step "Costruisco il gioco per $($cfg.appOrigin)"
Run 'npx' @('tsx', 'scripts/build.ts', '--config', 'deploy/wen-azulejo.config.json', '--output', 'dist/wen-azulejo.zip', '--force') 'La build'

# quale codice gira online, e quale sta per andarci (il timbro <meta name="game-code"> di index.html)
$built = ''
try { Add-Type -AssemblyName System.IO.Compression.FileSystem; $zipFile = [System.IO.Compression.ZipFile]::OpenRead($Zip)
  $reader = New-Object System.IO.StreamReader(($zipFile.GetEntry('index.html')).Open()); $html = $reader.ReadToEnd(); $reader.Close(); $zipFile.Dispose()
  if ($html -match 'name="game-code" content="([^"]+)"') { $built = $Matches[1] } } catch { }
$online = ''
try { $page = Invoke-WebRequest -UseBasicParsing -Uri "$($cfg.appOrigin)/" -TimeoutSec 20
  if ($page.Content -match 'name="game-code" content="([^"]+)"') { $online = $Matches[1] } else { $online = '(nessun timbro: una versione precedente)' } } catch { $online = '(non raggiungibile adesso)' }
Write-Host "Online adesso       : $online"
Write-Host "Questa versione     : $built"
if ($online -eq $built) { Write-Host 'Il codice online e'' gia'' questo: aggiorno lo stesso (nomi del muro aggiornati).' -ForegroundColor Green }

Step 'Pubblico il gioco su SuperRare Studio (verificatore e evento di punteggio compresi)'
$updated = Invoke-Rare @('app', 'update', "$($cfg.appId)", '--zip', $Zip, '--max-attempts', '10000')
if ($null -eq $updated -or -not $updated.ok) {
  if ($updated -and $updated.error -and $updated.error.code -eq 'auth_required') {
    Run 'rare-profile' @('login') 'Il login'
    $updated = Invoke-Rare @('app', 'update', "$($cfg.appId)", '--zip', $Zip, '--max-attempts', '10000')
  }
  if ($null -eq $updated -or -not $updated.ok) { Fail "La pubblicazione non e' riuscita. Risposta: $script:CliRaw" }
}

$line = 'Turn the azulejos of Lisbon, close the rosettes, save the loose tiles, paint the names of the wall. 90 seconds.'
Write-Host ''
Write-Host 'FATTO: WEN AZULEJO e'' online.' -ForegroundColor Green
Write-Host ''
Write-Host "Indirizzo del gioco : $($cfg.appOrigin)"
Write-Host "App ID              : $($cfg.appId)"
Write-Host 'Titolo              : WEN AZULEJO'
Write-Host "Riga                : $line"
Write-Host ''
Write-Host 'Ora apro il gioco (prova la Practice) e la pagina di invio all''arcade: entra con il wallet del tuo nome sul muro,'
Write-Host 'incolla indirizzo, App ID, titolo e riga qui sopra, il tuo wallet per i pagamenti, e spunta la casella.'
try { Set-Clipboard -Value "$($cfg.appOrigin)" } catch { }
Start-Process "$($cfg.appOrigin)/"
Start-Process 'https://thewallarcade.superrare.com/submit.html'
