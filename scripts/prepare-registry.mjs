import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const SERVER_NAME = 'io.github.A-Box-of-Tools/abox-tools';
export const REPOSITORY = 'A-Box-of-Tools/abox-tools-plugin';
export const REGISTRY = 'https://registry.modelcontextprotocol.io';
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function releaseVersion(tag) {
  if (typeof tag !== 'string' || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag)) {
    throw new Error('Use an exact release tag such as v0.2.1.');
  }
  return tag.slice(1);
}

export async function publicRequest(url, options = {}) {
  const { fetchImpl = fetch, sleep = wait, token, allowMissing = false, timeoutMs = 60000 } = options;
  const hostname = new URL(url).hostname;
  const headers = { 'User-Agent': 'abox-tools-registry', Accept: hostname === 'api.github.com' ? 'application/vnd.github+json' : '*/*' };
  // Authentication is optional for public API rate limits and never follows an asset download.
  if (hostname === 'api.github.com' && token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try { response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); }
    catch {
      if (attempt === 2) throw new Error('A public release request failed after three attempts.');
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (response.ok || (allowMissing && response.status === 404)) return response;
    const limited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    const retryable = limited || [502, 503, 504].includes(response.status);
    let delay = 1000 * (attempt + 1);
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    } else if (limited && response.headers.get('x-ratelimit-reset')) {
      delay = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
    }
    await response.body?.cancel();
    if (!retryable || attempt === 2 || !Number.isFinite(delay) || delay > 30000) {
      throw new Error(limited
        ? 'The public API rate limit was reached. Retry later or supply GITHUB_TOKEN for public API reads.'
        : `A public release request failed with HTTP ${response.status}.`);
    }
    await sleep(Math.max(1000, delay));
  }
}

export async function boundedText(response, limit = 1024 * 1024) {
  if (!response.body) throw new Error('A public release response had no body.');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('A public metadata response exceeded its size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function checksumFor(text, filename) {
  const matches = text.split('\n').map(line => /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)\r?$/i.exec(line))
    .filter(match => match?.[2] === filename);
  if (matches.length !== 1) throw new Error(`The checksum file must contain exactly one hash for ${filename}.`);
  return matches[0][1].toLowerCase();
}

export async function responseHash(response, expectedBytes) {
  if (!response.body) throw new Error('The release archive response had no body.');
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_ARCHIVE_BYTES || length > expectedBytes) throw new Error('The release archive exceeded its recorded size.');
    hash.update(chunk);
  }
  if (length !== expectedBytes) throw new Error('The release archive size does not match its public metadata.');
  return hash.digest('hex');
}

function exactAsset(release, filename, tag) {
  const matches = release.assets?.filter(asset => asset.name === filename) ?? [];
  if (matches.length !== 1) throw new Error(`The public release must contain exactly one ${filename}.`);
  const asset = matches[0];
  const url = `https://github.com/${REPOSITORY}/releases/download/${tag}/${filename}`;
  if (asset.browser_download_url !== url || asset.state !== 'uploaded'
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`The public release asset metadata is invalid: ${filename}.`);
  }
  return asset;
}

export function makeManifest(template, tag, digest) {
  const version = releaseVersion(tag);
  if (template.name !== SERVER_NAME || template.repository?.url !== `https://github.com/${REPOSITORY}`
      || template.$schema !== 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'
      || !/^[a-f0-9]{64}$/.test(digest) || /^0{64}$/.test(digest)) {
    throw new Error('The registry template identity or verified artifact hash is invalid.');
  }
  if (Object.hasOwn(template, 'version') || Object.hasOwn(template, 'packages') || Object.hasOwn(template, 'remotes')) {
    throw new Error('The registry template must leave version and installable artifacts to the release verifier.');
  }
  return {
    ...template, version,
    packages: [{
      registryType: 'mcpb',
      identifier: `https://github.com/${REPOSITORY}/releases/download/${tag}/abox-tools-${version}-universal.mcpb`,
      version, fileSha256: digest, transport: { type: 'stdio' },
    }],
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function comparePublished(response, manifest) {
  const status = response._meta?.['io.modelcontextprotocol.registry/official']?.status;
  if (status && status !== 'active') throw new Error('This registry version already exists with a non-active status and needs manual review.');
  if (JSON.stringify(canonical(response.server)) !== JSON.stringify(canonical(manifest))) {
    throw new Error('This registry version already exists with different metadata; it will not be overwritten.');
  }
  return true;
}

export async function registryState(manifest, options = {}) {
  const url = `${REGISTRY}/v0.1/servers/${encodeURIComponent(SERVER_NAME)}/versions/${encodeURIComponent(manifest.version)}?include_deleted=true`;
  const response = await publicRequest(url, { ...options, allowMissing: true });
  if (response.status === 404) { await response.body?.cancel(); return 'missing'; }
  comparePublished(JSON.parse(await boundedText(response)), manifest);
  return 'matching';
}

export async function prepareRegistry(tag, options = {}) {
  const version = releaseVersion(tag);
  const template = options.template ?? JSON.parse(await readFile(new URL('../registry/server.template.json', import.meta.url), 'utf8'));
  const release = JSON.parse(await boundedText(await publicRequest(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`, options), 4 * 1024 * 1024));
  if (release.draft !== false || release.tag_name !== tag) throw new Error('The requested release must already be public and match the exact tag.');
  const filename = `abox-tools-${version}-universal.mcpb`;
  const asset = exactAsset(release, filename, tag);
  const checksum = exactAsset(release, `${filename}.sha256`, tag);
  if (checksum.size > 4096) throw new Error('The universal archive checksum file is unexpectedly large.');
  const expected = checksumFor(await boundedText(await publicRequest(checksum.browser_download_url, options), 4096), filename);
  const digest = await responseHash(await publicRequest(asset.browser_download_url, { ...options, timeoutMs: 20 * 60 * 1000 }), asset.size);
  if (digest !== expected || (asset.digest && asset.digest !== `sha256:${digest}`)) {
    throw new Error('The universal MCPB does not match its SHA-256 release checksum or GitHub digest.');
  }
  const manifest = makeManifest(template, tag, digest);
  return { manifest, registry_state: await registryState(manifest, options) };
}

export async function main(args = process.argv.slice(2), settings = {}) {
  const { values } = parseArgs({ args, options: { tag: { type: 'string' }, output: { type: 'string' }, 'verify-published': { type: 'boolean' } } });
  if (!values.tag || !values.output) throw new Error('Use --tag v0.2.1 and --output with the generated server.json path.');
  const environment = settings.environment ?? process.env;
  const options = { fetchImpl: settings.fetchImpl, sleep: settings.sleep, token: environment.GITHUB_TOKEN ?? environment.GH_TOKEN };
  const output = path.resolve(values.output);
  if (values['verify-published']) {
    const manifest = JSON.parse(await readFile(output, 'utf8'));
    if (manifest.version !== releaseVersion(values.tag) || manifest.name !== SERVER_NAME) throw new Error('The generated manifest does not match the requested registry version.');
    if (await registryState(manifest, options) !== 'matching') throw new Error('The requested registry version is not publicly visible yet.');
    console.log(`Verified ${SERVER_NAME} version ${manifest.version} in the public registry.`);
    return;
  }
  const result = await prepareRegistry(values.tag, options);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result.manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT, `publish_needed=${result.registry_state === 'missing'}\n`, 'utf8');
  console.log(JSON.stringify({ server: SERVER_NAME, version: result.manifest.version, output_path: output,
    file_sha256: result.manifest.packages[0].fileSha256, registry_state: result.registry_state,
    publish_needed: result.registry_state === 'missing' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
