import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FACES,LABELS,RENDERER,cropDefaults,lightDefaults,CROP_FIELDS,LIGHT_FIELDS,clone,url,canvas,evaluate,validate,migrate,clearImageCache,inspectResolution } from './pipeline.js';
import {RESOLUTION_PRESETS,planResolution} from './resolution.js';
import {normalizeExportFolder,exportFileURL,viewerURL} from '../skybox-paths.js';

const $=id=>document.getElementById(id),uid=()=>crypto.randomUUID();
function createWorkspace() {
    return {
        schemaVersion:3, name:'untitled', size:1024, resolutionMode:'max', requestedSize:1024, renderer:RENDERER,
        nodes:[{id:'skybox-output',type:'skybox',x:920,y:30}], edges:[],
        view:{x:20,y:20,scale:0.8}, layout:{previewWidth:380,previewHeight:250}
    };
}
let state=createWorkspace();
const STORAGE_KEY='skybox-studio.workspace.v2';
let recovered=null,recoveryError=null,draftTimer;
try{const text=localStorage.getItem(STORAGE_KEY);if(text){recovered=JSON.parse(text);state=validate(migrate(recovered.pipeline));}}catch(error){recoveryError=error.message;recovered=null;}
let library=[],selected=null,selectedEdge=null,pending=null,wireDrag=null,generation=0,analysis=new Map(),timer,exporting=false,resolutionProfile=null;
let latestExport=recovered?.latestExport||null;
let selectedNodes=new Set((Array.isArray(recovered?.selection)?recovered.selection:[]).filter(id=>state.nodes.some(n=>n.id===id))),history=[clone(state)],historyIndex=0;
selected=selectedNodes.has(recovered?.selectedId)?recovered.selectedId:[...selectedNodes].at(-1)||null;
function saveDraft(){
    clearTimeout(draftTimer);
    try{const savedAt=new Date().toISOString();localStorage.setItem(STORAGE_KEY,JSON.stringify({pipeline:snapshot(),selection:[...selectedNodes],selectedId:selected,latestExport,savedAt}));$('autosave-status').textContent=recovered?'Restored · autosaved':'Autosaved';$('autosave-status').classList.remove('error');$('autosave-status').title=`Saved in this browser at ${new Date(savedAt).toLocaleTimeString()}. Save JSON for a portable backup.`;}
    catch(error){$('autosave-status').textContent='Autosave unavailable';$('autosave-status').classList.add('error');$('autosave-status').title=error.message+' — use Save JSON.';}
}
function queueDraftSave(){clearTimeout(draftTimer);draftTimer=setTimeout(saveDraft,250);}
window.addEventListener('pagehide',saveDraft);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')saveDraft();});
function checkpoint(){
    saveDraft();const next=snapshot();const comparable=s=>JSON.stringify({nodes:s.nodes,edges:s.edges,name:s.name,resolutionMode:s.resolutionMode,requestedSize:s.requestedSize});
    if(comparable(next)===comparable(history[historyIndex]))return;
    history=history.slice(0,historyIndex+1);history.push(next);if(history.length>100)history.shift();historyIndex=history.length-1;updateHistoryButtons();
}
function updateHistoryButtons(){$('undo').disabled=historyIndex===0;$('redo').disabled=historyIndex===history.length-1;}
function undoRedo(direction){
    checkpoint();const next=historyIndex+direction;if(next<0||next>=history.length)return;
    const view=state.view,layout=state.layout;historyIndex=next;state=clone(history[next]);state.view=view;state.layout=layout;
    selectedNodes=new Set([...selectedNodes].filter(id=>state.nodes.some(n=>n.id===id)));if(!selectedNodes.has(selected))selected=[...selectedNodes].at(-1)||null;
    selectedEdge=null;pending=null;analysis.clear();$('name').value=state.name;resolutionProfile=null;updateResolutionControls();drawGraph();inspect();schedule();updateHistoryButtons();
}
function deleteSelection(){
    if(selectedEdge){state.edges=state.edges.filter(e=>edgeKey(e)!==selectedEdge);changed();return;}
    const ids=new Set([...selectedNodes].filter(id=>nodeById(id)?.type!=='skybox'));if(!ids.size)return;
    state.nodes=state.nodes.filter(n=>!ids.has(n.id));state.edges=state.edges.filter(e=>!ids.has(e.from)&&!ids.has(e.to));selectedNodes.clear();selected=null;changed();
}
function duplicateSelection(){
    const originals=state.nodes.filter(n=>selectedNodes.has(n.id)&&n.type!=='skybox');if(!originals.length)return;
    if(state.nodes.length+originals.length>300){status('Duplication would exceed the 300-node limit.',true);return;}
    const mapping=new Map(originals.map(n=>[n.id,uid()]));const copies=originals.map(n=>({...clone(n),id:mapping.get(n.id),x:n.x+40,y:n.y+40}));
    const edges=state.edges.filter(e=>mapping.has(e.to)).map(e=>({from:mapping.get(e.from)||e.from,to:mapping.get(e.to)}));
    state.nodes.push(...copies);state.edges.push(...edges);selectedNodes=new Set(copies.map(n=>n.id));selected=copies.at(-1).id;changed();
}
const nodeById=id=>state.nodes.find(n=>n.id===id),incoming=(id,input)=>state.edges.find(e=>e.to===id&&(input===undefined||e.input===input));
const status=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
const title=n=>({source:'PHOTO / SOURCE',crop:'FRAME / CROP',light:'LIGHT / COLOR',info:'IMAGE / INFO',skybox:'SKYBOX / CUBE OUTPUT'}[n.type]);
const edgeKey=e=>`${e.from}→${e.to}:${e.input||''}`;
function selectNode(id,additive=false){
    if(!additive)selectedNodes.clear();if(additive&&selectedNodes.has(id))selectedNodes.delete(id);else selectedNodes.add(id);
    selected=selectedNodes.has(id)?id:[...selectedNodes].at(-1)||null;selectedEdge=null;drawGraph();inspect();
}
function changed(){checkpoint();pending=null;selectedEdge=null;drawGraph();inspect();schedule();}

async function refreshLibrary(){
    const response=await fetch('/api/library');if(!response.ok)throw new Error('Library API unavailable. Start python3 studio/server.py instead of the static server.');
    library=(await response.json()).images;$('library').replaceChildren();
    for(const source of library){
        const button=document.createElement('button');button.className='photo';
        const img=document.createElement('img');img.src=url(source.path);img.loading='lazy';
        const label=document.createElement('span');label.textContent=source.path.slice(4);button.append(img,label);button.onclick=()=>addNode('source',source);$('library').append(button);
    }
    if(!library.length)$('library').textContent='No images yet. Add photos to raw/, then refresh.';
    status(`${library.length} source images available.`);
}
function addNode(type,source){
    if(state.nodes.length>=300){status('Node limit reached (300). Remove or consolidate nodes before adding more.',true);return;}
    const count=state.nodes.filter(n=>n.type===type).length;
    const node={id:uid(),type,x:{source:40,crop:300,light:550,info:550}[type],y:(type==='info'?450:30)+count*190};
    if(type==='source')node.source=clone(source);else if(type==='crop')node.settings=cropDefaults();else if(type==='light')node.settings=lightDefaults();
    state.nodes.push(node);selected=node.id;selectedNodes=new Set([node.id]);changed();
}
function drawGraph(){
    $('nodes').replaceChildren();
    for(const node of state.nodes){
        const el=document.createElement('article');el.className=`node ${node.type}${selectedNodes.has(node.id)?' selected':''}`;el.dataset.id=node.id;el.style.left=node.x+'px';el.style.top=node.y+'px';
        const header=document.createElement('h3');header.textContent=title(node);
        const body=document.createElement('div');body.className='body';
        if(node.type==='source'){
            const img=document.createElement('img');img.src=url(node.source.path);body.append(img,document.createTextNode(node.source.path));
        }else if(node.type==='crop')body.textContent=`Zoom ${node.settings.zoom.toFixed(2)} · ${node.settings.rotation}°`;
        else if(node.type==='light')body.textContent=node.legacy?'Legacy grade · preserved':`EV ${node.settings.exposure>=0?'+':''}${node.settings.exposure.toFixed(2)} · light & color`;
        else if(node.type==='info'){body.classList.add('info-summary');body.textContent=infoSummary(node.id);}
        else if(node.type==='skybox'){
            body.classList.add('cube-inputs');
            FACES.forEach((face,i)=>{const row=document.createElement('div');row.className='cube-input';row.dataset.input=face;const label=document.createElement('strong'),connection=document.createElement('span');label.textContent=`${face.toUpperCase()} · ${LABELS[face]}`;connection.className='state';connection.textContent=incoming(node.id,face)?'CONNECTED':'EMPTY';row.append(label,connection);body.append(row);el.append(port(node,'input',face,i));});
        }
        el.append(header,body);if(!['source','skybox'].includes(node.type))el.append(port(node,'input'));if(node.type!=='skybox')el.append(port(node,'output'));
        if(node.type==='info'){
            const data=document.createElement('button');data.className='data-port';data.textContent='ƒ';data.title='Structured statistics output · select to inspect / save JSON. Numeric wiring reserved for future nodes.';
            data.setAttribute('aria-label','Inspect statistics output');data.onclick=e=>{e.stopPropagation();selectNode(node.id);};el.append(data);
        }
        body.onclick=event=>selectNode(node.id,event.shiftKey);
        header.onpointerdown=event=>{
            if(event.button!==0)return;event.preventDefault();event.stopPropagation();
            if(event.shiftKey){if(selectedNodes.has(node.id))selectedNodes.delete(node.id);else selectedNodes.add(node.id);}
            else if(!selectedNodes.has(node.id))selectedNodes=new Set([node.id]);
            selected=selectedNodes.has(node.id)?node.id:[...selectedNodes].at(-1)||null;selectedEdge=null;
            document.querySelectorAll('.node').forEach(e=>e.classList.toggle('selected',selectedNodes.has(e.dataset.id)));inspect();
            const startX=event.clientX,startY=event.clientY,positions=state.nodes.filter(n=>selectedNodes.has(n.id)).map(n=>({n,x:n.x,y:n.y}));header.setPointerCapture(event.pointerId);
            header.onpointermove=move=>{
                const dx=(move.clientX-startX)/state.view.scale,dy=(move.clientY-startY)/state.view.scale;
                const minX=Math.min(...positions.map(p=>p.x)),minY=Math.min(...positions.map(p=>p.y));
                for(const p of positions){p.n.x=p.x+Math.max(-minX,dx);p.n.y=p.y+Math.max(-minY,dy);const element=document.querySelector(`[data-id="${CSS.escape(p.n.id)}"]`);element.style.left=p.n.x+'px';element.style.top=p.n.y+'px';}drawWires();
            };
            header.onpointerup=header.onpointercancel=()=>{header.onpointermove=null;checkpoint();};
        };
        $('nodes').append(el);
    }applyView();drawWires();queueDraftSave();
}
function infoSummary(id){const s=analysis.get(id);return !s?'Connect an image to analyze':s.error?s.error:`${s.width} × ${s.height}\nMean Y ${(s.luminance.mean*100).toFixed(1)}% · ΔEV ${s.suggestedExposureTo18PercentGrayEV.toFixed(2)}`;}
function port(node,direction,input,index=0){
    const button=document.createElement('button');button.className=`port ${direction}`;button.dataset.node=node.id;button.dataset.direction=direction;if(input)button.dataset.input=input;
    if(input)button.style.top=(45+index*31)+'px';if(pending===node.id&&direction==='output')button.classList.add('pending');
    button.title=direction==='output'?'Image output · click or drag to connect':`${input?input.toUpperCase()+' ':''}image input · drag to rewire`;button.setAttribute('aria-label',`${title(node)} ${input||''} ${direction}`);
    button.onpointerdown=event=>{
        if(event.button!==0)return;event.stopPropagation();event.preventDefault();const original=direction==='input'?incoming(node.id,input):null;
        beginWire(event,original?{side:'to',fixed:original.from,original}:{side:direction==='output'?'to':'from',fixed:node.id,fixedInput:input},()=>clickPort(node,direction,input));
    };
    button.onclick=event=>{event.stopPropagation();if(event.detail===0)clickPort(node,direction,input);};return button;
}
function clickPort(node,direction,input){
    if(direction==='output'){pending=pending===node.id?null:node.id;drawGraph();return;}
    if(pending){connect(pending,node.id,input);return;}
    const edge=incoming(node.id,input);if(edge){selected=null;selectedNodes.clear();selectedEdge=edgeKey(edge);drawGraph();inspect();}
    else status('Drag from an output to this input, or click output then input.');
}
function validConnection(from,to,input,original){
    if(!nodeById(from)||!nodeById(to)||nodeById(from).type==='skybox'||nodeById(to).type==='source'||from===to)return false;
    if(nodeById(to).type==='skybox'&&!FACES.includes(input))return false;if(nodeById(to).type!=='skybox'&&input!==undefined)return false;
    const edges=state.edges.filter(e=>e!==original&&!(e.to===to&&e.input===input)),seen=new Set();
    function reaches(id){if(id===from)return true;if(seen.has(id))return false;seen.add(id);return edges.filter(e=>e.from===id).some(e=>reaches(e.to));}return !reaches(to);
}
function connect(from,to,input,original){
    if(!validConnection(from,to,input,original)){status('Connection rejected: invalid image port or cycle. Existing wiring preserved.',true);drawWires();return false;}
    state.edges=state.edges.filter(e=>e!==original&&!(e.to===to&&e.input===input));state.edges.push(input===undefined?{from,to}:{from,to,input});changed();return true;
}
function graphPoint(event){const rect=$('viewport').getBoundingClientRect(),v=state.view;return {x:(event.clientX-rect.left-v.x)/v.scale,y:(event.clientY-rect.top-v.y)/v.scale};}
function resolveDropTarget(event,side){
    const element=document.elementFromPoint(event.clientX,event.clientY),expected=side==='to'?'input':'output',direct=element?.closest(`.port.${expected}`);
    if(direct)return {node:direct.dataset.node,input:direct.dataset.input};
    const nodeElement=element?.closest('.node');if(!nodeElement)return null;const node=nodeById(nodeElement.dataset.id);if(!node)return null;
    if(side==='from')return node.type==='skybox'?null:{node:node.id};
    if(node.type==='source')return null;
    if(node.type!=='skybox')return {node:node.id};
    const rows=[...nodeElement.querySelectorAll('.cube-input')];if(!rows.length)return null;
    const row=rows.reduce((best,current)=>Math.abs(current.getBoundingClientRect().top+current.getBoundingClientRect().height/2-event.clientY)<Math.abs(best.getBoundingClientRect().top+best.getBoundingClientRect().height/2-event.clientY)?current:best);
    return {node:node.id,input:row.dataset.input,row};
}
function beginWire(event,options,onClick){
    const start={x:event.clientX,y:event.clientY};let moved=false;
    const drag={...options,...graphPoint(event)};
    function move(e){
        if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>4)moved=true;
        if(!moved)return;
        wireDrag=drag;Object.assign(drag,graphPoint(e));document.body.classList.add('wiring');
        document.querySelectorAll('.port').forEach(p=>{
            const compatible=p.dataset.direction===(drag.side==='to'?'input':'output'),from=drag.side==='to'?drag.fixed:p.dataset.node,to=drag.side==='to'?p.dataset.node:drag.fixed,input=drag.side==='to'?p.dataset.input:drag.fixedInput;
            p.classList.toggle('compatible',compatible&&validConnection(from,to,input,drag.original));
        });
        document.querySelectorAll('.node,.cube-input').forEach(el=>el.classList.remove('drop-compatible','drop-target'));
        const target=resolveDropTarget(e,drag.side);if(target){const from=drag.side==='to'?drag.fixed:target.node,to=drag.side==='to'?target.node:drag.fixed,input=drag.side==='to'?target.input:drag.fixedInput;if(validConnection(from,to,input,drag.original)){document.querySelector(`[data-id="${CSS.escape(target.node)}"]`)?.classList.add('drop-compatible');target.row?.classList.add('drop-target');}}
        drawWires();
    }
    function finish(e,cancel=false){
        document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',cancelled);document.removeEventListener('keydown',key);
        wireDrag=null;document.body.classList.remove('wiring');document.querySelectorAll('.port').forEach(p=>p.classList.remove('compatible'));document.querySelectorAll('.node,.cube-input').forEach(el=>el.classList.remove('drop-compatible','drop-target'));
        if(cancel){drawWires();return;}
        if(!moved){onClick?.();return;}
        const target=resolveDropTarget(e,drag.side);
        if(target)connect(drag.side==='to'?drag.fixed:target.node,drag.side==='to'?target.node:drag.fixed,drag.side==='to'?target.input:drag.fixedInput,drag.original);
        else if(document.elementFromPoint(e.clientX,e.clientY)?.closest('.node'))status('That node has no compatible image input/output. Existing connection kept.',true);
        else if(drag.original){state.edges=state.edges.filter(edge=>edge!==drag.original);changed();status('Edge disconnected.');}
        drawWires();
    }
    const up=e=>finish(e),cancelled=e=>finish(e,true),key=e=>{if(e.key==='Escape')finish(e,true);};
    document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);document.addEventListener('pointercancel',cancelled);document.addEventListener('keydown',key);
}
const svgElement=tag=>document.createElementNS('http://www.w3.org/2000/svg',tag);
function cable(from,to){return `M ${from.x} ${from.y} C ${from.x+Math.max(60,Math.abs(to.x-from.x)*0.4)} ${from.y}, ${to.x-Math.max(60,Math.abs(to.x-from.x)*0.4)} ${to.y}, ${to.x} ${to.y}`;}
function endpoint(id,side,input){const n=nodeById(id),index=n.type==='skybox'?Math.max(0,FACES.indexOf(input)):0;return {x:n.x+(side==='output'?180:0),y:n.y+(n.type==='skybox'?54+index*31:53)};}
function drawWires(){
    $('wires').replaceChildren();
    // Selected cable handles must sit above every other cable's generous hit area.
    const edges=[...state.edges].sort((a,b)=>Number(edgeKey(a)===selectedEdge)-Number(edgeKey(b)===selectedEdge));
    for(const edge of edges){
        if(wireDrag?.original===edge)continue;
        const from=endpoint(edge.from,'output'),to=endpoint(edge.to,'input',edge.input),active=selectedEdge===edgeKey(edge);
        const group=svgElement('g');group.classList.add('edge');if(active)group.classList.add('selected');
        const hit=svgElement('path');hit.setAttribute('d',cable(from,to));hit.classList.add('edge-hit');
        hit.onpointerdown=e=>{e.stopPropagation();};hit.onclick=e=>{e.stopPropagation();selected=null;selectedNodes.clear();selectedEdge=edgeKey(edge);drawGraph();inspect();};
        const path=svgElement('path');path.setAttribute('d',cable(from,to));path.classList.add('edge-line');group.append(hit,path);
        if(active){
            for(const side of ['from','to']){
                const point=side==='from'?{x:from.x+22,y:from.y}:{x:to.x-22,y:to.y};
                const handle=svgElement('circle');handle.setAttribute('cx',point.x);handle.setAttribute('cy',point.y);handle.setAttribute('r',8);handle.classList.add('edge-handle');handle.dataset.end=side;
                const hint=svgElement('title');hint.textContent=`Drag ${side==='from'?'source':'destination'} endpoint · drop on empty space to disconnect · Esc cancels`;handle.append(hint);
                handle.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();beginWire(e,{side,fixed:side==='from'?edge.to:edge.from,fixedInput:side==='from'?edge.input:undefined,original:edge},()=>{});};group.append(handle);
            }
        }$('wires').append(group);
    }
    if(wireDrag){
        const fixed=endpoint(wireDrag.fixed,wireDrag.side==='to'?'output':'input',wireDrag.fixedInput),path=svgElement('path');path.setAttribute('d',wireDrag.side==='to'?cable(fixed,wireDrag):cable(wireDrag,fixed));path.classList.add('edge-line','draft');$('wires').append(path);
    }
}
function applyView(){const v=state.view;$('graph').style.transform=`translate(${v.x}px,${v.y}px) scale(${v.scale})`;queueDraftSave();}
$('viewport').onpointerdown=event=>{
    if(event.button!==0||event.target.closest('.node,.edge'))return;
    const x=event.clientX,y=event.clientY,start=clone(state.view),boxSelect=event.shiftKey,origin=graphPoint(event);let moved=false;
    const previous=new Set(selectedNodes);$('viewport').setPointerCapture(event.pointerId);
    $('viewport').onpointermove=e=>{
        if(Math.hypot(e.clientX-x,e.clientY-y)>4)moved=true;if(!moved)return;
        if(boxSelect){
            const rect=$('viewport').getBoundingClientRect(),m=$('marquee');m.hidden=false;m.style.left=Math.min(x,e.clientX)-rect.left+'px';m.style.top=Math.min(y,e.clientY)-rect.top+'px';m.style.width=Math.abs(e.clientX-x)+'px';m.style.height=Math.abs(e.clientY-y)+'px';
            const p=graphPoint(e);selectedNodes=new Set(previous);
            for(const n of state.nodes){const width=n.type==='skybox'?230:180,height=n.type==='skybox'?250:n.type==='source'?160:100;if(n.x+width>=Math.min(origin.x,p.x)&&n.x<=Math.max(origin.x,p.x)&&n.y+height>=Math.min(origin.y,p.y)&&n.y<=Math.max(origin.y,p.y))selectedNodes.add(n.id);}
            document.querySelectorAll('.node').forEach(el=>el.classList.toggle('selected',selectedNodes.has(el.dataset.id)));
        }else{$('viewport').classList.add('panning');state.view.x=start.x+e.clientX-x;state.view.y=start.y+e.clientY-y;applyView();}
    };
    $('viewport').onpointerup=()=>{
        $('viewport').onpointermove=null;$('viewport').onpointerup=null;$('viewport').onpointercancel=null;$('viewport').classList.remove('panning');$('marquee').hidden=true;
        if(!moved){selected=null;selectedNodes.clear();selectedEdge=null;pending=null;drawGraph();inspect();}
        else if(boxSelect){selected=[...selectedNodes].at(-1)||null;selectedEdge=null;inspect();}
    };
    $('viewport').onpointercancel=()=>{$('viewport').onpointermove=null;$('viewport').onpointerup=null;$('viewport').onpointercancel=null;$('viewport').classList.remove('panning');$('marquee').hidden=true;selectedNodes=previous;drawGraph();};
};
$('viewport').addEventListener('wheel',event=>{
    event.preventDefault();const rect=$('viewport').getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,v=state.view,scale=Math.min(1.5,Math.max(0.2,v.scale*Math.exp(-event.deltaY*0.001)));
    v.x=x-(x-v.x)*scale/v.scale;v.y=y-(y-v.y)*scale/v.scale;v.scale=scale;applyView();
},{passive:false});
function frameGraph(selection=false){
    const nodes=state.nodes.filter(n=>!selection||selectedNodes.has(n.id));if(!nodes.length)return;
    const left=Math.min(...nodes.map(n=>n.x)),top=Math.min(...nodes.map(n=>n.y)),right=Math.max(...nodes.map(n=>n.x+(n.type==='skybox'?250:200))),bottom=Math.max(...nodes.map(n=>n.y+(n.type==='skybox'?270:n.type==='source'?160:110)));
    const box=$('viewport'),scale=Math.min(1.2,Math.max(0.2,Math.min((box.clientWidth-80)/(right-left),(box.clientHeight-80)/(bottom-top))));
    state.view={scale,x:(box.clientWidth-(right-left)*scale)/2-left*scale,y:(box.clientHeight-(bottom-top)*scale)/2-top*scale};applyView();
}
$('fit').onclick=()=>frameGraph();$('undo').onclick=()=>undoRedo(-1);$('redo').onclick=()=>undoRedo(1);
$('shortcuts').onclick=()=>$('shortcut-guide').showModal();$('close-shortcuts').onclick=()=>$('shortcut-guide').close();
document.addEventListener('keydown',event=>{
    if($('shortcut-guide').open||wireDrag)return;
    const key=event.key.toLowerCase(),modifier=event.metaKey||event.ctrlKey;
    // File commands work while naming artwork; native text undo/delete stay native.
    if(modifier&&(key==='s'||key==='o')){event.preventDefault();$(key==='o'?'restore':event.shiftKey?'export':'save').click();return;}
    const textEditing=event.target.closest('textarea,[contenteditable="true"],input:not([type="range"]):not([type="checkbox"])');
    if(textEditing||event.target.matches('select'))return;
    let handled=true;
    if(modifier&&key==='z')undoRedo(event.shiftKey?1:-1);else if(modifier&&key==='y')undoRedo(1);
    else if(modifier&&key==='d')duplicateSelection();
    else if(modifier&&key==='a'){selectedNodes=new Set(state.nodes.map(n=>n.id));selected=state.nodes.at(-1)?.id;selectedEdge=null;drawGraph();inspect();}
    else if(key==='delete'||key==='backspace')deleteSelection();
    else if(key==='escape'){pending=null;selected=null;selectedNodes.clear();selectedEdge=null;drawGraph();inspect();}
    else if(!modifier&&key==='c')addNode('crop');else if(!modifier&&key==='l')addNode('light');else if(!modifier&&key==='i')addNode('info');
    else if(!modifier&&key==='f')frameGraph(event.shiftKey);else if(key==='?')$('shortcut-guide').showModal();else handled=false;
    if(handled)event.preventDefault();
});

function action(text,fn){const b=document.createElement('button');b.textContent=text;b.onclick=fn;return b;}
function inspect(){
    const root=$('inspector');root.replaceChildren();const node=nodeById(selected);
    if(!node){
        if(selectedEdge){root.append(document.createTextNode('Edge selected. Drag either circular endpoint to rewire; drop on empty space to disconnect. Esc cancels.'),action('Delete edge',()=>{state.edges=state.edges.filter(e=>edgeKey(e)!==selectedEdge);changed();}));}
        else root.textContent='Select a node to edit. Photo → Frame → Light → Face. Info can tap any image stage. Click empty space to deselect; drag empty space to pan.';
        return;
    }
    const heading=document.createElement('h3');heading.textContent=title(node);root.append(heading);
    if(node.type==='source'){
        const label=document.createElement('label');label.textContent='Source image';const select=document.createElement('select');
        for(const source of library){const option=document.createElement('option');option.value=source.path;option.textContent=source.path;select.append(option);}select.value=node.source.path;
        select.onchange=()=>{node.source=clone(library.find(s=>s.path===select.value));changed();};label.append(select);root.append(label);
        const detail=document.createElement('p');detail.textContent=`SHA-256: ${node.source.sha256}`;detail.style.overflowWrap='anywhere';root.append(detail);
    }else if(node.type==='crop'||node.type==='light'){
        const info=document.createElement('p');info.textContent=node.type==='crop'?'Geometry only. Centered cover crop, then zoom, pan, rotate and flip. Positive pan moves the image left/up.':'Linear-sRGB exposure and white balance, luminance-weighted shadows/highlights, then tone endpoints, contrast and color. Artistic controls, not a RAW developer.';root.append(info);
        if(node.legacy){
            const note=document.createElement('p');note.className='notice';note.textContent='Migrated v1 grade is preserved exactly. Enable the new controls to replace that legacy grade (appearance may change).';root.append(note,action('Use new light engine',()=>{delete node.legacy;changed();}));
        }
        for(const [key,label,min,max,step]of node.type==='crop'?CROP_FIELDS:LIGHT_FIELDS){
            const container=document.createElement('label');container.textContent=label;container.className='adjustment';
            const number=document.createElement('input');number.type='number';number.min=min;number.max=max;number.step=step;number.value=node.settings[key];number.disabled=!!node.legacy;
            const range=document.createElement('input');range.type='range';range.min=min;range.max=max;range.step=step;range.value=node.settings[key];range.disabled=!!node.legacy;
            const apply=value=>{if(value===''||!Number.isFinite(Number(value)))return;node.settings[key]=Math.min(max,Math.max(min,Number(value)));range.value=number.value=node.settings[key];schedule();};
            number.onchange=()=>{apply(number.value);checkpoint();drawGraph();};range.oninput=()=>apply(range.value);range.onchange=()=>{checkpoint();drawGraph();};
            container.ondblclick=e=>{if(e.target===number)return;apply((node.type==='crop'?cropDefaults():lightDefaults())[key]);checkpoint();drawGraph();};container.append(number,range);root.append(container);
        }
        if(node.type==='crop')for(const key of ['flipX','flipY']){
            const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=node.settings[key];input.onchange=()=>{node.settings[key]=input.checked;checkpoint();schedule();};label.append(input,document.createTextNode(key==='flipX'?' Flip horizontal':' Flip vertical'));root.append(label);
        }
        root.append(action('Reset node',()=>{delete node.legacy;node.settings=node.type==='crop'?cropDefaults():lightDefaults();changed();}));
    }else if(node.type==='info'){
        const help=document.createElement('p');help.textContent='Image passes through unchanged. The ƒ output holds structured statistics for future numeric nodes. Measurements use an aspect-preserving sample, up to 512 px, with linear-sRGB luminance. Compare stages or photos to assess light balance.';root.append(help);
        const stats=document.createElement('div');stats.id='info-detail';root.append(stats);renderInfo();
    }else if(node.type==='skybox'){
        const p=document.createElement('p');p.textContent='The permanent terminal node: six named image inputs become one cube environment. It can be moved and selected, but never deleted or duplicated.';root.append(p);
        const detail=document.createElement('p');detail.id='resolution-detail';root.append(detail);renderResolutionDetail();
        const list=document.createElement('div');list.className='cube-inspector';
        for(const face of FACES){const row=document.createElement('div'),edge=incoming(node.id,face),label=document.createElement('span');label.textContent=`${face.toUpperCase()} · ${LABELS[face]} — ${edge?'connected':'empty'}`;row.append(label);if(edge)row.append(action('Disconnect',()=>{state.edges=state.edges.filter(e=>e!==edge);changed();}));list.append(row);}root.append(list);
    }
    const actions=document.createElement('div');actions.className='node-actions';
    if(node.type!=='skybox'&&incoming(node.id))actions.append(action('Disconnect input',()=>{state.edges=state.edges.filter(e=>e.to!==node.id);changed();}));
    if(node.type!=='skybox')actions.append(action('Delete node',()=>{state.nodes=state.nodes.filter(n=>n.id!==node.id);state.edges=state.edges.filter(e=>e.to!==node.id&&e.from!==node.id);selectedNodes.delete(node.id);selected=[...selectedNodes].at(-1)||null;changed();}));root.append(actions);
}
function renderInfo(){
    const root=$('info-detail');if(!root)return;root.replaceChildren();const s=analysis.get(selected);
    if(!s||s.error){root.textContent=s?.error||'Waiting for an image input…';return;}
    const histogram=canvas(600,180);histogram.className='histogram';histogram.setAttribute('aria-label','RGB and luminance histogram');
    const ctx=histogram.getContext('2d');ctx.fillStyle='#10141c';ctx.fillRect(0,0,600,180);
    for(const [channel,color]of [['red','#ef7979'],['green','#79d99b'],['blue','#7aa7ed'],['luminance','#e6e9ef']]){
        const h=s.histograms[channel],peak=Math.max(...h);ctx.strokeStyle=color;ctx.lineWidth=channel==='luminance'?2:1;ctx.beginPath();
        h.forEach((n,i)=>{const x=i/255*600,y=175-Math.log1p(n)/Math.log1p(peak)*165;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();
    }root.append(histogram);
    const pct=v=>(v*100).toFixed(2)+'%',ev=v=>v.toFixed(2)+' EV';
    const rows=[['Image',`${s.width} × ${s.height} · ${s.aspectRatio.toFixed(3)}:1`],['Sample',`${s.sampleWidth} × ${s.sampleHeight} · ${s.samplePixels.toLocaleString()} pixels`],
        ['Mean luminance',pct(s.luminance.mean)],['Median luminance',pct(s.luminance.median)],['Geometric mean',pct(s.luminance.geometricMean)],['Luminance std. dev.',pct(s.luminance.stddev)],
        ['Minimum / maximum',`${pct(s.luminance.min)} / ${pct(s.luminance.max)}`],['P01–P99 range',ev(s.dynamicRangeP01P99EV)],
        ['Near-black pixels',s.clipping.blackPercent.toFixed(2)+'%'],['Near-white pixels',s.clipping.whitePercent.toFixed(2)+'%'],['Any channel clipped',s.clipping.anyChannelPercent.toFixed(2)+'%'],
        ['Mean R / G / B',Object.values(s.meanDisplayRGB).map(pct).join(' / ')],['ΔEV → 18% gray',ev(s.suggestedExposureTo18PercentGrayEV)]];
    for(const [p,y]of Object.entries(s.luminance.percentiles))rows.push([`Luminance P${p}`,pct(y)]);
    const table=document.createElement('dl');table.className='stats';for(const [key,value]of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value;table.append(dt,dd);}root.append(table);
    const note=document.createElement('p');note.textContent='ΔEV is a suggestion from geometric-mean luminance, not automatic correction. Subject matter, black borders, and clipping affect it. Export analyzes the full-resolution pipeline; preview-stage stats may differ slightly.';root.append(note);
    root.append(action('Save statistics JSON',()=>downloadJSON({nodeId:selected,pipeline:snapshot(),statistics:s},'image-statistics.json')));
}

function schedule(){generation++;clearTimeout(timer);timer=setTimeout(renderPreview,100);queueDraftSave();}
const tiles=new Map();for(const face of FACES){
    const button=document.createElement('button'),c=canvas(256);button.append(c,document.createTextNode(`${face} · ${LABELS[face]}`));button.onclick=()=>selectNode(state.nodes.find(n=>n.type==='skybox').id);$('faces').append(button);tiles.set(face,{canvas:c,button});
}
async function renderPreview(){
    const version=generation,snapshot=clone(state);
    const [{outputs,analysis:nextAnalysis},profile]=await Promise.all([evaluate(snapshot,256),inspectResolution(snapshot)]);
    if(version!==generation)return;
    resolutionProfile=profile;updateResolutionControls();analysis=nextAnalysis;let missing=0;
    for(const face of FACES){const result=outputs.get(face),tile=tiles.get(face),ctx=tile.canvas.getContext('2d');ctx.fillStyle='#151922';ctx.fillRect(0,0,256,256);
        if(result.error){missing++;tile.button.title=result.error;ctx.fillStyle='#8491a6';ctx.font='16px sans-serif';ctx.fillText('No input',85,132);}else{ctx.drawImage(result,0,0);tile.button.title=LABELS[face];}}
    for(const node of state.nodes.filter(n=>n.type==='info')){const body=document.querySelector(`[data-id="${CSS.escape(node.id)}"] .info-summary`);if(body)body.textContent=infoSummary(node.id);}
    renderInfo();renderResolutionDetail();updateEnvironment();if(!exporting)status(missing?`${missing} cube inputs incomplete · Photo → Frame → Light → Skybox · tap any stage with Info.`:`Preview ready · native ceiling ${profile.maxSide}px · no-upscale export.`);
}
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(65,1,0.01,100);camera.position.set(3,2,4);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));$('three').append(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
const material=new THREE.MeshStandardMaterial({metalness:1,roughness:0.08}),sphere=new THREE.Mesh(new THREE.SphereGeometry(1,48,32),material);scene.add(sphere);scene.add(new THREE.HemisphereLight(0xffffff,0x444444,1));
let environment=null,inside=!!state.layout?.inside;
function updateEnvironment(){if(environment)environment.dispose();environment=new THREE.CubeTexture(FACES.map(face=>tiles.get(face).canvas));environment.colorSpace=THREE.SRGBColorSpace;environment.needsUpdate=true;scene.environment=environment;material.envMap=environment;material.needsUpdate=true;scene.background=$('background').checked?environment:new THREE.Color('#090b10');}
$('background').onchange=()=>{state.layout??={};state.layout.environment=$('background').checked;updateEnvironment();queueDraftSave();};
function applyPreviewMode(){inside=!!state.layout?.inside;sphere.visible=!inside;controls.target.set(0,0,0);camera.position.set(...(inside?[0,0,0.01]:[3,2,4]));controls.enableZoom=!inside;controls.enablePan=!inside;controls.update();$('background').checked=state.layout?.environment!==false;updateEnvironment();}
$('inside').onclick=()=>{state.layout??={};state.layout.inside=!inside;applyPreviewMode();queueDraftSave();};
new ResizeObserver(()=>{const box=$('three');if(!box.clientWidth||!box.clientHeight)return;renderer.setSize(box.clientWidth,box.clientHeight);camera.aspect=box.clientWidth/box.clientHeight;camera.updateProjectionMatrix();}).observe($('three'));
renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});

function applyLayout(){
    const layout=state.layout||{};const maxWidth=Math.max(280,window.innerWidth-550);
    const maxHeight=Math.max(160,window.innerHeight-180);
    const width=Math.min(maxWidth,Math.max(280,layout.previewWidth||380)),height=Math.min(maxHeight,Math.max(160,layout.previewHeight||250));
    document.documentElement.style.setProperty('--preview-width',width+'px');$('three').style.height=height+'px';
    for(const [id,value,min,max]of [['preview-resizer',width,280,maxWidth],['preview-height-resizer',height,160,maxHeight]]){
        $(id).setAttribute('aria-valuenow',String(Math.round(value)));$(id).setAttribute('aria-valuemin',String(min));$(id).setAttribute('aria-valuemax',String(Math.round(max)));
    }
    queueDraftSave();
}
function resizeHandle(id,axis){
    const handle=$(id);handle.onpointerdown=event=>{
        if(event.button!==0)return;event.preventDefault();const start=axis==='width'?event.clientX:event.clientY,initial=axis==='width'?$('preview').getBoundingClientRect().width:$('three').clientHeight;
        handle.setPointerCapture(event.pointerId);document.body.classList.add('resizing');
        handle.onpointermove=e=>{state.layout??={};state.layout[axis==='width'?'previewWidth':'previewHeight']=Math.max(axis==='width'?280:160,initial+(axis==='width'?start-e.clientX:e.clientY-start));applyLayout();};
        handle.onpointerup=handle.onpointercancel=()=>{handle.onpointermove=null;document.body.classList.remove('resizing');};
    };
    handle.onkeydown=e=>{
        if(!(axis==='width'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown']).includes(e.key))return;e.preventDefault();state.layout??={};const key=axis==='width'?'previewWidth':'previewHeight';
        state.layout[key]=(state.layout[key]||(axis==='width'?380:250))+((e.key==='ArrowLeft'||e.key==='ArrowDown')?20:-20);applyLayout();
    };
}
resizeHandle('preview-resizer','width');resizeHandle('preview-height-resizer','height');window.addEventListener('resize',applyLayout);

function updateResolutionControls() {
    const select=$('size'),profile=resolutionProfile;
    select.replaceChildren();
    const maxOption=document.createElement('option');maxOption.value='max';
    maxOption.textContent=profile?.complete?`Max native · ${profile.maxSide} px`:'Max native · connect all faces';select.append(maxOption);
    select.disabled=!profile?.complete;
    $('export').disabled=exporting||!profile?.complete;
    if(profile?.complete){
        const requested=state.requestedSize||state.size,effective=state.resolutionMode==='max'?profile.maxSide:Math.min(requested,profile.maxSide);
        const sizes=new Set(RESOLUTION_PRESETS.filter(size=>size<=profile.maxSide));
        if(state.resolutionMode!=='max')sizes.add(effective);
        for(const size of [...sizes].sort((a,b)=>a-b)){const option=document.createElement('option');option.value=String(size);option.textContent=`${size} px`;select.append(option);}
        state.size=effective;select.value=state.resolutionMode==='max'?'max':String(effective);
        $('resolution-limit').textContent=`≤ ${profile.maxSide}px`;
        $('resolution-limit').title=`Limited by ${profile.limitingFaces.map(face=>`${face.toUpperCase()}: ${profile.faces[face].sourcePath}`).join(', ')}. Zoom/crop pixel budgets included.`;
        queueDraftSave();
    }else{$('resolution-limit').textContent='no upscaling';$('resolution-limit').title='Complete all six faces to calculate the common native resolution.';}
    renderResolutionDetail();
}
function renderResolutionDetail(){
    const root=$('resolution-detail');if(!root)return;
    const profile=resolutionProfile;if(!profile){root.textContent='Calculating native pixel budgets…';return;}
    root.textContent=(profile.complete?`Common export ceiling: ${profile.maxSide} × ${profile.maxSide} px. `:'Connect all faces to determine the common export ceiling. ')+FACES.map(face=>{
        const info=profile.faces[face];return `${face.toUpperCase()}: ${info.error||`${info.maxSide}px from ${info.nativeWidth}×${info.nativeHeight}, zoom ${info.crops.map(c=>c.zoom).join(' × ')||'1'}`}`;
    }).join(' · ');
}
function snapshot(){state.name=$('name').value;return clone(state);}
function downloadJSON(value,filename){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}
$('save').onclick=()=>downloadJSON(snapshot(),`${state.name.replace(/[^a-z0-9_-]/gi,'-')||'skybox'}.pipeline.json`);$('restore').onclick=()=>$('snapshot').click();
function restorePipeline(value) {
    const next=validate(migrate(value));
    const warnings=next.nodes.filter(n=>n.type==='source'&&!library.some(s=>s.path===n.source.path&&s.sha256===n.source.sha256));
    if(warnings.length&&!confirm(`${warnings.length} sources are missing or changed. Load anyway? Export requires matching originals.`))return false;
    state=next;selected=null;selectedNodes.clear();selectedEdge=null;pending=null;analysis.clear();clearImageCache();$('name').value=state.name||'untitled';resolutionProfile=null;updateResolutionControls();checkpoint();applyLayout();applyPreviewMode();drawGraph();inspect();schedule();
    return true;
}
$('snapshot').onchange=async event=>{
    try{const file=event.target.files[0];if(file)restorePipeline(JSON.parse(await file.text()));}
    catch(error){status(error.message,true);}finally{event.target.value='';}
};
function updateExportLink() {
    const link=$('view-export');link.hidden=true;
    if(!latestExport)return;
    try{link.href=viewerURL(latestExport);link.title=`Last completed export: ${latestExport}. This does not show unexported draft edits.`;link.hidden=false;}catch{latestExport=null;}
}
async function initializeLibrary() {
    try{
        await refreshLibrary();
        const requested=new URL(location.href).searchParams.get('pipeline');if(!requested)return;
        const match=/^(\/?exports\/[a-zA-Z0-9_-]+)\/pipeline\.json$/.exec(requested);if(!match)throw new Error('Invalid exported pipeline path');
        const folder=normalizeExportFolder(match[1]),response=await fetch(exportFileURL(folder,'pipeline.json'),{cache:'no-store'});
        if(!response.ok)throw new Error('Exported pipeline is missing');
        const pipeline=await response.json();
        const consumeImportURL=()=>{const url=new URL(location.href);url.searchParams.delete('pipeline');window.history.replaceState(null,'',url);};
        const different=JSON.stringify({nodes:state.nodes,edges:state.edges})!==JSON.stringify({nodes:pipeline.nodes,edges:pipeline.edges});
        if(different&&state.nodes.length>1&&!confirm('Open this exported pipeline in Studio? It replaces the current browser draft; save JSON first if needed. You can undo the import during this session.')){consumeImportURL();return;}
        if(restorePipeline(pipeline)){latestExport=folder;updateExportLink();saveDraft();}
        // The deep link is a one-time import. Refresh must restore subsequent draft edits.
        consumeImportURL();
    }catch(error){status(error.message,true);}
}
async function exportRequest(path, body, contentType='application/json') {
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':contentType},body:contentType==='application/json'?JSON.stringify(body):body});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Export failed');
    return result;
}
function encodePNG(image) {
    return new Promise((resolve,reject)=>image.toBlob(blob=>blob?resolve(blob):reject(new Error('Browser could not encode this resolution. Select a smaller output size.')),'image/png'));
}
$('export').onclick=async()=>{
    $('export').disabled=true;exporting=true;
    let folder=null;
    try {
        const pipeline=validate(snapshot()),profile=await inspectResolution(pipeline);
        if(!profile.complete)throw new Error('Complete all six cube inputs before exporting.');
        pipeline.size=pipeline.resolutionMode==='max'?profile.maxSide:Math.min(pipeline.requestedSize||pipeline.size,profile.maxSide);
        state.size=pipeline.size;
        pipeline.resolutionReport=profile;
        pipeline.renderPlan=Object.fromEntries(planResolution(pipeline,pipeline.size,profile));
        status(`Preparing ${pipeline.size} × ${pipeline.size} no-upscale export…`);
        ({folder}=await exportRequest('/api/export/start',{name:pipeline.name,state:pipeline}));
        const {analysis:stats}=await evaluate(pipeline,pipeline.size,{
            noUpscale:true,
            onFace:async(face,image)=>{
                status(`Rendering / saving ${face.toUpperCase()} · ${pipeline.size} × ${pipeline.size}px…`);
                const png=await encodePNG(image);
                await exportRequest(`/api/export/face?folder=${encodeURIComponent(folder)}&face=${face}`,png,'image/png');
                if(face==='px'){
                    const preview=canvas(Math.min(256,image.width));preview.getContext('2d').drawImage(image,0,0,preview.width,preview.height);
                    await exportRequest(`/api/export/face?folder=${encodeURIComponent(folder)}&face=preview`,await encodePNG(preview),'image/png');
                }
            }
        });
        const result=await exportRequest('/api/export/finish',{folder,analysis:Object.fromEntries(stats)});
        latestExport=result.folder;updateExportLink();saveDraft();
        status(`Saved ${result.folder}/ — six PNGs + pipeline.json + manifest.json${stats.size?' + analysis.json':''}. View in Tesseract is ready.`);
    } catch(error) {
        status(error.message+(folder?` · Incomplete export: exports/${folder}/ (marked .pending.json)` : ''),true);
    } finally { exporting=false;updateResolutionControls(); }
};
$('crop').onclick=()=>addNode('crop');$('light').onclick=()=>addNode('light');$('info').onclick=()=>addNode('info');$('refresh').onclick=()=>refreshLibrary().catch(e=>status(e.message,true));$('size').onchange=()=>{state.resolutionMode=$('size').value==='max'?'max':'manual';if(state.resolutionMode==='manual')state.requestedSize=Number($('size').value);updateResolutionControls();checkpoint();};$('name').onchange=()=>{state.name=$('name').value;checkpoint();};
function resetWorkspace() {
    if (!confirm('Reset the workspace? This clears the browser draft and undo history. Save JSON first if you want to keep this arrangement. Photos and exported folders are not deleted.')) return;
    clearTimeout(draftTimer);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Reset still works if browser storage is disabled. */ }
    recovered=null;
    latestExport=null;
    updateExportLink();
    recoveryError=null;
    state=createWorkspace();
    selected=null;
    selectedNodes.clear();
    selectedEdge=null;
    pending=null;
    analysis.clear();
    resolutionProfile=null;
    clearImageCache();
    history=[clone(state)];
    historyIndex=0;
    $('name').value=state.name;
    updateResolutionControls();
    applyLayout();
    applyPreviewMode();
    drawGraph();
    inspect();
    updateHistoryButtons();
    schedule();
    saveDraft();
}
$('reset-workspace').onclick=resetWorkspace;
$('reload-app').onclick=()=>{saveDraft();location.reload();};
$('name').value=state.name||'untitled';updateResolutionControls();
applyLayout();applyPreviewMode();drawGraph();inspect();updateHistoryButtons();updateExportLink();schedule();initializeLibrary();
if(recovered){$('autosave-status').textContent='Restored · autosaved';$('autosave-status').title='Workspace restored from this browser. Undo history starts fresh after reload.';}
if(recoveryError){$('autosave-status').textContent='Recovery failed';$('autosave-status').classList.add('error');$('autosave-status').title=recoveryError;}
