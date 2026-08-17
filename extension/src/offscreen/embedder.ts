/**
 * Offscreen document hosting the embedding model.
 *
 * ## Why offscreen rather than the service worker or the content script
 *
 * The MV3 service worker is terminated after ~30s idle, and loading a 20MB model
 * takes long enough that it would be evicted and reloaded constantly. A content
 * script would work but injects the model and its WASM runtime into every
 * LinkedIn page, costing the host page memory and leaving our code in a context
 * the page can observe. An offscreen document gets a persistent DOM-capable
 * context that the page cannot see, which is what this needs.
 *
 * ## No remote code
 *
 * `allowRemoteModels` is false and the model and WASM binaries are loaded from
 * `chrome.runtime.getURL`. Chrome Web Store review rejects extensions that fetch
 * executable code at runtime, and a model that downloads on first use would also
 * leak *when* someone started job hunting to a third-party CDN. `npm run
 * fetch:model` vendors the weights at build time instead.
 */
import { env, pipeline } from '@huggingface/transformers';
import { MODEL_ID } from '../lib/resume-match';
import type { OffscreenRequest, OffscreenResponse } from '../lib/messages';

// Load everything from inside the extension bundle. Both flags matter: the first
// stops a CDN fetch, the second points the loader at our vendored copy.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
  // One thread. Multi-threaded ORT needs SharedArrayBuffer, which needs COOP/COEP
  // headers an extension page does not get.
  env.backends.onnx.wasm.numThreads = 1;
}

/**
 * The slice of the feature-extraction pipeline this file actually uses.
 *
 * The library's own `pipeline()` types enumerate every task, pooling mode, and
 * quantisation combination, and the resulting union is large enough that
 * TypeScript gives up on it outright (TS2590). Narrowing at this one boundary
 * keeps the rest of the file properly typed instead of scattering `any` through
 * the call site — the runtime contract is exactly what is declared here.
 */
interface FeatureExtractor {
  (
    input: string[],
    options: { pooling: 'mean'; normalize: boolean },
  ): Promise<{ tolist(): number[][] }>;
}

const loadPipeline = pipeline as unknown as (
  task: 'feature-extraction',
  model: string,
  options: { dtype: string },
) => Promise<FeatureExtractor>;

let extractor: Promise<FeatureExtractor> | null = null;

/** Loaded once and reused; the promise is cached so concurrent calls share one load. */
function getExtractor(): Promise<FeatureExtractor> {
  // int8 quantisation: ~23MB instead of ~90MB, at a similarity cost that does
  // not register for document-level comparison.
  extractor ??= loadPipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
  return extractor;
}

async function embed(texts: string[]): Promise<number[][]> {
  const model = await getExtractor();
  // Mean pooling plus L2 normalisation is what MiniLM's sentence embeddings
  // expect; without normalisation the cosine calculation downstream is skewed by
  // document length.
  const output = await model(texts, { pooling: 'mean', normalize: true });
  return output.tolist();
}

chrome.runtime.onMessage.addListener(
  (message: OffscreenRequest, _sender, sendResponse: (response: OffscreenResponse) => void) => {
    if (message?.target !== 'offscreen') return false;

    if (message.type === 'ping') {
      sendResponse({ ok: true, pong: true });
      return false;
    }

    if (message.type === 'embed') {
      embed(message.texts)
        .then((vectors) => sendResponse({ ok: true, vectors }))
        .catch((err: unknown) => {
          console.error('[SponsorScope] embedding failed', err);
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true; // Response is async.
    }

    return false;
  },
);
