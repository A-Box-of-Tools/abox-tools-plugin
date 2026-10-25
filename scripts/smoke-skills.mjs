#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_SOURCE = 'A-Box-of-Tools/abox-tools-plugin';
const SKILL = 'abox-local-files';
const runFile = promisify(execFile);
const require = createRequire(import.meta.url);

function inside(filename, directory) {
  const relative = path.relative(directory, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isolatedEnvironment(workspace, localSource) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|CODEX_HOME|XDG_.*|GIT_.*|GH_.*|GITHUB_TOKEN|SSH_.*|NPM_.*|npm_config_.*|NODE_OPTIONS|NODE_PATH|PYTHON.*|DISABLE_TELEMETRY|DO_NOT_TRACK)$/i.test(name)
    && !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name)));
  const home = path.join(workspace, 'home');
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    GH_CONFIG_DIR: path.join(home, '.config', 'gh'),
    TEMP: path.join(workspace, 'temporary'), TMP: path.join(workspace, 'temporary'), TMPDIR: path.join(workspace, 'temporary'),
    npm_config_cache: path.join(home, '.cache', 'npm'), npm_config_userconfig: path.join(home, '.npmrc'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true',
    GCM_INTERACTIVE: 'Never',
  });
  if (process.platform === 'win32') {
    const parsed = path.parse(home);
    env.HOMEDRIVE = parsed.root.replace(/[\\/]$/, '');
    env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(?:DISABLE_TELEMETRY|DO_NOT_TRACK)$/i.test(name)) env[name.toUpperCase()] = value;
  }
  // Public installation uses the official CLI defaults for discovery. Local QA does not advertise filesystem sources.
  if (localSource) env.DISABLE_TELEMETRY = '1';
  return { env, home };
}

async function regularFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const info = await lstat(filename);
    assert.ok(!info.isSymbolicLink(), `The copied skill must not contain symbolic links: ${entry.name}`);
    assert.ok(info.isFile() || info.isDirectory(), 'The copied skill contains a special file.');
    assert.ok(inside(await realpath(filename), root), 'The copied skill escaped its installation directory.');
    if (info.isDirectory()) files.push(...await regularFiles(filename, root));
    else files.push(path.relative(root, filename).split(path.sep).join('/'));
  }
  return files;
}

async function validateSkill(directory, expectedVersion) {
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'The official CLI must copy a project skill directory.');
  assert.equal(await realpath(directory), directory);
  const files = await regularFiles(directory);
  for (const required of ['SKILL.md', 'adapter-version.json', 'scripts/install-adapter.py', 'references/installation.md']) {
    assert.ok(files.includes(required), `The copied standalone skill is missing ${required}.`);
  }
  const metadata = JSON.parse(await readFile(path.join(directory, 'adapter-version.json'), 'utf8'));
  assert.equal(metadata.version, expectedVersion, 'The installed public skill must pin the version being tested. Push the release source before public QA.');
  assert.equal(metadata.repository, PUBLIC_SOURCE);
  const skill = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
  assert.ok(frontmatter, 'The copied skill must contain YAML frontmatter.');
  assert.match(frontmatter[1], /(?:^|\r?\n)name:\s*abox-local-files\s*(?:\r?\n|$)/);
  assert.match(frontmatter[1], /(?:^|\r?\n)description:\s*\S/);
  for (const name of files.filter(filename => filename.endsWith('.md'))) {
    const source = await readFile(path.join(directory, ...name.split('/')), 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim();
      if (/^(?:https?:\/\/|mailto:|#)/i.test(target)) continue;
      target = target.replace(/^<|>$/g, '').split(/[?#]/)[0];
      assert.ok(!path.isAbsolute(target) && !/^[a-z][a-z0-9+.-]*:/i.test(target), 'Skill references must not depend on machine-specific paths.');
      const filename = path.resolve(directory, path.dirname(name), decodeURIComponent(target));
      assert.ok(inside(filename, directory), `A skill reference depends on files outside its copied directory: ${name}`);
      assert.ok((await lstat(filename)).isFile(), `A copied skill reference is missing: ${target}`);
    }
  }
  return files;
}

async function pythonCommand(env, cwd) {
  const configured = process.env.ABOX_PYTHON;
  if (configured) assert.ok(path.isAbsolute(configured), 'ABOX_PYTHON must be an absolute executable path.');
  const candidates = configured ? [configured] : process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const command of candidates) {
    try {
      const result = await runFile(command, ['--version'], { cwd, env, windowsHide: true, timeout: 10000 });
      const version = /Python (\d+)\.(\d+)\.(\d+)/.exec(result.stdout + result.stderr);
      if (version && (Number(version[1]) > 3 || Number(version[1]) === 3 && Number(version[2]) >= 9)) return command;
    } catch { /* Try another supported Python command. */ }
  }
  throw new Error('Standalone skill QA requires Python 3.9 or later. Set ABOX_PYTHON to its absolute executable path if needed.');
}

async function offlineInstallerCheck(python, installer, cache, cwd, env) {
  try {
    await runFile(python, ['-I', '-B', installer, '--cache-root', cache, '--verify-only'], {
      cwd, env, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    assert.fail('An empty isolated adapter cache must not verify successfully.');
  } catch (error) {
    assert.equal(error.code, 1, 'The copied installer must run and reject an absent cache without a Python or path failure.');
    const result = JSON.parse(error.stderr.trim());
    assert.equal(result.ok, false);
    assert.equal(result.error, 'The installed adapter directory is invalid.');
  }
}

async function cleanup(workspace, parent) {
  const info = await lstat(workspace);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Refusing to remove a replaced QA directory.');
  const canonical = await realpath(workspace);
  assert.equal(canonical, workspace);
  assert.equal(path.dirname(canonical), parent);
  assert.ok(path.basename(canonical).startsWith('abox-skills-smoke-'));
  await rm(canonical, { recursive: true, force: true });
}

export async function smokeSkills(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    source: { type: 'string', default: PUBLIC_SOURCE },
    archive: { type: 'string' }, checksum: { type: 'string' },
    'prepared-bundle': { type: 'boolean', default: false },
  } });
  assert.equal(Boolean(values.archive), Boolean(values.checksum), '--archive and --checksum must be supplied together.');
  assert.ok(!values['prepared-bundle'] || !values.archive, '--prepared-bundle cannot be combined with --archive or --checksum.');
  const localSource = path.isAbsolute(values.source);
  assert.ok(localSource || values.source === PUBLIC_SOURCE, '--source must be the public owner/repo or an absolute local repository directory.');
  const source = localSource ? await realpath(values.source) : PUBLIC_SOURCE;
  if (localSource) assert.ok((await lstat(source)).isDirectory(), 'The local source must be a repository directory.');
  for (const filename of [values.archive, values.checksum].filter(Boolean)) {
    assert.ok(path.isAbsolute(filename), 'Offline release paths must be absolute.');
  }
  const project = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (values['prepared-bundle']) {
    const build = JSON.parse(await readFile(path.join(ROOT, '_release', 'build.json'), 'utf8'));
    const labels = { win32: 'windows', linux: 'linux', darwin: 'macos' };
    assert.equal(build.version, project.version, 'The prepared release must match the source version.');
    assert.equal(build.platform, process.platform, 'The prepared release must match this operating system.');
    assert.equal(build.arch, process.arch, 'The prepared release must match this CPU architecture.');
    assert.ok(labels[build.platform] && ['x64', 'arm64'].includes(build.arch), 'The prepared native release platform is unsupported.');
    const name = `abox-tools-${project.version}-${labels[build.platform]}-${build.arch}`;
    assert.equal(build.name, name, 'The prepared release label must match its platform and version.');
    values.archive = path.join(ROOT, 'release', `${name}.zip`);
    values.checksum = `${values.archive}.sha256`;
    for (const filename of [values.archive, values.checksum]) {
      const info = await lstat(filename);
      assert.ok(info.isFile() && !info.isSymbolicLink(), 'The prepared archive and checksum must be regular local files.');
    }
  }
  let skillsPackage;
  try { skillsPackage = require.resolve('skills/package.json'); }
  catch { throw new Error('Install the repository dev dependencies before running the official skills CLI QA.'); }
  const skillsMetadata = JSON.parse(await readFile(skillsPackage, 'utf8'));
  assert.equal(skillsMetadata.version, project.devDependencies.skills, 'The official skills CLI must match the reviewed pinned dev dependency.');
  const cli = path.resolve(path.dirname(skillsPackage), skillsMetadata.bin.skills);
  const parent = await realpath(tmpdir());
  const workspace = await realpath(await mkdtemp(path.join(parent, 'abox-skills-smoke-')));
  const { env, home } = isolatedEnvironment(workspace, localSource);
  const cwd = path.join(workspace, 'project');
  const cache = path.join(home, '.abox-tools', 'adapters');
  try {
    for (const directory of [cwd, home, env.TEMP, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME]) await mkdir(directory, { recursive: true });
    await writeFile(env.GIT_CONFIG_GLOBAL, '', { flag: 'wx' });
    await writeFile(env.npm_config_userconfig, '', { flag: 'wx' });
    // This is the documented `npx skills add` recipe, using the exact locally pinned CLI instead of downloading another version.
    await runFile(process.execPath, [cli, 'add', source, '--copy', '--skill', SKILL, '--agent', 'codex', '--yes'], {
      cwd, env, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    });
    const installed = path.join(cwd, '.agents', 'skills', SKILL);
    const files = await validateSkill(installed, project.version);
    const python = await pythonCommand(env, cwd);
    const installer = path.join(installed, 'scripts', 'install-adapter.py');
    await offlineInstallerCheck(python, installer, cache, cwd, env);
    let offlineAdapterInstalled = false;
    if (values.archive) {
      const result = await runFile(python, ['-I', '-B', installer, '--cache-root', cache,
        '--archive', values.archive, '--checksum', values.checksum], {
        cwd, env, windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024,
      });
      const adapter = JSON.parse(result.stdout.trim());
      assert.equal(adapter.ok, true);
      assert.equal(adapter.version, project.version);
      assert.ok(inside(await realpath(adapter.adapter_root), cache), 'The installer must stay inside the isolated cache.');
      const checked = JSON.parse((await runFile(python, ['-I', '-B', installer, '--cache-root', cache, '--verify-only'], {
        cwd, env, windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024,
      })).stdout.trim());
      assert.deepEqual(checked, adapter);
      const capabilities = JSON.parse((await runFile(adapter.node_executable, [adapter.cli, 'capabilities'], {
        cwd, env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
      })).stdout.trim());
      assert.equal(capabilities.ok, true);
      assert.equal(capabilities.version, project.version);
      assert.equal(capabilities.processing, 'local');
      offlineAdapterInstalled = true;
    }
    const result = {
      ok: true, source, skill: SKILL, skills_cli_version: skillsMetadata.version,
      adapter_version: project.version, copied_files: files.length, project_install: true,
      isolated_home: true, installer_checked_offline: true, adapter_installed_offline: offlineAdapterInstalled,
      telemetry: localSource ? 'disabled-for-local-source'
        : env.DISABLE_TELEMETRY || env.DO_NOT_TRACK ? 'existing-opt-out' : 'cli-defaults',
    };
    console.log(JSON.stringify(result));
    return result;
  } finally { await cleanup(workspace, parent); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await smokeSkills(); }
  catch (error) { console.error(`Skills installation QA failed: ${error.message}`); process.exitCode = 1; }
}
