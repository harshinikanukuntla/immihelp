#!/usr/bin/env node
/**
 * Vendors the sentence-embedding model into `public/models/`.
 *
 * Run once after cloning: `npm run fetch:model`.
 *
 * The weights are deliberately **not** committed (see .gitignore) and equally
 * deliberately **not** downloaded at runtime. Downloading at runtime would mean
 * shipping remote code, which Chrome Web Store review rejects, and it would tell
 * a third-party CDN the moment a user started looking at job postings. Fetching
 * at build time gets both properties right.
 *
 * all-MiniLM-L6-v2 quantised to int8 is ~23MB — small enough to bundle, and good
 * enough for document-level similarity, which is all Feature 2 needs.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const REVISION = 'main';

/** Paths are relative to the model repo and are recreated under public/models/. */
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];

const BASE = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}`;

async function main() {
  const target = resolve(root, 'public/models', MODEL_ID);
  await mkdir(resolve(target, 'onnx'), { recursive: true });

  for (const file of FILES) {
    const destination = resolve(target, file);
    if (existsSync(destination)) {
      const { size } = await stat(destination);
      console.log(`skip  ${file} (${formatBytes(size)} already present)`);
      continue;
    }

    const url = `${BASE}/${file}`;
    process.stdout.write(`fetch ${file} … `);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(destination, buffer);
    console.log(formatBytes(buffer.byteLength));
  }

  console.log(`\nModel vendored to public/models/${MODEL_ID}`);
  console.log('These files are gitignored — every contributor runs this once.');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch((err) => {
  console.error('\n' + err.message);
  console.error(
    '\nIf you are offline or behind a proxy, download the files listed in this ' +
      'script manually into public/models/' + MODEL_ID + '/.',
  );
  process.exit(1);
});
