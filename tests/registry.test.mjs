import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SERVER_NAME, REPOSITORY, checksumFor, comparePublished, main, makeManifest,
  prepareRegistry, publicRequest, releaseVersion, responseHash,
} from '../scripts/prepare-registry.mjs';

const template = JSON.parse(await readFile(new URL('../registry/server.template.json', import.meta.url), 'utf8'));
const tag = 'v0.2.1';
const filename = 'abox-tools-0.2.1-universal.mcpb';
const bytes = Buffer.from('A fixture for the published universal MCPB digest.');
const digest = createHash('sha256').update(bytes).digest('hex');
const base = `https://github.com/${REPOSITORY}/releases/download/${tag}`;
const manifest = makeManifest(template, tag, digest);

function fixture(change = () => {}, published = null) {
  const checksum = `${digest}  ${filename}\n`;
  const release = {
    tag_name: tag, draft: false,
    assets: [
      { name: filename, state: 'uploaded', size: bytes.length, digest: `sha256:${digest}`, browser_download_url: `${base}/${filename}` },
      { name: `${filename}.sha256`, state: 'uploaded', size: Buffer.byteLength(checksum), browser_download_url: `${base}/${filename}.sha256` },
    ],
  };
  const content = { archive: bytes, checksum };
  change(release, content);
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers });
      if (url === `https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`) return Response.json(release);
      if (url === `${base}/${filename}.sha256`) return new Response(content.checksum);
      if (url === `${base}/${filename}`) return new Response(content.archive);
      if (url.includes('/v0.1/servers/') && url.endsWith('/versions/0.2.1?include_deleted=true')) {
        return published ? Response.json(published) : new Response('Not found', { status: 404 });
      }
      throw new Error(`Unexpected public fixture request: ${url}`);
    },
  };
}

test('registry template is deliberately incomplete and release generation has one canonical package', () => {
  assert.equal(template.name, SERVER_NAME);
  assert.equal(template.version, undefined);
  assert.equal(template.packages, undefined);
  assert.equal(manifest.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.equal(manifest.version, '0.2.1');
  assert.equal(manifest.packages.length, 1);
  assert.deepEqual(manifest.packages[0], {
    registryType: 'mcpb', identifier: `${base}/${filename}`, version: '0.2.1',
    fileSha256: digest, transport: { type: 'stdio' },
  });
  assert.ok(manifest.description.length <= 100);
  assert.equal(manifest.packages[0].runtimeArguments, undefined);
});

test('release tags and hashes cannot become placeholder registry records', () => {
  for (const invalid of ['main', 'v0.2', 'v0.2.1/path', 'v01.2.1', 'v0.2.1;echo', undefined]) {
    assert.throws(() => releaseVersion(invalid), /exact release tag/);
  }
  assert.equal(releaseVersion('v0.2.1-rc.1'), '0.2.1-rc.1');
  assert.throws(() => makeManifest(template, tag, '0'.repeat(64)), /verified artifact hash/);
  assert.throws(() => makeManifest({ ...template, version: '0.2.1' }, tag, digest), /leave version/);
  assert.throws(() => makeManifest({ ...template, name: SERVER_NAME.toLowerCase() }, tag, digest), /template identity/);
});

test('public universal archive is streamed and checked against both published hashes', async () => {
  const fake = fixture();
  const result = await prepareRegistry(tag, { ...fake, token: 'fixture-token' });
  assert.deepEqual(result.manifest, manifest);
  assert.equal(result.registry_state, 'missing');
  assert.equal(fake.requests.length, 4);
  for (const request of fake.requests) {
    assert.equal(request.headers.Authorization, request.url.startsWith('https://api.github.com/') ? 'Bearer fixture-token' : undefined);
  }
  assert.ok(fake.requests.at(-1).url.includes(encodeURIComponent(SERVER_NAME)));
});

test('native bundles, missing assets, drafts, and duplicate universal artifacts are refused', async () => {
  const changes = [
    release => { release.draft = true; },
    release => { release.assets[0].name = 'abox-tools-0.2.0-windows-x64.mcpb'; },
    release => { release.assets.push({ ...release.assets[0] }); },
    release => { release.assets[0].browser_download_url = 'https://example.com/universal.mcpb'; },
  ];
  for (const change of changes) await assert.rejects(prepareRegistry(tag, fixture(change)));
});

test('truncated downloads and disagreeing checksum or GitHub digest fail before registry publication', async () => {
  const changes = [
    (release, content) => { content.archive = bytes.subarray(1); },
    (release, content) => { content.checksum = `${'1'.repeat(64)}  ${filename}\n`; },
    release => { release.assets[0].digest = `sha256:${'2'.repeat(64)}`; },
    (release, content) => { content.checksum = `${digest}  other.mcpb\n`; },
  ];
  for (const change of changes) {
    const fake = fixture(change);
    await assert.rejects(prepareRegistry(tag, fake), /size|checksum|digest|exactly one hash/);
    assert.ok(!fake.requests.some(request => request.url.includes('/v0.1/servers/')));
  }
  assert.throws(() => checksumFor(`${digest}  ${filename}\n${digest}  ${filename}\n`, filename), /exactly one hash/);
});

test('archive hashing accepts streamed chunks and enforces the recorded size', async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 7));
    controller.enqueue(bytes.subarray(7));
    controller.close();
  } });
  assert.equal(await responseHash(new Response(body), bytes.length), digest);
  await assert.rejects(responseHash(new Response(bytes), bytes.length - 1), /exceeded its recorded size/);
});

test('an exact active registry record is idempotent while differing or inactive versions fail', async () => {
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  const published = { server: reordered, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } };
  assert.equal(comparePublished(published, manifest), true);
  assert.equal((await prepareRegistry(tag, fixture(undefined, published))).registry_state, 'matching');
  assert.throws(() => comparePublished({ server: { ...manifest, title: 'Other metadata' } }, manifest), /will not be overwritten/);
  assert.throws(() => comparePublished({ ...published, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } }, manifest), /non-active status/);
});

test('public requests retry brief throttling and stop when a rate limit requires a long wait', async () => {
  let calls = 0;
  const delays = [];
  const response = await publicRequest('https://api.github.com/example', {
    fetchImpl: async () => ++calls === 1
      ? new Response('Wait', { status: 429, headers: { 'retry-after': '1' } }) : Response.json({ ok: true }),
    sleep: async milliseconds => delays.push(milliseconds),
  });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);
  await assert.rejects(publicRequest('https://api.github.com/example', {
    fetchImpl: async () => new Response('Wait', { status: 429, headers: { 'retry-after': '120' } }),
    sleep: async () => assert.fail('The publisher must not ignore the server retry delay.'),
  }), /rate limit was reached/);
});

test('the preparation script writes only verified metadata and reports whether publication is needed', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'abox-registry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'server.json');
  const githubOutput = path.join(directory, 'outputs');
  await main(['--tag', tag, '--output', output], { ...fixture(), environment: { GITHUB_OUTPUT: githubOutput } });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), manifest);
  assert.equal(await readFile(githubOutput, 'utf8'), 'publish_needed=true\n');
  await assert.rejects(main(['--tag', 'main', '--output', path.join(directory, 'invalid.json')]), /exact release tag/);
  await main(['--tag', tag, '--output', output, '--verify-published'], {
    ...fixture(undefined, { server: manifest }), environment: {},
  });
});
