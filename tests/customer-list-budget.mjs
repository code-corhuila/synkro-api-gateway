import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'..'),prefix='list-budget-'+randomUUID(),network=prefix;
const upstream=prefix+'-upstream',gateway=prefix+'-gateway',image=process.env.GATEWAY_TEST_IMAGE??prefix+':candidate';
const owned=[];let built=false,networkCreated=false,base,upstreamBase;
function docker(...args){
    const r=spawnSync('docker',args,{encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024});
    if(r.status!==0||r.error)throw Error(`Docker ${args[0]} failed; no request or credential logs are emitted`);
    return r.stdout.trim();
}
async function wait(probe){const end=Date.now()+60000;while(Date.now()<end){try{if(await probe())return;}catch{}await new Promise(r=>setTimeout(r,200));}throw Error('Bounded fixture readiness expired');}
async function call(path,options={}){return fetch(base+path,{...options,headers:{Authorization:'Bearer synthetic-test-token',...options.headers},signal:AbortSignal.timeout(15000)});}
function port(name){return 'http://127.0.0.1:'+JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['8080/tcp'][0].HostPort;}
async function startGateway(){
    docker('run','-d','--name',gateway,'--label','synkro.execution='+prefix,'--network',network,'-p','127.0.0.1::8000',
        '-e','CORS_ALLOWED_ORIGINS=http://localhost:5173','-e','RATE_LIMIT_PER_SECOND=1000',
        '-e','CUSTOMERS_LIST_RATE_PER_MINUTE=3','-e','CUSTOMERS_LIST_BURST=2','-e','CUSTOMERS_LIST_MAX_CONCURRENT=2',image);
    if(!owned.includes(gateway))owned.push(gateway);
    base='http://127.0.0.1:'+JSON.parse(docker('inspect',gateway))[0].NetworkSettings.Ports['8000/tcp'][0].HostPort;
    await wait(async()=> (await call('/health')).status===200);
    docker('exec',gateway,'nginx','-t');
}
async function fresh(){docker('rm','-f',gateway);await startGateway();}
try{
    docker('network','create','--label','synkro.execution='+prefix,network);networkCreated=true;
    if(!process.env.GATEWAY_TEST_IMAGE){docker('build','--label','synkro.execution='+prefix,'-t',image,'-f',resolve(root,'deploy/Dockerfile'),root);built=true;}
    docker('create','--name',upstream,'--label','synkro.execution='+prefix,'--network',network,'--network-alias','synkro-customers-api','-p','127.0.0.1::8080','node:22-bookworm-slim','node','/fixture.mjs');owned.push(upstream);
    docker('cp',resolve(root,'tests/fixtures/customer-list-upstream.mjs'),upstream+':/fixture.mjs');docker('start',upstream);upstreamBase=port(upstream);
    await wait(async()=> (await fetch(upstreamBase+'/health')).status===200);
    await startGateway();
    assert.equal((await fetch(base+'/api/v1/customers')).status,401);
    assert.equal((await call('/api/v1/customers',{method:'OPTIONS'})).status,204);
    for(let i=0;i<3;i++)assert.equal((await call('/api/v1/customers?page='+(i+1))).status,200,'Configured initial rate allowance must reach Customers');
    const excess=await call('/api/v1/customers');assert.equal(excess.status,429,'One request beyond the configured list allowance must be rejected');
    assert.equal(excess.headers.get('Retry-After'),'20');assert.equal((await excess.json()).error,'TOO_MANY_REQUESTS');
    assert.equal((await call('/api/v1/customers',{method:'HEAD'})).status,429,'HEAD must not bypass the listing quota');
    assert.equal((await call('/api/v1/customers/00000000-0000-4000-8000-000000000001')).status,200,'Read by id has a separate budget');
    assert.equal((await call('/api/v1/customers',{method:'POST',body:'{}'})).status,200,'Creation is not a list request');
    await fresh();
    const held=[call('/api/v1/customers?hold=1'),call('/api/v1/customers?hold=2')];
    await wait(async()=> (await (await fetch(upstreamBase+'/control/state')).json()).pending===2);
    try{
        const rejected=await call('/api/v1/customers?hold=3');assert.equal(rejected.status,429,'A third active list request must not reach upstream');
        assert.equal((await (await fetch(upstreamBase+'/control/state')).json()).pending,2);
        assert.equal((await call('/api/v1/customers/00000000-0000-4000-8000-000000000001')).status,200);
    }finally{await fetch(upstreamBase+'/control/release');await Promise.all(held);}
    await fresh();const start=Date.now();
    assert.equal((await call('/api/v1/customers?timeout=1')).status,503);
    assert.ok(Date.now()-start<6000,'Listing read timeout must be bounded independently');
    console.log('Customer list budget: PASS (3 admitted + 1 rejected/Retry-After=20; max active=2; read-by-id and POST unaffected; read timeout bounded)');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{
    for(const name of owned.reverse()){
        try{
            const result=spawnSync('docker',['inspect',name],{encoding:'utf8',timeout:20000});
            if(result.status!==0){assert.match(result.stderr,/No such/i);continue;}
            const details=JSON.parse(result.stdout)[0];assert.equal(details.Config.Labels['synkro.execution'],prefix);
            docker('rm','-f',name);
        }catch{console.error('Owned container cleanup failed; other owned resources will still be checked');process.exitCode=1;}
    }
    if(networkCreated)docker('network','rm',network);
    if(built)docker('image','rm',image);
}
