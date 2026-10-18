/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Shared isolation and cleanup only; scenarios live in the domain test files.
const {bounded,stopServer,installCleanup}=require('./test_lifecycle.cjs');
const {chromium}=require('playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');

async function runBrowser(test){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'spatial-test-'));
 let browser,server,serverErrors='';
 const errors=[];
 const cleanup=installCleanup(async()=>{
  try{if(browser)await bounded(browser.close(),10000,'Chromium shutdown');}
  finally{try{if(server)await stopServer(server);}finally{fs.rmSync(root,{recursive:true,force:true});}}
 });
 try{
  fs.cpSync(__dirname,path.join(root,'studio'),{recursive:true});fs.mkdirSync(path.join(root,'raw'));
  for(const file of ['index.html','tesseract.js','viewer-skyboxes.js','skybox-paths.js','visual-music.js','visual-music-core.js'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
  fs.cpSync(path.join(__dirname,'..','vendor'),path.join(root,'vendor'),{recursive:true});
  const fixture=`
import signal,sys
sys.path.insert(0,${JSON.stringify(__dirname)})
import server
from pathlib import Path
server.ROOT=Path(${JSON.stringify(root)})
server.VIDEO_MODE=${JSON.stringify(process.env.TESSERACT_TEST_VIDEO_MODE||'resumable')}
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
  server=spawn('python3',['-c',fixture]);
  server.stderr.on('data',data=>{serverErrors=(serverErrors+data.toString()).slice(-8192);});
  const port=await bounded(new Promise((resolve,reject)=>{
   let output='';server.stdout.on('data',data=>{output+=data.toString();const line=output.split('\n')[0];if(/^\d+$/.test(line))resolve(Number(line));});
   server.once('error',reject);server.once('exit',code=>reject(new Error(`Test server exited (${code}): ${serverErrors}`)));
  }),10000,'Test server startup');
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),timeout:15000,args:['--renderer-process-limit=2','--use-gl=angle','--use-angle=swiftshader']});
  const watchContext=context=>{
   context.on('console',message=>{if(/Shader Error|WebGLProgram/.test(message.text()))errors.push(message.text().slice(0,500));});
   context.on('page',page=>{
    page.on('pageerror',error=>errors.push(error.message));
    page.on('response',response=>{if(response.status()>=400&&['script','stylesheet'].includes(response.request().resourceType()))errors.push(`Resource failed: ${response.status()} ${response.url()}`);});
   });
  };
  const context=await browser.newContext({viewport:{width:1700,height:1100}});watchContext(context);
  const page=await context.newPage();
  await test({root,browser,context,page,port,errors});
  assert.deepEqual(errors,[],'browser must not hide JavaScript or shader errors');
 }catch(error){
  if(serverErrors)console.error('Test server diagnostics:\n'+serverErrors);
  throw error;
 }finally{await cleanup();}
}

// App/video fixtures do not drive Studio's UI just to obtain six valid PNGs.
// The actual Studio -> export -> viewer handoff remains in test_studio_browser.
async function seedEnvironment(page,root){
 const image=Buffer.from(await page.evaluate(()=>{
  const c=document.createElement('canvas');c.width=c.height=512;
  const ctx=c.getContext('2d'),g=ctx.createLinearGradient(0,0,512,512);
  g.addColorStop(0,'#203030');g.addColorStop(1,'#ffc080');ctx.fillStyle=g;ctx.fillRect(0,0,512,512);
  return c.toDataURL().split(',')[1];
 }),'base64');
 const faces=['px','nx','py','ny','pz','nz'],folder='test-environment';
 const output=path.join(root,'exports',folder);
 fs.mkdirSync(output,{recursive:true});fs.mkdirSync(path.join(root,'skybox'));
 for(const face of faces)for(const directory of [output,path.join(root,'raw'),path.join(root,'skybox')])fs.writeFileSync(path.join(directory,`${face}.png`),image);
 const manifest={schemaVersion:3,createdAt:new Date().toISOString(),pipeline:{name:'untitled',size:512,nodes:[]},outputs:Object.fromEntries(faces.map(face=>[face,{file:`${face}.png`,sha256:createHash('sha256').update(image).digest('hex')}]))};
 fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest));
 const broken=path.join(root,'exports','broken-fixture');fs.cpSync(output,broken,{recursive:true});
 fs.writeFileSync(path.join(broken,'manifest.json'),JSON.stringify({...manifest,pipeline:{...manifest.pipeline,name:'Broken fixture'}}));
 fs.writeFileSync(path.join(broken,'px.png'),'not a PNG');
 return {folder,manifest};
}
module.exports={runBrowser,seedEnvironment};
