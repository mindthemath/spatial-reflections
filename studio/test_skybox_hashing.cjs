// Published/insecure-origin regression, without Chromium or HTTP connections.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto, createHash } = require('crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'viewer-skyboxes.js'), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export function installSkyboxLibrary', 'function installSkyboxLibrary');
const faces = ['px','nx','py','ny','pz','nz'];
function fixture(crypto) {
  let fetches=0,created=0,revoked=0,states=0,caches=[];
  const status={textContent:'',classList:{add(){}}};
  const section={querySelector(selector){return selector==='#skybox-status'?status:{textContent:''};}};
  const canvas={getContext(){return {createLinearGradient(){return {addColorStop(){}};},fillRect(){}};}};
  const bytes=url=>new TextEncoder().encode(url);
  let complete;
  const done=new Promise(resolve=>{complete=resolve;});
  const context=vm.createContext({
    crypto, Blob,
    URL:{createObjectURL(){created++;return `blob:test-${created}`;},revokeObjectURL(){revoked++;}},
    Image:class {constructor(){this.naturalWidth=this.naturalHeight=16;}set src(_value){queueMicrotask(()=>this.onload());}},
    fetch:async (url,options)=>{fetches++;caches.push(options.cache);return {ok:true,blob:async()=>new Blob([bytes(url)],{type:'image/png'})};},
    document:{createElement(tag){return tag==='canvas'?canvas:section;}},
    THREE:{CubeTexture:class {constructor(images){this.images=images;}}},
    options:{
      mount:{prepend(){}}, renderer:{capabilities:{isWebGL2:true},getContext(){return {MAX_CUBE_MAP_TEXTURE_SIZE:1,getParameter(){return 1024;}};}},
      onTexture(){},onStateChange(state){if(++states>1)complete(state);},
      publication:{schemaVersion:1,slug:'artwork',size:16,skybox:Object.fromEntries(faces.map(face=>[face,`skybox/${face}.png`]))}
    }
  });
  vm.runInContext(source,context);
  return {context,status,done,bytes,caches,counts:()=>({fetches,created,revoked})};
}
async function published(crypto) {
  const value=fixture(crypto);
  value.api=vm.runInContext('installSkyboxLibrary(options)',value.context);
  let timer;
  try {
    value.state=await Promise.race([value.done,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Published load did not finish')),2000);
    })]);
  } finally {clearTimeout(timer);}
  return value;
}
(async()=>{
  // Both missing crypto and crypto without subtle occur on restricted origins.
  for(const crypto of [undefined,{}]) {
    const value=await published(crypto);
    assert.equal(value.state.ready,true);
    assert.equal(value.state.identity,null,'Unhashed assets must not get a verified render identity');
    assert.match(value.status.textContent,/16 × 16px/);
    assert.deepEqual(value.counts(),{fetches:6,created:6,revoked:6});
    assert(value.caches.every(cache=>cache==='default'),'Immutable published playback should allow HTTP caching');
    assert.throws(()=>value.api.acquireRenderLock(),/verification requires HTTPS or localhost/);
    const strict=fixture(crypto);
    await assert.rejects(vm.runInContext("loadImageAsset('skybox/px.png')",strict.context),/HTTPS or localhost/);
    assert.equal(strict.counts().fetches,0,'Fail export-capable loads before fetching large assets');
  }
  const loader=source.slice(source.indexOf('async function loadSelection('),source.indexOf('function renderLibrary()'));
  let lockMessage='';
  const locked=vm.createContext({renderLocks:1,message(text){lockMessage=text;}});
  vm.runInContext(loader,locked);
  assert.equal(await vm.runInContext("loadSelection('default')",locked),false);
  assert.match(lockMessage,/cannot change during video export/);
  const secure=await published(webcrypto);
  assert.equal(secure.state.ready,true);
  const identity=JSON.parse(secure.state.identity);
  for(const face of faces) {
    assert.equal(identity.faces[face],createHash('sha256').update(secure.bytes(`skybox/${face}.png`)).digest('hex'));
  }
  const release=secure.api.acquireRenderLock();release();release();
  const strict=fixture(webcrypto);
  const asset=await vm.runInContext("loadImageAsset('skybox/px.png')",strict.context);
  assert.equal(asset.sha256,identity.faces.px,'Export-capable loads retain actual-byte hashing');
  assert.deepEqual(strict.caches,['no-store'],'Export-capable loads must verify fresh bytes');
  // Exercise the actual export planner without a browser: ready is not enough
  // when the lock also requires a verified environment identity.
  const viewerSource=fs.readFileSync(path.join(__dirname,'..','tesseract.js'),'utf8');
  const planner=viewerSource.slice(viewerSource.indexOf('function videoExportPlan() {'),viewerSource.indexOf('function updateVideoExportSummary()'));
  const fields={
    'video-export-resolution':'1280x720','video-export-format':'mp4',
    'video-export-quality':'standard','video-export-range':'full',
    'video-export-checkpoint':'60','video-export-scratch':''
  };
  const plannerContext=vm.createContext({
    videoExportDialog:{},loopTiming:{exact:true,frameCount:30},exportFps:30,
    VIDEO_QUALITY_BITS_PER_PIXEL:{standard:.07},
    document:{getElementById(id){return {value:fields[id]};}}
  });
  vm.runInContext(planner,plannerContext);
  for(const state of [{ready:false,identity:null},{ready:true,identity:null},{ready:true,identity:secure.state.identity}]) {
    plannerContext.skyboxLibrary={getRenderState(){return state;}};
    const plan=vm.runInContext('videoExportPlan()',plannerContext);
    if(!state.ready)assert.match(plan.error,/finish loading/);
    else if(!state.identity)assert.match(plan.error,/verification requires HTTPS or localhost/);
    else assert.equal(plan.error,'');
  }
  const failed=await published({subtle:{digest:async()=>{throw new Error('injected digest failure');}}});
  assert.equal(failed.state.ready,false,'A failed available digest must not silently downgrade verification');
  assert.match(failed.status.textContent,/injected digest failure/);
  console.log('PASS: insecure published skyboxes load; export hashing stays mandatory; secure face hashes remain verified.');
})().catch(error=>{console.error(error);process.exitCode=1;});
