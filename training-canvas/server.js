'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const mcpBridge = require('./mcp');

const PORT = Number(process.env.PORT) || 8080;
const PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const INTEGRATION_TOKEN = process.env.INTEGRATION_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
if (!PASSWORD || !SESSION_SECRET || !DATABASE_URL) {
  console.error('Required: APP_PASSWORD, SESSION_SECRET, DATABASE_URL. Refusing to start without authenticated, persistent storage.');
  process.exit(1);
}
if (SESSION_SECRET.length < 32 || PASSWORD.length < 12) {
  console.error('SESSION_SECRET must be at least 32 characters, APP_PASSWORD at least 12.');
  process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL, max: 5, connectionTimeoutMillis: 10000 });
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const loginPage = fs.readFileSync(path.join(__dirname, 'login.html'));
const cookieName = 'coach_journal_session';
const day = 86400;
const loginAttempts = new Map();

async function setup() {
  await pool.query("CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("INSERT INTO workspaces (id,name,payload) VALUES ('business','Business workspace','{}'::jsonb) ON CONFLICT (id) DO NOTHING");
}
function hmac(input) { return crypto.createHmac('sha256', SESSION_SECRET).update(input).digest('hex'); }
function equal(a,b) {
  const x=Buffer.from(String(a)); const y=Buffer.from(String(b));
  return x.length===y.length && crypto.timingSafeEqual(x,y);
}
function signSession() {
  const exp = Date.now()+7*day*1000;
  const payload=String(exp);
  return payload+'.'+hmac(payload);
}
function authorized(req) {
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  if (INTEGRATION_TOKEN.length >= 32 && equal(bearer,INTEGRATION_TOKEN)) return true;
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='));
  if (!cookie) return false;
  const token=cookie.slice(cookieName.length+1);
  const [timestamp,signature]=token.split('.');
  return !!timestamp && !!signature && Number(timestamp)>Date.now() && equal(signature,hmac(timestamp));
}
function send(res,status,payload,headers={}) {
  const data=JSON.stringify(payload);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});
  res.end(data);
}
function serve(res,contents,type) {
  res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
  res.end(contents);
}
async function jsonBody(req) {
  let buf='';
  for await (const chunk of req) {
    buf+=chunk.toString('utf8');
    if(buf.length>1500000) {const e=new Error('Request too large');e.status=413;throw e;}
  }
  try{return JSON.parse(buf||'{}')}catch(_){const e=new Error('Invalid JSON');e.status=400;throw e;}
}
function validId(s){return typeof s==='string' && /^[a-zA-Z0-9_-]{1,90}$/.test(s);}
function normalizeCanvas(x) {
  if (!x || typeof x!=='object' || !Array.isArray(x.cards) || !Array.isArray(x.edges)) return null;
  if(x.cards.length>1500||x.edges.length>3000) return null;
  const cards=[];
  for(const c of x.cards) {
    if (!c || !validId(c.id) || !Number.isFinite(c.x) || !Number.isFinite(c.y) || typeof c.note!=='string' || c.note.length>15000) return null;
    cards.push({id:c.id,x:c.x,y:c.y,title:String(c.title||'').slice(0,120),type:['training','goal','habit','milestone'].includes(c.type)?c.type:'training',date:String(c.date||'').slice(0,40),note:c.note});
  }
  const cardIds=new Set(cards.map(c=>c.id));
  const edges=x.edges.filter(e=>Array.isArray(e)&&e.length===2&&cardIds.has(e[0])&&cardIds.has(e[1]));
  return {cards,edges,panX:Number.isFinite(x.panX)?x.panX:100,panY:Number.isFinite(x.panY)?x.panY:85,scale:Number.isFinite(x.scale)?Math.max(.3,Math.min(2.5,x.scale)):1};
}
async function handler(req,res) {
  const pathname=new URL(req.url||'/', 'http://localhost').pathname;
  if (mcpBridge.handles(pathname)) return mcpBridge.handle(req,res,pool,authorized);
  if(pathname==='/health')return send(res,200,{ok:true});
  if(pathname==='/login' && req.method==='GET') return serve(res,loginPage,'text/html; charset=utf-8');
  if(pathname==='/api/login' && req.method==='POST') {
    const ip=(req.socket.remoteAddress||'unknown'),now=Date.now(), attempt=loginAttempts.get(ip)||{count:0,since:now};
    if(now-attempt.since>15*60*1000){attempt.count=0;attempt.since=now;}
    if(attempt.count>=12)return send(res,429,{error:'Too many attempts; retry later'});
    const body=await jsonBody(req);
    if(typeof body.password!=='string'||!equal(body.password,PASSWORD)){
      attempt.count++;loginAttempts.set(ip,attempt);return send(res,401,{error:'Incorrect password'});
    }
    loginAttempts.delete(ip);
    const cookie=cookieName+'='+signSession()+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+7*day+(isProduction?'; Secure':'');
    return send(res,200,{ok:true},{'set-cookie':cookie});
  }
  if(pathname==='/api/logout' && req.method==='POST')
    return send(res,200,{ok:true},{'set-cookie':cookieName+'=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(isProduction?'; Secure':'')});
  if (!authorized(req)){
    if(pathname==='/'||pathname==='/index.html'){res.writeHead(302,{location:'/login','cache-control':'no-store'});return res.end();}
    return send(res,401,{error:'Authentication required'});
  }
  if((pathname==='/'||pathname==='/index.html')&&req.method==='GET') return serve(res,html,'text/html; charset=utf-8');
  if(pathname==='/api/workspaces'&&req.method==='GET'){
    const result=await pool.query('SELECT id,name,updated_at FROM workspaces ORDER BY updated_at DESC');
    return send(res,200,{items:result.rows});
  }
  if(pathname==='/api/workspaces'&&req.method==='POST'){
    const body=await jsonBody(req);
    if(!validId(body.id)||typeof body.name!=='string'||!body.name.trim()||body.name.length>100)return send(res,400,{error:'Invalid workspace'});
    await pool.query('INSERT INTO workspaces(id,name,payload) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',[body.id,body.name.trim(),JSON.stringify({cards:[],edges:[],panX:100,panY:85,scale:1})]);
    return send(res,201,{ok:true});
  }
  const m=pathname.match(/^\/api\/workspaces\/([a-zA-Z0-9_-]{1,90})$/);
  if(m&&req.method==='GET'){
    const result=await pool.query('SELECT id,name,payload,updated_at FROM workspaces WHERE id=$1',[m[1]]);
    return result.rows.length?send(res,200,result.rows[0]):send(res,404,{error:'Workspace not found'});
  }
  if(m&&req.method==='PUT'){
    const body=await jsonBody(req),canvas=normalizeCanvas(body);
    if(!canvas)return send(res,400,{error:'Invalid canvas'});
    const result=await pool.query('UPDATE workspaces SET payload=$2::jsonb,updated_at=NOW() WHERE id=$1 RETURNING id,updated_at',[m[1],JSON.stringify(canvas)]);
    return result.rows.length?send(res,200,result.rows[0]):send(res,404,{error:'Workspace not found'});
  }
  // Integration endpoint adds one free-form card without replacing existing sessions.
  const add=pathname.match(/^\/api\/workspaces\/([a-zA-Z0-9_-]{1,90})\/cards$/);
  if(add&&req.method==='POST'){
    const b=await jsonBody(req),note=String(b.note||'');
    if(!note.trim()||note.length>15000)return send(res,400,{error:'Note required (max 15000 characters)'});
    const card={id:crypto.randomUUID(),title:String(b.title||'Training note').slice(0,120),note,date:String(b.date||'').slice(0,40),type:['training','goal','habit','milestone'].includes(b.type)?b.type:'training',x:Number.isFinite(b.x)?b.x:100,y:Number.isFinite(b.y)?b.y:100};
    const conn=await pool.connect();
    try{
      await conn.query('BEGIN');
      const r=await conn.query('SELECT payload FROM workspaces WHERE id=$1 FOR UPDATE',[add[1]]);
      if(!r.rows.length){await conn.query('ROLLBACK');return send(res,404,{error:'Workspace not found'});}
      const canvas=normalizeCanvas(r.rows[0].payload)||{cards:[],edges:[],panX:100,panY:85,scale:1};
      if(canvas.cards.length>=1500){await conn.query('ROLLBACK');return send(res,400,{error:'Too many cards'});}
      canvas.cards.push(card);
      await conn.query('UPDATE workspaces SET payload=$2::jsonb,updated_at=NOW() WHERE id=$1',[add[1],JSON.stringify(canvas)]);
      await conn.query('COMMIT');
      return send(res,201,{card});
    }catch(e){await conn.query('ROLLBACK');throw e;}finally{conn.release();}
  }
  return send(res,404,{error:'Not found'});
}
// One-time, reversible cleanup of legacy exercise-per-card entries.
// Preserve the original payload in the database before rewriting any workspace.
async function consolidateLegacyWorkoutCards(){
 await pool.query("CREATE TABLE IF NOT EXISTS coach_journal_migration_backups (workspace_id TEXT NOT NULL, migration_key TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY(workspace_id,migration_key))");
 const rows=await pool.query("SELECT id,payload FROM workspaces");
 for(const row of rows.rows){
  const canvas=row.payload;
  if(!canvas||!Array.isArray(canvas.cards))continue;
  const groups=new Map();
  for(const c of canvas.cards){
   if(c.type!=='training'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(c.date||'')||/^(History|Objectives)$/i.test((c.title||'').trim()))continue;
   if(!groups.has(c.date))groups.set(c.date,[]);
   groups.get(c.date).push(c);
  }
  let changed=false;
  const next=JSON.parse(JSON.stringify(canvas));
  for(const [date,items] of groups){
   // Only migrate clear legacy exercise-per-card sessions, not distinct workouts.
   const legacy=items.length>=4&&items.some(c=>/^Planned session/i.test(c.title||''))&&items.some(c=>/^(Completed|Correction|In progress|Session adjustment)/i.test(c.title||''));
   if(!legacy)continue;
   const ids=new Set(items.map(c=>c.id));
   const ordered=next.cards.filter(c=>ids.has(c.id));
   const primary=ordered[0];
   primary.title='Workout — '+date;
   primary.note=ordered.map(c=>'### '+c.title+'\\n'+c.note).join('\\n\\n');
   const goal=next.cards.find(c=>/^(Objectives|Goals)$/i.test((c.title||'').trim()));
   if(goal){primary.x=goal.x+365;primary.y=goal.y;}
   next.cards=next.cards.filter(c=>!ids.has(c.id)||c.id===primary.id);
   next.edges=(next.edges||[]).filter(e=>next.cards.some(c=>c.id===e[0])&&next.cards.some(c=>c.id===e[1]));
   changed=true;
  }
  if(!changed)continue;
  const conn=await pool.connect();
  try{
   await conn.query('BEGIN');
   const locked=await conn.query('SELECT payload FROM workspaces WHERE id=$1 FOR UPDATE',[row.id]);
   if(!locked.rows.length||JSON.stringify(locked.rows[0].payload)!==JSON.stringify(canvas)){await conn.query('ROLLBACK');continue;}
   await conn.query("INSERT INTO coach_journal_migration_backups(workspace_id,migration_key,payload) VALUES($1,'legacy-workout-cards-v1',$2::jsonb) ON CONFLICT DO NOTHING",[row.id,JSON.stringify(canvas)]);
   await conn.query('UPDATE workspaces SET payload=$2::jsonb,updated_at=NOW() WHERE id=$1',[row.id,JSON.stringify(next)]);
   await conn.query('COMMIT');
   console.log('Consolidated legacy workout notes in workspace '+row.id);
  }catch(e){await conn.query('ROLLBACK');throw e;}finally{conn.release();}
 }
}
Promise.all([setup().then(consolidateLegacyWorkoutCards),mcpBridge.init(pool)]).then(()=>{
  http.createServer((req,res)=>handler(req,res).catch(err=>{
    console.error('Request failed',err.message);
    if(!res.headersSent)send(res,err.status||500,{error:err.status?err.message:'Server error'});
  })).listen(PORT,'0.0.0.0',()=>console.log('Coach Journal online on '+PORT));
}).catch(err=>{console.error('Database setup failed',err.message);process.exit(1);});
