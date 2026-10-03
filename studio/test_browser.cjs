// Optional integration test. Requires Playwright; never touches the real raw/ or exports/.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-integration-'));
 fs.cpSync(__dirname,path.join(root,'studio'),{recursive:true});fs.mkdirSync(path.join(root,'raw'));
 const server=spawn('python3',['-c',`import sys;sys.path.insert(0,${JSON.stringify(__dirname)});import server;from pathlib import Path;server.ROOT=Path(${JSON.stringify(root)});http=server.ThreadingHTTPServer(('localhost',0),server.Handler);print(http.server_port,flush=True);http.serve_forever()`]);
 let browser;
 try{
  const port=await new Promise((resolve,reject)=>{server.stdout.once('data',data=>resolve(Number(data.toString().trim())));server.once('error',reject);});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),args:['--use-gl=angle','--use-angle=swiftshader']});
  const page=await browser.newPage({viewport:{width:1700,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=320;c.height=180;const ctx=c.getContext('2d'),g=ctx.createLinearGradient(0,0,320,180);g.addColorStop(0,'#203030');g.addColorStop(1,'#ffc080');ctx.fillStyle=g;ctx.fillRect(0,0,320,180);return c.toDataURL().split(',')[1];});
  fs.writeFileSync(path.join(root,'raw','a.png'),Buffer.from(image,'base64'));fs.writeFileSync(path.join(root,'raw','b.png'),Buffer.from(image,'base64'));
  await page.goto(`http://localhost:${port}/studio/`);await page.waitForSelector('.photo');
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
  await page.locator('#size').selectOption('512');await page.locator('#export').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Saved '),{timeout:30000});
  const folder=fs.readdirSync(path.join(root,'exports'))[0],manifest=JSON.parse(fs.readFileSync(path.join(root,'exports',folder,'manifest.json')));
  assert.equal(Object.keys(manifest.outputs).length,6);assert.equal(Object.keys(manifest.analysis).length,1);assert(fs.existsSync(path.join(root,'exports',folder,'analysis.json')));
  assert.equal(manifest.pipeline.schemaVersion,3);assert.equal(manifest.pipeline.nodes.filter(n=>n.type==='skybox').length,1);assert.equal(manifest.pipeline.nodes.find(n=>n.type==='light').settings.exposure,1.25);
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
  assert.deepEqual(errors,[]);console.log('PASS: cube output/protection, whole-node/face-row drops, rewiring, undo/redo, resize, lighting/statistics, export lineage, migration, refresh recovery, explicit reset and app reload.');
 }finally{if(browser)await browser.close();server.kill();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
