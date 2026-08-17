#!/usr/bin/env node
/**
 * Builds the extension into `dist/`.
 *
 * esbuild directly rather than a framework plugin, because MV3 has two hard
 * constraints that generic bundler plugins get wrong often enough to be a
 * recurring source of breakage:
 *
 *  - **Content scripts cannot be ES modules.** They must be a single IIFE file
 *    with no import statements, so `content.js` is bundled separately with
 *    `format: 'iife'`.
 *  - **The service worker must be an ES module**, since the manifest declares
 *    `"type": "module"`.
 *
 * Everything else here is copying files and prepending the generated design
 * tokens to each page stylesheet.
 */
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  target: ['chrome116'],
  logLevel: 'info',
  // CSS is imported as a string and injected into the shadow root at runtime,
  // so the panel's styles are scoped and cannot leak into the host page.
  loader: { '.css': 'text', '.wasm': 'file' },
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
};

/** Content scripts must be a single IIFE; everything else is an ES module. */
const ENTRIES = [
  { in: 'src/content/index.ts', out: 'content.js', format: 'iife' },
  { in: 'src/background/index.ts', out: 'background.js', format: 'esm' },
  { in: 'src/offscreen/embedder.ts', out: 'offscreen.js', format: 'esm' },
  { in: 'src/options/index.ts', out: 'options.js', format: 'esm' },
  { in: 'src/popup/index.ts', out: 'popup.js', format: 'esm' },
];

/** Page stylesheets get the generated tokens prepended so `--ss-*` resolves. */
const PAGE_STYLES = [
  { in: 'src/options/options.css', out: 'options.css' },
  { in: 'src/popup/popup.css', out: 'popup.css' },
];

const STATIC_FILES = [
  { in: 'src/options/options.html', out: 'options.html' },
  { in: 'src/popup/popup.html', out: 'popup.html' },
  { in: 'src/offscreen/offscreen.html', out: 'offscreen.html' },
];

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  await copyPublic();
  await buildStyles();
  await copyStatic();
  await copyModelRuntime();
  await bundleScripts();

  await verify();
  console.log(watch ? 'Watching for changes…' : `Built to ${dist}`);
}

async function bundleScripts() {
  for (const entry of ENTRIES) {
    const options = {
      ...shared,
      entryPoints: [resolve(root, entry.in)],
      outfile: resolve(dist, entry.out),
      format: entry.format,
    };

    if (watch) {
      const ctx = await context(options);
      await ctx.watch();
    } else {
      await build(options);
    }
  }
}

async function copyPublic() {
  await cp(resolve(root, 'public'), dist, { recursive: true });
}

async function buildStyles() {
  const tokens = await readFile(resolve(root, 'src/design/tokens.css'), 'utf8');
  for (const style of PAGE_STYLES) {
    const css = await readFile(resolve(root, style.in), 'utf8');
    await writeFile(resolve(dist, style.out), `${tokens}\n${css}`);
  }
}

async function copyStatic() {
  for (const file of STATIC_FILES) {
    await cp(resolve(root, file.in), resolve(dist, file.out));
  }
}

/**
 * Copies the ONNX Runtime WASM binaries next to the bundle.
 *
 * These must be served from inside the extension: loading them from a CDN would
 * be remote code execution, which Chrome Web Store review rejects, and would
 * also leak to a third party the moment somebody opened a job posting.
 */
async function copyModelRuntime() {
  const candidates = [
    'node_modules/@huggingface/transformers/dist',
    'node_modules/onnxruntime-web/dist',
  ];

  const wasmDir = resolve(dist, 'wasm');
  await mkdir(wasmDir, { recursive: true });

  let copied = 0;
  for (const candidate of candidates) {
    const source = resolve(root, candidate);
    if (!existsSync(source)) continue;
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(source)) {
      if (name.endsWith('.wasm') || name.endsWith('.mjs')) {
        await cp(resolve(source, name), resolve(wasmDir, name));
        copied += 1;
      }
    }
  }

  if (copied === 0) {
    console.warn(
      'WARNING: no ONNX Runtime WASM files found. Resume matching will not work.\n' +
        '         Run `npm install`, then `npm run fetch:model`.',
    );
  }
}

/**
 * Fails the build on the mistakes that produce an extension Chrome will load but
 * that does not work — which are much more expensive to diagnose than a build error.
 */
async function verify() {
  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));

  const referenced = [
    manifest.background?.service_worker,
    manifest.options_ui?.page,
    manifest.action?.default_popup,
    ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
    ...Object.values(manifest.icons ?? {}),
  ].filter(Boolean);

  const missing = referenced.filter((file) => !existsSync(resolve(dist, file)));
  if (missing.length > 0) {
    throw new Error(`manifest.json references files that were not built: ${missing.join(', ')}`);
  }

  // A content script bundled as ESM loads silently and then does nothing.
  const content = await readFile(resolve(dist, 'content.js'), 'utf8');
  if (/^\s*import\s/m.test(content) || /^\s*export\s/m.test(content)) {
    throw new Error('content.js contains import/export — it must be bundled as an IIFE.');
  }

  if (!existsSync(resolve(dist, 'models'))) {
    console.warn(
      'NOTE: dist/models is absent, so resume matching will be inactive.\n' +
        '      Run `npm run fetch:model` to vendor the embedding model.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
