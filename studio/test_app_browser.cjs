/* Copyright 2026 Michael Pilosov. All rights reserved. */
const {ensureGuard}=require('./test_lifecycle.cjs');
ensureGuard(__filename,{network:true,timeout:180});
const {runBrowser,seedEnvironment}=require('./test_browser_fixture.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
runBrowser(async ({root,browser,context,page,port,errors})=>{
  const {folder}=await seedEnvironment(page,root);
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
  await autoplay.goto(`http://localhost:${port}/autoplay.html?soundframe=1080p`);await autoplay.waitForFunction(()=>/waiting for a click/.test(document.querySelector('.music-status')?.textContent));
  assert.equal(await autoplay.locator('#sound-toggle').getAttribute('aria-label'),'Play soundtrack');
  await autoplay.mouse.click(400,300);await autoplay.waitForFunction(()=>document.querySelector('.music-start').disabled);
  // Live analysis reads the offscreen sound frame (here forced to 16:9) and drives the score.
  await autoplay.evaluate(()=>{viewer.setState({rotationCoefficients:{xw:0.5}});viewer.play();});await autoplay.waitForFunction(()=>/frame drives \d+% motion/.test(document.querySelector('.music-status').textContent),null,{timeout:10000}).catch(async error=>{throw new Error(`Live soundtrack stalled: ${await autoplay.locator('.music-status').textContent()}; page errors: ${errors.join('; ')}`,{cause:error});});
  assert.equal(await autoplay.locator('#sound-toggle').getAttribute('aria-label'),'Mute soundtrack');assert(await autoplay.locator('#sound-toggle').isVisible());
  await autoplay.locator('#sound-toggle').click();assert.equal(await autoplay.locator('#sound-toggle').getAttribute('aria-pressed'),'false');assert(!(await autoplay.locator('.music-start').isDisabled()));
  await autoplay.locator('#sound-toggle').click();await autoplay.waitForFunction(()=>document.querySelector('#sound-toggle').getAttribute('aria-pressed')==='true');
  assert.equal(await autoplay.evaluate(()=>navigator.audioSession.type),'playback');await autoplay.close();
  const viewer=await page.context().newPage();viewer.on('pageerror',e=>errors.push(e.message));await viewer.goto(`http://localhost:${port}/?skybox=exports/${folder}`);
  await viewer.waitForFunction(()=>document.querySelector('#skybox-status')?.textContent.includes('512 × 512px'));
  assert.equal(await viewer.locator('#active-skybox').innerText(),'untitled');assert.equal(await viewer.locator('#viewer-shader').inputValue(),'chrome');
  assert(!(await viewer.locator('#viewer-mirror-reflections').isChecked()),'experimental reflections start off');
  await viewer.evaluate(()=>viewer.setState({mirrorReflections:true}));
  assert(await viewer.locator('#viewer-mirror-reflections').isChecked());
  await viewer.locator('#viewer-shape').selectOption('rectified-5-cell');
  assert.equal(await viewer.evaluate(()=>JSON.parse(localStorage.getItem('tesseract.viewer-settings.v1')).shape),'rectified-5-cell');
  await viewer.reload();await viewer.waitForSelector('#viewer-shape');assert.equal(await viewer.locator('#viewer-shape').inputValue(),'rectified-5-cell');
  assert(await viewer.locator('#viewer-mirror-reflections').isChecked(),'reflection setting survives reload');
  await viewer.evaluate(()=>viewer.setState({mirrorReflections:false}));
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
  await viewer.locator('#close-skyboxes').click();
  await viewer.goto(`http://localhost:${port}/`);await viewer.waitForFunction(()=>document.querySelector('#active-skybox')?.textContent==='untitled');assert(viewer.url().includes('skybox=exports'));
  await viewer.close();
  console.log('PASS: app publication, live audio, settings, gallery, publishing and failure retention.');
}).catch(error=>{console.error(error);process.exitCode=1;});
