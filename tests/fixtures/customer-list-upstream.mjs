import {createServer} from 'node:http';
let pending=[],started=0;
const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(url.pathname==='/control/release') {for(const held of pending)reply(held,200,{data:[]});pending=[];return reply(res,200,{});}
    if(url.pathname==='/control/state')return reply(res,200,{started,pending:pending.length});
    if(url.pathname==='/health')return reply(res,200,{status:'ok'});
    if(req.method==='GET'&&url.pathname==='/api/v1/customers'){
        started++;
        if(url.searchParams.has('hold')){pending.push(res);return;}
        if(url.searchParams.has('timeout')){setTimeout(()=>reply(res,200,{data:[]}),10000);return;}
        return reply(res,200,{data:[]});
    }
    return reply(res,200,{customerId:'00000000-0000-4000-8000-000000000001',active:true});
}).listen(8080,'0.0.0.0');
