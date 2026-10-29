import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createLiveManager } from '../src/live.mjs';
import { findBrowser } from '../src/browser.mjs';

// This permanent interoperability QA is deliberately separate from offline CI.
// Opting in visits the real public pages and creates only ephemeral test rooms.
const enabled = process.env.ABOX_TEST_LIVE_WEBSITE === '1';
const executablePath = enabled ? await findBrowser() : null;
const WEBSITE = 'https://abox.tools';
const RENDEZVOUS = 'wss://rendezvous.abox.tools';
const LAUNCH_ARGS = ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--mute-audio'];

// A real Web Audio source and native MediaStream exercise Opus/RTP without
// consulting any physical capture device or browser permission grant.
function installSyntheticMicrophone() {
  const facts = window.aboxWebsiteVoiceFixture = { started: 0, stopped: 0, tracks: [] };
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (!constraints?.audio || constraints.video) throw new Error('This QA fixture accepts synthetic audio only.');
    const Context = window.AudioContext ?? window.webkitAudioContext;
    const context = new Context({ sampleRate: 48000 }), destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.frequency.value = 440; gain.gain.value = 0.15;
    oscillator.connect(gain); gain.connect(destination); oscillator.start();
    try { await context.resume(); } catch { oscillator.stop(); void context.close(); throw new Error('The synthetic audio source could not resume.'); }
    const track = destination.stream.getAudioTracks()[0], nativeStop = track.stop.bind(track);
    let stopped = false;
    track.stop = () => {
      if (!stopped) { stopped = true; facts.stopped++; oscillator.stop(); oscillator.disconnect(); gain.disconnect(); void context.close().catch(() => {}); }
      nativeStop();
    };
    facts.started++; facts.tracks.push(track);
    return destination.stream;
  };
}

function companionManager() {
  return createLiveManager({ browserPath: async () => executablePath, launch: async options => {
    const browser = await chromium.launch({ ...options, headless: true, args: [...options.args, '--mute-audio'] });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async settings => { const context = await newContext(settings); await context.addInitScript(installSyntheticMicrophone); return context; };
    return browser;
  } });
}

function invitationSocket(invitation, tool) {
  const url = new URL(invitation), code = new URLSearchParams(url.hash.slice(1)).get('code');
  assert.equal(url.origin === WEBSITE && url.pathname === `/${tool}/` && /^[a-f0-9]{64}$/.test(code ?? ''), true, 'The companion must supply a compatible public invitation.');
  return `${RENDEZVOUS}/${tool === 'walkie-talkie' ? 'broadcast' : 'inbox'}/${code}`;
}

async function publicPage(invitation, tool) {
  let browser;
  try {
    const expectedSocket = invitationSocket(invitation, tool);
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 30000, args: LAUNCH_ARGS });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await context.addInitScript(installSyntheticMicrophone);
    const traffic = { paired: 0, blocked_http: 0, blocked_sockets: 0 };
    await context.route('**/*', async route => {
      const request = route.request(); let url;
      try { url = new URL(request.url()); } catch { traffic.blocked_http++; return route.abort('blockedbyclient'); }
      // Assets retain their deployed version-query strings. Navigation remains
      // on this one tool, and beacons/third-party scripts receive no exception.
      const document = request.isNavigationRequest(), asset = /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|svg|ico|json|webmanifest|txt)$/i.test(url.pathname);
      if (url.origin !== WEBSITE || url.username || url.password || request.method() !== 'GET'
          || (document ? url.pathname !== `/${tool}/` : !asset)) {
        traffic.blocked_http++; return route.abort('blockedbyclient');
      }
      // Never follow an allowed asset's redirect to an unreviewed origin.
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 20000 });
        if (response.status() >= 300 && response.status() < 400) { traffic.blocked_http++; return route.abort('blockedbyclient'); }
        return route.fulfill({ response });
      } catch { return route.abort('failed'); }
    });
    await context.routeWebSocket('**/*', socket => {
      if (socket.url() !== expectedSocket) { traffic.blocked_sockets++; return socket.close({ code: 1008, reason: 'Only the invited QA voice session is allowed' }); }
      traffic.paired++; socket.connectToServer();
    });
    const page = await context.newPage();
    context.on('page', extra => { if (extra !== page) void extra.close().catch(() => {}); });
    await page.goto(invitation, { waitUntil: 'load', timeout: 30000 });
    return { browser, page, traffic };
  } catch {
    await browser?.close().catch(() => {});
    // Navigation errors can contain the capability-bearing URL. Keep those
    // credentials out of test output as well as normal tool summaries.
    throw new Error('The isolated public voice page could not load its allowed assets and invitation.');
  }
}

async function connected(manager, session_id) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const state = await manager.status({ session_id });
    if (state.connected && state.peer_count > 0) return;
    if (state.phase === 'error') throw new Error('The companion reported a voice transport error.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The public page and companion did not establish their expected direct voice connection.');
}

async function fixtureFacts(page) {
  return page.evaluate(() => ({ started: window.aboxWebsiteVoiceFixture.started, stopped: window.aboxWebsiteVoiceFixture.stopped,
    live: window.aboxWebsiteVoiceFixture.tracks.filter(track => track.readyState === 'live').length }));
}

async function assertReceivedTone(page, selector) {
  await page.waitForFunction(selector => {
    const audio = document.querySelector(selector);
    return audio?.srcObject?.getAudioTracks().some(track => track.readyState === 'live') && audio.currentTime > 0;
  }, selector, { timeout: 30000 });
  const facts = await page.evaluate(async selector => {
    const audio = document.querySelector(selector), Context = window.AudioContext ?? window.webkitAudioContext;
    const context = new Context(), source = context.createMediaStreamSource(audio.srcObject), analyser = context.createAnalyser(), silent = context.createGain();
    analyser.fftSize = 1024; silent.gain.value = 0; source.connect(analyser); analyser.connect(silent); silent.connect(context.destination);
    let timer, peak = 0, measured = 0;
    try {
      await Promise.race([context.resume(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('analysis resume')), 5000); })]);
      clearTimeout(timer);
      const samples = new Float32Array(analyser.fftSize), deadline = performance.now() + 10000;
      while (performance.now() < deadline) {
        analyser.getFloatTimeDomainData(samples); measured++;
        for (const value of samples) peak = Math.max(peak, Math.abs(value));
        if (peak > 0.01) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { peak, measured, tracks: audio.srcObject.getAudioTracks().length, advancing: audio.currentTime > 0 };
    } finally { clearTimeout(timer); source.disconnect(); analyser.disconnect(); silent.disconnect(); await context.close(); }
  }, selector);
  assert.equal(facts.advancing, true); assert.ok(facts.tracks > 0); assert.ok(facts.measured > 0);
  assert.ok(facts.peak > 0.01, 'Native received audio must contain the original synthetic tone rather than only a live silent track.');
}

test('optional public walkie listener receives companion push-to-talk voice without microphone access', { skip: !enabled || !executablePath, timeout: 120000 }, async t => {
  const manager = companionManager(); let website;
  t.after(async () => { await website?.browser.close().catch(() => {}); await manager.closeAll(); });
  const host = await manager.start('walkie-talkie', { role: 'host', room_name: 'Synthetic website interoperability QA' }), source = manager.testPage(host.session_id);
  await source.locator('#start').click();
  await source.locator('#invitation-output').waitFor({ state: 'visible', timeout: 30000 });
  website = await publicPage(await source.locator('#share-link').inputValue(), 'walkie-talkie');
  await website.page.locator('#wt-listener').waitFor({ state: 'visible', timeout: 30000 });
  await connected(manager, host.session_id);
  await website.page.waitForFunction(() => document.getElementById('wt-audio').srcObject?.getAudioTracks().some(track => track.readyState === 'live'), null, { timeout: 30000 });
  // Use the public page's actual playback action. Its first automatic play may
  // have been blocked; otherwise toggle mute and unmute to exercise the same UI.
  if (await website.page.locator('#wt-mute').getAttribute('aria-pressed') !== 'true') await website.page.locator('#wt-mute').click();
  await website.page.locator('#wt-mute').click();
  await source.locator('#talk').focus(); await source.keyboard.down('Space');
  try {
    assert.equal(await source.locator('#talk').getAttribute('aria-pressed'), 'true');
    await assertReceivedTone(website.page, '#wt-audio');
  } finally { await source.keyboard.up('Space'); }
  assert.equal(await source.locator('#talk').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await fixtureFacts(website.page), { started: 0, stopped: 0, live: 0 });
  assert.ok(website.traffic.paired > 0);
  await website.page.locator('#wt-leave').click();
  await source.locator('#stop').click();
  const facts = await fixtureFacts(source); assert.ok(facts.started > 0); assert.equal(facts.stopped, facts.started); assert.equal(facts.live, 0);
  const state = await manager.status({ session_id: host.session_id }); assert.equal(state.phase, 'stopped'); assert.equal(state.capture, 'none');
});

test('optional public oncall sender authenticates to a companion pager and sends held synthetic voice', { skip: !enabled || !executablePath, timeout: 120000 }, async t => {
  const manager = companionManager(); let website;
  t.after(async () => { await website?.browser.close().catch(() => {}); await manager.closeAll(); });
  const host = await manager.start('voice-oncall', { role: 'host', room_name: 'Synthetic website interoperability QA' }), receiver = manager.testPage(host.session_id);
  const password = 'Synthetic-QA-access-29';
  await receiver.locator('#password').fill(password); await receiver.locator('#start').click();
  await receiver.locator('#invitation-output').waitFor({ state: 'visible', timeout: 30000 });
  website = await publicPage(await receiver.locator('#share-link').inputValue(), 'voice-oncall');
  await website.page.locator('#vi-sender-password').fill(password); await website.page.locator('#vi-join').click();
  await connected(manager, host.session_id);
  await website.page.locator('#vi-hold').waitFor({ state: 'visible', timeout: 30000 });
  await website.page.waitForFunction(() => !document.getElementById('vi-hold').disabled, null, { timeout: 30000 });
  await receiver.locator('#sound').click();
  await website.page.locator('#vi-hold').focus(); await website.page.keyboard.down('Space');
  try {
    assert.equal(await website.page.locator('#vi-hold').getAttribute('aria-pressed'), 'true');
    await assertReceivedTone(receiver, '#audio-streams audio');
  } finally { await website.page.keyboard.up('Space'); }
  assert.equal(await website.page.locator('#vi-hold').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await fixtureFacts(receiver), { started: 0, stopped: 0, live: 0 });
  assert.ok(website.traffic.paired > 0);
  await website.page.locator('#vi-leave').click();
  const facts = await fixtureFacts(website.page); assert.ok(facts.started > 0); assert.equal(facts.stopped, facts.started); assert.equal(facts.live, 0);
  await receiver.locator('#stop').click();
  const state = await manager.status({ session_id: host.session_id }); assert.equal(state.phase, 'stopped'); assert.equal(state.capture, 'none');
});
