import { readFileSync } from 'node:fs'
import * as module from 'node:module'
import { URL } from 'node:url'
import { TextDecoder } from 'node:util'

const MAX_ENTRIES = 1_000
const MAX_CHARACTERS = 1_048_576

// Ink's layout caches see every streaming revision, so entry count alone cannot bound retained text.
export default class TextCache {
  #entries = new Map<string, unknown>()
  #characters = 0

  get(key: string): unknown {
    return this.#entries.get(key)
  }

  set(key: string, value: unknown): void {
    const characters = key.length + (typeof value === 'string' ? value.length : 0)
    if (characters > MAX_CHARACTERS) {
      return
    }
    if (this.#entries.has(key)) {
      const previous = this.#entries.get(key)
      this.#characters -= key.length + (typeof previous === 'string' ? previous.length : 0)
      this.#entries.delete(key)
    }
    if (this.#entries.size >= MAX_ENTRIES || this.#characters + characters > MAX_CHARACTERS) {
      this.#entries.clear()
      this.#characters = 0
    }
    this.#entries.set(key, value)
    this.#characters += characters
  }
}

const legacyCacheImport = "import TextCache from './strands-text-cache.js';"
const cacheImport = `import TextCache from ${JSON.stringify(new URL('./ink.js', import.meta.url).href)};`
const patches = new Map<string, [string, string][]>([
  ['measure-text.js', [['const cache = new Map();', 'const cache = new TextCache();']]],
  [
    'wrap-text.js',
    [
      ['const cache = {};', 'const cache = new TextCache();'],
      ['cache[cacheKey];', 'cache.get(cacheKey);'],
      ['cache[cacheKey] = wrappedText;', 'cache.set(cacheKey, wrappedText);'],
    ],
  ],
  [
    'ink.js',
    [
      [
        'this.lastTerminalWidth = getWindowSize(this.options.stdout).columns;',
        `this.lastTerminalWidth = getWindowSize(this.options.stdout).columns;
        this.lastTerminalHeight = getWindowSize(this.options.stdout).rows;`,
      ],
      [
        `    resized = () => {
        const currentWidth = getWindowSize(this.options.stdout).columns;
        if (currentWidth < this.lastTerminalWidth) {
            // We clear the screen when decreasing terminal width to prevent duplicate overlapping re-renders.
            this.log.clear();
            this.lastOutput = '';
            this.lastOutputToRender = '';
        }
        this.calculateLayout();
        dom.emitLayoutListeners(this.rootNode);
        this.onRender();
        this.lastTerminalWidth = currentWidth;
    };`,
        // Ink's listener runs before application size subscribers. Wait for their dimensions to commit.
        `    resized = () => {
        if (this.resizePending || this.isUnmounted) return;
        const { columns, rows } = getWindowSize(this.options.stdout);
        if (columns === this.lastTerminalWidth && rows === this.lastTerminalHeight) return;
        this.resizePending = true;
        this.throttledOnRender?.cancel();
        this.throttledLog.cancel?.();
        queueMicrotask(() => {
            reconciler.flushSyncWork();
            this.resizePending = false;
            if (this.isUnmounted || this.isUnmounting) return;
            const { columns, rows } = getWindowSize(this.options.stdout);
            this.resizedFromFullscreen = this.lastOutputHeight >= this.lastTerminalHeight;
            const sync = this.shouldSync();
            if (sync) this.options.stdout.write(bsu);
            try {
                if (!this.resizedFromFullscreen && columns < this.lastTerminalWidth) {
                    this.log.clear();
                    this.lastOutput = '';
                    this.lastOutputToRender = '';
                }
                this.calculateLayout();
                dom.emitLayoutListeners(this.rootNode);
                this.onRender();
                this.lastTerminalWidth = columns;
                this.lastTerminalHeight = rows;
            } finally {
                if (sync) this.options.stdout.write(esu);
            }
        });
    };`,
      ],
      [
        `    onRender = () => {
        this.hasPendingThrottledRender = false;`,
        `    onRender = () => {
        if (this.resizePending) return;
        this.hasPendingThrottledRender = false;`,
      ],
      [
        '        if (shouldClearTerminal) {',
        // Absolute row positions survive terminal clipping/reflow; erase only after writing each replacement row.
        `        const resizedFromFullscreen = this.resizedFromFullscreen;
        this.resizedFromFullscreen = false;
        if (resizedFromFullscreen && outputHeight <= viewportRows) {
            const lines = output.split('\\n');
            let frame = lines.map((line, row) => ansiEscapes.cursorTo(0, row) + line + ansiEscapes.eraseEndLine).join('');
            if (outputHeight < viewportRows) {
                frame += ansiEscapes.cursorTo(0, outputHeight) + ansiEscapes.eraseDown;
            }
            frame += ansiEscapes.cursorTo(0, Math.min(outputHeight, viewportRows - 1));
            this.options.stdout.write(frame);
            this.lastOutput = output;
            this.lastOutputToRender = outputToRender;
            this.lastOutputHeight = outputHeight;
            this.log.sync(outputToRender);
            return;
        }
        if (shouldClearTerminal) {`,
      ],
    ],
  ],
])
let targets: Map<string, [string, string][]>

export function initialize({ entrypoint }: { entrypoint: string }): void {
  targets = new Map([...patches].map(([name, replacements]) => [new URL(name, entrypoint).href, replacements]))
}

export async function load(
  url: string,
  context: module.LoadHookContext,
  nextLoad: Parameters<module.LoadHook>[2]
): Promise<module.LoadFnOutput> {
  return patch(url, await nextLoad(url, context))
}

function patch(url: string, loaded: module.LoadFnOutput): module.LoadFnOutput {
  const replacements = targets.get(url)
  if (!replacements) {
    return loaded
  }
  let source =
    typeof loaded.source === 'string'
      ? loaded.source
      : new TextDecoder('utf-8', { ignoreBOM: true }).decode(loaded.source)
  if (source.startsWith(cacheImport)) {
    return loaded
  }
  if (source.startsWith(legacyCacheImport)) {
    source = source.slice(legacyCacheImport.length)
  } else {
    for (const [before, after] of replacements) {
      if (source.split(before).length !== 2) {
        throw new Error(`Cannot apply the Ink runtime patch to ${url}.`)
      }
      source = source.replace(before, after)
    }
  }
  return { ...loaded, source: `${cacheImport}\n${source}` }
}

if (!new URL(import.meta.url).search) {
  const entrypoint = import.meta.resolve('ink')
  const version = JSON.parse(readFileSync(new URL('../package.json', entrypoint), 'utf8')).version
  if (version !== '7.1.1') {
    throw new Error(`Review the Ink runtime patches before upgrading Ink to ${version}.`)
  }
  if (module.registerHooks) {
    initialize({ entrypoint })
    module.registerHooks({
      load: (url, context, nextLoad) => patch(url, nextLoad(url, context)),
    })
  } else {
    // Synchronous hooks were added in Node 22.15; earlier Node 22 releases use the loader thread.
    module.register(new URL('?loader', import.meta.url), { data: { entrypoint } })
  }
}
