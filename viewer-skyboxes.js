import * as THREE from 'three';
import {normalizeExportFolder,exportFileURL,studioURL} from './skybox-paths.js';

const FACES=['px','nx','py','ny','pz','nz'];
const STORAGE_KEY='tesseract.skybox.v1';

function diagnosticTexture() {
    const colors=['#732626','#262673','#267326','#737326','#267373','#732673'];
    const images=colors.map(color=>{
        const image=document.createElement('canvas');image.width=image.height=16;
        const ctx=image.getContext('2d'),gradient=ctx.createLinearGradient(0,0,16,16);
        gradient.addColorStop(0,color);gradient.addColorStop(1,'#000');ctx.fillStyle=gradient;ctx.fillRect(0,0,16,16);return image;
    });
    const texture=new THREE.CubeTexture(images);texture.needsUpdate=true;return texture;
}
async function loadImageAsset(url,{requireHash=true}={}) {
    // Published static works may run on plain HTTP (e.g. signage players).
    // Export-capable loads must still hash actual bytes for resume identity.
    const subtle=globalThis.crypto?.subtle;
    if(!subtle&&requireHash)throw new Error('Skybox verification requires HTTPS or localhost');
    const response=await fetch(url,{cache:requireHash?'no-store':'default'});
    if(!response.ok)throw new Error(`Missing or unreadable image: ${url}`);
    const blob=await response.blob();
    // Do not retain an ArrayBuffer plus a Blob copy throughout image decoding.
    const digest=subtle?await subtle.digest('SHA-256',await blob.arrayBuffer()):null;
    const sha256=digest?Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''):null;
    const objectURL=URL.createObjectURL(blob);
    try{
        const image=await new Promise((resolve,reject)=>{const value=new Image();value.onload=()=>resolve(value);value.onerror=()=>reject(new Error(`Missing or unreadable image: ${url}`));value.src=objectURL;});
        return {image,sha256};
    }finally{URL.revokeObjectURL(objectURL);}
}
function textureFromImages(images,renderer,expectedSize=null) {
    const side=images[0].naturalWidth;
    if(!side||images.some(image=>image.naturalWidth!==side||image.naturalHeight!==side))throw new Error('Skybox faces must be square and all have the same dimensions');
    if(expectedSize!==null&&expectedSize!==side)throw new Error('Image dimensions do not match the export manifest');
    const gl=renderer.getContext(),gpuLimit=gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE);
    if(!gpuLimit)throw new Error('WebGL context is unavailable');
    const displaySide=Math.min(side,gpuLimit);
    const texture=new THREE.CubeTexture(images.map(image=>{
        if(side===displaySide)return image;
        const canvas=document.createElement('canvas');canvas.width=canvas.height=displaySide;
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Could not allocate preview textures');ctx.drawImage(image,0,0,displaySide,displaySide);return canvas;
    }));
    if(!renderer.capabilities.isWebGL2&&!THREE.MathUtils.isPowerOfTwo(displaySide)){texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;}
    texture.needsUpdate=true;
    return {texture,side,displaySide};
}
function slugify(value) {
    return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60);
}

export function installSkyboxLibrary({mount,renderer,getShader,onTexture,onSwitchChrome,getViewerState,onStateChange=()=>{},publication,confirmAction}) {
    let renderReady=false,renderIdentity=null,renderLocks=0;
    const setRenderState=(ready,identity=renderIdentity)=>{renderReady=ready;renderIdentity=identity;onStateChange({ready:renderReady,identity:renderIdentity});};
    const renderApi={
        getRenderState(){return {ready:renderReady,identity:renderIdentity};},
        acquireRenderLock(){
            if(!renderReady)throw new Error('Wait for the skybox to finish loading before exporting video');
            if(!renderIdentity)throw new Error('Skybox verification requires HTTPS or localhost before exporting video');
            renderLocks+=1;let released=false;
            return ()=>{if(!released){released=true;renderLocks=Math.max(0,renderLocks-1);}};
        }
    };
    if(publication?.schemaVersion===1){
        const section=document.createElement('section');section.className='viewer-skybox';
        section.innerHTML='<div class="skybox-heading">WORK</div><div id="active-skybox"></div><p id="skybox-status" role="status">Loading published environment…</p>';
        mount.prepend(section);section.querySelector('#active-skybox').textContent=publication.title||'Published work';
        const status=section.querySelector('#skybox-status');onTexture(diagnosticTexture());setRenderState(false,null);
        (async()=>{
            try{
                if(!publication.skybox||!FACES.every(face=>publication.skybox[face]===`skybox/${face}.png`))throw new Error('Published skybox configuration is invalid');
                const assets=await Promise.all(FACES.map(face=>loadImageAsset(publication.skybox[face],{requireHash:false})));
                const {texture,side,displaySide}=textureFromImages(assets.map(asset=>asset.image),renderer,publication.size??null);onTexture(texture);
                setRenderState(true,assets.every(asset=>asset.sha256)?JSON.stringify({kind:'published',slug:publication.slug||'',manifestSha256:publication.source?.manifestSha256||null,faces:Object.fromEntries(FACES.map((face,index)=>[face,assets[index].sha256]))}):null);
                status.textContent=`${side} × ${side}px${displaySide<side?` · display reduced to ${displaySide}px for this GPU`:''}`;
            }catch(error){setRenderState(false,null);status.textContent=error.message;status.classList.add('error');}
        })();
        return {...renderApi,refreshShaderHint(){},loadSelection(){return false;},refreshLibrary(){}};
    }

    const section=document.createElement('section');section.className='viewer-skybox';
    section.innerHTML=`<div class="skybox-heading">SKYBOX</div><div id="active-skybox">Diagnostic environment</div><div class="skybox-actions"><button id="browse-skyboxes" type="button">Browse exports…</button><button id="default-skybox" type="button">Default</button><button id="publish-skybox" type="button" disabled>Publish…</button></div><p id="skybox-status" role="status"></p><button id="switch-to-chrome" type="button" hidden>Switch to Chrome</button><div class="skybox-links"><a id="edit-skybox" target="_blank" rel="noopener" hidden>Open in Studio ↗</a><a id="skybox-manifest" target="_blank" rel="noopener" hidden>Lineage JSON ↗</a></div>`;
    mount.prepend(section);
    const dialog=document.createElement('dialog');dialog.id='skybox-library-dialog';
    dialog.innerHTML=`<div class="library-heading"><strong>SKYBOX / EXPORT LIBRARY</strong><button id="refresh-skyboxes" type="button">Refresh</button><button id="close-skyboxes" type="button">Close</button></div><p>Completed Studio exports. Loading changes only the environment—not your camera, animation or shader.</p><p id="skybox-library-status" role="status"></p><div id="skybox-export-list"></div>`;
    document.body.append(dialog);
    const publishDialog=document.createElement('dialog');publishDialog.id='publish-skybox-dialog';
    publishDialog.innerHTML=`<form id="publish-skybox-form"><div class="library-heading"><strong>PUBLISH STATIC WORK</strong><button id="close-publish" type="button">Close</button></div><p>Snapshot this export, the current viewer settings, and this version of the runtime into <code>site/work/&lt;slug&gt;/</code>.</p><label>Title<input id="publish-title" required maxlength="100"></label><label>URL slug<input id="publish-slug" required maxlength="60" pattern="[a-z0-9]+(?:-[a-z0-9]+)*"></label><label>Description<textarea id="publish-description" maxlength="1000"></textarea></label><div class="skybox-actions"><button id="confirm-publish" type="submit">Publish snapshot</button></div><p id="publish-result" role="status"></p></form>`;
    document.body.append(publishDialog);
    const $=id=>document.getElementById(id);
    let active=null,activeName='',entries=[],requestId=0;
    function message(text,error=false){for(const id of ['skybox-status','skybox-library-status']){$(id).textContent=text;$(id).classList.toggle('error',error);}}
    function refreshShaderHint() {
        $('switch-to-chrome').hidden=getShader()==='chrome';
        $('switch-to-chrome').title='Skybox images are reflected by Chrome. Debug shaders do not display them.';
    }
    function updateLinks() {
        const isExport=active&&active!=='default';
        $('edit-skybox').hidden=$('skybox-manifest').hidden=!isExport;$('publish-skybox').disabled=!isExport;
        if(isExport){$('edit-skybox').href=studioURL(active);$('skybox-manifest').href=exportFileURL(active,'manifest.json');}
        refreshShaderHint();
    }
    function remember(folder) {
        try{localStorage.setItem(STORAGE_KEY,folder);}catch{/* Viewer still works when storage is blocked. */}
        const url=new URL(location.href);url.searchParams.set('skybox',folder);history.replaceState(null,'',url);
    }
    async function loadSelection(folder,{rememberSelection=true}={}) {
        if(renderLocks){message('The skybox cannot change during video export',true);return false;}
        const version=++requestId,previousIdentity=renderIdentity,hadActive=!!active;
        setRenderState(false,previousIdentity);
        try {
            folder=folder==='default'?'default':normalizeExportFolder(folder);
            message('Loading skybox…');
            let name='Default skybox',size=null,expectedHashes=null;
            if(folder!=='default'){
                const response=await fetch(exportFileURL(folder,'manifest.json'),{cache:'no-store'});
                if(!response.ok)throw new Error('Export manifest is missing. Is this export complete?');
                const manifest=await response.json();
                if(!manifest.outputs||!FACES.every(face=>manifest.outputs[face]?.file===`${face}.png`))throw new Error('Manifest must identify all six named PNG faces');
                name=manifest.pipeline?.name||folder;size=manifest.pipeline?.size;
                expectedHashes=Object.fromEntries(FACES.map(face=>[face,manifest.outputs[face].sha256||null]));
            }
            const urls=FACES.map(face=>folder==='default'?`/skybox/${face}.png`:exportFileURL(folder,`${face}.png`));
            const assets=await Promise.all(urls.map(url=>loadImageAsset(url)));
            if(expectedHashes&&FACES.some((face,index)=>expectedHashes[face]&&expectedHashes[face]!==assets[index].sha256))throw new Error('Skybox image content does not match the export manifest');
            const identity=JSON.stringify({kind:folder==='default'?'default':'export',folder,faces:Object.fromEntries(FACES.map((face,index)=>[face,assets[index].sha256]))});
            const {texture,side,displaySide}=textureFromImages(assets.map(asset=>asset.image),renderer,size);
            if(version!==requestId){texture.dispose();return false;}
            onTexture(texture);active=folder;activeName=name;setRenderState(true,identity);
            $('active-skybox').textContent=name;$('active-skybox').title=folder==='default'?'skybox/':folder;
            message(`${side} × ${side}px${displaySide<side?` · display reduced to ${displaySide}px for this GPU; originals unchanged`:''}`);
            if(rememberSelection)remember(folder);
            updateLinks();renderLibrary();dialog.close();return true;
        }catch(error){if(version===requestId){setRenderState(hadActive,previousIdentity);message(`${error.message}. Kept the current environment.`,true);}return false;}
    }
    function renderLibrary() {
        const list=$('skybox-export-list');list.replaceChildren();
        if(!entries.length){list.textContent='No completed exports yet. Export an arrangement from Studio, then refresh.';return;}
        for(const entry of entries){
            const card=document.createElement('article');card.className='skybox-card';
            const image=document.createElement('img');image.src=exportFileURL(entry.folder,entry.thumbnail||'px.png');image.loading='lazy';image.alt=`${entry.name} — representative PX face`;
            const name=document.createElement('strong');name.textContent=entry.name;
            const info=document.createElement('small');info.textContent=`${entry.size||'?'}px · ${new Date(entry.createdAt).toLocaleString()} · ${entry.sourceCount} source photos`;
            const actions=document.createElement('div');actions.className='skybox-actions';
            const load=document.createElement('button');load.type='button';load.textContent=entry.folder===active?'Loaded':'Load skybox';load.onclick=()=>loadSelection(entry.folder);
            const edit=document.createElement('a');edit.textContent='Studio ↗';edit.href=studioURL(entry.folder);edit.target='_blank';edit.rel='noopener';
            actions.append(load,edit);card.append(image,name,info,actions);list.append(card);
        }
    }
    async function refreshLibrary() {
        $('skybox-export-list').textContent='Loading completed exports…';
        try{
            const response=await fetch('/api/exports',{cache:'no-store'});if(!response.ok)throw new Error('Export library requires python3 studio/server.py');
            entries=(await response.json()).exports;renderLibrary();
        }catch(error){$('skybox-export-list').textContent=error.message;}
    }
    $('browse-skyboxes').onclick=()=>{dialog.showModal();refreshLibrary();};
    $('close-skyboxes').onclick=()=>dialog.close();$('refresh-skyboxes').onclick=refreshLibrary;
    $('default-skybox').onclick=async()=>{
        if(!await confirmAction({title:'DEFAULT SKYBOX',message:'Replace the current environment with the default skybox?',confirmLabel:'Load default'}))return;
        loadSelection('default');
    };
    $('switch-to-chrome').onclick=()=>{onSwitchChrome();refreshShaderHint();};
    $('publish-skybox').onclick=()=>{
        $('publish-title').value=activeName||'';$('publish-slug').value=slugify(activeName||'');$('publish-slug').dataset.edited='';
        $('publish-description').value='';$('publish-result').replaceChildren();publishDialog.showModal();
    };
    $('close-publish').onclick=()=>publishDialog.close();
    $('publish-title').oninput=()=>{if(!$('publish-slug').dataset.edited)$('publish-slug').value=slugify($('publish-title').value);};
    $('publish-slug').oninput=()=>{$('publish-slug').dataset.edited='yes';};
    $('publish-skybox-form').onsubmit=async event=>{
        event.preventDefault();const button=$('confirm-publish'),result=$('publish-result');button.disabled=true;result.textContent='Publishing snapshot…';result.classList.remove('error');
        try{
            const response=await fetch('/api/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:$('publish-title').value,slug:$('publish-slug').value,description:$('publish-description').value,exportFolder:active,viewerState:getViewerState()})});
            const value=await response.json();if(!response.ok)throw new Error(value.error||'Publish failed');
            result.replaceChildren(document.createTextNode('Published: '));const link=document.createElement('a');link.href=value.url;link.textContent=value.url;link.target='_blank';link.rel='noopener';result.append(link);
        }catch(error){result.textContent=error.message;result.classList.add('error');}finally{button.disabled=false;}
    };
    onTexture(diagnosticTexture());setRenderState(false,null);refreshShaderHint();
    let desired=new URL(location.href).searchParams.get('skybox');
    if(!desired){try{desired=localStorage.getItem(STORAGE_KEY);}catch{/* Default if storage is unavailable. */}}
    loadSelection(desired||'default',{rememberSelection:!!desired});
    return {...renderApi,refreshShaderHint,loadSelection,refreshLibrary};
}
