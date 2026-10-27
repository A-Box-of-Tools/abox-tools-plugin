import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseJson } from '../vendor/abox/shared/js/parse-json.js';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { MAX_INPUT_BYTES, readInput, newOutput, writeNew, requireExtension } from './files.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_PASSWORD_CONFIG_BYTES = 16 * 1024;
export const MAX_PASSWORD_OUTPUT_BYTES = 64 * 1024;
export const MAX_PASSWORD_COUNT = 100;
export const MAX_REDACTION_CONFIG_BYTES = 64 * 1024;
export const MAX_REDACTION_REGIONS = 100;
export const MAX_REDACTION_PIXELS = 32_000_000;
export const MAX_REDACTION_SIDE = 16384;
export const MAX_REDACTION_WORK_PIXELS = MAX_REDACTION_PIXELS * 4;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function invalid(message) { throw new AdapterError('INVALID_CONFIG', message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    invalid('The local JSON configuration contains an unsupported shape or field.');
  }
}
function integer(value, low, high) { return Number.isSafeInteger(value) && value >= low && value <= high; }
const setting = (config, key, fallback) => config[key] === undefined ? fallback : config[key];

async function jsonFile(value, maxBytes) {
  const input = await readInput(value, { max_bytes: maxBytes });
  let text, tree;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(input.data); }
  catch { throw new AdapterError('INVALID_UTF8', 'Local configuration files must contain valid UTF-8 JSON.'); }
  // The existing JSON parser is recursive. A small lexical bound precedes it;
  // configuration is deliberately much shallower than arbitrary JSON data.
  let depth = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '"') {
      for (at++; at < text.length; at++) {
        if (text[at] === '\\') at++;
        else if (text[at] === '"') break;
      }
    } else if (text[at] === '{' || text[at] === '[') {
      if (++depth > 8) invalid('Local JSON configuration supports at most eight nested containers.');
    } else if (text[at] === '}' || text[at] === ']') depth = Math.max(0, depth - 1);
  }
  try { tree = parseJson(text); }
  catch { invalid('The local configuration must contain valid JSON. Its contents are not included in errors.'); }
  const plain = node => {
    if (node.t === 'map') {
      const result = Object.create(null);
      for (const pair of node.pairs) {
        if (Object.hasOwn(result, pair.key)) invalid('Duplicate keys are unsupported in local configuration files.');
        result[pair.key] = plain(pair.value);
      }
      return result;
    }
    if (node.t === 'seq') return node.items.map(plain);
    if (node.t === 'num') return Number(node.raw);
    if (node.t === 'null') return null;
    return node.value;
  };
  return { path: input.path, value: plain(tree) };
}

function passwordSettings(config) {
  const mode = setting(config, 'mode', 'password'), count = setting(config, 'count', 1);
  if (!['password', 'passphrase'].includes(mode) || !integer(count, 1, MAX_PASSWORD_COUNT)) {
    invalid('Choose password or passphrase mode and a count from 1 to 100.');
  }
  if (mode === 'password') {
    keys(config, ['mode', 'count', 'length', 'lowercase', 'uppercase', 'digits', 'symbols', 'symbol_set', 'avoid_lookalikes', 'require_each']);
    const result = { mode, count, length: setting(config, 'length', 24), lower: setting(config, 'lowercase', true),
      upper: setting(config, 'uppercase', true), digits: setting(config, 'digits', true), symbols: setting(config, 'symbols', true),
      symbolSet: setting(config, 'symbol_set', 'full'), avoidLookalikes: setting(config, 'avoid_lookalikes', false),
      requireEach: setting(config, 'require_each', true) };
    if (!integer(result.length, 8, 128) || !['full', 'safe'].includes(result.symbolSet)
        || ['lower', 'upper', 'digits', 'symbols', 'avoidLookalikes', 'requireEach'].some(key => typeof result[key] !== 'boolean')
        || ![result.lower, result.upper, result.digits, result.symbols].some(Boolean)) {
      invalid('Password length must be 8 to 128, with boolean character-class settings and a full or safe symbol set.');
    }
    return result;
  }
  keys(config, ['mode', 'count', 'words', 'wordlist', 'separator', 'capitalization', 'add_digit', 'add_symbol']);
  const result = { mode, count, words: setting(config, 'words', 6), list: setting(config, 'wordlist', 'long'),
    separator: setting(config, 'separator', 'hyphen'), capitals: setting(config, 'capitalization', 'lower'),
    addDigit: setting(config, 'add_digit', false), addSymbol: setting(config, 'add_symbol', false) };
  if (!integer(result.words, 4, 12) || !['long', 'short'].includes(result.list)
      || !['hyphen', 'space', 'dot', 'underscore', 'none', 'digit'].includes(result.separator)
      || !['lower', 'title', 'upper'].includes(result.capitals)
      || typeof result.addDigit !== 'boolean' || typeof result.addSymbol !== 'boolean') {
    invalid('Passphrases support 4 to 12 words, a bundled long or short list, a supported separator and capitalization, and boolean suffix settings.');
  }
  return result;
}

function wordTrie(words, capitals) {
  const root = new Map();
  for (const original of words) {
    const word = capitals === 'upper' ? original.toUpperCase()
      : capitals === 'title' ? original[0].toUpperCase() + original.slice(1) : original;
    let node = root;
    for (const char of word) {
      if (!node.has(char)) node.set(char, new Map());
      node = node.get(char);
    }
    node.set(null, true);
  }
  return root;
}

function phraseMatches(secret, settings, trie, safeSymbols) {
  let body = secret;
  if (settings.addSymbol) { if (!safeSymbols.includes(body.at(-1))) return false; body = body.slice(0, -1); }
  if (settings.addDigit) { if (!/\d/.test(body.at(-1) ?? '')) return false; body = body.slice(0, -1); }
  const separator = { hyphen: '-', space: ' ', dot: '.', underscore: '_', none: '' }[settings.separator];
  let positions = new Set([0]);
  // Matching the wordlist rather than splitting on '-' also handles the four
  // unchanged EFF words whose own spelling contains a hyphen.
  for (let word = 0; word < settings.words; word++) {
    const next = new Set();
    for (const from of positions) {
      let node = trie;
      for (let at = from; at < body.length && node.has(body[at]); at++) {
        node = node.get(body[at]);
        if (!node.has(null)) continue;
        const end = at + 1;
        if (word === settings.words - 1) { if (end === body.length) return true; }
        else if (settings.separator === 'digit') { if (/[0-9]/.test(body[end] ?? '')) next.add(end + 1); }
        else if (body.startsWith(separator, end)) next.add(end + separator.length);
      }
    }
    positions = next;
  }
  return false;
}

async function makePasswords(settings) {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new AdapterError('SECURE_RANDOM_UNAVAILABLE', 'Cryptographic randomness is unavailable. No secrets were generated.');
  }
  const { generate, alphabet, SYMBOL_SETS } = await import('../vendor/abox/tools/password-generator/src/generate.js');
  const { wordlist } = await import('../vendor/abox/tools/password-generator/src/wordlist.js');
  const classes = settings.mode === 'password' ? alphabet(settings).map(entry => new Set(entry.chars)) : null;
  const allowed = classes && new Set(classes.flatMap(set => [...set]));
  const trie = settings.mode === 'passphrase' ? wordTrie(wordlist(settings.list), settings.capitals) : null;
  const secrets = [];
  for (let at = 0; at < settings.count; at++) {
    const secret = generate(settings);
    const valid = settings.mode === 'password'
      ? secret.length === settings.length && [...secret].every(char => allowed.has(char))
        && (!settings.requireEach || classes.every(set => [...secret].some(char => set.has(char))))
      : phraseMatches(secret, settings, trie, SYMBOL_SETS.safe);
    if (!valid || /[\r\n]/.test(secret)) throw new AdapterError('VERIFICATION_FAILED', 'The generated secret did not match the requested settings. No output was written.');
    secrets.push(secret);
  }
  const data = new TextEncoder().encode(secrets.join('\n') + '\n');
  if (data.length > MAX_PASSWORD_OUTPUT_BYTES) throw new AdapterError('OUTPUT_SIZE', 'The generated secret file exceeds the 64 KiB output limit.');
  return data;
}

async function passwordWorker(settings, options) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'abox-passwords', settings },
    execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => { worker.removeAllListeners(); error ? reject(error) : resolve(result); });
    };
    const abort = () => finish(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new AdapterError('OPERATION_TIMEOUT', 'Secret generation exceeded the two-minute limit.')), 120000);
    worker.on('message', message => message.error ? finish(new AdapterError(message.error.code, message.error.message)) : finish(null, message.data));
    worker.on('error', () => finish(new AdapterError('PASSWORD_GENERATION_FAILED', 'The isolated generator could not finish. No output was written.')));
    worker.on('exit', () => finish(new AdapterError('PASSWORD_GENERATION_FAILED', 'The isolated generator stopped before producing a result.')));
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  });
}

export async function generatePasswords(args, options = {}) {
  options.signal?.throwIfAborted();
  const output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== '.txt') throw new AdapterError('OUTPUT_EXTENSION', 'Use a new .txt output file for generated secrets.');
  const config = args.config_path === undefined ? { path: null, value: {} } : await jsonFile(args.config_path, MAX_PASSWORD_CONFIG_BYTES);
  if (!object(config.value)) invalid('The password configuration must be a JSON object.');
  const settings = passwordSettings(config.value);
  options.signal?.throwIfAborted();
  const made = await passwordWorker(settings, options);
  const data = Buffer.from(made.buffer, made.byteOffset, made.byteLength);
  try {
    if (!data.length || data.length > MAX_PASSWORD_OUTPUT_BYTES) throw new AdapterError('VERIFICATION_FAILED', 'The generated file could not be verified.');
    options.signal?.throwIfAborted(); await writeNew(output, data);
    return { ok: true, operation: 'generate-passwords', output_path: output, config_path: config.path,
      mode: settings.mode, count: settings.count, output_bytes: data.length, format: 'txt', encoding: 'utf-8',
      final_newline: true, random_source: 'crypto.getRandomValues', verified: true,
      ...(settings.mode === 'password' ? { length: settings.length } : { word_count: settings.words, wordlist: settings.list }),
      warnings: ['The requested output is a plaintext secret file. Keep it private; generated values are omitted from tool results.'] };
  } finally { data.fill(0); }
}

function redactionSettings(config) {
  keys(config, ['image_width', 'image_height', 'regions']);
  if (!integer(config.image_width, 1, MAX_REDACTION_SIDE) || !integer(config.image_height, 1, MAX_REDACTION_SIDE)
      || config.image_width * config.image_height > MAX_REDACTION_PIXELS
      || !Array.isArray(config.regions) || config.regions.length < 1 || config.regions.length > MAX_REDACTION_REGIONS) {
    invalid('Declare decoded image_width and image_height within 16384 pixels per side and 32 megapixels, and 1 to 100 regions.');
  }
  let work = 0;
  for (const region of config.regions) {
    keys(region, ['x', 'y', 'width', 'height']);
    if (!integer(region.x, 0, config.image_width - 1) || !integer(region.y, 0, config.image_height - 1)
        || !integer(region.width, 1, config.image_width - region.x)
        || !integer(region.height, 1, config.image_height - region.y)) {
      invalid('Every region must use whole, nonnegative x/y and positive width/height, entirely inside the declared image. Regions are never clipped.');
    }
    work += region.width * region.height;
    if (work > MAX_REDACTION_WORK_PIXELS) invalid('The combined rectangle areas, including overlaps, exceed the 128 megapixel work limit.');
  }
  return config;
}

export async function redactImage(args, options = {}) {
  options.signal?.throwIfAborted();
  const output = await newOutput(args.output_path); requireExtension(output, 'image/png');
  const config = await jsonFile(args.regions_path, MAX_REDACTION_CONFIG_BYTES), settings = redactionSettings(config.value);
  options.signal?.throwIfAborted();
  const input = await readInput(args.input_path), image = await supportedImage(input.data);
  if (image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
    throw new AdapterError('ANIMATED_IMAGE', 'Redaction accepts still JPEG, PNG and WebP images. Animated images are refused.');
  }
  const dimensions = rasterInputDimensions(image);
  if (!dimensions || !integer(dimensions.width, 1, MAX_REDACTION_SIDE) || !integer(dimensions.height, 1, MAX_REDACTION_SIDE)
      || dimensions.width * dimensions.height > MAX_REDACTION_PIXELS) {
    throw new AdapterError('IMAGE_DIMENSIONS', 'The input has missing or unsupported dimensions, or exceeds 16384 pixels per side or 32 megapixels.');
  }
  const made = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: `source.${image.kind}`, mimeType: MIME[image.kind], buffer: input.data });
    return page.evaluate(async ({ settings, maxBytes }) => {
      const { applyRegions } = await import('/vendor/abox/tools/redact-image/src/redact.js');
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const refuse = (code, message) => ({ error: { code, message } });
      let source, checked, canvas;
      try {
        source = await codecs.decode(document.querySelector('#input').files[0]);
        const width = source.width, height = source.height;
        if (width !== settings.image_width || height !== settings.image_height) {
          return refuse('REDACTION_DIMENSIONS', 'Declared image dimensions must match the decoded display image exactly, including orientation. No regions were applied.');
        }
        canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(source.bitmap, 0, 0); codecs.release(source.bitmap); source = null;
        const expected = context.getImageData(0, 0, width, height);
        const original = Uint8ClampedArray.from(expected.data);
        applyRegions(expected, settings.regions.map(region => ({ ...region, style: 'fill' })));
        context.putImageData(expected, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob || blob.type !== 'image/png' || !blob.size || blob.size > maxBytes) return refuse('OUTPUT_SIZE', 'The redacted PNG could not be encoded within the 128 MiB output limit.');
        checked = await codecs.decode(blob);
        if (checked.width !== width || checked.height !== height) return refuse('VERIFICATION_FAILED', 'The redacted PNG changed image dimensions.');
        context.clearRect(0, 0, width, height); context.drawImage(checked.bitmap, 0, 0);
        codecs.release(checked.bitmap); checked = null;
        const actual = context.getImageData(0, 0, width, height).data;
        let covered = 0;
        // Independent row intervals verify every requested pixel as opaque
        // black. All remaining pixels are checked against the decoded source.
        for (let y = 0; y < height; y++) {
          const spans = settings.regions.filter(region => y >= region.y && y < region.y + region.height)
            .map(region => [region.x, region.x + region.width]).sort((left, right) => left[0] - right[0]);
          const merged = [];
          for (const span of spans) {
            if (merged.length && span[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], span[1]);
            else merged.push(span);
          }
          let region = 0;
          for (let x = 0; x < width; x++) {
            while (region < merged.length && x >= merged[region][1]) region++;
            const hidden = region < merged.length && x >= merged[region][0], at = (y * width + x) * 4;
            if (hidden) {
              covered++;
              if (actual[at] !== 0 || actual[at + 1] !== 0 || actual[at + 2] !== 0 || actual[at + 3] !== 255
                  || expected.data[at] !== 0 || expected.data[at + 1] !== 0 || expected.data[at + 2] !== 0 || expected.data[at + 3] !== 255) {
                return refuse('VERIFICATION_FAILED', 'A requested region did not decode as an opaque black fill.');
              }
            } else {
              const alpha = actual[at + 3] / 255, expectedAlpha = original[at + 3] / 255;
              if (actual[at + 3] !== original[at + 3]
                  || Math.abs(actual[at] * alpha - original[at] * expectedAlpha) > 1
                  || Math.abs(actual[at + 1] * alpha - original[at + 1] * expectedAlpha) > 1
                  || Math.abs(actual[at + 2] * alpha - original[at + 2] * expectedAlpha) > 1) {
                return refuse('VERIFICATION_FAILED', 'The redacted PNG did not retain the decoded pixels outside the regions.');
              }
            }
          }
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('read failed')); reader.readAsDataURL(blob);
        });
        return { data, width, height, redacted_pixels: covered,
          verification: { decoded: true, all_pixels_checked: width * height, opaque_regions: true, visible_pixel_tolerance: 1 } };
      } catch { return refuse('REDACTION_FAILED', 'The installed browser could not decode, redact or verify this image. No output was written.'); }
      finally {
        codecs.release(source?.bitmap); codecs.release(checked?.bitmap);
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      }
    }, { settings, maxBytes: MAX_INPUT_BYTES });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64'); delete made.data;
  const checked = await supportedImage(data);
  const allowed = new Set(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'cICP']);
  const checkedDimensions = rasterInputDimensions(checked);
  if (checked.kind !== 'png' || !data.length || data.length > MAX_INPUT_BYTES
      || checked.doc.chunks.some(chunk => !allowed.has(chunk.type))
      || checkedDimensions?.width !== settings.image_width || checkedDimensions?.height !== settings.image_height) {
    throw new AdapterError('VERIFICATION_FAILED', 'The redacted PNG container, dimensions or metadata inventory could not be verified.');
  }
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: 'redact-image', input_path: input.path, regions_path: config.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, format: 'png', region_count: settings.regions.length,
    coordinate_space: 'decoded-display-pixels', redaction: 'opaque-black-fill', source_metadata_copied: false,
    verified: true, ...made, warnings: ['The new PNG contains flattened 8-bit SDR pixels. Source metadata is not copied; colors and precision can change.',
      'Only the requested rectangles are redacted. Review the saved image before sharing it.'] };
}

if (!isMainThread && workerData?.kind === 'abox-passwords') {
  try {
    const data = await makePasswords(workerData.settings);
    parentPort.postMessage({ data }, [data.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof AdapterError ? { code: error.code, message: error.message }
      : { code: 'PASSWORD_GENERATION_FAILED', message: 'The existing generator could not complete these settings. No output was written.' } });
  } finally { parentPort.close(); }
}
