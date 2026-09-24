/* Blob Party online server.
   Runs the REAL game (game.html) with no screen inside jsdom - one copy per room - and lets players connect with WebSockets.
   Room "pub" = Quick Match (everyone together). 4-letter codes = friend rooms. */
const http=require('http'), fs=require('fs'), path=require('path');
const {WebSocketServer}=require('ws');
const {JSDOM,VirtualConsole}=require('jsdom');

const PORT=process.env.PORT||8790;
const HTML=fs.readFileSync(path.join(__dirname,'game.html'),'utf8');
const TICK=1/20;                          /* the world moves 20 times a second (players smooth it out) */
const MAX_PUB=16, MAX_ROOM=8, MAX_WORLDS=6, EMPTY_MS=90*1000;
const worlds=new Map();                   /* room id -> world */
let nextConn=1;

function log(...a){ console.log(new Date().toISOString().slice(11,19),...a); }

/* ---------- one game world = one headless copy of the game ---------- */
function makeWorld(id){
  const vc=new VirtualConsole(); vc.on('jsdomError',e=>log('['+id+'] page error:',String(e&&e.message||e).slice(0,200)));
  const dom=new JSDOM(HTML,{url:'http://blobserver/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
    const noop=new Proxy(function(){},{get:(t,k)=>k==='canvas'?{width:1,height:1}:k==='measureText'?(()=>({width:10})):
      (k==='createLinearGradient'||k==='createRadialGradient'||k==='createConicGradient'||k==='createPattern')?(()=>({addColorStop(){}})):
      k==='getImageData'?(()=>({data:new Uint8ClampedArray(4)})):noop,apply:()=>undefined,set:()=>true});
    w.HTMLCanvasElement.prototype.getContext=function(){ return noop; }; w.HTMLCanvasElement.prototype.toDataURL=()=>'data:,';
    w.Path2D=class{ moveTo(){} lineTo(){} arc(){} rect(){} closePath(){} ellipse(){} quadraticCurveTo(){} bezierCurveTo(){} roundRect(){} addPath(){} };
    w.CanvasRenderingContext2D=function(){}; w.CanvasRenderingContext2D.prototype.roundRect=function(){};
    w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}}); w.AudioContext=undefined; w.webkitAudioContext=undefined; }});
  const W={id,dom,win:dom.window,conns:new Map(),empty:Date.now(),timer:null,ready:false,pub:id.startsWith('pub')};
  worlds.set(id,W);
  /* wait for the game to boot, then turn it into a server world */
  const start=Date.now();
  const wait=setInterval(()=>{ let ok=false; try{ ok=W.win.eval('typeof netHostMsg==="function"&&typeof S!=="undefined"&&!!S'); }catch(_){}
    if(!ok&&Date.now()-start<20000) return; clearInterval(wait);
    try{ W.win.eval(SERVER_MODE); W.win.eval('srvStart('+JSON.stringify(id)+','+(W.pub?MAX_PUB:MAX_ROOM)+')'); }catch(e){ log('['+id+'] boot failed',e.message); }
    W.ready=true; W.last=Date.now();
    W.timer=setInterval(()=>{ try{ W.win.srvTick(TICK); }catch(e){ log('['+id+'] tick error',e.message); } },TICK*1000);
    log('world',id,'ready'); },200);
  return W;
}
function killWorld(W){ clearInterval(W.timer); try{ W.win.close(); }catch(_){} worlds.delete(W.id); log('world',W.id,'closed'); }

/* runs INSIDE each world page: no local player, the server is the host */
const SERVER_MODE=`
window.requestAnimationFrame=function(){ return 0; };           /* no drawing on a server */
frame=function(){};
function srvStart(code,max){ if(P){ const i=blobs.indexOf(P); if(i>=0) blobs.splice(i,1); } P=null; STATE='menu'; closePop();
  S.mode='classic'; S.diff=1; WORLDDIFF=-1; initWorld(); NET_MAX=max+1;
  Object.assign(NET,{role:'host',peer:null,code:code,pub:code.indexOf('pub')===0,go:true,conns:new Map(),lastFood:new Map(),prevFood:null}); window.NETLIVE=true;
  netName=function(){ return 'Server'; }; }
/* map events happen around the real players (the game normally uses "you") */
const _evT=evTick, SR={t:0};
evTick=function(dt){ SR.t+=dt; const rs=[]; NET.conns.forEach(c=>{ if(c.blob&&c.blob.alive) rs.push(c.blob); }); if(!rs.length) return;
  const rb=rs[(Math.random()*rs.length)|0], kP=P, kR=R0, kS=STATE; P=rb; R0=SR; STATE='play';
  try{ _evT(dt); } catch(e){} finally{ P=kP; R0=kR; STATE=kS; } };
function srvTick(dt){ if(NET.conns.size) update(dt); }
`;

/* ---------- web page + WebSockets ---------- */
const server=http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});
  if(req.url.startsWith('/status')){ res.end(JSON.stringify([...worlds.values()].map(W=>({room:W.id,players:W.conns.size})))); return; }
  res.end('Blob Party server is awake! Rooms: '+worlds.size); });
const wss=new WebSocketServer({server,maxPayload:64*1024});
const code4=()=>Array.from({length:4},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[(Math.random()*24)|0]).join('');

wss.on('connection',ws=>{
  const id='c'+(nextConn++); let W=null, c=null, alive=true;
  ws.on('pong',()=>{ alive=true; });
  const ping=setInterval(()=>{ if(!alive){ ws.terminate(); return; } alive=false; try{ ws.ping(); }catch(_){} },20000);
  const toWorld=(d)=>{ if(!W||!W.ready){ setTimeout(()=>toWorld(d),150); return; } try{ W.win.netHostMsg(c,d); }catch(e){ log('msg error',e.message); } };
  ws.on('message',raw=>{ let d; try{ d=JSON.parse(raw); }catch(_){ return; } if(!d||typeof d.t!=='string') return;
    if(!W){                                           /* first message picks the room */
      if(d.t!=='room') return; let room=String(d.room||'');
      if(room==='pub'){ room=null; for(const w of worlds.values()) if(w.pub&&w.conns.size<MAX_PUB){ room=w.id; break; }
        if(!room){ let n=1; while(worlds.has('pub'+n)) n++; room='pub'+n; } }
      else if(room==='new'){ if(worlds.size>=MAX_WORLDS){ ws.send(JSON.stringify({t:'nope',why:'busy'})); ws.close(); return; } do{ room=code4(); }while(worlds.has(room)); }
      else { room=room.toUpperCase().replace(/[^A-Z]/g,'').slice(0,4); if(!worlds.has(room)){ ws.send(JSON.stringify({t:'nope',why:'noroom'})); ws.close(); return; } }
      W=worlds.get(room)||(worlds.size<MAX_WORLDS?makeWorld(room):null);
      if(!W){ ws.send(JSON.stringify({t:'nope',why:'busy'})); ws.close(); return; }
      c={peer:id,open:true,send:m=>{ if(ws.readyState===1) ws.send(JSON.stringify(m)); },close:()=>{ try{ ws.close(); }catch(_){} },on(){},off(){}};
      W.conns.set(id,c); ws.send(JSON.stringify({t:'room',room:W.id,pub:W.pub})); log(id,'joined',W.id,'('+W.conns.size+')'); return; }
    toWorld(d); });
  ws.on('close',()=>{ clearInterval(ping); if(!W||!c) return; c.open=false; W.conns.delete(id); W.empty=Date.now();
    try{ if(W.ready) W.win.netDrop(c); }catch(_){} log(id,'left',W.id,'('+W.conns.size+')'); });
  ws.on('error',()=>{});
});
/* close rooms nobody is in */
setInterval(()=>{ for(const W of [...worlds.values()]) if(!W.conns.size&&Date.now()-W.empty>EMPTY_MS) killWorld(W); },15000);
server.listen(PORT,()=>log('Blob Party server on port',PORT));
