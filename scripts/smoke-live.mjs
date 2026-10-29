import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function smokeLive({ runFile, runtime, bundle, cwd, env }) {
  const moduleUrl = pathToFileURL(path.join(bundle, 'src/live.mjs')).href;
  const playwrightUrl = pathToFileURL(path.join(bundle, 'node_modules/playwright-core/index.mjs')).href;
  const code = `import assert from 'node:assert/strict';
import {createLiveManager} from ${JSON.stringify(moduleUrl)};
import {chromium} from ${JSON.stringify(playwrightUrl)};
let sockets=0;
const manager=createLiveManager({launch:options=>chromium.launch({...options,headless:true}),connectSocket:()=>{sockets++;throw Error('Unexpected pairing')}});
let roles=0;
try {
  for(const [tool,values] of Object.entries({'share-text':['host','reader'],'remote-camera':['host','viewer'],'walkie-talkie':['host','listener'],'voice-oncall':['host','sender']})) {
    for(const role of values) {
      const opened=await manager.start(tool,{role});
      const state=await manager.status({session_id:opened.session_id});
      assert.equal(state.phase,'idle');assert.equal(state.capture,'none');assert.equal(state.peer_count,0);
      const page=manager.testPage(opened.session_id);assert.equal(await page.locator('#start').isEnabled(),true);
      await manager.stop({session_id:opened.session_id});assert.equal(page.isClosed(),true);roles++;
    }
  }
  assert.equal(sockets,0);
  console.log(JSON.stringify({ok:true,roles,unrequested_pairing:0,unrequested_capture:0,relocated_assets:true,bundled_runtime:true}));
}finally{await manager.closeAll();}`;
  const result = await runFile(runtime, ['--input-type=module', '--eval', code], { cwd, env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true); assert.equal(value.roles, 8);
  return value;
}
