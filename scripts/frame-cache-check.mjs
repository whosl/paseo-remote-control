import assert from "node:assert/strict";
import { FrameCache } from "../server/screen/frame-cache.ts";
const cache=new FrameCache();cache.publish(Buffer.from("frame-one"));
const first=await cache.read(undefined,250);assert.equal(first.frame.base64,Buffer.from("frame-one").toString("base64"));
let done=false;const next=cache.read(first.frame.hash,250).then(result=>{done=true;return result});
await new Promise(r=>setTimeout(r,20));assert.equal(done,false);cache.publish(Buffer.from("frame-two"));const result=await next;assert.equal(result.frame.jpeg.toString(),"frame-two");assert.ok(result.waitedMs>=15&&result.waitedMs<200);
const timeout=await cache.read(result.frame.hash,25);assert.equal(timeout.frame.hash,result.frame.hash);assert.ok(timeout.waitedMs>=20);
const waiting=cache.read(result.frame.hash,250);cache.close();assert.equal((await waiting).frame,null);
console.log("Changed-frame wait, bounded timeout, payload caching and shutdown cleanup checks passed");
