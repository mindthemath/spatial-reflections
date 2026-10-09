/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Browser integration test. Uses the Bun-managed Playwright dependency and never touches real raw/ or exports/.
const {ensureGuard,bounded,stopServer,installCleanup}=require('./test_lifecycle.cjs');
ensureGuard(__filename,{network:true,timeout:300});
const {chromium}=require('playwright');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn,spawnSync}=require('child_process');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-integration-'));
 fs.cpSync(__dirname,path.join(root,'studio'),{recursive:true});fs.mkdirSync(path.join(root,'raw'));
 for(const file of ['index.html','tesseract.js','viewer-skyboxes.js','skybox-paths.js','visual-music.js','visual-music-core.js'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
 fs.cpSync(path.join(__dirname,'..','vendor'),path.join(root,'vendor'),{recursive:true});
 const fixture=`
import signal,sys
sys.path.insert(0,${JSON.stringify(__dirname)})
import server
from pathlib import Path
server.ROOT=Path(${JSON.stringify(root)})
server.VIDEO_MODE=${JSON.stringify(process.env.TESSERACT_TEST_VIDEO_MODE || 'resumable')}
http=server.StudioHTTPServer(('localhost',0),server.Handler)
def stop(*_): raise KeyboardInterrupt()
signal.signal(signal.SIGTERM,stop)
try:
    print(http.server_port,flush=True)
    http.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.pause_all_videos()
    http.server_close()
`;
 const server=spawn('python3',['-c',fixture]);
 let browser,serverErrors='';
 // Drain stderr continuously. Per-frame HTTP logs must never fill the pipe and
 // block the test server; retain only a small diagnostic tail.
 server.stderr.on('data',data=>{serverErrors=(serverErrors+data.toString()).slice(-8192);});
 const cleanup=installCleanup(async()=>{
  try{if(browser)await bounded(browser.close(),10000,'Chromium shutdown');}
  finally{await stopServer(server);fs.rmSync(root,{recursive:true,force:true});}
 });
 try{
  const port=await bounded(new Promise((resolve,reject)=>{
   let output='';server.stdout.on('data',data=>{output+=data.toString();const line=output.split('\n')[0];if(/^\d+$/.test(line))resolve(Number(line));});
   server.once('error',reject);server.once('exit',code=>reject(new Error(`Test server exited (${code}): ${serverErrors}`)));
  }),10000,'Test server startup');
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),timeout:15000,args:['--renderer-process-limit=2','--use-gl=angle','--use-angle=swiftshader']});
  const context=await browser.newContext({viewport:{width:1700,height:1100}});
  const page=await context.newPage(),errors=[];let starting=true,failStartup;
  const startupFailure=new Promise((_,reject)=>{failStartup=reject;});
  page.on('pageerror',error=>{errors.push(error.message);if(starting)failStartup(new Error(`Studio startup page error: ${error.message}`));});
  page.on('response',response=>{if(starting&&response.status()>=400&&['script','stylesheet','image'].includes(response.request().resourceType()))failStartup(new Error(`Studio startup resource failed: ${response.status()} ${response.url()}`));});
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1536;c.height=1024;const ctx=c.getContext('2d'),g=ctx.createLinearGradient(0,0,1536,1024);g.addColorStop(0,'#203030');g.addColorStop(1,'#ffc080');ctx.fillStyle=g;ctx.fillRect(0,0,1536,1024);return c.toDataURL().split(',')[1];});
  fs.writeFileSync(path.join(root,'raw','a.png'),Buffer.from(image,'base64'));fs.writeFileSync(path.join(root,'raw','b.png'),Buffer.from(image,'base64'));
  await page.goto(`http://localhost:${port}/studio/`);await Promise.race([page.waitForSelector('.photo'),startupFailure]);starting=false;
  const center=async locator=>{const b=await locator.boundingBox();assert(b,'Element has bounds');return {x:b.x+b.width/2,y:b.y+b.height/2};};
  const drag=async(from,to)=>{const a=await center(from),b=await center(to);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:12});await page.mouse.up();};
  const capture=async()=>{const download=page.waitForEvent('download');await page.locator('#save').click();const d=await download;return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
  const key=async value=>{await page.locator('#fit').focus();await page.keyboard.press(value);};
  await page.locator('.photo').first().click();await page.locator('.photo').nth(1).click();
  await key('c');await key('l');await key('i');
  assert.equal(await page.locator('.node.crop').count(),1);assert.equal(await page.locator('.node.light').count(),1);assert.equal(await page.locator('.node.info').count(),1);
  // Whole node bodies are generous drop targets; precision ports remain available.
  await drag(page.locator('.node.source .output').first(),page.locator('.node.crop .body'));
  await drag(page.locator('.node.crop .output'),page.locator('.node.light .body'));
  for(const face of ['px','nx','py','ny','pz','nz'])await drag(page.locator('.node.light .output'),page.locator(`.node.skybox .input[data-input="${face}"]`));
  await drag(page.locator('.node.info .input'),page.locator('.node.light .output')); // reverse drag
  await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Preview ready'));
  await page.locator('.node.info .body').click();await page.waitForSelector('#info-detail .histogram');
  assert.match(await page.locator('#info-detail').innerText(),/Geometric mean/);
  // Click empty space clears selection without moving graph, including subthreshold pointer jitter.
  const before=await page.locator('#graph').getAttribute('style'),vp=await page.locator('#viewport').boundingBox();
  await page.mouse.click(vp.x+20,vp.y+vp.height-20);assert.equal(await page.locator('.node.selected').count(),0);assert.equal(await page.locator('#graph').getAttribute('style'),before);
  // Lightroom-style adjustment, undo/redo treats one range edit as one change.
  await page.locator('.node.light .body').click();const range=page.locator('#inspector input[type=range]').first();await range.fill('1.25');await range.dispatchEvent('change');
  assert.equal((await capture()).nodes.find(n=>n.type==='light').settings.exposure,1.25);
  await key('Control+z');assert.equal((await capture()).nodes.find(n=>n.type==='light').settings.exposure,0);
  await key('Control+Shift+z');assert.equal((await capture()).nodes.find(n=>n.type==='light').settings.exposure,1.25);
  // Duplicate/delete/undo via keyboard.
  await page.locator('.node.crop .body').click();await key('Control+d');assert.equal(await page.locator('.node.crop').count(),2);
  await key('Delete');assert.equal(await page.locator('.node.crop').count(),1);await key('Control+z');assert.equal(await page.locator('.node.crop').count(),2);await key('Control+Shift+z');
  // Rewire SOURCE endpoint through its selected cable handle.
  await page.locator('.node.skybox .input[data-input="px"]').click();await drag(page.locator('.edge-handle[data-end=from]'),page.locator('.node.source').nth(1));
  let snapshot=await capture(),cube=snapshot.nodes.find(n=>n.type==='skybox'),secondSource=snapshot.nodes.filter(n=>n.type==='source')[1];assert.equal(snapshot.edges.find(e=>e.to===cube.id&&e.input==='px').from,secondSource.id);
  await key('Control+z');snapshot=await capture();cube=snapshot.nodes.find(n=>n.type==='skybox');assert.equal(snapshot.nodes.find(n=>n.id===snapshot.edges.find(e=>e.to===cube.id&&e.input==='px').from).type,'light');
  // Move DESTINATION endpoint to replace another connection, then undo.
  await page.locator('.node.skybox .input[data-input="px"]').click();await drag(page.locator('.edge-handle[data-end=to]'),page.locator('.node.skybox .cube-input[data-input="nx"]'));
  snapshot=await capture();cube=snapshot.nodes.find(n=>n.type==='skybox');assert(!snapshot.edges.some(e=>e.to===cube.id&&e.input==='px'));await key('Control+z');
  // Drop connected input on empty space to disconnect, restore via undo.
  const input=await center(page.locator('.node.skybox .input[data-input="px"]'));await page.mouse.move(input.x,input.y);await page.mouse.down();await page.mouse.move(vp.x+30,vp.y+vp.height-30,{steps:10});await page.mouse.up();
  snapshot=await capture();cube=snapshot.nodes.find(n=>n.type==='skybox');assert(!snapshot.edges.some(e=>e.to===cube.id&&e.input==='px'));await key('Control+z');
  // Invalid cycle drop preserves the existing cable.
  const original=await capture();await drag(page.locator('.node.light .output'),page.locator('.node.crop .input'));assert.deepEqual((await capture()).edges,original.edges);
  // Resizing changes both sidebar and 3D dimensions.
  const width=await page.locator('#preview').evaluate(e=>e.clientWidth),divider=await center(page.locator('#preview-resizer'));
  await page.mouse.move(divider.x,divider.y);await page.mouse.down();await page.mouse.move(divider.x-100,divider.y,{steps:8});await page.mouse.up();assert((await page.locator('#preview').evaluate(e=>e.clientWidth))>width+80);
  const height=await page.locator('#three').evaluate(e=>e.clientHeight),heightDivider=await center(page.locator('#preview-height-resizer'));
  await page.mouse.move(heightDivider.x,heightDivider.y);await page.mouse.down();await page.mouse.move(heightDivider.x,heightDivider.y+80,{steps:8});await page.mouse.up();assert((await page.locator('#three').evaluate(e=>e.clientHeight))>height+60);
  await page.waitForFunction(()=>document.querySelector('#resolution-limit').textContent==='≤ 1024px');
  assert.equal(await page.locator('#size option[value="2048"]').count(),0);
  await page.locator('#size').selectOption('512');await page.locator('#export').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Saved '),{timeout:30000});
  const folder=fs.readdirSync(path.join(root,'exports'))[0],manifest=JSON.parse(fs.readFileSync(path.join(root,'exports',folder,'manifest.json')));
  assert.equal(Object.keys(manifest.outputs).length,6);assert.equal(Object.keys(manifest.analysis).length,1);assert(fs.existsSync(path.join(root,'exports',folder,'analysis.json')));
  assert.equal(manifest.pipeline.schemaVersion,3);assert.equal(manifest.pipeline.resolutionReport.maxSide,1024);assert.equal(manifest.pipeline.nodes.filter(n=>n.type==='skybox').length,1);assert.equal(manifest.pipeline.nodes.find(n=>n.type==='light').settings.exposure,1.25);
  assert.equal(manifest.thumbnail,'preview.png');assert(await page.locator('#view-export').isVisible());
  // Studio -> viewer handoff, gallery loading, shader prompt, persistent selection and failure retention.
  fs.mkdirSync(path.join(root,'skybox'));for(const face of ['px','nx','py','ny','pz','nz']){
   const image=path.join(root,'exports',folder,`${face}.png`);
   fs.copyFileSync(image,path.join(root,'raw',`${face}.png`));
   fs.copyFileSync(image,path.join(root,'skybox',`${face}.png`));
  }
  const broken=path.join(root,'exports','broken-fixture');fs.cpSync(path.join(root,'exports',folder),broken,{recursive:true});
  const badManifest=JSON.parse(JSON.stringify(manifest));badManifest.pipeline.name='Broken fixture';fs.writeFileSync(path.join(broken,'manifest.json'),JSON.stringify(badManifest));fs.writeFileSync(path.join(broken,'px.png'),'not a PNG');
  const publishedPiece={schemaVersion:1,slug:'published-test',title:'Published test',size:512,skybox:Object.fromEntries(['px','nx','py','ny','pz','nz'].map(face=>[face,`skybox/${face}.png`])),viewer:{panelExpanded:true,animationPaused:true}};
  const publishedHTML=fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<script id="piece-config" type="application/json"></script>',`<script id="piece-config" type="application/json">${JSON.stringify(publishedPiece)}</script>`);
  fs.writeFileSync(path.join(root,'published.html'),publishedHTML);
  const published=await page.context().newPage();published.on('pageerror',e=>errors.push(e.message));await published.goto(`http://localhost:${port}/published.html`);await published.waitForSelector('#controlPanel');
  assert(await published.locator('#controlPanelContent').isHidden());assert.equal(await published.locator('#controlPanelHeader > button[aria-controls]').getAttribute('aria-label'),'Open controls');
  assert.equal(await published.locator('#open-video-export, #video-export-dialog').count(),0);assert.deepEqual(await published.evaluate(()=>[typeof viewer.listExports,typeof viewer.loadSkybox,'loadSkybox(folder)' in viewer.describe().methods]),['undefined','undefined',false]);assert((await published.locator('#controlPanel').boundingBox()).width<=67);await published.locator('#controlPanelHeader > button[aria-controls]').click();assert(await published.locator('#controlPanelContent').isVisible());await published.close();
  // iOS-like autoplay: resume() only starts audio inside an activating gesture, and touch-down is not one.
  fs.writeFileSync(path.join(root,'autoplay.html'),publishedHTML.replace(JSON.stringify(publishedPiece),JSON.stringify({...publishedPiece,viewer:{...publishedPiece.viewer,music:{enabled:true},musicAutoplay:true}})));
  const autoplay=await page.context().newPage();autoplay.on('pageerror',e=>errors.push(e.message));
  await autoplay.addInitScript(()=>{Object.defineProperty(navigator,'audioSession',{value:{type:'auto'}});const real=AudioContext.prototype.resume,waiting=[];AudioContext.prototype.resume=function(){if(!navigator.userActivation.isActive||window.event?.type==='pointerdown')return new Promise(resolve=>waiting.push(resolve));return real.call(this).then(()=>waiting.splice(0).forEach(resolve=>resolve()));};});
  await autoplay.goto(`http://localhost:${port}/autoplay.html`);await autoplay.waitForFunction(()=>/waiting for a click/.test(document.querySelector('.music-status')?.textContent));
  assert.equal(await autoplay.locator('#sound-toggle').getAttribute('aria-label'),'Play soundtrack');
  await autoplay.mouse.click(400,300);await autoplay.waitForFunction(()=>document.querySelector('.music-start').disabled);
  assert.equal(await autoplay.locator('#sound-toggle').getAttribute('aria-label'),'Mute soundtrack');assert(await autoplay.locator('#sound-toggle').isVisible());
  await autoplay.locator('#sound-toggle').click();assert.equal(await autoplay.locator('#sound-toggle').getAttribute('aria-pressed'),'false');assert(!(await autoplay.locator('.music-start').isDisabled()));
  await autoplay.locator('#sound-toggle').click();await autoplay.waitForFunction(()=>document.querySelector('#sound-toggle').getAttribute('aria-pressed')==='true');
  assert.equal(await autoplay.evaluate(()=>navigator.audioSession.type),'playback');await autoplay.close();
  const viewer=await page.context().newPage();viewer.on('pageerror',e=>errors.push(e.message));await viewer.goto(await page.locator('#view-export').getAttribute('href'));
  await viewer.waitForFunction(()=>document.querySelector('#skybox-status')?.textContent.includes('512 × 512px'));
  assert.equal(await viewer.locator('#active-skybox').innerText(),'untitled');assert.equal(await viewer.locator('#viewer-shader').inputValue(),'chrome');
  await viewer.locator('#viewer-shape').selectOption('rectified-5-cell');
  assert.equal(await viewer.evaluate(()=>JSON.parse(localStorage.getItem('tesseract.viewer-settings.v1')).shape),'rectified-5-cell');
  await viewer.reload();await viewer.waitForSelector('#viewer-shape');assert.equal(await viewer.locator('#viewer-shape').inputValue(),'rectified-5-cell');
  await viewer.screenshot({path:path.join(os.tmpdir(),'rectified-5-cell.png')});
  await viewer.locator('#viewer-shape').selectOption('tesseract');
  const dragOverlay=await viewer.evaluate(()=>{
   const zone=document.getElementById('drop-zone');
   const emit=type=>window.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,clientX:200,clientY:200}));
   emit('dragenter');emit('dragover');const shown=zone.style.display;
   emit('dragleave');const left=zone.style.display;
   emit('dragenter');emit('dragover');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
   return {shown,left,cancelled:zone.style.display};
  });
  assert.deepEqual(dragOverlay,{shown:'block',left:'none',cancelled:'none'});
  // Video export defaults to a 30s clip inside the loop, and still rejects an empty window before encoding.
  const simpleVideo=process.env.TESSERACT_TEST_VIDEO_MODE==='simple';
  assert.equal(await viewer.locator('.visual-music > details').evaluate(details=>details.open),false);
  if(simpleVideo){await viewer.locator('.visual-music > details > summary').click();await viewer.locator('.music-preset').selectOption('abyssdrive');await viewer.locator('.music-start').click();}
  await viewer.locator('#rotation-xw').fill('10');await viewer.locator('details').filter({hasText:'Video timing'}).locator('summary').click();
  await viewer.locator('#open-video-export').click();await viewer.waitForSelector('#video-export-dialog[open]');await viewer.waitForFunction(()=>document.querySelector('#video-export-dialog').dataset.serverAvailable==='yes'||document.querySelector('#video-export-status').classList.contains('error'));
  assert.deepEqual(await viewer.locator('#video-export-dialog').evaluate(dialog=>JSON.parse(dialog.dataset.encoderRecovery)),{recovered:0,alreadyExited:0,refused:0,skippedActive:0,failed:0,indexFailed:false});
  const renderEnvironment=await viewer.locator('#video-export-dialog').evaluate(dialog=>JSON.parse(JSON.parse(dialog.dataset.renderSignature).environment));assert.equal(renderEnvironment.kind,'export');assert.equal(Object.keys(renderEnvironment.faces).length,6);assert(Object.values(renderEnvironment.faces).every(hash=>/^[a-f0-9]{64}$/.test(hash)));
  if(!simpleVideo){assert.equal(await viewer.locator('#video-export-checkpoint').inputValue(),'60');assert(await viewer.locator('#video-export-scratch').isVisible());}
  assert.equal(await viewer.locator('#video-export-range').inputValue(),'clip');assert.match(await viewer.locator('#video-export-summary').innerText(),/Clip/);assert.match(await viewer.locator('#video-export-summary').innerText(),/30\.00 s/);assert.match(await viewer.locator('#video-export-summary').innerText(),/estimated MP4 size/);
  await viewer.locator('#video-export-range').selectOption('full');assert(!(await viewer.locator('#video-export-clip-fields').isVisible()));assert.equal(await viewer.locator('#video-export-range option[value="full"]').innerText(),'Whole loop');assert.doesNotMatch(await viewer.locator('#video-export-summary').innerText(),/[Pp]erfect/);
  if(!simpleVideo){await viewer.locator('#video-export-checkpoint').fill('0');assert.match(await viewer.locator('#video-export-summary').innerText(),/No checkpoints/);assert.match(await viewer.locator('#video-export-summary').innerText(),/restarts from frame 0/);}
  await viewer.locator('#video-export-range').selectOption('clip');assert(await viewer.locator('#video-export-clip-fields').isVisible());if(!simpleVideo)await viewer.locator('#video-export-checkpoint').fill('60');
  await viewer.locator('#video-export-duration').fill('5');assert.match(await viewer.locator('#video-export-status').innerText(),/5\.00 s clip is selected/);
  await viewer.locator('#video-export-format').selectOption('mkv');assert.match(await viewer.locator('#video-export-summary').innerText(),/H\.264 MKV/);
  await viewer.locator('#video-export-range').selectOption('clip');await viewer.locator('#video-export-duration').fill('0');assert.match(await viewer.locator('#video-export-summary').innerText(),/at least one frame/);
  // Exercise the complete browser → streamed PNG → ffmpeg path when ffmpeg is available on the test host.
  if(await viewer.evaluate(()=>document.querySelector('#video-export-dialog').dataset.serverAvailable==='yes'&&document.querySelector('#video-export-dialog').dataset.videoMode!=='simple')){
   await viewer.locator('#video-export-duration').fill('0.02');await viewer.locator('#video-export-resolution').selectOption('1280x720');await viewer.locator('#video-export-quality').selectOption('draft');
   await viewer.locator('#confirm-video-export').click();await viewer.waitForSelector('#video-export-result a',{timeout:30000});assert.match(await viewer.locator('#video-export-status').innerText(),/^Export complete/);assert(fs.readdirSync(path.join(root,'videos')).some(file=>file.endsWith('.mkv')));
   let pauseAcknowledged=false;
   await viewer.route('**/api/video/pause',async route=>{
    await new Promise(resolve=>setTimeout(resolve,400));
    const response=await route.fetch();
    pauseAcknowledged=true;
    await route.fulfill({response});
   },{times:1});
   await viewer.locator('#video-export-name').fill('browser-pause');
   await viewer.locator('#video-export-duration').fill('2');
   await viewer.locator('#confirm-video-export').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('Rendering + encoding'));
   assert.equal(await viewer.locator('#video-resume-jobs').evaluate(section=>section.inert),true);
   await viewer.locator('#cancel-video-export').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('paused'));
   assert(pauseAcknowledged,'pause UI completed before the server acknowledged it');
   const pausedCard=viewer.locator('.video-resume-job').filter({hasText:'browser-pause'});
   await pausedCard.waitFor();assert(!(await pausedCard.locator('.resume-video-export').isDisabled()));
   assert.equal(await viewer.locator('#video-resume-jobs').evaluate(section=>section.inert),false);
   const savedPause=await viewer.evaluate(()=>fetch('/api/video/jobs').then(response=>response.json()).then(value=>value.jobs.find(job=>job.request.name==='browser-pause').request));
   await viewer.locator('#video-export-name').fill('wrong-new-export');await viewer.locator('#video-export-resolution').selectOption('1920x1080');
   await viewer.locator('#video-export-format').selectOption('mp4');await viewer.locator('#video-export-quality').selectOption('high');
   await viewer.locator('#video-export-checkpoint').fill('120');await viewer.locator('#video-export-duration').fill('0.5');
   await pausedCard.locator('.resume-video-export').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('Rendering + encoding'));
   assert.equal(await viewer.locator('#video-export-name').inputValue(),'browser-pause');
   assert.equal(await viewer.locator('#video-export-resolution').inputValue(),'1280x720');
   assert.equal(await viewer.locator('#video-export-format').inputValue(),'mkv');assert.equal(await viewer.locator('#video-export-quality').inputValue(),'draft');
   assert.equal(await viewer.locator('#video-export-checkpoint').inputValue(),'60');assert.equal(await viewer.locator('#video-export-duration').inputValue(),'0:02.000');
   assert.match(await viewer.locator('#video-export-summary').innerText(),/Resuming saved export/);
   assert((await viewer.locator('#video-export-summary').innerText()).includes(`${savedPause.frames.toLocaleString()} frames`));
   await viewer.locator('#cancel-video-export').click();await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('paused'));
   await pausedCard.locator('.discard-video-export').click();await viewer.locator('#confirm-action-accept').click();await pausedCard.waitFor({state:'detached'});

   await viewer.locator('#video-export-name').fill('browser-cancel');
   await viewer.locator('#video-export-duration').fill('2');
   await viewer.locator('#confirm-video-export').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('Rendering + encoding'));
   await viewer.locator('#discard-active-video-export').click();await viewer.locator('#confirm-action-accept').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('cancelled and discarded'));
   assert.equal(await viewer.evaluate(()=>fetch('/api/video/jobs').then(response=>response.json()).then(value=>value.jobs.length)),0);
   assert(!fs.readdirSync(path.join(root,'videos')).some(file=>file.startsWith('browser-cancel-')));
   await viewer.route('**/api/video/frame?*',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'injected frame failure'})}),{times:1});
   await viewer.route('**/api/video/pause',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'injected pause failure'})}),{times:1});
   await viewer.locator('#video-export-name').fill('browser-failed-pause');await viewer.locator('#video-export-duration').fill('0.02');
   await viewer.locator('#confirm-video-export').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('Could not pause'));
   assert.doesNotMatch(await viewer.locator('#video-export-status').innerText(),/Export paused/);
   const failedPause=viewer.locator('.video-resume-job').filter({hasText:'browser-failed-pause'});await failedPause.waitFor();
   await failedPause.locator('.discard-video-export').click();await viewer.locator('#confirm-action-accept').click();await failedPause.waitFor({state:'detached'});
   await viewer.route('**/api/video/frame?*',async route=>{
    const query=new URL(route.request().url()).searchParams;
    const paused=await context.request.post(`http://localhost:${port}/api/video/pause`,{data:{id:query.get('id'),lease:query.get('lease'),reason:'libx264 diagnostic: injected scratch full'}});
    assert(paused.ok());await route.fulfill({status:400,json:{error:'Checkpoint encoder failed'}});
   },{times:1});
   await viewer.locator('#video-export-name').fill('browser-encoder-failure');await viewer.locator('#confirm-video-export').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('Export paused'));
   assert.doesNotMatch(await viewer.locator('#video-export-status').innerText(),/Could not pause|lease is no longer active/);
   const encoderFailure=viewer.locator('.video-resume-job').filter({hasText:'browser-encoder-failure'});await encoderFailure.waitFor();
   assert.match(await encoderFailure.innerText(),/libx264 diagnostic: injected scratch full/);
   await encoderFailure.locator('.discard-video-export').click();await viewer.locator('#confirm-action-accept').click();await encoderFailure.waitFor({state:'detached'});
   const pausedId=await viewer.evaluate(async()=>{
    const dialog=document.querySelector('#video-export-dialog'),signature=dialog.dataset.renderSignature;
    const request={name:'browser-resume',width:1280,height:720,fps:60,frames:1,quality:'draft',format:'mp4',checkpointSeconds:60,sourceUrl:location.pathname+location.search,renderSignature:signature,startFrame:0,loopFrameCount:1,loopPeriod:0,timeStep:0,viewerState:{}};
    const started=await fetch('/api/video/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json());
    await fetch('/api/video/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:started.id,lease:started.lease})});
    return started.id;
   });
   await viewer.locator('#close-video-export').click();await viewer.locator('#open-video-export').click();await viewer.waitForSelector(`.video-resume-job[data-job-id="${pausedId}"]`);
   await viewer.locator(`.video-resume-job[data-job-id="${pausedId}"] .resume-video-export`).click();await viewer.waitForSelector('#video-export-result a',{timeout:30000});assert(fs.readdirSync(path.join(root,'videos')).some(file=>file.startsWith('browser-resume-')&&file.endsWith('.mp4')));
   // Legacy signatures cannot resume rendering, but fully durable jobs must
   // finalize through the actual UI without requiring a matching environment.
   const legacyId=await viewer.evaluate(async()=>{
    const signature=JSON.parse(document.querySelector('#video-export-dialog').dataset.renderSignature);delete signature.environment;
    const request={name:'browser-legacy-finalize',width:64,height:64,fps:24,frames:1,quality:'draft',format:'mp4',checkpointSeconds:1,sourceUrl:location.pathname+location.search,renderSignature:JSON.stringify(signature),viewerState:{}};
    const start=await fetch('/api/video/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
    if(!start.ok)throw new Error(await start.text());
    const started=await start.json();
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;canvas.getContext('2d').fillRect(0,0,64,64);
    const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const frame=await fetch(`/api/video/frame?id=${started.id}&frame=0&lease=${started.lease}`,{method:'POST',headers:{'Content-Type':'image/png'},body:png});
    if(!frame.ok)throw new Error(await frame.text());
    await fetch('/api/video/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:started.id,lease:started.lease})});
    return started.id;
   });
   const finalizeContext=await browser.newContext({viewport:{width:800,height:600}}),finalizePage=await finalizeContext.newPage();
   finalizePage.on('pageerror',error=>errors.push(error.message));
   await finalizePage.goto(`http://localhost:${port}/?skybox=exports%2Fmissing-legacy-environment`);
   await finalizePage.waitForFunction(()=>document.querySelector('#skybox-status')?.classList.contains('error'));
   await finalizePage.route('**/api/video/capabilities',async route=>{
    const response=await route.fetch();const capabilities=await response.json();
    await route.fulfill({json:{...capabilities,available:false,canManage:true,reason:'injected missing libx264'}});
   });
   await finalizePage.locator('details').filter({hasText:'Video timing'}).locator('summary').click();
   await finalizePage.locator('#open-video-export').click();
   const legacy=finalizePage.locator(`.video-resume-job[data-job-id="${legacyId}"]`);await legacy.waitFor();
   assert.equal(await legacy.locator('.restore-video-export').count(),0);assert.equal(await legacy.locator('.resume-video-export').innerText(),'Finalize');
   await finalizePage.route('**/api/video/finish',async route=>{
    const request=route.request().postDataJSON();
    // Simulate a concat failure after the server consumed the rendering lease.
    const paused=await finalizeContext.request.post(`http://localhost:${port}/api/video/pause`,{data:{id:request.id}});
    assert(paused.ok());await route.fulfill({status:500,json:{error:'injected concat failure'}});
   });
   await legacy.locator('.resume-video-export').click();
   await finalizePage.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('Finalization failed; checkpoints retained'));
   assert.doesNotMatch(await finalizePage.locator('#video-export-status').innerText(),/Could not pause|lease is no longer active|Export paused/);
   await finalizePage.unroute('**/api/video/finish');await legacy.waitFor();
   await legacy.locator('.resume-video-export').click();await finalizePage.waitForSelector('#video-export-result a',{timeout:30000});
   assert(fs.readdirSync(path.join(root,'videos')).some(file=>file.startsWith('browser-legacy-finalize-')&&file.endsWith('.mp4')));
   await finalizeContext.close();
   const mismatchId=await viewer.evaluate(async()=>{
    const signature=JSON.parse(document.querySelector('#video-export-dialog').dataset.renderSignature);signature.shader='different-render';
    const request={name:'mismatch',width:1280,height:720,fps:60,frames:1,quality:'draft',format:'mp4',checkpointSeconds:60,sourceUrl:location.pathname+location.search,renderSignature:JSON.stringify(signature),startFrame:0,loopFrameCount:1,loopPeriod:0,timeStep:0,viewerState:{}};
    const started=await fetch('/api/video/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json());
    await fetch('/api/video/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:started.id,lease:started.lease})});
    return started.id;
   });
   await viewer.locator('#close-video-export').click();await viewer.locator('#open-video-export').click();const mismatch=viewer.locator(`.video-resume-job[data-job-id="${mismatchId}"]`);await mismatch.waitFor();assert(await mismatch.locator('.resume-video-export').isDisabled());assert.match(await mismatch.innerText(),/settings do not match/i);
   await mismatch.locator('.discard-video-export').click();await viewer.locator('#confirm-action-accept').click();await mismatch.waitFor({state:'detached'});
   const restorableId=await viewer.evaluate(async()=>{
    const dialog=document.querySelector('#video-export-dialog'),signature=dialog.dataset.renderSignature,viewerState=JSON.parse(localStorage.getItem('tesseract.viewer-settings.v1'));
    viewerState.panelExpanded=false;viewerState.videoTimingExpanded=false;viewerState.animationPaused=true;
    const request={name:'restore-settings',width:1280,height:720,fps:viewerState.exportFps,frames:1,quality:'high',format:'mkv',checkpointSeconds:120,sourceUrl:location.pathname+location.search,renderSignature:signature,startFrame:0,loopFrameCount:600,loopPeriod:0,timeStep:0,viewerState};
    const started=await fetch('/api/video/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json());
    await fetch('/api/video/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:started.id,lease:started.lease})});return started.id;
   });
   await viewer.locator('#close-video-export').click();await viewer.locator('#viewer-shader').selectOption('rough');await viewer.locator('#open-video-export').click();
   const restorable=viewer.locator(`.video-resume-job[data-job-id="${restorableId}"]`);await restorable.waitFor();assert(await restorable.locator('.resume-video-export').isDisabled());
   await viewer.locator('#video-export-resolution').selectOption('1920x1080');await viewer.locator('#video-export-quality').selectOption('high');
   await restorable.locator('.restore-video-export').click();await viewer.waitForFunction(id=>{const button=document.querySelector(`.video-resume-job[data-job-id="${id}"] .resume-video-export`);return button&&!button.disabled;},restorableId);assert.equal(await viewer.locator('#viewer-shader').inputValue(),'chrome');
   assert.equal(await viewer.locator('#video-export-resolution').inputValue(),'1280x720');assert.equal(await viewer.locator('#video-export-quality').inputValue(),'high');
   assert.equal(await viewer.locator('#video-export-name').inputValue(),'restore-settings');assert.equal(await viewer.locator('#video-export-format').inputValue(),'mkv');
   assert.equal(await viewer.locator('#video-export-checkpoint').inputValue(),'120');assert.equal(await viewer.locator('#video-export-range').inputValue(),'clip');
   assert.equal(await viewer.locator('#video-export-start').inputValue(),'0:00.000');
   assert.equal(await viewer.locator('#controlPanelContent').evaluate(element=>element.hidden),false);
   const restoredPreferences=await viewer.evaluate(()=>JSON.parse(localStorage.getItem('tesseract.viewer-settings.v1')));
   assert.equal(restoredPreferences.panelExpanded,true);assert.equal(restoredPreferences.videoTimingExpanded,true);
   await restorable.locator('.discard-video-export').click();await viewer.locator('#confirm-action-accept').click();await restorable.waitFor({state:'detached'});
  }
  if(await viewer.evaluate(()=>document.querySelector('#video-export-dialog').dataset.videoMode==='simple')){
   assert(await viewer.locator('#video-export-checkpoint').isHidden());assert(await viewer.locator('#video-export-scratch').isHidden());
   await viewer.evaluate(()=>{const select=document.getElementById('viewer-shape');select.value='rectified-5-cell';select.dispatchEvent(new Event('change',{bubbles:true}));});
   await viewer.locator('#video-export-name').fill('simple-browser');await viewer.locator('#video-export-start').fill('0.5');await viewer.locator('#video-export-duration').fill('0.02');
   assert.match(await viewer.locator('#video-export-summary').innerText(),/SIMPLE MODE/);assert.match(await viewer.locator('#video-export-summary').innerText(),/generative AAC soundtrack/);
   await viewer.locator('#video-export-resolution').selectOption('1280x720');await viewer.locator('#video-export-format').selectOption('mp4');await viewer.locator('#video-export-quality').selectOption('draft');
   await viewer.locator('#confirm-video-export').click();
   await viewer.waitForFunction(()=>['complete','error'].includes(document.querySelector('#video-export-dialog').dataset.statusMode));
   assert.equal(await viewer.locator('#video-export-dialog').getAttribute('data-status-mode'),'complete',await viewer.locator('#video-export-status').innerText());
   await viewer.waitForSelector('#video-export-result a',{timeout:30000});
   const movie=fs.readdirSync(path.join(root,'videos')).find(file=>file.startsWith('simple-browser-')&&file.endsWith('.mp4'));assert(movie);
   const stem=path.join(root,'videos',movie.slice(0,-4));
   const metadata=JSON.parse(fs.readFileSync(`${stem}.json`,'utf8'));
   assert.equal(metadata.videoMode,'simple');assert.equal(metadata.poster.file,path.basename(`${stem}.png`));
   assert.equal(metadata.frames,1);assert(metadata.startFrame>0);assert(metadata.renderSignature);assert(metadata.viewerState);
   assert.equal(metadata.viewerState.shader,'chrome');assert.equal(metadata.viewerState.shape,'rectified-5-cell');
   assert.equal(metadata.viewerState.music.preset,'abyssdrive');assert.equal(metadata.viewerState.music.tension,.88);assert.equal(metadata.viewerState.music.layers.field,0);
   assert.equal(metadata.music.scoreHash.length,64);assert.equal(metadata.audio.codec,'pcm_s16le');assert(!('file' in metadata.audio));
   assert.equal(JSON.parse(metadata.renderSignature).shape,'rectified-5-cell');assert.equal(JSON.parse(metadata.renderSignature).music.preset,'abyssdrive');
   const probe=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name','-of','json',`${stem}.mp4`],{encoding:'utf8'});
   assert.equal(probe.status,0,probe.stderr);assert.deepEqual(JSON.parse(probe.stdout).streams.map(stream=>[stream.codec_type,stream.codec_name]),[['video','h264'],['audio','aac']]);
   const decodedAudio=spawnSync('ffmpeg',['-v','error','-i',`${stem}.mp4`,'-map','0:a:0','-f','s16le','-'],{maxBuffer:1024*1024});
   assert.equal(decodedAudio.status,0,decodedAudio.stderr.toString());assert(decodedAudio.stdout.some(byte=>byte!==0),'Generated soundtrack is audible, not silent PCM');
   await viewer.locator('#close-video-export').click();
   await viewer.locator('#viewer-shader').selectOption('rough');await viewer.locator('#rotation-xw').fill('3');await viewer.locator('#viewer-shape').selectOption('tesseract');
   const pngBase64=fs.readFileSync(`${stem}.png`).toString('base64');
   const restoreMessages=[];viewer.on('console',message=>{restoreMessages.push(message.text());if(restoreMessages.length>20)restoreMessages.shift();});
   await viewer.evaluate(({pngBase64,name})=>{
    const bytes=Uint8Array.from(atob(pngBase64),char=>char.charCodeAt(0));
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],name,{type:'image/png'}));
    window.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
   },{pngBase64,name:path.basename(`${stem}.png`)});
   try{await viewer.waitForFunction(frame=>{const state=JSON.parse(localStorage.getItem('tesseract.viewer-settings.v1'));return state.shader==='chrome'&&state.animationPaused&&state.timelineFrame===frame;},metadata.startFrame,{timeout:5000});}
   catch(error){throw new Error(`PNG restore failed: ${restoreMessages.join('\n')}\nSaved: ${await viewer.evaluate(()=>localStorage.getItem('tesseract.viewer-settings.v1'))}`,{cause:error});}
   const restored=await viewer.evaluate(()=>JSON.parse(localStorage.getItem('tesseract.viewer-settings.v1')));
   assert.equal(restored.shape,'rectified-5-cell');assert.equal(await viewer.locator('#viewer-shape').inputValue(),'rectified-5-cell');
   assert.deepEqual(restored.rotationCoefficients,metadata.viewerState.rotationCoefficients);
   assert.deepEqual(restored.camera,metadata.viewerState.camera);assert.equal(restored.exportFps,metadata.fps);
   assert.equal(restored.music.preset,'abyssdrive');assert.equal(await viewer.locator('.music-preset').inputValue(),'abyssdrive');
   await viewer.locator('#open-video-export').click();
   await viewer.locator('#video-export-name').fill('simple-browser-cancel');
   await viewer.locator('#video-export-duration').fill('2');await viewer.locator('#confirm-video-export').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('Rendering + encoding'));
   assert.equal(await viewer.locator('#cancel-video-export').innerText(),'Cancel export');assert(await viewer.locator('#discard-active-video-export').isHidden());
   await viewer.locator('#cancel-video-export').click();await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('cancelled and discarded'));
   assert(!fs.existsSync(path.join(root,'videos','.checkpoints')));assert(!fs.existsSync(path.join(root,'videos','.video-jobs.json')));
   assert(!fs.readdirSync(path.join(root,'videos')).some(file=>file.startsWith('.simple-')));
   assert(await viewer.locator('#video-resume-jobs').isHidden());
  }
  if(await viewer.locator('#video-export-dialog').isVisible())await viewer.locator('#close-video-export').click();
  const cameraBefore=await viewer.locator('#viewer-camera-info').innerText();
  await viewer.locator('#viewer-shader').selectOption('rough');assert(await viewer.locator('#switch-to-chrome').isVisible());
  await viewer.locator('#default-skybox').click();await viewer.locator('#confirm-action-accept').click();
  try{await viewer.waitForFunction(()=>document.querySelector('#active-skybox').textContent==='Default skybox');}
  catch(error){throw new Error(`Default skybox failed: ${await viewer.locator('#skybox-status').textContent()}; page errors: ${errors.join('; ')}`,{cause:error});}
  assert.equal(await viewer.locator('#viewer-camera-info').innerText(),cameraBefore);assert.equal(await viewer.locator('#viewer-shader').inputValue(),'rough');
  await viewer.locator('#browse-skyboxes').click();await viewer.waitForSelector('.skybox-card');
  await viewer.locator('.skybox-card').filter({has:viewer.locator('strong',{hasText:'untitled'})}).getByRole('button',{name:'Load skybox'}).click();
  await viewer.waitForFunction(()=>document.querySelector('#active-skybox').textContent==='untitled');assert.equal(await viewer.locator('#viewer-shader').inputValue(),'rough');
  await viewer.locator('#switch-to-chrome').click();assert.equal(await viewer.locator('#viewer-shader').inputValue(),'chrome');assert(!(await viewer.locator('#switch-to-chrome').isVisible()));
  let publishRequest=null;await viewer.route('**/api/publish',async route=>{publishRequest=route.request().postDataJSON();await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({url:'/site/work/save-video/'})});});
  let viewerDownloads=0;viewer.on('download',()=>viewerDownloads++);await viewer.locator('#publish-skybox').click();
  assert.equal(await viewer.locator('#publish-settings-source').inputValue(),'defaults');assert.equal(await viewer.locator('#publish-start-frame').inputValue(),'1');
  assert.equal(await viewer.locator('#publish-animation-autoplay').inputValue(),'no');assert.equal(await viewer.locator('#publish-music-autoplay').inputValue(),'no');
  await viewer.locator('#publish-title').fill('');await viewer.locator('#publish-title').pressSequentially('save video');await viewer.waitForTimeout(100);
  assert.equal(await viewer.locator('#publish-title').inputValue(),'save video');assert.equal(viewerDownloads,0);
  await viewer.locator('#publish-settings-source').selectOption('current');await viewer.locator('#publish-start-frame').fill('42');
  await viewer.locator('#publish-animation-autoplay').selectOption('yes');await viewer.locator('#publish-music-autoplay').selectOption('yes');
  await viewer.locator('#confirm-publish').click();await viewer.waitForFunction(()=>document.querySelector('#publish-result a'));
  assert.equal(publishRequest.viewerState.timelineFrame,41);assert.equal(publishRequest.viewerState.animationPaused,false);assert.equal(publishRequest.viewerState.music.enabled,true);assert.equal(publishRequest.viewerState.musicAutoplay,true);assert.equal(publishRequest.viewerState.shader,'chrome');
  await viewer.unroute('**/api/publish');await viewer.locator('#close-publish').click();
  const validURL=viewer.url();await viewer.locator('#browse-skyboxes').click();await viewer.waitForSelector('.skybox-card');
  await viewer.screenshot({path:path.join(os.tmpdir(),'tesseract-library.png')});
  await viewer.locator('.skybox-card').filter({has:viewer.locator('strong',{hasText:'Broken fixture'})}).getByRole('button',{name:'Load skybox'}).click();
  await viewer.waitForFunction(()=>document.querySelector('#skybox-status').textContent.includes('Kept the current environment'));
  assert.equal(await viewer.locator('#active-skybox').innerText(),'untitled');assert.equal(viewer.url(),validURL);assert.equal(await viewer.locator('#viewer-camera-info').innerText(),cameraBefore);
  await viewer.locator('#close-skyboxes').click();const editURL=await viewer.locator('#edit-skybox').getAttribute('href');
  await viewer.goto(`http://localhost:${port}/`);await viewer.waitForFunction(()=>document.querySelector('#active-skybox')?.textContent==='untitled');assert(viewer.url().includes('skybox=exports'));
  const editing=await page.context().newPage();editing.on('pageerror',e=>errors.push(e.message));editing.on('dialog',dialog=>dialog.accept());await editing.goto(editURL);
  await editing.waitForFunction(()=>document.querySelector('#resolution-limit')?.textContent==='≤ 1024px');assert.equal(await editing.locator('.node.skybox').count(),1);assert.equal(await editing.locator('.node.light').count(),1);
  await editing.waitForFunction(()=>!new URL(location.href).searchParams.has('pipeline'));assert(!editing.url().includes('pipeline='));
  await editing.locator('.node.light .body').click();const editExposure=editing.locator('#inspector input[type=range]').first();await editExposure.fill('2.5');await editExposure.dispatchEvent('change');
  await editing.reload();await editing.waitForSelector('.photo');assert.equal(await editing.evaluate(()=>JSON.parse(localStorage.getItem('skybox-studio.workspace.v2')).pipeline.nodes.find(n=>n.type==='light').settings.exposure),2.5);
  await editing.close();await viewer.close();
  // Processing tests run directly in-browser (Canvas API required).
  const processing=await page.evaluate(async()=>{
   const p=await import('./pipeline.js');const image=p.canvas(100,50),ctx=image.getContext('2d');ctx.fillStyle='rgb(128,128,128)';ctx.fillRect(0,0,100,50);
   const stats=p.statistics(image),neutral=p.light(image,p.lightDefaults(),100),bright=p.light(image,{...p.lightDefaults(),exposure:1},100);
   const pixel=c=>c.getContext('2d').getImageData(0,0,1,1).data[0];
   const v1={schemaVersion:1,renderer:'canvas2d-cover-v1',size:512,nodes:[{id:'old',type:'transform',x:0,y:0,transforms:{...p.cropDefaults(),exposure:1,contrast:1.2,saturation:0.8}},...p.FACES.map(face=>({id:face,type:'face',face,x:600,y:0}))],edges:[{from:'old',to:'px'}]};
   const migrated=p.validate(p.migrate(v1));let cycle=false;try{p.validate({...migrated,edges:[{from:'old',to:'old-light'},{from:'old-light',to:'old'}]});}catch{cycle=true;}
   return {mean:stats.luminance.mean,ev:stats.suggestedExposureTo18PercentGrayEV,width:stats.width,height:stats.height,neutral:pixel(neutral),bright:pixel(bright),migration:migrated.nodes.filter(n=>n.type==='crop'||n.type==='light').map(n=>n.type),cubeCount:migrated.nodes.filter(n=>n.type==='skybox').length,cycle};
  });
  assert(Math.abs(processing.mean-0.21586)<0.001);assert.equal(processing.width,100);assert.equal(processing.height,50);assert.equal(processing.neutral,128);assert(processing.bright>170);assert.deepEqual(processing.migration,['crop','light']);assert.equal(processing.cubeCount,1);assert(processing.cycle);
  // JSON round trip and multiple selection.
  snapshot=await capture();const json=path.join(root,'roundtrip.json');fs.writeFileSync(json,JSON.stringify(snapshot));await page.locator('#snapshot').setInputFiles(json);
  await page.waitForTimeout(300);assert.equal(await page.locator('.node.info').count(),1);await key('Control+a');assert.equal(await page.locator('.node.selected').count(),snapshot.nodes.length);
  await key('Escape');assert.equal(await page.locator('.node.selected').count(),0);await key('?');assert(await page.locator('#shortcut-guide').isVisible());await page.locator('#close-shortcuts').click();
  // Cube remains permanent through direct deletion and duplication commands.
  await page.locator('.node.skybox .body').click();await key('Delete');assert.equal(await page.locator('.node.skybox').count(),1);
  await key('Control+d');assert.equal(await page.locator('.node.skybox').count(),1);assert(!(await page.locator('#inspector').innerText()).includes('Delete node'));
  await page.locator('.node.info .body').click();await page.waitForSelector('#info-detail .histogram');
  assert.equal(await page.locator('#workspace').evaluate(e=>getComputedStyle(e).userSelect),'none');
  const countBeforeReload=await page.locator('.node').count(),widthBeforeReload=await page.locator('#preview').evaluate(e=>e.clientWidth),heightBeforeReload=await page.locator('#three').evaluate(e=>e.clientHeight);
  await page.waitForFunction(()=>document.querySelector('#autosave-status').textContent==='Autosaved');await page.reload();await page.waitForSelector('.photo');
  assert.equal(await page.locator('.node').count(),countBeforeReload);assert.equal((await capture()).nodes.find(n=>n.type==='light').settings.exposure,1.25);
  assert(Math.abs((await page.locator('#preview').evaluate(e=>e.clientWidth))-widthBeforeReload)<3);assert(Math.abs((await page.locator('#three').evaluate(e=>e.clientHeight))-heightBeforeReload)<3);
  assert.equal(await page.locator('#autosave-status').innerText(),'Restored · autosaved');await page.locator('.node.info .body').click();await page.waitForSelector('#info-detail .histogram');
  await page.screenshot({path:process.env.STUDIO_SCREENSHOT||path.join(os.tmpdir(),'skybox-studio-v2.png')});
  // An old browser draft also migrates on page load, not only through JSON import.
  snapshot=await capture();const legacy=JSON.parse(JSON.stringify(snapshot)),oldCube=legacy.nodes.find(n=>n.type==='skybox');legacy.schemaVersion=2;legacy.name='legacy-migration-check';
  legacy.nodes=legacy.nodes.filter(n=>n.type!=='skybox');for(const [i,face]of ['px','nx','py','ny','pz','nz'].entries())legacy.nodes.push({id:`face-${face}`,type:'face',face,x:oldCube.x,y:oldCube.y+i*140});
  legacy.edges=legacy.edges.map(e=>e.to===oldCube.id?{from:e.from,to:`face-${e.input}`}:{...e});
  const legacyContext=await browser.newContext({viewport:{width:1700,height:1100}}),legacyPage=await legacyContext.newPage();legacyPage.on('pageerror',e=>errors.push(e.message));
  await legacyPage.addInitScript(value=>localStorage.setItem('skybox-studio.workspace.v2',JSON.stringify({pipeline:value,selection:['face-px']})),legacy);
  await legacyPage.goto(`http://localhost:${port}/studio/`);await legacyPage.waitForSelector('.photo');assert.equal(await legacyPage.locator('#name').inputValue(),'legacy-migration-check');
  assert.equal(await legacyPage.locator('.node.skybox').count(),1);assert.equal(await legacyPage.locator('.node.face').count(),0);assert.equal(await legacyPage.locator('.cube-input .state').filter({hasText:'CONNECTED'}).count(),6);
  await legacyPage.waitForTimeout(400);const migratedDraft=await legacyPage.evaluate(()=>JSON.parse(localStorage.getItem('skybox-studio.workspace.v2')).pipeline);assert.equal(migratedDraft.schemaVersion,3);assert.equal(migratedDraft.edges.filter(e=>e.input).length,6);
  await legacyContext.close();
  // Reset is explicit, confirmed and leaves source files / exported lineage untouched.
  page.once('dialog',dialog=>dialog.accept());await page.locator('#reset-workspace').click();
  assert.equal(await page.locator('.node').count(),1);assert.equal(await page.locator('.node.skybox').count(),1);assert.equal((await capture()).edges.length,0);assert(await page.locator('#undo').isDisabled());
  assert(fs.existsSync(path.join(root,'exports',folder,'pipeline.json')));assert(fs.existsSync(path.join(root,'raw','a.png')));
  await Promise.all([page.waitForEvent('load'),page.locator('#reload-app').click()]);await page.waitForSelector('.photo');assert.equal(await page.locator('.node').count(),1);assert.equal((await capture()).edges.length,0);
  assert.deepEqual(errors,[]);console.log('PASS: Studio graph/export, viewer gallery, publish-dialog keyboard isolation, offline vendored runtime, failure retention, persistence and Studio reopen.');
 }finally{await cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
