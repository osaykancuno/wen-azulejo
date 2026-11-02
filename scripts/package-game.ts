// Builds one game archive: the browser bundle, the server verifier and the matching scoring configuration, kept together.
// Adapted from studio-games-example/scripts/package-game.ts (MIT, Copyright 2026 SuperRare).
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { strToU8 } from 'fflate';
import { scoringConfiguration, type Configuration } from '../src/shell/config.js';

export type GameFiles = Record<string, Uint8Array>;
const root = fileURLToPath(new URL('../', import.meta.url));
const TITLES: Record<Configuration['game'], string> = { 'wen-azulejo': 'WEN AZULEJO' };

const common = { absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'inline' } as const;

/**
 * The fingerprint of the game's code: every source file under src/ except the snapshot of the wall's names (refreshed at
 * each publish), with the dependencies' lockfile. Written in index.html (<meta name="game-code">), so the page online
 * says which code it runs: the same fingerprint means the same game.
 */
export async function codeFingerprint(): Promise<string> {
  const names = (await readdir(new URL('../src/', import.meta.url), { recursive: true }))
    .map((name) => name.replaceAll('\\', '/')).filter((name) => /\.(ts|js|css|html)$/.test(name)).sort();
  const hash = createHash('sha256');
  // line endings as Git stores them (a Windows checkout may turn them into CRLF): the same code, the same fingerprint
  const text = async (path: string): Promise<string> => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  for (const name of names) hash.update(`${name}\n${await text(`../src/${name}`)}\n`);
  hash.update(await text('../package-lock.json'));
  return hash.digest('hex').slice(0, 12);
}

export async function packageGame(configuration: Configuration): Promise<GameFiles> {
  const [browser, verifier, template, stylesheet, license, notice] = await Promise.all([
    build({ ...common, entryPoints: [`src/entries/${configuration.game}.ts`] }),
    build({ ...common, entryPoints: [`src/verifiers/${configuration.game}.ts`] }),
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/shell/styles.css', import.meta.url)),
    readFile(new URL('../LICENSE', import.meta.url)),
    readFile(new URL('../NOTICE', import.meta.url)),
  ]);
  const appBundle = browser.outputFiles[0];
  const verifierBundle = verifier.outputFiles[0];
  if (!appBundle || !verifierBundle) throw new Error('Bundler returned no application or verifier output.');
  if (verifierBundle.contents.byteLength > 256_000) throw new Error('Server verifier exceeds Studio’s 256 KB module limit.');
  const code = await codeFingerprint();
  const appPath = `assets/app-${createHash('sha256').update(appBundle.contents).digest('hex').slice(0, 16)}.js`;
  const stylePath = `assets/styles-${createHash('sha256').update(stylesheet).digest('hex').slice(0, 16)}.css`;
  const index = template
    .replace('<head>', `<head>\n    <meta name="play-factory-game-id" content="${configuration.appId}">\n    <meta name="game-code" content="${configuration.game}@${code}">\n    <link data-rare-app-metadata="true" rel="canonical" href="${configuration.appOrigin}/">`)
    .replace('<title>THE WALL ARCADE</title>', `<title>${TITLES[configuration.game]} · THE WALL ARCADE</title>`)
    .replace('./assets/app.js', `./${appPath}`)
    .replace('./assets/styles.css', `./${stylePath}`);
  if (!index.includes(appPath) || !index.includes(stylePath)) throw new Error('index.html template placeholders were not replaced.');
  return {
    'index.html': strToU8(index),
    'config.json': strToU8(`${JSON.stringify(configuration, null, 2)}\n`),
    [appPath]: appBundle.contents,
    [stylePath]: stylesheet,
    'server-verifier.js': verifierBundle.contents,
    'scoring-config.json': strToU8(`${JSON.stringify(scoringConfiguration(configuration.game), null, 2)}\n`),
    LICENSE: license,
    NOTICE: notice,
  };
}
