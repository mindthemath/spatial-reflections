/* Copyright 2026 Michael Pilosov. All rights reserved. */
const {ensureGuard}=require('./test_lifecycle.cjs');
ensureGuard(__filename,{network:true,timeout:180});
const {runBrowser,seedEnvironment}=require('./test_browser_fixture.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
runBrowser(async ({root,browser,context,page,port,errors})=>{
  const {folder}=await seedEnvironment(page,root);
  const viewer=page;await viewer.goto(`http://localhost:${port}/?skybox=exports/${folder}`);
  await viewer.waitForFunction(()=>document.querySelector('#skybox-status')?.textContent.includes('512 × 512px'));
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
   await viewer.waitForFunction(()=>document.querySelector('#video-export-status').textContent.includes('Export paused'),null,{timeout:10000}).catch(async error=>{throw new Error(`Encoder-failure UI: ${await viewer.locator('#video-export-status').innerText()}; errors: ${errors.join('; ')}`,{cause:error});});
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
  console.log('PASS: '+(process.env.TESSERACT_TEST_VIDEO_MODE||'resumable')+' video export, cancellation and recovery.');
}).catch(error=>{console.error(error);process.exitCode=1;});
