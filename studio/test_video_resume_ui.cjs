// Resume compatibility and asynchronous skybox refresh, no browser/network.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'..','tesseract.js'),'utf8');
const helpers=source.slice(source.indexOf('function refreshVideoEnvironmentState()'),source.indexOf('function videoExportPlanFromRequest('));
const signature=(environment='verified',shader='chrome')=>JSON.stringify({environment,shader});
const elements=new Map();
function element(){return {classList:{add(){},remove(){}},dataset:{},children:[],append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);},replaceChildren(){this.children=[];},addEventListener(){}};}
const section=element(),list=element();elements.set('video-resume-jobs',section);elements.set('video-resume-job-list',list);
let summaries=0,requests=[];
const context=vm.createContext({
 document:{getElementById(id){return elements.get(id);},createElement:element},
 videoExportDialog:{open:true,dataset:{statusMode:'ready',serverAvailable:'yes'}},videoExportRunning:false,
 videoExportDialogRequest:1,videoResumeJobsRequest:0,
 location:{pathname:'/',search:''},videoRenderSignature:()=>signature(),
 updateVideoExportSummary(){summaries++;},
 videoControlApi(){return new Promise((resolve,reject)=>requests.push({resolve,reject}));}
});
vm.runInContext(helpers,context);
const job=(sig=signature(),extras={})=>({id:'job',state:'paused',frames:30,nextFrame:0,request:{sourceUrl:'/',renderSignature:sig,viewerState:{}},...extras});
function compatibility(value,current=signature()){context.job=value;context.current=current;return vm.runInContext("videoResumeCompatibility(job,current,'/')",context);}
(async()=>{
 assert.equal(compatibility(job()).available,true);
 assert.equal(compatibility(job(signature('verified','rough'))).restore,true);
 const legacy=compatibility(job(JSON.stringify({shader:'chrome'})));
 assert.equal(legacy.available,false);assert.equal(legacy.restore,false);assert.match(legacy.reason,/predates verified/);
 const changed=compatibility(job(signature('other-skybox')));
 assert.equal(changed.available,false);assert.equal(changed.restore,false);assert.match(changed.reason,/original skybox/);
 assert.equal(compatibility(job(JSON.stringify({shader:'chrome'}),{nextFrame:30})).available,true,'Legacy finalization needs no new frames');
 assert.equal(compatibility(job(signature(),{state:'active'})).restore,false);
 const finalizing=compatibility(job(signature(),{state:'finalizing',nextFrame:30}));
 assert.equal(finalizing.available,false);assert.equal(finalizing.restore,false);assert.match(finalizing.reason,/being finalized/);
 assert.equal(compatibility(job(),signature(null)).available,false);
 context.job=job();context.current=signature();
 const noEncoder=vm.runInContext("videoResumeCompatibility(job,current,'/',false)",context);
 assert.equal(noEncoder.available,false);assert.equal(noEncoder.restore,false);assert.match(noEncoder.reason,/encoding is unavailable/);
 context.job=job(JSON.stringify({shader:'chrome'}),{nextFrame:30});
 assert.equal(vm.runInContext("videoResumeCompatibility(job,current,'/',false).available",context),true);
 // Restored video fields must be reflected in the visible selects.
 elements.set('video-export-resolution',{value:'1920x1080'});elements.set('video-export-quality',{value:'draft'});
 Object.assign(context,{motionStepSlider:null,motionStepLabel:null,rotationSpeed:.005,
  currentShader:'chrome',currentLighting:'quad',lightDistance:5,showVertices:false,
  exportFpsSelect:null,videoExportWidth:1280,videoExportHeight:720,videoExportQuality:'high'});
 vm.runInContext(source.slice(source.indexOf('function syncViewerControlsFromState()'),source.indexOf('const COEFFICIENT_SCALE')),context);
 vm.runInContext('syncViewerControlsFromState()',context);
 let restored;
 context.applyViewerSettings=settings=>{restored=settings;};
 vm.runInContext(source.slice(source.indexOf('function restoreVideoRenderSettings('),source.indexOf('function syncViewerControlsFromState()')),context);
 context.saved={shader:'chrome',videoExportWidth:1280,panelExpanded:false,videoTimingExpanded:false,animationPaused:true};
 vm.runInContext('restoreVideoRenderSettings(saved)',context);
 assert.equal(restored.shader,'chrome');assert.equal(restored.videoExportWidth,1280);
 for(const key of ['panelExpanded','videoTimingExpanded','animationPaused'])assert.equal(key in restored,false);
 assert.equal(context.saved.panelExpanded,false,'Stored provenance must not be mutated');
 assert.equal(elements.get('video-export-resolution').value,'1280x720');assert.equal(elements.get('video-export-quality').value,'high');
 vm.runInContext(source.slice(source.indexOf('function videoExportFailureMessage('),source.indexOf('async function runVideoExport(')),context);
 context.error=new Error('frame failure');context.stopError=new Error('encoder could not stop');
 const failedPause=vm.runInContext('videoExportFailureMessage(error,stopError,null,true)',context);
 assert.match(failedPause,/frame failure/);assert.match(failedPause,/Could not pause/);assert.doesNotMatch(failedPause,/Export paused/);
 assert.match(vm.runInContext('videoExportFailureMessage(error,null,null,true)',context),/Export paused/);
 assert.equal(vm.runInContext('videoExportFailureMessage(error,null,null,false)',context),'frame failure');
 context.stopError=new Error('Video export lease is no longer active');
 const failedFinish=vm.runInContext('videoExportFailureMessage(error,stopError,null,true,true)',context);
 assert.match(failedFinish,/Finalization failed; checkpoints retained/);assert.doesNotMatch(failedFinish,/Could not pause|Export paused/);
 assert.match(vm.runInContext('videoExportFailureMessage(error,stopError,null,true,false)',context),/Could not pause/);
 assert.match(vm.runInContext('videoExportFailureMessage(error,stopError,"discard",true,true)',context),/Could not cancel/);
 context.stopError=new Error('scratch unavailable');
 assert.match(vm.runInContext('videoExportFailureMessage(error,stopError,null,true,true)',context),/Could not pause.*scratch unavailable/);
 context.videoExportDialog.open=false;
 vm.runInContext('refreshVideoEnvironmentState()',context);
 assert.equal(requests.length,0);
 context.videoExportDialog.open=true;context.videoExportRunning=true;
 vm.runInContext('refreshVideoEnvironmentState()',context);assert.equal(requests.length,0);
 context.videoExportRunning=false;
 for(const mode of ['checking','error']) {
  context.videoExportDialog.dataset.statusMode=mode;
  vm.runInContext('refreshVideoEnvironmentState()',context);assert.equal(requests.length,0);
 }
 context.videoExportDialog.dataset.statusMode='ready';
 vm.runInContext('refreshVideoEnvironmentState()',context);
 assert.equal(requests.length,1);assert.equal(context.videoExportDialog.dataset.renderSignature,signature());
 requests.shift().resolve({jobs:[job()]});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(list.children[0].dataset.jobId,'job');assert.equal(summaries,5);
 // A loading-state request may finish after the ready-state request. Latest wins.
 const first=vm.runInContext('loadVideoResumeJobs()',context);
 const second=vm.runInContext('loadVideoResumeJobs()',context);
 requests[1].resolve({jobs:[job(signature(),{id:'latest'})]});await second;
 requests[0].resolve({jobs:[job(signature(),{id:'stale'})]});await first;
 assert.deepEqual(list.children.map(card=>card.dataset.jobId),['latest']);
 requests=[];
 const oldError=vm.runInContext('loadVideoResumeJobs()',context);
 const newer=vm.runInContext('loadVideoResumeJobs()',context);
 requests[1].resolve({jobs:[job(signature(),{id:'newer'})]});await newer;
 requests[0].reject(new Error('stale failure'));await oldError;
 assert.deepEqual(list.children.map(card=>card.dataset.jobId),['newer']);
 // A server lacking libx264 must still expose existing jobs for management.
 for(const id of ['video-export-range','video-export-start','video-export-duration','video-export-result','video-export-status'])elements.set(id,element());
 Object.assign(context,{loopTiming:{frameCount:30},exportFps:30,timelineFrame:0,formatTimeInput:String});
 context.videoExportDialog.showModal=function(){this.open=true;};
 vm.runInContext(source.slice(source.indexOf('async function openVideoExportDialog()'),source.indexOf('function refreshVideoEnvironmentState()')),context);
 requests=[];
 const opened=vm.runInContext('openVideoExportDialog()',context);
 requests[0].resolve({available:false,canManage:true,reason:'libx264 unavailable',freeBytes:1000});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.length,2);requests[1].resolve({jobs:[]});await opened;
 assert.equal(context.videoExportDialog.dataset.serverAvailable,'no');
 assert.equal(context.videoExportDialog.dataset.statusMode,'ready');
 assert.match(elements.get('video-export-status').textContent,/Completed checkpoints/);
 requests=[];
 const unavailable=vm.runInContext('openVideoExportDialog()',context);
 requests[0].resolve({available:false,canManage:false,reason:'server unavailable'});await unavailable;
 assert.equal(requests.length,1);assert.equal(context.videoExportDialog.dataset.statusMode,'error');
 let controls=[];
 context.videoControlApi=(url,options)=>{controls.push({url,body:JSON.parse(options.body)});return Promise.resolve({});};
 Object.assign(context,{activeVideoExportJob:{id:'known-job',lease:'nonce'},videoExportStopAction:'discard',videoExportStopPromise:null,videoExportStopJobId:null});
 vm.runInContext(source.slice(source.indexOf('function ensureVideoExportStopRequest()'),source.indexOf('function requestVideoExportCancellation()')),context);
 await vm.runInContext('ensureVideoExportStopRequest()',context);
 await vm.runInContext('ensureVideoExportStopRequest()',context);
 assert.equal(controls.length,1);assert.equal(controls[0].url,'/api/video/cancel');assert.deepEqual(controls[0].body,{id:'known-job',lease:'nonce'});
 console.log('PASS: resume/restore policy, verified-state refresh, stale-response suppression, leased cancellation and truthful pause errors.');
})().catch(error=>{console.error(error);process.exitCode=1;});
