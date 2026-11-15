import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { signEvent, verifyEvent, P2PRoom } from "../packages/p2p/index.js";
globalThis.crypto ??= webcrypto;
const enc=new TextEncoder();
const hex=x=>[...new Uint8Array(x)].map(v=>v.toString(16).padStart(2,"0")).join("");
async function wallet(){
 const pair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
 const key=await crypto.subtle.exportKey("jwk",pair.publicKey);
 const id="agent:"+hex(await crypto.subtle.digest("SHA-256",enc.encode(JSON.stringify({crv:key.crv,kty:key.kty,x:key.x,y:key.y})))).slice(0,40);
 return {id,key,publicKey:key,session:crypto.randomUUID(),label:"Test",sign:async v=>Buffer.from(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},pair.privateKey,enc.encode(JSON.stringify(v)))).toString("base64url")};
}
test("signed message is authentic, tampered message fails", async()=>{
 const w=await wallet(), e=await signEvent(w,"demo","message",{text:"hello"});
 assert.equal(await verifyEvent(e),true);
 assert.equal(await verifyEvent({...e,payload:{text:"tampered"}}),false);
 assert.equal(await verifyEvent({...e,ts:123}),false);
 assert.equal(await verifyEvent({...e,agent:"agent:forged"}),false);
});
test("same-origin room rejects replay and cross-room events",async()=>{
 const a=await wallet(), b=await wallet(), room=new P2PRoom(b,"demo");
 const e=await signEvent(a,"demo","message",{text:"hello"});
 assert.equal(await room.receive(e),true);
 assert.equal(await room.receive(e),false);
 assert.equal(await room.receive({...e,room:"other"}),false);
 assert.equal(room.peers.size,1);
 await room.close();
});
test("separate wallet sessions can share a public key",async()=>{
 const w=await wallet(),room=new P2PRoom(w,"demo");
 const another={...w,session:crypto.randomUUID()};
 assert.equal(await room.receive(await signEvent(another,"demo","hello",{label:"Other tab"})),true);
 assert.equal(room.peers.size,1);
 await room.close();
});
test("private mode never publishes presence",async()=>{
 const w=await wallet(),room=new P2PRoom(w,"demo",{privateMode:true});
 await room.start(); await assert.rejects(room.send("message",{text:"denied"}),/private/); await room.close();
});
