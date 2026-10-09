/* Copyright 2026 Michael Pilosov. All rights reserved. */
// window.studio / window.viewer agent API. Isolated temp root and server; never touches real raw/ or exports/.
const {ensureGuard,bounded,stopServer,installCleanup}=require('./test_lifecycle.cjs');
ensureGuard(__filename,{network:true,timeout:180});
const {chromium}=require('playwright');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-api-'));
 fs.cpSync(__dirname,path.join(root,'studio'),{recursive:true});fs.mkdirSync(path.join(root,'raw'));
 for(const file of ['index.html','tesseract.js','viewer-skyboxes.js','skybox-paths.js','visual-music.js','visual-music-core.js'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
 fs.cpSync(path.join(__dirname,'..','vendor'),path.join(root,'vendor'),{recursive:true});
 const fixture=`
import signal,sys
sys.path.insert(0,${JSON.stringify(__dirname)})
import server
from pathlib import Path
server.ROOT=Path(${JSON.stringify(root)})
http=server.StudioHTTPServer(('localhost',0),server.Handler)
def stop(*_): raise KeyboardInterrupt()
signal.signal(signal.SIGTERM,stop)
try:
    print(http.server_port,flush=True)
    http.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    http.server_close()
`;
 const server=spawn('python3',['-c',fixture]);
 let browser,serverErrors='';
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
  const page=await (await browser.newContext({viewport:{width:1400,height:900}})).newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const png=(width,height)=>page.evaluate(([w,h])=>{const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d'),g=ctx.createLinearGradient(0,0,w,h);g.addColorStop(0,'#203030');g.addColorStop(1,'#ffc080');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);return c.toDataURL().split(',')[1];},[width,height]);
  fs.writeFileSync(path.join(root,'raw','photo.png'),Buffer.from(await png(1536,1024),'base64'));
  const face=Buffer.from(await png(64,64),'base64');for(const name of ['px','nx','py','ny','pz','nz'])fs.writeFileSync(path.join(root,'raw',`${name}.png`),face);
  const call=(fn,arg)=>page.evaluate(fn,arg);
  const rejects=(fn,pattern,arg)=>assert.rejects(call(fn,arg),pattern);

  // Studio: build, edit, validate, undo and export through window.studio only.
  await page.goto(`http://localhost:${port}/studio/`);await call(()=>studio.ready);
  assert(await call(()=>studio.describe().methods['export()']));assert(await call(()=>studio.describe().guidance.length));
  assert.match(await page.locator('#agent-note').textContent(),/studio\.describe\(\)/);
  assert((await call(()=>studio.library())).some(item=>item.path==='raw/photo.png'));
  const ids=await call(()=>{
   const source=studio.addNode('source',{source:'photo.png'}),frame=studio.addNode('frame',{settings:{zoom:2}}),light=studio.addNode('light',{settings:{exposure:99}});
   studio.connect(source,frame);studio.connect(frame,light);return {source,frame,light};
  });
  let pipeline=(await call(()=>studio.getState())).pipeline;
  assert.equal(pipeline.nodes.find(n=>n.id===ids.frame).settings.zoom,2);assert.equal(pipeline.nodes.find(n=>n.id===ids.light).settings.exposure,5,'settings are clamped');
  assert.equal(await page.locator(`[data-id="${ids.frame}"][role="group"]`).count(),1);
  await rejects(()=>studio.addNode('source',{source:'missing.jpg'}),/not in the library/);
  await rejects(id=>studio.connect(id,'skybox-output'),/needs a face/,ids.light);
  await rejects(({light,source})=>studio.connect(light,source),/rejected/,ids);
  await rejects(id=>studio.setParams(id,{sharpness:1}),/Unknown frame setting "sharpness"/,ids.frame);
  assert.deepEqual(await call(id=>studio.setParams(id,{zoom:9,flipX:true}),ids.frame),{zoom:5,panX:0,panY:0,rotation:0,flipX:true,flipY:false});
  await call(()=>studio.undo());assert.equal((await call(()=>studio.getState())).pipeline.nodes.find(n=>n.id===ids.frame).settings.zoom,2,'undo restores');
  await call(()=>studio.redo());assert.equal((await call(()=>studio.getState())).pipeline.nodes.find(n=>n.id===ids.frame).settings.zoom,5);
  await call(id=>{for(const face of ['px','nx','py','ny','pz','nz'])studio.connect(id,'skybox-output',face);},ids.light);
  await call(()=>studio.setName('agent test'));await call(()=>studio.idle());
  const state=await call(()=>studio.getState());
  assert.equal(state.pipeline.name,'agent test');assert.equal(state.resolution.complete,true);assert.match(state.status,/Preview ready/);
  const folder=await call(()=>studio.export());
  assert.match(folder,/^exports\/agent-test-/);assert(fs.existsSync(path.join(root,folder,'manifest.json')));
  await rejects(()=>studio.reset(),/Pass \{force: true\}/);
  await call(()=>studio.reset({force:true}));assert.equal((await call(()=>studio.getState())).pipeline.nodes.length,1);
  await call(p=>studio.loadPipeline(p),pipeline);assert.equal((await call(()=>studio.getState())).pipeline.nodes.length,4);

  // Viewer: settings drive the visible controls, persist, and load the Studio export.
  await page.goto(`http://localhost:${port}/`);await call(()=>viewer.ready);
  assert.equal((await call(()=>viewer.getState())).ready,true);assert(await call(()=>viewer.describe().guidance.length));
  assert.match(await page.locator('#agent-note').textContent(),/viewer\.describe\(\)/);
  await call(()=>viewer.setState({shader:'rough',lighting:'quad',rotationCoefficients:{xw:0.5},shape:'rectified-5-cell'}));
  assert.equal(await page.locator('#viewer-shader').inputValue(),'rough');assert.equal(await page.locator('#viewer-lighting').inputValue(),'quad');
  assert.equal(await page.locator('#rotation-xw').inputValue(),'10');assert.equal(await page.locator('#viewer-shape').inputValue(),'rectified-5-cell');
  assert.equal(JSON.parse(await call(()=>localStorage.getItem('tesseract.viewer-settings.v1'))).shader,'rough','persisted like a manual edit');
  assert.equal(await page.getByLabel('Shader Type:').count(),1);
  await rejects(()=>viewer.setState({shader:'glass'}),/shader must be one of/);
  await rejects(()=>viewer.setState({zoom:2}),/Unknown setting zoom/);
  await call(()=>viewer.play());assert.equal((await call(()=>viewer.getState())).animationPaused,false);
  await call(()=>viewer.pause());
  assert((await call(()=>viewer.listExports())).some(entry=>entry.folder===folder));
  assert.equal((await call(f=>viewer.loadSkybox(f),folder)).skybox,folder);
  await rejects(()=>viewer.loadSkybox('exports/missing'),/manifest is missing/);
  const shot=await call(()=>viewer.screenshot({maxSize:200}));
  assert.match(shot,/^data:image\/png;base64,/);
  assert(await call(src=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(Math.max(image.width,image.height)<=200);image.src=src;}),shot));
  assert.deepEqual(errors,[]);
  console.log('PASS: studio and viewer agent APIs build, validate, undo, export, persist and load through the normal UI paths.');
 }finally{await cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
