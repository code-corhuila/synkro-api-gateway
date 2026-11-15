"""Real Gateway/Workflow/Customers/PostgreSQL; Products and Sales are controlled protocol participants.

Only disposable resources labelled by this execution are used. The test-only RLS
policy pauses listing SQL while leaving the real workflow's UUID lookup free.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import base64, json, os, secrets, shutil, subprocess, tempfile, time, urllib.request, urllib.error, uuid

ROOT=Path(__file__).resolve().parents[1]
CUSTOMERS=Path(os.environ['CUSTOMERS_API_REPO']).resolve()
WORKFLOW=Path(os.environ['WORKFLOW_REPO']).resolve()
PINS={'customers':'cbd67c302c9649e417eaa69934a9741f3453c679','workflow':'9c604f5948f27db6c43b5fca721d455651a81008'}
OWNER='list-saga-'+uuid.uuid4().hex
containers=[];images=[];network_created=False;lock_process=None
def command(args,data=None,timeout=600,check=True):
    r=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
    if check and r.returncode:
        message=(r.stderr.decode(errors='replace').splitlines() or ['no diagnostic'])[0][:200]
        for name in ['password','app_password','admin','human','service']:
            value=globals().get(name)
            if isinstance(value,str):message=message.replace(value,'[REDACTED]')
        raise RuntimeError('Fixture command failed: '+args[0]+' '+args[1]+': '+message)
    return r
def docker(*args,data=None,timeout=600):return command(['docker',*map(str,args)],data,timeout).stdout.decode().strip()
def wait(probe,seconds=60):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        try:
            if probe():return
        except Exception:pass
        time.sleep(.05)
    raise AssertionError('Bounded fixture condition did not become ready')
def build(suffix,source):
    image=OWNER+'-'+suffix;images.append(image)
    docker('build','--label','synkro.execution='+OWNER,'-q','-t',image,'-f',source/'deploy/Dockerfile',source,timeout=1200)
    return image
def create(suffix,image,args=(),cmd=()):
    name=OWNER+'-'+suffix
    docker('create','--name',name,'--label','synkro.execution='+OWNER,'--network',OWNER,*args,image,*cmd)
    containers.append(name);return name
def start(name):docker('start',name)
def port(name,number):
    data=json.loads(docker('inspect',name))[0]
    return 'http://127.0.0.1:'+data['NetworkSettings']['Ports'][str(number)+'/tcp'][0]['HostPort']
def request(base,path,credential,method='GET',body=None,key=None):
    headers={'Content-Type':'application/json','X-Correlation-Id':OWNER}
    if credential:headers['Authorization']='Bearer '+credential
    if key:headers['Idempotency-Key']=key
    req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    try:response=urllib.request.urlopen(req,timeout=15)
    except urllib.error.HTTPError as error:response=error
    with response:return response.status,dict(response.headers),json.loads(response.read())
def check(value,message):
    if not value:raise AssertionError(message)

with tempfile.TemporaryDirectory(prefix=OWNER) as temporary:
    folder=Path(temporary)
    def env(name,values):
        path=folder/name;path.write_text(''.join(k+'='+v+'\n' for k,v in values.items()),encoding='utf8');os.chmod(path,0o600);return path
    openssl=shutil.which('openssl') or 'C:/Program Files/Git/usr/bin/openssl.exe'
    private=folder/'private.pem';public=folder/'public.pem'
    command([openssl,'genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',str(private)])
    command([openssl,'pkey','-in',str(private),'-pubout','-out',str(public)])
    def token(subject,roles,permissions):
        encode=lambda v:base64.urlsafe_b64encode(v).rstrip(b'=')
        now=int(time.time());claims={'sub':subject,'roles':roles,'permissions':permissions,'iat':now-1,'exp':now+3600,'jti':str(uuid.uuid4())}
        raw=encode(b'{"alg":"RS256"}')+b'.'+encode(json.dumps(claims).encode())
        sig=command([openssl,'dgst','-sha256','-sign',str(private)],data=raw).stdout
        return (raw+b'.'+encode(sig)).decode()
    admin=token(str(uuid.uuid4()),['ADMIN'],[])
    human=token(str(uuid.uuid4()),['SALESPERSON'],['sales:create'])
    service=token('synkro-workflow',['SERVICE'],['customers:read','stock:reserve','stock:release','sales:register'])
    password=secrets.token_hex(24);app_password=secrets.token_hex(24)
    (folder/'app-password').write_text(app_password);os.chmod(folder/'app-password',0o600)
    customer_id=str(uuid.uuid4());product_id=str(uuid.uuid4())
    try:
        for source,pin in [(CUSTOMERS,PINS['customers']),(WORKFLOW,PINS['workflow'])]:
            check(command(['git','-C',str(source),'rev-parse','HEAD']).stdout.decode().strip()==pin,'Dependency checkout does not match the immutable pin')
        docker('network','create','--label','synkro.execution='+OWNER,OWNER);network_created=True
        pg_env=env('pg.env',{'POSTGRES_DB':'synkro','POSTGRES_PASSWORD':password})
        pg=create('pg','postgres:16.6-alpine',['--network-alias','db','--env-file',pg_env,'--tmpfs','/var/lib/postgresql/data']);start(pg)
        wait(lambda:command(['docker','exec',pg,'pg_isready','-h','127.0.0.1','-U','postgres','-d','synkro'],check=False).returncode==0)
        def sql(query):return docker('exec','-i',pg,'psql','-X','-U','postgres','-d','synkro','-qAt','-v','ON_ERROR_STOP=1',data=query.encode())
        sql("REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE ROLE customers_app LOGIN PASSWORD '"+app_password+"'; CREATE ROLE workflow_app LOGIN PASSWORD '"+app_password+"'")
        migration_env=env('migrate.env',{'FLYWAY_URL':'jdbc:postgresql://db:5432/synkro','FLYWAY_USER':'postgres','FLYWAY_PASSWORD':password})
        for suffix,source,image,cmd,args in [
            ('customers-migrate',CUSTOMERS/'tests/fixtures/customers-db','flyway/flyway:10.20.1',['/workspace/scripts/migrate.sh','migrate'],['--entrypoint','/bin/sh']),
            ('workflow-migrate',WORKFLOW/'db','flyway/flyway:11.20.3-alpine',['-workingDirectory=/workspace','-configFiles=flyway.toml','migrate'],[])]:
            runner=create(suffix,image,['--env-file',migration_env,*args],cmd)
            docker('cp',str(source)+'/.',runner+':/workspace');docker('start','-a',runner)
            check(json.loads(docker('inspect',runner))[0]['State']['ExitCode']==0,'Migration failed')
        # Existing Workflow fixtures provide only Products/Sales; Customers below is the real provider.
        (folder/'config.json').write_text(json.dumps({'human':human,'service':service,'customer':customer_id,'product':product_id}))
        fixture=create('participants','python:3.13.7-alpine3.22',['--network-alias','participants','-w','/fixtures'],['python','/fixtures/participants.py'])
        docker('cp',WORKFLOW/'tests/controlled_participants.py',fixture+':/fixtures/participants.py')
        docker('cp',folder/'config.json',fixture+':/fixtures/config.json');start(fixture)
        customers_image=build('customers',CUSTOMERS)
        customer_env=env('customers.env',{'SPRING_DATASOURCE_URL':'jdbc:postgresql://db:5432/synkro','SPRING_DATASOURCE_USERNAME':'customers_app','SPRING_DATASOURCE_PASSWORD':app_password,'JWT_PUBLIC_KEY_FILE':'/run/public.pem'})
        customers=create('customers',customers_image,['--network-alias','synkro-customers-api','--env-file',customer_env,'-p','127.0.0.1::8080'])
        docker('cp',public,customers+':/run/public.pem');start(customers);customers_base=port(customers,8080)
        wait(lambda:request(customers_base,'/health',None)[0]==200)
        status,_,body=request(customers_base,'/api/v1/customers',admin,'POST',{'name':'Budget synthetic','identityDocument':uuid.uuid4().hex[:25],'email':'budget@example.test','phone':'3001234567','address':'Synthetic street'},str(uuid.uuid4()))
        check(status==201,'Synthetic customer creation failed');customer_id=body['customerId']
        workflow_image=build('workflow',WORKFLOW)
        workflow_env=env('workflow.env',{'WORKFLOW_DATABASE_URL':'jdbc:postgresql://db:5432/synkro','WORKFLOW_APP_PASSWORD_FILE':'/run/app-password','JWT_PUBLIC_KEY_FILE':'/run/public.pem','SERVICE_TOKEN':service,'PRODUCTS_BASE_URL':'http://participants:8080','SALES_BASE_URL':'http://participants:8080'})
        workflow=create('workflow',workflow_image,['--network-alias','synkro-workflow','--env-file',workflow_env,'-p','127.0.0.1::8080'])
        docker('cp',public,workflow+':/run/public.pem');docker('cp',folder/'app-password',workflow+':/run/app-password')
        # Keep the host file private; grant only the container's runtime user access to its copied secret.
        # Preserve the runtime uid when copying an archive, without weakening the host file mode.
        runtime_uid=int(docker('run','--rm','--label','synkro.execution='+OWNER,'--entrypoint','id',workflow_image,'-u'))
        runtime_gid=int(docker('run','--rm','--label','synkro.execution='+OWNER,'--entrypoint','id',workflow_image,'-g'))
        import io,tarfile
        archive=io.BytesIO()
        with tarfile.open(fileobj=archive,mode='w') as tar:
            data=app_password.encode();entry=tarfile.TarInfo('app-password');entry.size=len(data);entry.mode=0o400;entry.uid=runtime_uid;entry.gid=runtime_gid;tar.addfile(entry,io.BytesIO(data))
        docker('cp','-a','-',workflow+':/run',data=archive.getvalue());start(workflow)
        workflow_base=port(workflow,8080);wait(lambda:request(workflow_base,'/health',None)[0]==200)
        gateway_image=build('gateway',ROOT)
        gateway=create('gateway',gateway_image,['-e','CORS_ALLOWED_ORIGINS=http://localhost:5173','-e','RATE_LIMIT_PER_SECOND=1000','-p','127.0.0.1::8000']);start(gateway)
        gateway_base=port(gateway,8000);wait(lambda:request(gateway_base,'/health',None)[0]==200)
        sql("CREATE FUNCTION customers_schema.test_listing_pause() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(281282283); RETURN true; END $$; ALTER TABLE customers_schema.customer ENABLE ROW LEVEL SECURITY; CREATE POLICY test_listing_pause ON customers_schema.customer FOR SELECT TO customers_app USING (CASE WHEN current_query() ILIKE '%ORDER BY registration_date%' THEN customers_schema.test_listing_pause() ELSE true END)")
        lock_process=subprocess.Popen(['docker','exec','-i',pg,'psql','-X','-U','postgres','-d','synkro','-qAt'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        lock_process.stdin.write(b'SELECT pg_advisory_lock(281282283);\n');lock_process.stdin.flush()
        wait(lambda:sql("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=281282283 AND granted AND mode='ExclusiveLock'")=='1')
        with ThreadPoolExecutor(max_workers=2) as executor:
            held=[executor.submit(request,gateway_base,'/api/v1/customers',admin) for _ in range(2)]
            try:
                waiting=lambda:int(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='synkro-customers-api' AND wait_event_type='Lock' AND query ILIKE '%ORDER BY registration_date%'"))
                wait(lambda:waiting()==2,5)
                status,headers,_=request(gateway_base,'/api/v1/customers',admin)
                check(status==429 and int(headers.get('Retry-After','0'))>=1,'Excess list request must return 429 with Retry-After')
                status,_,saga=request(gateway_base,'/api/v1/sagas/register-sale',human,'POST',{'customerId':customer_id,'lines':[{'productId':product_id,'quantity':1}]},str(uuid.uuid4()))
                check(status==201,'Real Workflow must accept the saga during the list burst')
                end=time.monotonic()+1.5
                while saga['status']!='COMPLETED' and time.monotonic()<end:
                    time.sleep(.02);_,_,saga=request(gateway_base,'/api/v1/sagas/'+saga['sagaId'],human)
                check(saga['status']=='COMPLETED','Real saga must complete while listing SQL is held')
                check('validate-customer' in saga['completedSteps'],'Real validate-customer step must complete')
                check(waiting()==2,'Both listing SQL operations must remain blocked when the saga completes')
            finally:
                lock_process.stdin.close();lock_process.wait(timeout=10);lock_process=None
            check(all(f.result()[0]==200 for f in held),'Admitted listing work must recover after release')
        check(request(gateway_base,'/api/v1/customers/'+customer_id,service)[0]==200,'Workflow point reads must remain available after load')
        print('PASS: real Gateway/Workflow/Customers/PostgreSQL saga completed with two listing SQL operations held and excess listing rejected with 429; recovery passed. Products/Sales were controlled protocol participants.',flush=True)
    finally:
        if lock_process is not None:
            lock_process.stdin.close();lock_process.wait(timeout=10)
        cleanup_failed=False
        for name in reversed(containers):
            try:
                item=json.loads(docker('inspect',name))[0]
                check(item['Config']['Labels']['synkro.execution']==OWNER,'Unowned cleanup refused')
                docker('rm','-f','-v',name)
            except Exception:cleanup_failed=True
        if network_created:docker('network','rm',OWNER)
        for image in reversed(images):
            info=command(['docker','image','inspect',image],check=False)
            if info.returncode==0:
                check(json.loads(info.stdout)[0]['Config']['Labels']['synkro.execution']==OWNER,'Unowned image cleanup refused');docker('image','rm',image)
        check(not cleanup_failed,'Owned fixture cleanup failed')
