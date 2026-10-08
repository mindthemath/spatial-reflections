// Saved export form/summary regressions, no browser/server/encoder.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','tesseract.js'),'utf8');
const elements=new Map();
for(const id of ['name','resolution','format','quality','range','checkpoint','scratch','start','duration','clip-fields','summary','status'])
 elements.set(`video-export-${id}`,{value:'stale',hidden:false,classList:{add(){},remove(){}}});
elements.set('confirm-video-export',{disabled:false});
const resolution=elements.get('video-export-resolution');resolution.options=[{value:'1920x1080'}];resolution.appendChild=option=>resolution.options.push(option);
const context=vm.createContext({
 document:{getElementById:id=>elements.get(id),createElement:()=>({})},loopTiming:{frameCount:1000},exportFps:60,
 formatTimeInput:seconds=>seconds.toFixed(3),formatBytes:String,formatBitRate:String,formatDuration:String,currentShader:'chrome',
 videoExportDialog:{dataset:{freeBytes:'1',serverAvailable:'yes',statusMode:'running'}},videoExportRunning:true,activeVideoExportPlan:null,
 videoExportPlan(){throw new Error('Running summary must not read new-export form defaults');}
});
vm.runInContext(source.slice(source.indexOf('function videoExportPlanFromRequest('),source.indexOf('function videoExportPlan()')),context);
vm.runInContext(source.slice(source.indexOf('function updateVideoExportSummary('),source.indexOf('function videoExportLabel(')),context);
const request={name:'saved movie',width:1280,height:720,fps:30,frames:900,startFrame:0,loopFrameCount:1000,
 format:'mkv',quality:'high',checkpointSeconds:120,scratchPath:'/saved/scratch',bitRate:456789,estimatedBytes:5000000};
context.request=request;
vm.runInContext('restoreVideoExportForm(request)',context);
for(const [id,value] of Object.entries({name:'saved movie',resolution:'1280x720',format:'mkv',quality:'high',range:'clip',
 checkpoint:'120',scratch:'/saved/scratch',start:'0.000',duration:'30.000'}))assert.equal(elements.get(`video-export-${id}`).value,value,id);
assert.equal(resolution.options.length,2,'Custom saved resolutions stay visible');
vm.runInContext('restoreVideoExportForm(request)',context);assert.equal(resolution.options.length,2);
context.activeVideoExportPlan=vm.runInContext('({...videoExportPlanFromRequest(request),resumed:true})',context);
vm.runInContext('updateVideoExportSummary()',context);
const summary=elements.get('video-export-summary').innerHTML;
assert.match(summary,/Resuming saved export/);assert.match(summary,/Clip · frames 0–899/);
assert.match(summary,/30 FPS · 900 frames/);assert.match(summary,/H\.264 MKV · High quality · 456789/);
assert.match(summary,/every 120 seconds/);assert.equal(elements.get('video-export-clip-fields').hidden,false);
assert.equal(elements.get('confirm-video-export').disabled,true);
context.request={...request,frames:1000};
assert.equal(vm.runInContext('videoExportPlanFromRequest(request).range',context),'full');
context.request={...request,startFrame:17};
vm.runInContext('restoreVideoExportForm(request)',context);
assert.equal(elements.get('video-export-start').value,'0.567');
context.request={...request,quality:'master',bitRate:50000000,estimatedBytes:100000000,music:{enabled:true}};
context.activeVideoExportPlan=vm.runInContext('({...videoExportPlanFromRequest(request),resumed:true})',context);
vm.runInContext('updateVideoExportSummary()',context);
assert.match(elements.get('video-export-summary').innerHTML,/Master · CRF 12 · slow · grain-tuned dark-detail AQ/);
assert.match(elements.get('video-export-summary').innerHTML,/no bitrate ceiling/);
console.log('PASS: saved export fields, zero-start clip classification, master profile and authoritative running summary.');
