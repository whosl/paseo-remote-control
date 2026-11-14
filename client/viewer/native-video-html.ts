/** Receive-only WebRTC document for an already installed Android WebView. No remote page or scripts. */
export function nativeVideoDocument(nonce: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:; img-src data:; base-uri 'none'; form-action 'none'">
<style>html,body,video,canvas{margin:0;width:100%;height:100%;overflow:hidden;background:#000}video,canvas{position:absolute;inset:0;object-fit:contain}canvas{display:none}</style></head><body><video muted autoplay playsinline></video><canvas></canvas><script>
(() => {
const nonce=${JSON.stringify(nonce).replace(/</g, "\\u003c")}, video=document.querySelector('video'), canvas=document.querySelector('canvas');
let sequence=0, packetSequence=0, sending=null, outgoing=[], pc, closed=false, applied=false, ready=false, previous, poll, stats, timeout, disconnected;
// History events use this view's ordinary native events. Do not replace the app-wide WebView
// messaging module: other Paseo WebViews (including terminals) own that module.
// Android reports the data URL for loadDataWithBaseURL history events. Carry bounded packets
// in the document title instead, and acknowledge each packet through the injected command.
const pump=()=>{if(closed||sending||!outgoing.length)return;const item=outgoing[0];const chunk=item.encoded.slice(item.index*1000,(item.index+1)*1000);const packet=++packetSequence;sending=packet;document.title='paseo-rtc:'+nonce+':'+packet+':'+item.id+':'+item.index+':'+item.total+':'+chunk;setTimeout(()=>{try{history.replaceState(null,'','#paseo-rtc-packet='+packet);}catch{}},0);};
const emit=data=>{if(data.type==='stats'&&outgoing.length>=2)return;const id=++sequence,encoded=encodeURIComponent(JSON.stringify({nonce,sequence:id,...data}));outgoing.push({id,encoded,index:0,total:Math.ceil(encoded.length/1000)});pump();};
const freeze=()=>{try{if(video.readyState>=2&&video.videoWidth){canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);canvas.style.display='block';}}catch{} video.pause();};
const stop=()=>{if(closed)return;closed=true;clearInterval(poll);clearInterval(stats);clearTimeout(timeout);clearTimeout(disconnected);freeze();if(pc)pc.close();video.srcObject=null;};
const fail=error=>{if(closed)return;outgoing=[];sending=null;emit({type:'error',message:String(error?.message||error)});stop();};
addEventListener('pagehide',stop);
video.onloadeddata=()=>{if(closed||ready)return;ready=true;clearTimeout(timeout);emit({type:'ready',width:video.videoWidth,height:video.videoHeight});};
video.onerror=()=>fail('Video decoding failed; using Paseo frames.');
(async()=>{
 if(typeof RTCPeerConnection==='undefined')throw Error('WebRTC is unavailable in this Android WebView.');
 pc=new RTCPeerConnection({iceServers:[]});
 pc.ontrack=event=>{video.srcObject=new MediaStream([event.track]);video.play().catch(fail);};
 pc.onconnectionstatechange=()=>{clearTimeout(disconnected);if(pc.connectionState==='failed')fail('Direct connection unavailable; using Paseo frames.');else if(pc.connectionState==='disconnected')disconnected=setTimeout(()=>fail('Direct video disconnected; using Paseo frames.'),2500);};
 const transceiver=pc.addTransceiver('video',{direction:'recvonly'});
 const codecs=RTCRtpReceiver.getCapabilities('video')?.codecs.filter(c=>c.mimeType.toLowerCase()==='video/h264')||[];
 if(!codecs.length)throw Error('H.264 decoding is unavailable in this Android WebView.');
 transceiver.setCodecPreferences?.(codecs);
 await pc.setLocalDescription(await pc.createOffer());
 if(closed)return;
 if(pc.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',gathered);reject(Error('ICE gathering timed out'));},3000);
  const gathered=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',gathered);resolve();}};
  pc.addEventListener('icegatheringstatechange',gathered);gathered();
 });
 if(closed)return;emit({type:'offer',sdp:pc.localDescription.sdp});
 timeout=setTimeout(()=>fail('Direct video did not arrive; using Paseo frames.'),10000);
 poll=setInterval(()=>{try{
  const command=JSON.parse(window.ReactNativeWebView.injectedObjectJson());
  if(command.nonce!==nonce)return;if(command.stop){stop();return;}
  if(sending&&command.ack===sending){sending=null;const item=outgoing[0];if(++item.index>=item.total)outgoing.shift();pump();}
  if(command.answer&&!applied){applied=true;pc.setRemoteDescription({type:'answer',sdp:command.answer}).catch(fail);}
 }catch{}},40);
 stats=setInterval(async()=>{try{
  const reports=await pc.getStats();if(closed||!ready)return;
  let frames=0,bytes=0,rttMs=null;reports.forEach(r=>{
   if(r.type==='inbound-rtp'&&(r.kind==='video'||r.mediaType==='video')){frames+=Number(r.framesDecoded||0);bytes+=Number(r.bytesReceived||0);}
   if(r.type==='candidate-pair'&&r.state==='succeeded'&&r.nominated&&typeof r.currentRoundTripTime==='number')rttMs=Math.round(r.currentRoundTripTime*1000);
  });const at=performance.now();if(previous){const seconds=Math.max(.001,(at-previous.at)/1000);emit({type:'stats',fps:Math.max(0,(frames-previous.frames)/seconds),kbps:Math.max(0,(bytes-previous.bytes)*8/seconds/1000),rttMs});}previous={at,frames,bytes};
 }catch{}},1000);
})().catch(fail);
})();</script></body></html>`;
}
