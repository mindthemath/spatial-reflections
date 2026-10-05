// Resume compatibility and asynchronous skybox refresh, no browser/network.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'..','tesseract.js'),'utf8');
const helpers=source.slice(source.indexOf('function refreshVideoEnvironmentState()'),source.indexOf('function videoExportPlanFromRequest('));
const signature=(environment='verified',shader='chrome')=>JSON.stringify({environment,shader});
const elements=new Map();
function element(){return {dataset:{},children:[],append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);},replaceChildren(){this.children=[];},addEventListener(){}};}
const section=element(),list=element();elements.set('video-resume-jobs',section);elements.set('video-resume-job-list',list);
let summaries=0,requests=[];
const context=vm.createContext({
 document:{getElementById(id){return elements.get(id);},createElement:element},
 videoExportDialog:{open:true,dataset:{statusMode:'ready'}},videoExportRunning:false,
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
 assert.equal(compatibility(job(),signature(null)).available,false);
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
 console.log('PASS: explicit legacy policy, meaningful restore, skybox-ready refresh, and stale-response suppression.');
})().catch(error=>{console.error(error);process.exitCode=1;});
