// NFR-004/007/009 -> HU-INF-09/#325 -> stable entry contract and real NGINX reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = new URL('../', import.meta.url);
const templateUrl = new URL('deploy/blue-green-entry.conf.template', root);
const composeUrl = new URL('deploy/blue-green-entry.compose.yml', root);

test('entry contract publishes only loopback web/API ports and mounts configuration read-only', () => {
  const source = readFileSync(composeUrl, 'utf8');
  assert.match(source, /127\.0\.0\.1:5173:5173/);
  assert.match(source, /127\.0\.0\.1:8000:8000/);
  assert.match(source, /read_only: true/);
  assert.doesNotMatch(source, /build:|privileged:|docker\.sock/);
});

test('real stable entry switches and rolls back while requests and prior hashed assets remain available', {timeout:120000}, async () => {
  const template = readFileSync(templateUrl, 'utf8'); // Missing feature fails before creating resources.
  const image = process.env.SYNKRO_TEST_NGINX_IMAGE || 'nginx:1.27-alpine';
  const run = 'synkro-edge-test-' + randomUUID();
  const folder = mkdtempSync(join(tmpdir(), 'synkro-edge-'));
  const config = join(folder, 'nginx.conf');
  const retained = join(folder, 'retained');
  mkdirSync(join(retained, 'assets'), {recursive:true});
  writeFileSync(join(retained, 'assets', 'prior-12345678.js'), 'old-public-asset');
  const names = [];
  const docker = (...args) => execFileSync('docker', args, {encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']}).trim();
  let network;
  let edge;
  const render = color => template.replaceAll('__ACTIVE_HOST__', run + '-' + color + ':80')
    .replaceAll('__ACTIVE_GATEWAY__', run + '-' + color + ':8000').replaceAll('__SLOT__', color);
  try {
    network = docker('network','create','--label','io.synkro.edge.test='+run,run);
    for (const color of ['blue','green']) {
      const file = join(folder,color+'.conf');
      writeFileSync(file, 'events{} http{server{listen80; location/ {return200"'+color+'";}} server{listen8000; location/ {return200"'+color+'";}}}'.replaceAll('listen80','listen 80').replaceAll('listen8000','listen 8000').replaceAll('location/','location /').replaceAll('return200','return 200 '));
      const name=run+'-'+color;
      names.push(docker('run','-d','--name',name,'--network',run,'--label','io.synkro.edge.test='+run,
        '--mount','type=bind,source='+file+',target=/tmp/test.conf,readonly','--entrypoint','nginx',image,'-g','daemon off;','-c','/tmp/test.conf'));
    }
    writeFileSync(config, render('blue'));
    edge=docker('run','-d','--name',run+'-edge','--network',run,'--label','io.synkro.edge.test='+run,
      '-p','127.0.0.1::5173','-p','127.0.0.1::8000','--mount','type=bind,source='+folder+',target=/etc/synkro-edge,readonly',
      '--mount','type=bind,source='+retained+',target=/srv/retained,readonly','--entrypoint','nginx',image,'-g','daemon off;','-c','/etc/synkro-edge/nginx.conf');
    names.push(edge);
    const web='http://'+docker('port',edge,'5173/tcp');
    const api='http://'+docker('port',edge,'8000/tcp');
    const wait=async()=>{for(let n=0;n<100;n++){try{if((await fetch(api+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('entry readiness');};
    await wait();
    assert.equal(await (await fetch(web+'/')).text(),'blue');
    const observations=[];
    let polling=true;
    const poll=(async()=>{while(polling){try { const response=await fetch(api+'/health');observations.push({status:response.status,body:await response.text()});}catch{observations.push({status:0});}await new Promise(r=>setTimeout(r,10));}})();
    try {
      for(const color of ['green','blue']) {
        writeFileSync(config,render(color));
        docker('exec',edge,'nginx','-t','-c','/etc/synkro-edge/nginx.conf');
        docker('exec',edge,'nginx','-s','reload','-c','/etc/synkro-edge/nginx.conf');
        for(let n=0;n<100;n++){if(await (await fetch(api+'/health')).text()===color)break;await new Promise(r=>setTimeout(r,20));if(n===99)throw Error('switch not observed');}
      }
    } finally {polling=false;await poll;}
    assert.ok(observations.some(row=>row.body==='blue'));
    assert.ok(observations.some(row=>row.body==='green'));
    assert.ok(observations.every(row=>row.status===200),'no request failures during switch/rollback');
    // Active upstream returns 404 for every hash, so the entry must serve the prior public file.
    const previousConfig=readFileSync(join(folder,'blue.conf'),'utf8');
    writeFileSync(join(folder,'blue.conf'),previousConfig.replaceAll('location / {','location /assets/ {return 404;} location / {'));
    docker('exec',run+'-blue','nginx','-s','reload','-c','/tmp/test.conf');
    const prior=await fetch(web+'/assets/prior-12345678.js');
    assert.equal(prior.status,200);assert.equal(await prior.text(),'old-public-asset');
    assert.equal((await fetch(web+'/assets/missing-12345678.js')).status,404);
    assert.equal((await fetch(web+'/assets/prior-12345678.js',{method:'POST'})).status,403);
    writeFileSync(config,'invalid nginx configuration');
    assert.notEqual(spawnSync('docker',['exec',edge,'nginx','-t','-c','/etc/synkro-edge/nginx.conf']).status,0);
    assert.equal((await fetch(api+'/health')).status,200,'invalid candidate config cannot interrupt existing workers');
  } finally {
    for(const id of names.reverse()){
      const item=JSON.parse(docker('inspect',id))[0];
      assert.equal(item.Config.Labels['io.synkro.edge.test'],run);
      docker('rm','-f',id);
    }
    if(network){const item=JSON.parse(docker('network','inspect',network))[0];assert.equal(item.Labels['io.synkro.edge.test'],run);assert.equal(Object.keys(item.Containers).length,0);docker('network','rm',network);}
  }
});
