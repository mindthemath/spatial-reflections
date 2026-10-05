// Browser integration test. Uses the Bun-managed Playwright dependency and never touches real raw/ or exports/.
const {chromium}=require('playwright');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-integration-'));
 fs.cpSync(__dirname,path.join(root,'studio'),{recursive:true});fs.mkdirSync(path.join(root,'raw'));
 for(const file of ['index.html','tesseract.js','viewer-skyboxes.js','skybox-paths.js'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
 fs.cpSync(path.join(__dirname,'..','vendor'),path.join(root,'vendor'),{recursive:true});
 const server=spawn('python3',['-c',`import sys;sys.path.insert(0,${JSON.stringify(__dirname)});import server;from pathlib import Path;server.ROOT=Path(${JSON.stringify(root)});http=server.ThreadingHTTPServer(('localhost',0),server.Handler);print(http.server_port,flush=True);http.serve_forever()`]);
 let browser;
 try{
  const port=await new Promise((resolve,reject)=>{server.stdout.once('data',data=>resolve(Number(data.toString().trim())));server.once('error',reject);});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),args:['--use-gl=angle','--use-angle=swiftshader']});
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
  fs.mkdirSync(path.join(root,'skybox'));for(const face of ['px','nx','py','ny','pz','nz'])fs.copyFileSync(path.join(root,'exports',folder,`${face}.png`),path.join(root,'skybox',`${face}.png`));
  const broken=path.join(root,'exports','broken-fixture');fs.cpSync(path.join(root,'exports',folder),broken,{recursive:true});
  const badManifest=JSON.parse(JSON.stringify(manifest));badManifest.pipeline.name='Broken fixture';fs.writeFileSync(path.join(broken,'manifest.json'),JSON.stringify(badManifest));fs.writeFileSync(path.join(broken,'px.png'),'not a PNG');
  const viewer=await page.context().newPage();viewer.on('pageerror',e=>errors.push(e.message));await viewer.goto(await page.locator('#view-export').getAttribute('href'));
  await viewer.waitForFunction(()=>document.querySelector('#skybox-status')?.textContent.includes('512 × 512px'));
  assert.equal(await viewer.locator('#active-skybox').innerText(),'untitled');assert.equal(await viewer.locator('#viewer-shader').inputValue(),'chrome');
  // Video export defaults to a 30s clip inside the loop, and still rejects an empty window before encoding.
  await viewer.locator('#rotation-xw').fill('10');await viewer.locator('details').filter({hasText:'Video timing'}).locator('summary').click();
  await viewer.locator('#open-video-export').click();await viewer.waitForSelector('#video-export-dialog[open]');await viewer.waitForFunction(()=>document.querySelector('#video-export-dialog').dataset.serverAvailable==='yes'||document.querySelector('#video-export-status').classList.contains('error'));
  assert.deepEqual(await viewer.locator('#video-export-dialog').evaluate(dialog=>JSON.parse(dialog.dataset.encoderRecovery)),{recovered:0,alreadyExited:0,refused:0,skippedActive:0,failed:0,indexFailed:false});
  assert.equal(await viewer.locator('#video-export-checkpoint').inputValue(),'60');assert(await viewer.locator('#video-export-scratch').isVisible());
  assert.equal(await viewer.locator('#video-export-range').inputValue(),'clip');assert.match(await viewer.locator('#video-export-summary').innerText(),/Clip/);assert.match(await viewer.locator('#video-export-summary').innerText(),/30\.00 s/);assert.match(await viewer.locator('#video-export-summary').innerText(),/estimated MP4 size/);
  await viewer.locator('#video-export-range').selectOption('full');assert(!(await viewer.locator('#video-export-clip-fields').isVisible()));assert.equal(await viewer.locator('#video-export-range option[value="full"]').innerText(),'Whole loop');assert.doesNotMatch(await viewer.locator('#video-export-summary').innerText(),/[Pp]erfect/);
  await viewer.locator('#video-export-checkpoint').fill('0');assert.match(await viewer.locator('#video-export-summary').innerText(),/No checkpoints/);assert.match(await viewer.locator('#video-export-summary').innerText(),/restarts from frame 0/);
  await viewer.locator('#video-export-range').selectOption('clip');assert(await viewer.locator('#video-export-clip-fields').isVisible());await viewer.locator('#video-export-checkpoint').fill('60');
  await viewer.locator('#video-export-duration').fill('5');assert.match(await viewer.locator('#video-export-status').innerText(),/5\.00 s clip is selected/);
  await viewer.locator('#video-export-format').selectOption('mkv');assert.match(await viewer.locator('#video-export-summary').innerText(),/H\.264 MKV/);
  await viewer.locator('#video-export-range').selectOption('clip');await viewer.locator('#video-export-duration').fill('0');assert.match(await viewer.locator('#video-export-summary').innerText(),/at least one frame/);
  // Exercise the complete browser → streamed PNG → ffmpeg path when ffmpeg is available on the test host.
  if(await viewer.evaluate(()=>document.querySelector('#video-export-dialog').dataset.serverAvailable==='yes')){
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
   await viewer.locator('#cancel-video-export').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('paused'));
   assert(pauseAcknowledged,'pause UI completed before the server acknowledged it');
   const pausedCard=viewer.locator('.video-resume-job').filter({hasText:'browser-pause'});
   await pausedCard.waitFor();assert(!(await pausedCard.locator('.resume-video-export').isDisabled()));
   await pausedCard.locator('.discard-video-export').click();await viewer.locator('#confirm-action-accept').click();await pausedCard.waitFor({state:'detached'});

   await viewer.locator('#video-export-name').fill('browser-cancel');
   await viewer.locator('#video-export-duration').fill('2');
   await viewer.locator('#confirm-video-export').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('Rendering + encoding'));
   await viewer.locator('#discard-active-video-export').click();await viewer.locator('#confirm-action-accept').click();
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('cancelled and discarded'));
   assert.equal(await viewer.evaluate(()=>fetch('/api/video/jobs').then(response=>response.json()).then(value=>value.jobs.length)),0);
   assert(!fs.readdirSync(path.join(root,'videos')).some(file=>file.startsWith('browser-cancel-')));
   const pausedId=await viewer.evaluate(async()=>{
    const dialog=document.querySelector('#video-export-dialog'),signature=dialog.dataset.renderSignature;
    const request={name:'browser-resume',width:1280,height:720,fps:60,frames:1,quality:'draft',format:'mp4',checkpointSeconds:60,sourceUrl:location.pathname+location.search,renderSignature:signature,startFrame:0,loopFrameCount:1,loopPeriod:0,timeStep:0,viewerState:{}};
    const started=await fetch('/api/video/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json());
    await fetch('/api/video/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:started.id,lease:started.lease})});
    return started.id;
   });
   await viewer.locator('#close-video-export').click();await viewer.locator('#open-video-export').click();await viewer.waitForSelector(`.video-resume-job[data-job-id="${pausedId}"]`);
   await viewer.locator(`.video-resume-job[data-job-id="${pausedId}"] .resume-video-export`).click();await viewer.waitForSelector('#video-export-result a',{timeout:30000});assert(fs.readdirSync(path.join(root,'videos')).some(file=>file.startsWith('browser-resume-')&&file.endsWith('.mp4')));
   const mismatchId=await viewer.evaluate(async()=>{
    const request={name:'mismatch',width:1280,height:720,fps:60,frames:1,quality:'draft',format:'mp4',checkpointSeconds:60,sourceUrl:location.pathname+location.search,renderSignature:'different-render',startFrame:0,loopFrameCount:1,loopPeriod:0,timeStep:0,viewerState:{}};
    const started=await fetch('/api/video/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json());
    await fetch('/api/video/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:started.id,lease:started.lease})});
    return started.id;
   });
   await viewer.locator('#close-video-export').click();await viewer.locator('#open-video-export').click();const mismatch=viewer.locator(`.video-resume-job[data-job-id="${mismatchId}"]`);await mismatch.waitFor();assert(await mismatch.locator('.resume-video-export').isDisabled());assert.match(await mismatch.innerText(),/settings do not match/i);
   await mismatch.locator('.discard-video-export').click();await viewer.locator('#confirm-action-accept').click();await mismatch.waitFor({state:'detached'});
   const restorableId=await viewer.evaluate(async()=>{
    const dialog=document.querySelector('#video-export-dialog'),signature=dialog.dataset.renderSignature,viewerState=JSON.parse(localStorage.getItem('tesseract.viewer-settings.v1'));
    const request={name:'restore-settings',width:1280,height:720,fps:viewerState.exportFps,frames:1,quality:'draft',format:'mp4',checkpointSeconds:60,sourceUrl:location.pathname+location.search,renderSignature:signature,startFrame:0,loopFrameCount:1,loopPeriod:0,timeStep:0,viewerState};
    const started=await fetch('/api/video/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json());
    await fetch('/api/video/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:started.id,lease:started.lease})});return started.id;
   });
   await viewer.locator('#close-video-export').click();await viewer.locator('#viewer-shader').selectOption('rough');await viewer.locator('#open-video-export').click();
   const restorable=viewer.locator(`.video-resume-job[data-job-id="${restorableId}"]`);await restorable.waitFor();assert(await restorable.locator('.resume-video-export').isDisabled());
   await restorable.locator('.restore-video-export').click();await viewer.waitForFunction(id=>{const button=document.querySelector(`.video-resume-job[data-job-id="${id}"] .resume-video-export`);return button&&!button.disabled;},restorableId);assert.equal(await viewer.locator('#viewer-shader').inputValue(),'chrome');
   await restorable.locator('.discard-video-export').click();await viewer.locator('#confirm-action-accept').click();await restorable.waitFor({state:'detached'});
  }
  if(await viewer.locator('#video-export-dialog').isVisible())await viewer.locator('#close-video-export').click();
  const cameraBefore=await viewer.locator('#viewer-camera-info').innerText();
  await viewer.locator('#viewer-shader').selectOption('rough');assert(await viewer.locator('#switch-to-chrome').isVisible());
  await viewer.locator('#default-skybox').click();await viewer.locator('#confirm-action-accept').click();await viewer.waitForFunction(()=>document.querySelector('#active-skybox').textContent==='Default skybox');
  assert.equal(await viewer.locator('#viewer-camera-info').innerText(),cameraBefore);assert.equal(await viewer.locator('#viewer-shader').inputValue(),'rough');
  await viewer.locator('#browse-skyboxes').click();await viewer.waitForSelector('.skybox-card');
  await viewer.locator('.skybox-card').filter({has:viewer.locator('strong',{hasText:'untitled'})}).getByRole('button',{name:'Load skybox'}).click();
  await viewer.waitForFunction(()=>document.querySelector('#active-skybox').textContent==='untitled');assert.equal(await viewer.locator('#viewer-shader').inputValue(),'rough');
  await viewer.locator('#switch-to-chrome').click();assert.equal(await viewer.locator('#viewer-shader').inputValue(),'chrome');assert(!(await viewer.locator('#switch-to-chrome').isVisible()));
  let viewerDownloads=0;viewer.on('download',()=>viewerDownloads++);await viewer.locator('#publish-skybox').click();
  await viewer.locator('#publish-title').fill('');await viewer.locator('#publish-title').pressSequentially('save video');await viewer.waitForTimeout(100);
  assert.equal(await viewer.locator('#publish-title').inputValue(),'save video');assert.equal(viewerDownloads,0);await viewer.locator('#close-publish').click();
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
 }finally{if(browser)await browser.close();server.kill();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
