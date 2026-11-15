// AI Auth server-optional proof of concept. Identity is NOT authorization.
const te = new TextEncoder();
const toHex = x => [...new Uint8Array(x)].map(v=>v.toString(16).padStart(2,"0")).join("");
const b64 = x => btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const from64 = x => Uint8Array.from(atob(x.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-x.length%4)%4)),v=>v.charCodeAt(0));
const idFor = async jwk => "agent:"+toHex(await crypto.subtle.digest("SHA-256",te.encode(JSON.stringify({crv:jwk.crv,kty:jwk.kty,x:jwk.x,y:jwk.y})))).slice(0,40);
export async function createIdentity(label="Agent"){
  // Non-extractable keys are persisted by the browser's IndexedDB structured clone.
  const db = await new Promise((ok,fail)=>{const r=indexedDB.open("ai-auth-wallet-v1",1);r.onupgradeneeded=()=>r.result.createObjectStore("keys");r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error)});
  let keys=await new Promise((ok,fail)=>{const r=db.transaction("keys").objectStore("keys").get("main");r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error)});
  if(!keys){keys=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);await new Promise((ok,fail)=>{const t=db.transaction("keys","readwrite");t.objectStore("keys").put(keys,"main");t.oncomplete=ok;t.onerror=()=>fail(t.error)})}
  const publicKey=await crypto.subtle.exportKey("jwk",keys.publicKey);
  db.close();
  return {id:await idFor(publicKey),label,session:crypto.randomUUID(),publicKey,sign:async value=>b64(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,te.encode(JSON.stringify(value))))};
}
export async function signEvent(identity,room,type,payload={}){
  if(!/^[\w:-]{1,100}$/.test(room))throw Error("Invalid room");
  const value={v:1,agent:identity.id,session:identity.session,key:identity.publicKey,ts:Date.now(),nonce:crypto.randomUUID(),room,type,payload};
  return {...value,sig:await identity.sign(value)};
}
export async function verifyEvent(event){
  if(!event||event.v!==1||typeof event.sig!=="string"||typeof event.ts!=="number"||Math.abs(Date.now()-event.ts)>120000||typeof event.nonce!=="string"||event.nonce.length<10)return false;
  try{
    if(event.key.kty!=="EC"||event.key.crv!=="P-256"||await idFor(event.key)!==event.agent)return false;
    const key=await crypto.subtle.importKey("jwk",event.key,{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
    const {sig,...value}=event;
    return await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,from64(sig),te.encode(JSON.stringify(value)));
  }catch{return false}
}
export class P2PRoom {
  constructor(identity,room,{privateMode=false}={}){this.identity=identity;this.room=room;this.privateMode=privateMode;this.peers=new Map();this.seen=new Set();this.listeners=new Set();this.channels=new Set();this.closed=false}
  subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
  notify(event){for(const listener of this.listeners)listener(event)}
  async start(){if(this.privateMode)return this;this.broadcast=new BroadcastChannel("ai-auth:"+location.origin+":"+this.room);this.broadcast.onmessage=({data})=>{void this.receive(data)};await this.send("hello",{label:this.identity.label});this.timer=setInterval(()=>{void this.send("heartbeat",{label:this.identity.label});this.expire()},7000);return this}
  async send(type,payload={}){if(this.privateMode||this.closed)throw Error("Session is private or closed");const event=await signEvent(this.identity,this.room,type,payload);this.broadcast?.postMessage(event);for(const channel of this.channels)if(channel.readyState==="open")channel.send(JSON.stringify(event));this.notify({direction:"out",event});return event}
  async receive(event){if(this.closed||event?.room!==this.room||(event.agent===this.identity.id&&event.session===this.identity.session))return false;const key=event.agent+":"+event.nonce;if(this.seen.has(key)||!(await verifyEvent(event)))return false;this.seen.add(key);if(this.seen.size>4000)this.seen.clear();const peer=event.agent+":"+event.session;if(event.type==="goodbye")this.peers.delete(peer);else this.peers.set(peer,{id:event.agent,session:event.session,label:String(event.payload?.label||event.agent).slice(0,80),seen:Date.now()});this.notify({direction:"in",event});if(event.type==="hello")await this.send("heartbeat",{label:this.identity.label});return true}
  expire(){for(const [id,peer] of this.peers)if(Date.now()-peer.seen>24000)this.peers.delete(id)}
  attach(channel){this.channels.add(channel);channel.onmessage=({data})=>{try{void this.receive(JSON.parse(data))}catch{}};channel.onclose=()=>this.channels.delete(channel);return channel}
  async close(){if(this.closed)return;if(!this.privateMode)await this.send("goodbye",{});this.closed=true;clearInterval(this.timer);this.broadcast?.close();for(const c of this.channels)c.close();this.channels.clear();this.listeners.clear()}
}
// No signaling infrastructure is involved; users exchange the offer/answer manually.
export class ManualWebRTC {
  constructor(room){this.room=room;this.peer=new RTCPeerConnection({iceServers:[]});this.peer.ondatachannel=e=>room.attach(e.channel)}
  async offer(){this.room.attach(this.peer.createDataChannel("ai-auth"));await this.peer.setLocalDescription(await this.peer.createOffer());return this.sdp()}
  async answer(offer){await this.peer.setRemoteDescription(JSON.parse(offer));await this.peer.setLocalDescription(await this.peer.createAnswer());return this.sdp()}
  async finish(answer){await this.peer.setRemoteDescription(JSON.parse(answer))}
  async sdp(){if(this.peer.iceGatheringState!=="complete")await new Promise(resolve=>{let timer=setTimeout(resolve,12000);this.peer.addEventListener("icegatheringstatechange",()=>{if(this.peer.iceGatheringState==="complete"){clearTimeout(timer);resolve()}})});return JSON.stringify(this.peer.localDescription)}
  close(){this.peer.close()}
}