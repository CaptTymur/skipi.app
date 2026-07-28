#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISHER = path.join(ROOT, 'scripts', 'publish-rf-mirror.sh');
const PREPARE = path.join(ROOT, 'scripts', 'prepare-rf-mirror.sh');
const RUNBOOK = path.join(ROOT, 'scripts', 'RF_MIRROR_PUBLISH.md');

let pass = 0;
let fail = 0;

function ok(condition, message) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${message}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${message}`);
  }
}

function section(title) {
  console.log(`\n# ${title}`);
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function lines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

const source = fs.readFileSync(PUBLISHER, 'utf8');
const prepareSource = fs.readFileSync(PREPARE, 'utf8');
const runbookSource = fs.readFileSync(RUNBOOK, 'utf8');

section('Static transport and operator contract');
ok(!/sftp:\/\//i.test(source), 'publisher has no executable SFTP URL');
ok(!/RF_SFTP_/i.test(source), 'publisher has no legacy SFTP credential path');
ok(!/\b(?:ssh|sftp)\b[^\n]*(?:-p|-P|port|:\/\/)/i.test(source), 'publisher has no SSH/SFTP client mode');
ok((source.match(/\blftp\b[^\n]*(?:-u|-e)/g) || []).length === 1, 'publisher contains one FTP client invocation');
ok(/ftp:\/\/[^\s"']+:21/.test(source), 'publisher fixes the FTP control port at 21');
ok(/net:max-retries\s+1/.test(source), 'publisher configures one try with no retry');
ok(/ftp:ssl-allow\s+no/.test(source), 'publisher forces plain FTP');
ok(/api-ru\/public_html/.test(source) && !/\/home\/c\/cq62932\/api-ru\/public_html/.test(source), 'publisher uses the FTP-chroot docroot');

for (const [name, text] of [['prepare instructions', prepareSource], ['publisher runbook', runbookSource]]) {
  ok(/FTP:21/.test(text), `${name} names FTP:21`);
  ok(/one attempt|one login attempt|single login attempt/i.test(text), `${name} states the one-attempt rule`);
  ok(/no retr(?:y|ies)/i.test(text), `${name} states the no-retry rule`);
  ok(/rollback evidence|rollback-evidence/i.test(text), `${name} requires rollback evidence`);
  ok(!/RF_SFTP_USER|RF_SFTP_PASS|sftp:\/\//i.test(text), `${name} does not instruct SFTP use`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-publish-contract-'));
const bin = path.join(tmp, 'bin');
const stage = path.join(tmp, 'stage');
fs.mkdirSync(bin);
fs.mkdirSync(stage);

const eventsFile = path.join(tmp, 'events.log');
const commandFile = path.join(tmp, 'lftp-command.txt');
const manifestCountFile = path.join(tmp, 'manifest-fetch-count');
const manifestUrl = 'https://api-ru.skipi.app/seafarer/latest.json';
const assetFixtures = [
  ['https://api-ru.skipi.app/downloads/seafarer/0.4.179/Skipi_0.4.179_amd64.AppImage', Buffer.from('0123456789abcdeffixture-appimage')],
  ['https://api-ru.skipi.app/downloads/seafarer/0.4.179/Skipi_0.4.179_x64-setup.exe', Buffer.from('fedcba9876543210fixture-windows')],
];
const liveBytes = Buffer.from('{"version":"0.4.178","platforms":{"linux":{"url":"https://api-ru.skipi.app/old.AppImage","signature":"old-signature"}}}\n');
const manifest = {
  version: '0.4.179',
  platforms: {
    linux: { url: assetFixtures[0][0], signature: 'fixture-linux-signature' },
    windows: { url: assetFixtures[1][0], signature: 'fixture-windows-signature' },
  },
};
fs.writeFileSync(path.join(stage, 'latest.rf.json'), `${JSON.stringify(manifest)}\n`);
for (const [url, bytes] of assetFixtures) fs.writeFileSync(path.join(stage, path.basename(url)), bytes);

writeExecutable(path.join(bin, 'curl'), `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const events = process.env.HARNESS_EVENTS;
const manifestUrl = ${JSON.stringify(manifestUrl)};
const live = Buffer.from(${JSON.stringify(liveBytes.toString('base64'))}, 'base64');
const assets = new Map(${JSON.stringify(assetFixtures.map(([url, bytes]) => [url, bytes.toString('base64')]))}.map(([url, bytes]) => [url, Buffer.from(bytes, 'base64')]));
const append = (line) => fs.appendFileSync(events, line + '\\n');
const valueAfter = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : '';
};
const url = [...args].reverse().find((arg) => /^https:\\/\\//.test(arg)) || '';
const output = valueAfter('-o');
if (url === manifestUrl) {
  let count = Number(fs.existsSync(process.env.HARNESS_MANIFEST_COUNT) ? fs.readFileSync(process.env.HARNESS_MANIFEST_COUNT, 'utf8') : '0') + 1;
  fs.writeFileSync(process.env.HARNESS_MANIFEST_COUNT, String(count));
  if (count === 1) append('ROLLBACK_EVIDENCE');
  else append('FINAL_LIVE_VERIFY');
  if (process.env.FAIL_PHASE === 'post_rename' && count > 1) process.exit(22);
  if (output) fs.writeFileSync(output, count === 1 ? live : Buffer.from(${JSON.stringify(`${JSON.stringify(manifest)}\n`)}));
  else process.stdout.write(count === 1 ? live : Buffer.from(${JSON.stringify(`${JSON.stringify(manifest)}\n`)}));
  process.exit(0);
}
if (assets.has(url) && args.includes('-I')) {
  append(args.includes('-w') ? 'FINAL_ASSET_VERIFY' : 'ASSET_VERIFY');
  if (process.env.FAIL_PHASE === 'asset_verify') process.exit(22);
  if (args.includes('-w')) process.stdout.write('200');
  else process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Length: ' + assets.get(url).length + '\\r\\n\\r\\n');
  process.exit(0);
}
if (assets.has(url) && args.includes('-r')) {
  if (output) fs.writeFileSync(output, assets.get(url).subarray(0, 16));
  if (args.includes('-w')) process.stdout.write('206');
  process.exit(0);
}
console.error('unexpected curl args: ' + JSON.stringify(args));
process.exit(64);
`);

writeExecutable(path.join(bin, 'lftp'), `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const append = (line) => fs.appendFileSync(process.env.HARNESS_EVENTS, line + '\\n');
const e = args.indexOf('-e');
const commands = e >= 0 ? args[e + 1] : '';
const remote = args.find((arg) => /^ftp:\\/\\//.test(arg)) || '';
fs.writeFileSync(process.env.HARNESS_LFTP_COMMAND, commands);
append('FTP_LOGIN:' + remote);
const shellEscape = (shellCommand) => {
  const result = spawnSync('/bin/sh', ['-c', shellCommand], { env: process.env, encoding: 'utf8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) process.exit(result.status || 1);
};
// Faithful to real lftp parsing: a newline ends a command, ";" separates
// commands within a line, and "!" hands the WHOLE remainder of its line
// (including any ";"-separated tail) to the local shell.
for (const rawLine of commands.split('\\n')) {
  const segments = rawLine.split(';');
  for (let i = 0; i < segments.length; i += 1) {
    const command = segments[i].trim();
    if (!command) continue;
    if (command.startsWith('!')) {
      shellEscape(segments.slice(i).join(';').trim().slice(1).trim());
      break;
    }
    if (command.startsWith('put ')) {
      if (/ -o ["']?latest\\.json\.[^ "']+\.new/.test(command)) {
        const match = command.match(/ -o ["']?([^ "']+)/);
        append('MANIFEST_PUT:' + (match ? match[1].replace(/["']$/, '') : 'unknown'));
      } else {
        const match = command.match(/put(?: -O ["'][^"']+["'])? ["']([^"']+)["']/);
        append('ASSET_PUT:' + (match ? match[1].split('/').pop() : 'unknown'));
        if (process.env.FAIL_PHASE === 'upload') process.exit(41);
      }
    } else if (command.startsWith('mv ')) {
      append('MANIFEST_RENAME');
    }
  }
}
process.exit(0);
`);

const baseEnv = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  HARNESS_EVENTS: eventsFile,
  HARNESS_LFTP_COMMAND: commandFile,
  HARNESS_MANIFEST_COUNT: manifestCountFile,
  RF_FTP_USER: 'USER_SECRET_7f58',
  RF_FTP_PASS: 'PASS_SECRET_b0d1',
};

const commonArgs = [
  PUBLISHER,
  '--staging', stage,
  '--manifest-local', 'latest.rf.json',
  '--manifest-url', manifestUrl,
  '--expect-version', '0.4.179',
];

function resetRuntime() {
  for (const file of [eventsFile, commandFile, manifestCountFile]) {
    fs.rmSync(file, { force: true });
  }
}

function run(extraArgs, env = {}) {
  const mergedEnv = { ...baseEnv, ...env };
  for (const [name, value] of Object.entries(mergedEnv)) {
    if (value === undefined) delete mergedEnv[name];
  }
  return spawnSync('/bin/bash', [...commonArgs, ...extraArgs], {
    cwd: ROOT,
    env: mergedEnv,
    encoding: 'utf8',
  });
}

section('Dry-run and rollback refusal');
resetRuntime();
const dryRun = run(['--dry-run'], { RF_FTP_USER: undefined, RF_FTP_PASS: undefined });
ok(dryRun.status === 0, 'dry-run succeeds without credentials or evidence capture');
ok(lines(eventsFile).length === 0, 'dry-run performs zero network and zero FTP invocation');
ok(/FTP:21/i.test(dryRun.stdout) && /assets first/i.test(dryRun.stdout) && /manifest last/i.test(dryRun.stdout), 'dry-run prints the bounded FTP:21 plan');

resetRuntime();
const noEvidence = run([]);
ok(noEvidence.status !== 0, 'real publish refuses an absent rollback-evidence target');
ok(lines(eventsFile).length === 0, 'rollback-evidence refusal occurs before network or login');

section('Successful execution order');
resetRuntime();
const evidence = path.join(tmp, 'rollback', 'seafarer-latest.previous.json');
fs.mkdirSync(path.dirname(evidence));
const success = run(['--rollback-evidence', evidence]);
const successOutput = `${success.stdout}\n${success.stderr}`;
const successEvents = lines(eventsFile);
ok(success.status === 0, `real publish succeeds with hermetic stubs${success.status === 0 ? '' : ` (status ${success.status}: ${successOutput.trim().slice(-500)})`}`);
ok(fs.existsSync(evidence) && fs.readFileSync(evidence).equals(liveBytes), 'rollback evidence preserves exact pre-live manifest bytes');
ok(successEvents.filter((line) => line.startsWith('FTP_LOGIN:')).length === 1, 'real publish makes exactly one FTP client/login attempt');
ok(successEvents.find((line) => line.startsWith('FTP_LOGIN:')) === 'FTP_LOGIN:ftp://5.23.50.183:21', 'the sole control connection is plain FTP on port 21');
const eventKinds = successEvents.map((line) => line.split(':')[0]);
const expectedOrder = ['ROLLBACK_EVIDENCE', 'FTP_LOGIN', 'ASSET_PUT', 'ASSET_PUT', 'ASSET_VERIFY', 'ASSET_VERIFY', 'MANIFEST_PUT', 'MANIFEST_RENAME', 'FINAL_LIVE_VERIFY', 'FINAL_ASSET_VERIFY', 'FINAL_ASSET_VERIFY'];
ok(expectedOrder.every((kind, index) => eventKinds[index] === kind), `observed order is rollback -> login -> assets -> public verify -> temp manifest -> rename -> final verify (${eventKinds.join(' -> ')})`);
const tempEvent = successEvents.find((line) => line.startsWith('MANIFEST_PUT:')) || '';
ok(/^MANIFEST_PUT:latest\.json\.0\.4\.179\.[A-Za-z0-9._-]+\.new$/.test(tempEvent), 'manifest upload uses a versioned unique temporary basename');
ok(!successOutput.includes(baseEnv.RF_FTP_USER) && !successOutput.includes(baseEnv.RF_FTP_PASS), 'credential values are absent from stdout/stderr');
const persistedEvidence = fs.existsSync(evidence) ? fs.readFileSync(evidence) : Buffer.alloc(0);
ok(fs.existsSync(evidence) && !persistedEvidence.includes(baseEnv.RF_FTP_USER) && !persistedEvidence.includes(baseEnv.RF_FTP_PASS), 'credential values are absent from persisted evidence');
ok(/rollback evidence:.+SHA-256:.+bytes:/is.test(successOutput), 'publisher reports only rollback evidence path, SHA-256, and size');
const lftpCommands = fs.existsSync(commandFile) ? fs.readFileSync(commandFile, 'utf8') : '';
ok(/set net:max-retries 1/.test(lftpCommands) && /set net:idle 24h/.test(lftpCommands) && /set ftp:proxy ""/.test(lftpCommands) && /set ftp:ssl-allow no/.test(lftpCommands), 'runtime FTP session disables retries/proxies and retains its sole control connection');
const remoteMutationCommands = lftpCommands.split(/[;\n]/).map((command) => command.trim()).filter((command) => /^(?:put|mv)\s/.test(command));
ok(!remoteMutationCommands.some((command) => command.startsWith('put ') && / -o ["']?latest\.json["']?$/.test(command)) && remoteMutationCommands.some((command) => command.startsWith('mv ') && /latest\.json["']?$/.test(command)), 'live manifest basename is a rename target, never a direct upload target');
ok(!/(^|[;\n])\s*(?:rm|glob\s+-f\s+rm|mrm)\b/.test(lftpCommands), 'normal publish command contains no remote deletion');

section('Shell-escape line separation ("!" consumes the rest of its lftp line)');
const lftpLines = lftpCommands.split('\n').map((line) => line.trim()).filter(Boolean);
ok(lftpLines.filter((line) => line.startsWith('!')).length === 2, 'both local verification hooks are "!" commands starting their own lines');
ok(lftpLines.every((line) => !line.startsWith('!') || !line.includes(';')), 'no ";" on any "!" line (the local shell would swallow every later lftp command)');
const firstShellEscape = lftpLines.findIndex((line) => line.startsWith('!'));
const manifestPutLine = lftpLines.findIndex((line) => /^put\b.* -o /.test(line));
const renameLine = lftpLines.findIndex((line) => line.startsWith('mv '));
const lastShellEscape = lftpLines.reduce((last, line, index) => (line.startsWith('!') ? index : last), -1);
const byeLine = lftpLines.indexOf('bye');
ok(firstShellEscape >= 0 && manifestPutLine > firstShellEscape && renameLine > manifestPutLine && lastShellEscape > renameLine && byeLine > lastShellEscape, `manifest put, atomic rename, final "!" verify and bye each survive as their own lftp lines after the first "!" (indexes: !=${firstShellEscape} put=${manifestPutLine} mv=${renameLine} !=${lastShellEscape} bye=${byeLine})`);
ok(lftpLines.every((line) => !(/^(?:mkdir|put|mv|bye)\b/.test(line) && /;/.test(line))), 'no lftp command line chains further commands with ";"');

section('Failure containment');
for (const phase of ['upload', 'asset_verify']) {
  resetRuntime();
  const phaseEvidence = path.join(tmp, 'rollback', `${phase}.previous.json`);
  const result = run(['--rollback-evidence', phaseEvidence], { FAIL_PHASE: phase });
  const events = lines(eventsFile);
  ok(result.status !== 0, `${phase} failure returns nonzero`);
  ok(!events.some((line) => line.startsWith('MANIFEST_PUT:')) && !events.includes('MANIFEST_RENAME'), `${phase} failure cannot reach manifest upload or rename`);
}

resetRuntime();
const postEvidence = path.join(tmp, 'rollback', 'post-rename.previous.json');
const postRename = run(['--rollback-evidence', postEvidence], { FAIL_PHASE: 'post_rename' });
const postEvents = lines(eventsFile);
ok(postRename.status !== 0 && postEvents.includes('MANIFEST_RENAME'), 'post-rename verification failure returns nonzero after the atomic rename');
ok(`${postRename.stdout}\n${postRename.stderr}`.includes(postEvidence), 'post-rename failure reports the exact rollback evidence path');
ok(postEvents.filter((line) => line.startsWith('FTP_LOGIN:')).length === 1, 'failure path does not silently retry the FTP login');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
