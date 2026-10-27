// Sprout Garden server: static files + a tiny built-in WebSocket relay (no npm dependencies).
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const PORT=process.env.PORT||3000,PUB=path.join(__dirname,'public');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const slots=[null,null,null,null],plots={};let evT=null;
// plot ownership must match the client: middle row of each field is shared (-1), other quarters belong to slots 0-3
const own=i=>{const r=Math.floor((i%15)/3);return r===2?-1:(i<15?0:2)+(r<2?0:1)};
const snap=()=>Object.entries(plots).map(([i,p])=>[+i,p.t,(Date.now()-p.at)/1000]);

const server=http.createServer((req,res)=>{
  let f=decodeURIComponent(req.url.split('?')[0]);if(f==='/')f='/index.html';
  const p=path.join(PUB,path.normalize(f));
  if(!p.startsWith(PUB)){res.writeHead(403);return res.end()}
  fs.readFile(p,(e,d)=>{if(e){res.writeHead(404);return res.end('Not found')}
    res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(d)})});

// ---- minimal RFC 6455 websocket ----
server.on('upgrade',(req,sock)=>{
  const key=req.headers['sec-websocket-key'];
  if(!key||String(req.headers.upgrade).toLowerCase()!=='websocket'){sock.destroy();return}
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+
    crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')+'\r\n\r\n');
  const c={sock,buf:Buffer.alloc(0),slot:null,fr:''};
  sock.on('data',d=>{c.buf=Buffer.concat([c.buf,d]);let f;while((f=parse(c)))handle(c,f)});
  sock.on('close',()=>drop(c));sock.on('error',()=>sock.destroy())});
function parse(c){const b=c.buf;if(b.length<2)return null;let len=b[1]&127,o=2;
  if(len===126){if(b.length<4)return null;len=b.readUInt16BE(2);o=4}
  else if(len===127){if(b.length<10)return null;len=Number(b.readBigUInt64BE(2));o=10}
  if(len>65536){c.sock.destroy();return null}
  const masked=b[1]&128;if(masked)o+=4;if(b.length<o+len)return null;
  const pay=Buffer.from(b.subarray(o,o+len));if(masked){const m=b.subarray(o-4,o);for(let i=0;i<len;i++)pay[i]^=m[i&3]}
  c.buf=b.subarray(o+len);return{op:b[0]&15,fin:b[0]&128,pay}}
function frame(c,op,d){const n=d.length;let h;
  if(n<126)h=Buffer.from([128|op,n]);else if(n<65536){h=Buffer.alloc(4);h[0]=128|op;h[1]=126;h.writeUInt16BE(n,2)}
  else{h=Buffer.alloc(10);h[0]=128|op;h[1]=127;h.writeBigUInt64BE(BigInt(n),2)}
  if(!c.sock.destroyed)c.sock.write(Buffer.concat([h,d]))}
const send=(c,o)=>frame(c,1,Buffer.from(JSON.stringify(o)));
const bcast=(from,o)=>slots.forEach(c=>c&&c!==from&&send(c,o));
function handle(c,{op,fin,pay}){
  if(op===8){c.sock.end();return}
  if(op===9){frame(c,10,pay);return}
  if(op===1||op===0){c.fr=(op===1?'':c.fr)+pay.toString();if(!fin)return;let m;try{m=JSON.parse(c.fr)}catch(e){return}c.fr='';msg(c,m)}}

// ---- game logic ----
function msg(c,m){
  if(m.a==='join'&&c.slot===null){
    const s=slots.indexOf(null);if(s<0){send(c,{m:'full'});return c.sock.end()}
    c.slot=s;c.name=String(m.n||'Farmer').replace(/[<>]/g,'').slice(0,14)||'Farmer';slots[s]=c;
    send(c,{m:'welcome',slot:s,players:slots.filter(Boolean).map(x=>({s:x.slot,n:x.name})),plots:snap()});
    bcast(c,{m:'join',s,n:c.name});weather();return}
  if(c.slot===null)return;
  if(m.a==='pos')return bcast(c,{m:'p',s:c.slot,x:+m.x||0,z:+m.z||0,r:+m.r||0,c:m.c|0});
  const i=m.i|0;if(i<0||i>29||(own(i)>=0&&own(i)!==c.slot))return;const p=plots[i];
  if(m.a==='plant'){const t=m.t|0;if(p||t<0||t>15)return send(c,{m:'snap',plots:snap()});plots[i]={t,at:Date.now()}}
  else if(m.a==='harvest'){if(!p)return send(c,{m:'snap',plots:snap()});delete plots[i]}
  else if(m.a==='water'||m.a==='fert'){if(!p)return}
  else return;
  bcast(c,{m:'act',a:m.a,i,t:m.t|0,s:c.slot})}
function drop(c){if(c.slot===null)return;slots[c.slot]=null;bcast(c,{m:'leave',s:c.slot});
  if(!slots.some(Boolean)){for(const k in plots)delete plots[k];clearTimeout(evT);evT=null}}
function weather(){if(evT)return;evT=setTimeout(()=>{evT=null;if(!slots.some(Boolean))return;
  bcast(null,{m:'ev',k:Math.random()<.5?'rain':'storm'});weather()},(40+Math.random()*60)*1000)}

server.listen(PORT,()=>{console.log('🌱 Sprout Garden running:\n   http://localhost:'+PORT);
  for(const l of Object.values(os.networkInterfaces()))for(const a of l)if(a.family==='IPv4'&&!a.internal)console.log('   http://'+a.address+':'+PORT+'  (friends on your network)')});
