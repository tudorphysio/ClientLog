import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import app from './app.js';
const user=process.env.APP_USERNAME, password=process.env.APP_PASSWORD;
if (!user || !password) throw new Error('Set APP_USERNAME and APP_PASSWORD before starting.');
if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) throw new Error('Attach a Railway volume at /data before starting so records persist.');
const dir=process.env.DATA_DIR||process.env.RAILWAY_VOLUME_MOUNT_PATH||'./data';
mkdirSync(dir,{recursive:true});
const sqlite=new DatabaseSync(join(dir,'training-canvas.sqlite'));
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);');
const DB={prepare(sql){const statement=sqlite.prepare(sql);let args=[];return {bind(...values){args=values;return this},async run(){return statement.run(...args)},async all(){return {results:statement.all(...args)}}}}};
const expected=Buffer.from('Basic '+Buffer.from(user+':'+password).toString('base64'));
const server=http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
  const auth=Buffer.from(req.headers.authorization||'');
  if(auth.length!==expected.length||!timingSafeEqual(auth,expected)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Training Canvas", charset="UTF-8"','Cache-Control':'no-store'});res.end('Sign in to Training Canvas');return;}
  try{
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>1100000){res.writeHead(413);res.end('Record too large');return;}chunks.push(chunk);}
    const proto=req.headers['x-forwarded-proto']==='https'?'https':'http';
    const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
    const request=new Request(proto+'://'+req.headers.host+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
    const response=await app.fetch(request,{DB});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){console.error('Request failed',error);res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"Request failed"}');}
});
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Training Canvas is ready'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{sqlite.close();process.exit(0)}));
