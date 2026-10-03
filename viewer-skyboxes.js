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
function loadImage(url) {
    return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error(`Missing or unreadable image: ${url}`));image.src=url;});
}

export function installSkyboxLibrary({mount,renderer,getShader,onTexture,onSwitchChrome}) {
    const section=document.createElement('section');section.className='viewer-skybox';
    section.innerHTML=`<div class="skybox-heading">SKYBOX</div><div id="active-skybox">Diagnostic environment</div><div class="skybox-actions"><button id="browse-skyboxes" type="button">Browse exports…</button><button id="default-skybox" type="button">Default</button></div><p id="skybox-status" role="status"></p><button id="switch-to-chrome" type="button" hidden>Switch to Chrome</button><div class="skybox-links"><a id="edit-skybox" target="_blank" rel="noopener" hidden>Open in Studio ↗</a><a id="skybox-manifest" target="_blank" rel="noopener" hidden>Lineage JSON ↗</a></div>`;
    mount.prepend(section);
    const dialog=document.createElement('dialog');dialog.id='skybox-library-dialog';
    dialog.innerHTML=`<div class="library-heading"><strong>SKYBOX / EXPORT LIBRARY</strong><button id="refresh-skyboxes" type="button">Refresh</button><button id="close-skyboxes" type="button">Close</button></div><p>Completed Studio exports. Loading changes only the environment—not your camera, animation or shader.</p><p id="skybox-library-status" role="status"></p><div id="skybox-export-list"></div>`;
    document.body.append(dialog);
    const $=id=>document.getElementById(id);
    let active=null,entries=[],requestId=0;
    function message(text,error=false){for(const id of ['skybox-status','skybox-library-status']){$(id).textContent=text;$(id).classList.toggle('error',error);}}
    function refreshShaderHint() {
        $('switch-to-chrome').hidden=getShader()==='chrome';
        $('switch-to-chrome').title='Skybox images are reflected by Chrome. Debug shaders do not display them.';
    }
    function updateLinks() {
        const isExport=active&&active!=='default';
        $('edit-skybox').hidden=$('skybox-manifest').hidden=!isExport;
        if(isExport){$('edit-skybox').href=studioURL(active);$('skybox-manifest').href=exportFileURL(active,'manifest.json');}
        refreshShaderHint();
    }
    function remember(folder) {
        try{localStorage.setItem(STORAGE_KEY,folder);}catch{/* Viewer still works when storage is blocked. */}
        const url=new URL(location.href);url.searchParams.set('skybox',folder);history.replaceState(null,'',url);
    }
    async function loadSelection(folder,{rememberSelection=true}={}) {
        const version=++requestId;
        try {
            folder=folder==='default'?'default':normalizeExportFolder(folder);
            message('Loading skybox…');
            let name='Default skybox',size=null;
            if(folder!=='default'){
                const response=await fetch(exportFileURL(folder,'manifest.json'),{cache:'no-store'});
                if(!response.ok)throw new Error('Export manifest is missing. Is this export complete?');
                const manifest=await response.json();
                if(!manifest.outputs||!FACES.every(face=>manifest.outputs[face]?.file===`${face}.png`))throw new Error('Manifest must identify all six named PNG faces');
                name=manifest.pipeline?.name||folder;size=manifest.pipeline?.size;
            }
            const urls=FACES.map(face=>folder==='default'?`/skybox/${face}.png`:exportFileURL(folder,`${face}.png`));
            const images=await Promise.all(urls.map(loadImage));
            const side=images[0].naturalWidth;
            if(!side||images.some(image=>image.naturalWidth!==side||image.naturalHeight!==side))throw new Error('Skybox faces must be square and all have the same dimensions');
            if(size!==null&&size!==side)throw new Error('Image dimensions do not match the export manifest');
            const gl=renderer.getContext(),gpuLimit=gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE);
            if(!gpuLimit)throw new Error('WebGL context is unavailable');
            const displaySide=Math.min(side,gpuLimit);
            const texture=new THREE.CubeTexture(images.map(image=>{
                if(side===displaySide)return image;
                const canvas=document.createElement('canvas');canvas.width=canvas.height=displaySide;
                const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Could not allocate preview textures');ctx.drawImage(image,0,0,displaySide,displaySide);return canvas;
            }));
            // Keep arbitrary native sizes on WebGL1 without Three.js silently rounding to powers of two.
            if(!renderer.capabilities.isWebGL2&&!THREE.MathUtils.isPowerOfTwo(displaySide)){texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;}
            // Preserve the original viewer's custom Chrome shader color convention.
            texture.needsUpdate=true;
            if(version!==requestId){texture.dispose();return false;}
            onTexture(texture);active=folder;
            $('active-skybox').textContent=name;$('active-skybox').title=folder==='default'?'skybox/':folder;
            message(`${side} × ${side}px${displaySide<side?` · display reduced to ${displaySide}px for this GPU; originals unchanged`:''}`);
            if(rememberSelection)remember(folder);
            updateLinks();renderLibrary();dialog.close();return true;
        }catch(error){if(version===requestId)message(`${error.message}. Kept the current environment.`,true);return false;}
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
    $('default-skybox').onclick=()=>loadSelection('default');
    $('switch-to-chrome').onclick=()=>{onSwitchChrome();refreshShaderHint();};
    onTexture(diagnosticTexture());refreshShaderHint();
    let desired=new URL(location.href).searchParams.get('skybox');
    if(!desired){try{desired=localStorage.getItem(STORAGE_KEY);}catch{/* Default if storage is unavailable. */}}
    loadSelection(desired||'default',{rememberSelection:!!desired});
    return {refreshShaderHint,loadSelection,refreshLibrary};
}
