// Smoke: the gateway's logs must not leak query strings, request lines,
// tokens or bodies, while still allowing an access line to be correlated.
//
//   node tests/customer-log-privacy.mjs                  builds THIS worktree
//   GATEWAY_TEST_IMAGE=<image> node tests/...mjs         runs against an existing image
//   node tests/customer-log-privacy.mjs --static-only    config checks, no Docker
//
// Needs Node 22 and a Docker CLI. Everything it creates carries the label
// synkro.test=customer-log-privacy and is removed on exit, success or not.
// It never prints captured logs: a baseline image would leak the marker
// into this very output.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const staticOnly = process.argv.includes('--static-only');
const existingImage = process.env.GATEWAY_TEST_IMAGE;

const runId = randomBytes(4).toString('hex');
const names = {
  image: `gw-privacy-img-${runId}`,
  container: `gw-privacy-${runId}`,
  network: `gw-privacy-net-${runId}`,
};
const labelArgs = ['--label', 'synkro.test=customer-log-privacy', '--label', `synkro.test.run=${runId}`];

const marker = `MK${randomBytes(6).toString('hex')}`;
const bodyMarker = `BD${randomBytes(6).toString('hex')}`;
const token = `TK${randomBytes(12).toString('hex')}`;
const percentEncode = (text) => [...Buffer.from(text)].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
const encodedMarker = percentEncode(marker);

const results = [];
const check = (description, passed) => {
  results.push({ description, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${description}`);
};

const docker = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: args[0] === 'build' ? 600000 : 20000, ...options });
let createdContainer=false, createdNetwork=false, createdImage=false;

// ---------------------------------------------------------------- static

function staticChecks() {
  const template = readFileSync(join(root, 'templates', 'default.conf.template'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const logFormat = /log_format\s+\w+\s+escape=json\s+'([^;]*)';/s.exec(template)?.[1] ?? '';
  const forbidden = ['$request"', '$request ', '$request_uri', '$args', '$query_string', '$is_args', '$http_authorization', '$request_body'];

  check('static: an escape=json log_format is declared', logFormat !== '');
  check('static: log_format has method, path, status and correlation fields',
    ['method', 'path', 'status', 'correlationId'].every((field) => logFormat.includes(`"${field}"`)));
  check('static: log_format never references query, request line, token or body variables',
    logFormat !== '' && !forbidden.some((variable) => logFormat.includes(variable)));
  check('static: server uses the JSON access_log on stdout', /access_log\s+\/dev\/stdout\s+\w+\s*;/.test(template));
  check('static: request-bearing error_log is silenced at server level', /error_log\s+\/dev\/null\s+emerg\s*;/.test(template));
}

// ---------------------------------------------------------------- docker

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request({ port, method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function hostPort() {
  const out = docker(['port', names.container, '8000/tcp']).stdout ?? '';
  const match = /127\.0\.0\.1:(\d+)/.exec(out);
  return match ? Number(match[1]) : null;
}

async function waitUntilReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const port = hostPort();
    if (port) {
      try {
        if ((await request({ port, path: '/health' })).status === 200) return port;
      } catch { /* not listening yet */ }
    }
    await sleep(500);
  }
  return null;
}

function captureLogs() {
  const logs = docker(['logs', names.container], { maxBuffer: 16 * 1024 * 1024 });
  return { stdout: logs.stdout ?? '', stderr: logs.stderr ?? '' };
}

function accessEntries(stdout) {
  return stdout.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry === 'object' ? [entry] : [];
    } catch {
      return [];
    }
  });
}

async function waitForAccessLines(correlationIds) {
  const deadline = Date.now() + 5000;
  let logs = captureLogs();
  while (Date.now() < deadline) {
    const seen = new Set(accessEntries(logs.stdout).map((entry) => entry.correlationId));
    if (correlationIds.every((id) => seen.has(id))) break;
    await sleep(300);
    logs = captureLogs();
  }
  return logs;
}

function cleanup() {
  function removeOwned(kind,name,args){
    const inspect=docker([kind,'inspect',name]);
    if(inspect.status!==0){check(`cleanup can inspect owned ${kind}`,false);return;}
    const item=JSON.parse(inspect.stdout)[0],labels=item.Config?.Labels??item.Labels;
    if(labels?.['synkro.test.run']!==runId){check(`cleanup refuses unowned ${kind}`,false);return;}
    check(`cleanup removes owned ${kind}`,docker(args).status===0);
  }
  if(createdContainer){removeOwned('container',names.container,['rm','-f','--volumes',names.container]);createdContainer=false;}
  if(createdNetwork){removeOwned('network',names.network,['network','rm',names.network]);createdNetwork=false;}
  if(createdImage){removeOwned('image',names.image,['rmi',names.image]);createdImage=false;}
}

async function dockerChecks() {
  let image = existingImage;
  if (!image) {
    const build = docker(['build', '-q', '-f', 'deploy/Dockerfile', '-t', names.image, ...labelArgs, '.'], { cwd: root });
    if (build.status !== 0) {
      check('docker build of this worktree succeeds', false);
      return;
    }
    image = names.image;
    createdImage=true;
  }

  const net = docker(['network', 'create', ...labelArgs, names.network]);
  createdNetwork=net.status===0;
  const run = net.status === 0 && docker([
    'run', '-d', '--name', names.container, '--network', names.network, ...labelArgs,
    '-e', 'CORS_ALLOWED_ORIGINS=http://localhost:5173',
    '-e', 'RATE_LIMIT_PER_SECOND=1000',
    '-p', '127.0.0.1::8000',
    image,
  ]);
  if (!run || run.status !== 0) {
    check('gateway container starts', false);
    return;
  }
  createdContainer=true;

  const port = await waitUntilReady();
  check('gateway becomes ready within 30s', port !== null);
  if (port === null) return;

  const auth = { Authorization: `Bearer ${token}` };
  const requests = [
    { id: `c1-${runId}`, method: 'GET', path: `/api/v1/customers?identityDocument=${marker}`, headers: { ...auth }, status: 503 },
    { id: `c2-${runId}`, method: 'GET', path: `/api/v1/customers?identityDocument=${marker}`, headers: {}, status: 401 },
    { id: `c3-${runId}`, method: 'GET', path: `/api/v1/customers?identityDocument=${marker}&identityDocument=${marker}&q=${marker}`, headers: { ...auth }, status: 503 },
    { id: `c4-${runId}`, method: 'GET', path: `/api/v1/customers?identityDocument=${encodedMarker}`, headers: { ...auth }, status: 503 },
    { id: `c5-${runId}`, method: 'POST', path: '/api/v1/customers', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ identityDocument: bodyMarker }), status: 503 },
  ];

  for (const spec of requests) {
    const response = await request({ port, method: spec.method, path: spec.path, body: spec.body, headers: { ...spec.headers, 'X-Correlation-Id': spec.id } });
    spec.response = response;
    check(`${spec.method} request ${spec.id} answers ${spec.status}`, response.status === spec.status);
    check(`response ${spec.id} carries its correlation id`, response.body.includes(spec.id));
  }

  const { stdout, stderr } = await waitForAccessLines(requests.map((spec) => spec.id));
  const entries = accessEntries(stdout);

  for (const spec of requests) {
    const entry = entries.find((candidate) => candidate.correlationId === spec.id);
    check(`access line exists for ${spec.id}`, entry !== undefined);
    check(`access line ${spec.id} records method ${spec.method}`, entry?.method === spec.method);
    check(`access line ${spec.id} records the bare path`, entry?.path === '/api/v1/customers');
    check(`access line ${spec.id} records status ${spec.status}`, Number(entry?.status) === spec.status);
    check(`access line ${spec.id} carries the shared logging metadata`,
      typeof entry?.timestamp==='string' && entry.level==='INFO' && entry.service==='synkro-api-gateway' && entry.message==='request completed');
    const keys = Object.keys(entry ?? {});
    check(`access line ${spec.id} has no request-line/query/auth fields`,
      entry !== undefined && !keys.some((key) => /^(request|query|args|uri|request_uri|authorization|body)$/i.test(key)));
  }

  const combined = `${stdout}\n${stderr}`;
  const lower = combined.toLowerCase();
  const leaks = [
    ['query marker', [marker, encodedMarker, encodedMarker.toUpperCase()]],
    ['body marker', [bodyMarker]],
    ['bearer token', [token]],
    ['query key name', ['identityDocument']],
    ['query separator after the path', ['/api/v1/customers?']],
  ];
  for (const [label, needles] of leaks) {
    check(`captured stdout+stderr contains no ${label}`, !needles.some((needle) => lower.includes(needle.toLowerCase())));
  }
  check('captured logs are non-empty (capture works)', combined.trim().length > 0);
  console.log(`(log summary: ${entries.length} JSON access lines, ${stderr.split('\n').filter(Boolean).length} stderr lines; contents withheld)`);
}

// ---------------------------------------------------------------- main

let exitCode = 1;
const onSignal = () => { cleanup(); process.exit(130); };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

try {
  staticChecks();
  if (!staticOnly) {
    try {
      await dockerChecks();
    } catch (error) {
      check(`docker smoke ran without internal error (${error.code ?? error.name})`, false);
    } finally {
      cleanup();
    }
  }
  const failed = results.filter((result) => !result.passed).length;
  console.log(`\n=== ${results.length - failed} passed, ${failed} failed ===`);
  exitCode = failed === 0 ? 0 : 1;
} finally {
  process.exitCode = exitCode;
}
