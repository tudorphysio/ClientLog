'use strict';
// Single-owner MCP bridge with OAuth 2.1 authorization-code + PKCE.
// No client records, tokens, or secrets are hard-coded or sent to GitHub.
const crypto=require('node:crypto');
const { URL, URLSearchParams }=require('node:url');
const BASE='https://clientlog-production-8c3920e3.up.railway.app';
const b64=s=>Buffer.from(s).toString('base64url');
const rand=()=>crypto.randomBytes(32).toString('base64url');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const safeEqual=(a,b)=>{const x=Buffer.from(String(a));const y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
function json(res,code,obj,extra={}){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra});res.end(JSON.stringify(obj))}
function text(res,code,body){res.writeHead(code,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(body)}
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>200000)throw Error('Request too large')}return (req.headers['content-type']||'').includes('application/json')?JSON.parse(s||'{}'):Object.fromEntries(new URLSearchParams(s))}
const metadata={
 issuer:BASE,
 authorization_endpoint:BASE+'/oauth/authorize',
 token_endpoint:BASE+'/oauth/token',
 registration_endpoint:BASE+'/oauth/register',
 response_types_supported:['code'],
 grant_types_supported:['authorization_code','refresh_token'],
 code_challenge_methods_supported:['S256'],
 token_endpoint_auth_methods_supported:['none'],
 scopes_supported:['journal:read','journal:write']
};
async function init(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, redirect_uris JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())");
 await pool.query("CREATE TABLE IF NOT EXISTS oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, scope TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)");
 await pool.query("CREATE TABLE IF NOT EXISTS oauth_tokens (token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)");
 await pool.query("CREATE INDEX IF NOT EXISTS oauth_tokens_expiry_idx ON oauth_tokens (expires_at)");
}
function validateRedirect(s){
 try{const u=new URL(s);
   if(u.protocol!=='https:')return false;
   const h=u.hostname.toLowerCase();
   return h==='chatgpt.com'||h.endsWith('.chatgpt.com')||h==='openai.com'||h.endsWith('.openai.com');
 }catch(_){return false}
}
function oauthError(res,code,error,description){return json(res,code,{error,error_description:description||error},{'access-control-allow-origin':'*'})}
function authProblem(res){
 return json(res,401,{error:'unauthorized',error_description:'OAuth authorization required'},
 {'www-authenticate':'Bearer resource_metadata="'+BASE+'/.well-known/oauth-protected-resource/mcp"'});
}
async function bearerScope(pool,req,needed){
 const a=req.headers.authorization||'';
 if(!a.startsWith('Bearer '))return false;
 const token=a.slice(7);
 if(!token||token.length>300)return false;
 const r=await pool.query("SELECT scope FROM oauth_tokens WHERE token_hash=$1 AND kind='access' AND expires_at>NOW()",[hash(token)]);
 return Boolean(r.rows.length&&(needed==='journal:read'||r.rows[0].scope.includes('journal:write')));
}
function result(id,value){return {jsonrpc:'2.0',id,result:value}}
function rpcError(id,code,message){return {jsonrpc:'2.0',id,error:{code,message}}}
const toolSchemas=[
 {name:'list_training_profiles',description:'List client or personal training journal profiles from your private Coach Journal.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'read_training_profile',description:'Read all training cards and notes for a named profile ID. Use list_training_profiles first if the ID is unknown.',inputSchema:{type:'object',properties:{profile_id:{type:'string',description:'Exact profile id returned by list_training_profiles'}},required:['profile_id'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'create_training_profile',description:'Create a new profile/workspace in the private Coach Journal. Avoid duplicates by listing first.',inputSchema:{type:'object',properties:{profile_name:{type:'string',description:'Name to show in workspace selector'}},required:['profile_name'],additionalProperties:false},annotations:{destructiveHint:false}},
 {name:'add_training_card',description:'Append one dated, free-form training card to a profile without deleting existing journal cards. If necessary first create or locate the profile. Do not invent exercises, dates, loads or repetitions.',inputSchema:{type:'object',properties:{profile_id:{type:'string'},title:{type:'string'},date:{type:'string',description:'YYYY-MM-DD, or empty if unknown'},note:{type:'string',description:'Free-text session details'},type:{type:'string',enum:['training','goal','habit','milestone']}},required:['profile_id','title','note'],additionalProperties:false},annotations:{destructiveHint:false}},
 {name:'upsert_workout_session',description:'Create ONE Workout card per profile and date, or append exercise updates and corrections to that existing workout. Use for successive exercise reports in the same session; never create a separate card per exercise. Do not invent repetitions, loads, test results or completion.',inputSchema:{type:'object',properties:{profile_id:{type:'string'},date:{type:'string',description:'YYYY-MM-DD session date'},note:{type:'string',description:'New session details; appended to existing workout unless mode is replace'},title:{type:'string',description:'Optional workout title for newly created card'},mode:{type:'string',enum:['append','replace'],description:'append (default) or replace the complete workout note'}},required:['profile_id','date','note'],additionalProperties:false},annotations:{destructiveHint:false}},
 {name:'consolidate_training_cards',description:'Combine explicitly selected existing cards into ONE workout card using the supplied verified consolidated note. The listed cards are removed after merging, so only use when explicitly requested and after reading the profile. Do not include History, Objectives or unrelated workouts.',inputSchema:{type:'object',properties:{profile_id:{type:'string'},card_ids:{type:'array',items:{type:'string'},minItems:2},date:{type:'string'},title:{type:'string'},note:{type:'string'}},required:['profile_id','card_ids','date','title','note'],additionalProperties:false},annotations:{destructiveHint:true}}
];
const validId=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,90}$/.test(s);
async function callTool(pool,name,a){
 if(name==='list_training_profiles'){
  const r=await pool.query('SELECT id,name,updated_at FROM workspaces ORDER BY name ASC');return {profiles:r.rows};
 }
 if(name==='read_training_profile'){
  if(!validId(a.profile_id))throw Error('Invalid profile ID');
  const r=await pool.query('SELECT id,name,payload,updated_at FROM workspaces WHERE id=$1',[a.profile_id]);
  if(!r.rows.length)throw Error('Profile not found');
  return {profile:r.rows[0]};
 }
 if(name==='create_training_profile'){
  if(typeof a.profile_name!=='string'||!a.profile_name.trim()||a.profile_name.length>100)throw Error('Invalid profile name');
  const name=a.profile_name.trim();
  const match=await pool.query('SELECT id,name FROM workspaces WHERE LOWER(name)=LOWER($1)',[name]);
  if(match.rows.length)return {profile:match.rows[0],already_exists:true};
  const id='p_'+crypto.randomUUID().replaceAll('-','');
  const canvas={cards:[],edges:[],panX:100,panY:85,scale:1};
  const r=await pool.query('INSERT INTO workspaces(id,name,payload) VALUES($1,$2,$3::jsonb) RETURNING id,name',[id,name,JSON.stringify(canvas)]);
  return {profile:r.rows[0],created:true};
 }
 if(name==='upsert_workout_session'){
  if(!validId(a.profile_id)||typeof a.date!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(a.date))throw Error('Invalid profile or date');
  if(typeof a.note!=='string'||!a.note.trim()||a.note.length>14000)throw Error('Invalid workout note');
  const conn=await pool.connect();
  try{
   await conn.query('BEGIN');
   const r=await conn.query('SELECT payload FROM workspaces WHERE id=$1 FOR UPDATE',[a.profile_id]);
   if(!r.rows.length)throw Error('Profile not found');
   const canvas=r.rows[0].payload;
   if(!canvas||!Array.isArray(canvas.cards))throw Error('Invalid canvas');
   let card=canvas.cards.find(c=>c.type==='training'&&c.date===a.date&&/^Workout(?:\\s|\\s*[—–-])/i.test(c.title||''));
   let created=false;
   if(card){
    card.note=a.mode==='replace'?a.note:card.note.trimEnd()+'\\n'+a.note;
    if(card.note.length>15000)throw Error('Workout note too large; consolidate older details first');
   }else{
    if(canvas.cards.length>=1500)throw Error('Card limit reached');
    const last=canvas.cards[canvas.cards.length-1];
    let x=last?last.x+365:110,y=last?last.y:95;
    const height=c=>Math.min(680,225+Math.ceil((c.note||'').length/32)*24);
    for(let row=0;row<100;row++){const ty=y+row*320;if(!canvas.cards.some(c=>x<c.x+355&&x+355>c.x&&ty<c.y+height(c)+25&&ty+320>c.y)){y=ty;break;}}
    card={id:crypto.randomUUID(),title:String(a.title||'Workout — '+a.date).slice(0,120),note:a.note,date:a.date,type:'training',x,y};
    canvas.cards.push(card);created=true;
   }
   await conn.query('UPDATE workspaces SET payload=$2::jsonb,updated_at=NOW() WHERE id=$1',[a.profile_id,JSON.stringify(canvas)]);
   await conn.query('COMMIT');
   return {created,updated:!created,card,profile_id:a.profile_id};
  }catch(e){await conn.query('ROLLBACK');throw e}finally{conn.release()}
 }
 if(name==='consolidate_training_cards'){
  if(!validId(a.profile_id)||!Array.isArray(a.card_ids)||a.card_ids.length<2||new Set(a.card_ids).size!==a.card_ids.length)throw Error('Invalid card selection');
  if(typeof a.date!=='string'||!/^\\d{4}-\\d{2}-\\d{2}$/.test(a.date)||typeof a.note!=='string'||!a.note.trim()||a.note.length>15000||typeof a.title!=='string'||!a.title.trim())throw Error('Invalid session details');
  const conn=await pool.connect();
  try{
   await conn.query('BEGIN');
   const r=await conn.query('SELECT payload FROM workspaces WHERE id=$1 FOR UPDATE',[a.profile_id]);
   if(!r.rows.length)throw Error('Profile not found');
   const canvas=r.rows[0].payload;
   if(!canvas||!Array.isArray(canvas.cards))throw Error('Invalid canvas');
   const selected=a.card_ids.map(id=>canvas.cards.find(c=>c.id===id));
   if(selected.some(c=>!c||c.type!=='training'||c.date!==a.date||/^(History|Objectives)$/i.test(c.title||'')))throw Error('All selected cards must be dated training entries; History and Objectives are protected');
   const target=selected[0],discard=new Set(a.card_ids.slice(1));
   target.title=a.title.slice(0,120);target.note=a.note;
   canvas.cards=canvas.cards.filter(c=>!discard.has(c.id));
   canvas.edges=(canvas.edges||[]).filter(e=>!discard.has(e[0])&&!discard.has(e[1]));
   await conn.query('UPDATE workspaces SET payload=$2::jsonb,updated_at=NOW() WHERE id=$1',[a.profile_id,JSON.stringify(canvas)]);
   await conn.query('COMMIT');
   return {merged:true,card:target,removed_count:discard.size,profile_id:a.profile_id};
  }catch(e){await conn.query('ROLLBACK');throw e}finally{conn.release()}
 }
 if(name==='add_training_card'){
  if(!validId(a.profile_id))throw Error('Invalid profile ID');
  if(typeof a.note!=='string'||!a.note.trim()||a.note.length>15000)throw Error('Note is required (max 15000 characters)');
  const date=a.date||'';
  if(date&& !/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Date must be YYYY-MM-DD');
  const card={id:crypto.randomUUID(),title:String(a.title||'Training note').slice(0,120),note:a.note,date,type:['training','goal','habit','milestone'].includes(a.type)?a.type:'training',x:100,y:100};
  const conn=await pool.connect();
  try{
   await conn.query('BEGIN');
   const r=await conn.query('SELECT payload FROM workspaces WHERE id=$1 FOR UPDATE',[a.profile_id]);
   if(!r.rows.length){await conn.query('ROLLBACK');throw Error('Profile not found')}
   const canvas=r.rows[0].payload;
   if(!canvas||!Array.isArray(canvas.cards))throw Error('Invalid stored canvas');
   if(canvas.cards.length>=1500)throw Error('Card limit reached');
   const i=canvas.cards.length;
   card.x=110+(i%5)*365;card.y=95+Math.floor(i/5)*320;
   canvas.cards.push(card);
   await conn.query('UPDATE workspaces SET payload=$2::jsonb,updated_at=NOW() WHERE id=$1',[a.profile_id,JSON.stringify(canvas)]);
   await conn.query('COMMIT');
   return {created:true,card,profile_id:a.profile_id};
  }catch(e){await conn.query('ROLLBACK');throw e}finally{conn.release()}
 }
 throw Error('Unknown tool');
}
async function handle(req,res,pool,isAuthorized){
 const path=new URL(req.url||'/',BASE).pathname;
 if(path==='/.well-known/oauth-authorization-server' ||path==='/.well-known/openid-configuration'){
  if(req.method==='GET')return json(res,200,metadata);
 }
 if(path==='/.well-known/oauth-protected-resource' || path==='/.well-known/oauth-protected-resource/mcp'){
  if(req.method==='GET')return json(res,200,{
   resource:BASE+'/mcp',authorization_servers:[BASE],
   scopes_supported:['journal:read','journal:write'],
   bearer_methods_supported:['header']
  });
 }
 if(path==='/oauth/register'&&req.method==='POST'){
  const b=await body(req);
  const uris=b.redirect_uris;
  if(!Array.isArray(uris)||uris.length<1||uris.length>5||!uris.every(validateRedirect))return oauthError(res,400,'invalid_redirect_uri');
  if(b.token_endpoint_auth_method&&b.token_endpoint_auth_method!=='none')return oauthError(res,400,'invalid_client_metadata','Only public clients supported');
  const id=rand();
  await pool.query('INSERT INTO oauth_clients(id,redirect_uris) VALUES($1,$2::jsonb)',[id,JSON.stringify(uris)]);
  return json(res,201,{client_id:id,client_id_issued_at:Math.floor(Date.now()/1000),redirect_uris:uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
 }
 if(path==='/oauth/authorize'&&(req.method==='GET'||req.method==='POST')){
  const u=new URL(req.url||'',BASE);
  const b=req.method==='POST'?await body(req):Object.fromEntries(u.searchParams);
  const cid=b.client_id,redir=b.redirect_uri,challenge=b.code_challenge;
  const reg=await pool.query('SELECT redirect_uris FROM oauth_clients WHERE id=$1',[cid||'']);
  if(!reg.rows.length||!reg.rows[0].redirect_uris.includes(redir)||!validateRedirect(redir)||b.response_type!=='code'||b.code_challenge_method!=='S256'||!challenge||!/^[A-Za-z0-9_-]{43,128}$/.test(challenge))return text(res,400,'Invalid OAuth authorization request');
  // Use the same authenticated browser session as the journal. Never ask for
  // the app password on a third-party connection consent page.
  if(req.method==='GET'&&!isAuthorized(req)){
    res.writeHead(302,{location:'/login?next='+encodeURIComponent(u.pathname+u.search),'cache-control':'no-store'});
    res.end();return;
  }
  if(!isAuthorized(req))return text(res,401,'Please sign into Coach Journal first, then restart the connection from ChatGPT.');
  if(req.method==='GET'){
   const esc=s=>String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
   const hidden=['client_id','redirect_uri','response_type','state','scope','code_challenge','code_challenge_method','resource'].map(k=>'<input type="hidden" name="'+k+'" value="'+esc(b[k])+'">').join('');
   return text(res,200,'<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Allow Coach Journal Access</title><body style="font:17px system-ui;background:#faf9f4;display:grid;place-items:center;min-height:90vh"><form id="consent" method="POST" action="/oauth/authorize" style="max-width:420px;background:white;padding:28px;border:1px solid #d7c6a2;border-radius:12px"><h2>Connect Coach Journal</h2><p>You are signed into your journal.</p><p>Allow the ChatGPT connector to read profiles and add training cards?</p>'+hidden+'<button id="approve" type="submit" style="display:block;margin-top:20px;background:#a38c5f;border:0;color:white;padding:12px 22px;border-radius:8px;cursor:pointer">Allow access</button><p id="status" role="status" style="font:13px system-ui;color:#765e31;min-height:20px"></p></form><script>document.getElementById("consent").addEventListener("submit",async function(e){e.preventDefault();const button=document.getElementById("approve"),status=document.getElementById("status");button.disabled=true;status.textContent="Authorizing Coach Journal...";try{const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),15000);let response;try{response=await fetch("/oauth/authorize",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/x-www-form-urlencoded","accept":"application/json"},body:new URLSearchParams(new FormData(e.currentTarget)).toString(),signal:ctrl.signal})}finally{clearTimeout(timeout)}const data=await response.json();if(!response.ok||!data.redirect_uri)throw Error(data.error||data.message||"Authorization failed");status.textContent="Permission granted. Returning to ChatGPT...";window.location.assign(data.redirect_uri)}catch(err){status.textContent="Connection problem: "+(err.name==="AbortError"?"Server timed out":err.message)+". Please report this message.";button.disabled=false}});</script></body></html>');
  }
  const code=rand(),scope='journal:read journal:write';
  await pool.query("INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,code_challenge,scope,expires_at) VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL '5 minutes')",[hash(code),cid,redir,challenge,scope]);
  const destination=new URL(redir);destination.searchParams.set('code',code);if(b.state)destination.searchParams.set('state',b.state);
  if((req.headers.accept||'').includes('application/json'))return json(res,200,{redirect_uri:destination.toString()});
  res.writeHead(302,{location:destination.toString(),'cache-control':'no-store'});res.end();return;
 }
 if(path==='/oauth/token'&&req.method==='POST'){
  const b=await body(req),cid=b.client_id||'';
  if(b.grant_type==='authorization_code'){
   const code=b.code||'';
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const r=await client.query("DELETE FROM oauth_codes WHERE code_hash=$1 AND expires_at>NOW() RETURNING client_id,redirect_uri,code_challenge,scope",[hash(code)]);
    if(!r.rows.length||r.rows[0].client_id!==cid||r.rows[0].redirect_uri!==b.redirect_uri){await client.query('ROLLBACK');return oauthError(res,400,'invalid_grant')}
    const proof=b.code_verifier||'';
    if(!proof||!safeEqual(b64(crypto.createHash('sha256').update(proof).digest()),r.rows[0].code_challenge)){await client.query('ROLLBACK');return oauthError(res,400,'invalid_grant')}
    const access=rand(),refresh=rand();
    await client.query("INSERT INTO oauth_tokens(token_hash,client_id,scope,kind,expires_at) VALUES ($1,$2,$3,'access',NOW()+INTERVAL '1 hour'),($4,$2,$3,'refresh',NOW()+INTERVAL '90 days')",[hash(access),cid,r.rows[0].scope,hash(refresh)]);
    await client.query('COMMIT');
    return json(res,200,{access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope:r.rows[0].scope});
   }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }
  if(b.grant_type==='refresh_token'){
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const r=await client.query("DELETE FROM oauth_tokens WHERE token_hash=$1 AND kind='refresh' AND client_id=$2 AND expires_at>NOW() RETURNING scope",[hash(b.refresh_token||''),cid]);
    if(!r.rows.length){await client.query('ROLLBACK');return oauthError(res,400,'invalid_grant')}
    const access=rand(),refresh=rand();
    await client.query("INSERT INTO oauth_tokens(token_hash,client_id,scope,kind,expires_at) VALUES ($1,$2,$3,'access',NOW()+INTERVAL '1 hour'),($4,$2,$3,'refresh',NOW()+INTERVAL '90 days')",[hash(access),cid,r.rows[0].scope,hash(refresh)]);
    await client.query('COMMIT');
    return json(res,200,{access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope:r.rows[0].scope});
   }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }
  return oauthError(res,400,'unsupported_grant_type');
 }
 if(path==='/mcp'){
  if(req.method==='GET')return json(res,405,{error:'Use POST for MCP JSON-RPC'});
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const reqBody=await body(req),id=reqBody.id;
  if(reqBody.jsonrpc!=='2.0'||typeof reqBody.method!=='string')return json(res,400,rpcError(id??null,-32600,'Invalid request'));
  if(!await bearerScope(pool,req,reqBody.method==='tools/call'?'journal:write':'journal:read'))return authProblem(res);
  const method=reqBody.method,params=reqBody.params||{};
  if(method==='notifications/initialized')return res.writeHead(202).end();
  if(method==='initialize')return json(res,200,result(id,{protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'Coach Journal',version:'1.0.0'},instructions:'Private single-owner training journal. List profiles before creating duplicates. Never invent exercises, weights, repetitions or dates. Read existing data before editing.'}));
  if(method==='ping')return json(res,200,result(id,{}));
  if(method==='tools/list')return json(res,200,result(id,{tools:toolSchemas}));
  if(method==='tools/call'){
   const tool=toolSchemas.find(t=>t.name===params.name);
   if(!tool)return json(res,200,rpcError(id,-32602,'Unknown tool'));
   try{
    const value=await callTool(pool,params.name,params.arguments||{});
    return json(res,200,result(id,{content:[{type:'text',text:JSON.stringify(value)}]}));
   }catch(err){return json(res,200,result(id,{content:[{type:'text',text:err.message}],isError:true}))}
  }
  return json(res,200,rpcError(id,-32601,'Method not found'));
 }
 return false;
}
module.exports={init,handle,handles:p=>p==='/mcp'||p.startsWith('/oauth/')||p.startsWith('/.well-known/oauth-')||p.startsWith('/.well-known/openid-configuration')};
