// Versioned image processing and provenance. No graph UI or Three.js dependencies.
export const FACES = ['px','nx','py','ny','pz','nz'];
export const LABELS = {px:'Right +X',nx:'Left −X',py:'Top +Y',ny:'Bottom −Y',pz:'Front +Z',nz:'Back −Z'};
export const RENDERER = 'canvas-linear-grade-v2';
export const cropDefaults = () => ({zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false});
export const lightDefaults = () => ({exposure:0,contrast:0,highlights:0,shadows:0,whites:0,blacks:0,temperature:0,tint:0,vibrance:0,saturation:0});
export const CROP_FIELDS = [['zoom','Zoom',1,5,0.01],['panX','Pan X',-1,1,0.01],['panY','Pan Y',-1,1,0.01],['rotation','Rotation °',-180,180,1]];
export const LIGHT_FIELDS = [['exposure','Exposure EV',-5,5,0.05],['contrast','Contrast',-100,100,1],['highlights','Highlights',-100,100,1],['shadows','Shadows',-100,100,1],['whites','Whites',-100,100,1],['blacks','Blacks',-100,100,1],['temperature','Warmth',-100,100,1],['tint','Tint · green ↔ magenta',-100,100,1],['vibrance','Vibrance',-100,100,1],['saturation','Saturation',-100,100,1]];
export const clone = value => JSON.parse(JSON.stringify(value));
export const url = path => '/' + path.split('/').map(encodeURIComponent).join('/');
export function canvas(width,height=width){const c=document.createElement('canvas');c.width=width;c.height=height;return c;}
export function dimensions(image){return {width:image.naturalWidth||image.width,height:image.naturalHeight||image.height};}
const clamp = (v,min=0,max=1) => Math.min(max,Math.max(min,v));
const linear = v => v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;
const display = v => v<=0.0031308?v*12.92:1.055*v**(1/2.4)-0.055;
const smooth = (a,b,x) => {const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
const LINEAR = Float64Array.from({length:256},(_,i)=>linear(i/255));
export function crop(input,s,size){
    const output=canvas(size),ctx=output.getContext('2d');const {width,height}=dimensions(input);
    const scale=Math.max(size/width,size/height)*s.zoom;
    ctx.fillStyle='#000';ctx.fillRect(0,0,size,size);ctx.translate(size/2,size/2);ctx.rotate(s.rotation*Math.PI/180);ctx.scale(s.flipX?-1:1,s.flipY?-1:1);
    ctx.drawImage(input,-width*scale/2-s.panX*width*scale,-height*scale/2-s.panY*height*scale,width*scale,height*scale);
    return output;
}
export function light(input,s,maxDimension){
    const {width,height}=dimensions(input),scale=Math.min(1,maxDimension/Math.max(width,height));
    const output=canvas(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))),ctx=output.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='#000';ctx.fillRect(0,0,output.width,output.height);ctx.drawImage(input,0,0,output.width,output.height);
    if(Object.values(s).every(v=>v===0))return output;
    const pixels=ctx.getImageData(0,0,output.width,output.height),d=pixels.data;
    const exposure=2**s.exposure,temp=s.temperature/100,tint=s.tint/100;
    const gains=[2**(temp*0.4+tint*0.15),2**(-tint*0.3),2**(-temp*0.4+tint*0.15)];
    for(let i=0;i<d.length;i+=4){
        let r=LINEAR[d[i]]*exposure*gains[0],g=LINEAR[d[i+1]]*exposure*gains[1],b=LINEAR[d[i+2]]*exposure*gains[2];
        const y=0.2126*r+0.7152*g+0.0722*b;
        const ev=(s.shadows/100)*(1-smooth(0.03,0.5,y))*1.8+(s.highlights/100)*smooth(0.2,1,y)*1.8;
        const gain=2**ev;r*=gain;g*=gain;b*=gain;
        let channels=[display(Math.max(0,r)),display(Math.max(0,g)),display(Math.max(0,b))];
        const tone=0.2126*channels[0]+0.7152*channels[1]+0.0722*channels[2];
        const offset=s.blacks/100*(1-smooth(0,0.35,tone))*0.18+s.whites/100*smooth(0.5,1,tone)*0.18;
        channels=channels.map(c=>(c-0.5)*(2**(s.contrast/100))+0.5+offset);
        const luma=0.2126*channels[0]+0.7152*channels[1]+0.0722*channels[2];
        const max=Math.max(...channels),min=Math.min(...channels),chroma=max>0?(max-min)/max:0;
        const saturation=Math.max(0,1+s.saturation/100+s.vibrance/100*(1-clamp(chroma)));
        for(let channel=0;channel<3;channel++)d[i+channel]=clamp(luma+(channels[channel]-luma)*saturation)*255;
    }
    ctx.putImageData(pixels,0,0);return output;
}
// Retains the exact v1 grade for migrated snapshots (including negative contrast ranges).
export function legacyGrade(input,s,size){
    const output=canvas(size),ctx=output.getContext('2d',{willReadFrequently:true});ctx.drawImage(input,0,0,size,size);
    const pixels=ctx.getImageData(0,0,size,size),d=pixels.data;
    for(let i=0;i<d.length;i+=4){
        const rgb=[d[i],d[i+1],d[i+2]].map(v=>(v*2**s.exposure-127.5)*s.contrast+127.5);
        const y=rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
        for(let j=0;j<3;j++)d[i+j]=y+(rgb[j]-y)*s.saturation;
    }ctx.putImageData(pixels,0,0);return output;
}
export function statistics(input){
    const {width,height}=dimensions(input),scale=Math.min(1,512/Math.max(width,height));
    const sample=canvas(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))),ctx=sample.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='#000';ctx.fillRect(0,0,sample.width,sample.height);ctx.drawImage(input,0,0,sample.width,sample.height);
    const data=ctx.getImageData(0,0,sample.width,sample.height).data,N=data.length/4;
    const histograms={luminance:Array(256).fill(0),red:Array(256).fill(0),green:Array(256).fill(0),blue:Array(256).fill(0)};
    const values=new Float64Array(N),sumRGB=[0,0,0];let sum=0,sum2=0,log=0,black=0,white=0,clipped=0,min=1,max=0;
    for(let i=0,k=0;i<data.length;i+=4,k++){
        const rgb=[data[i],data[i+1],data[i+2]],y=0.2126*LINEAR[rgb[0]]+0.7152*LINEAR[rgb[1]]+0.0722*LINEAR[rgb[2]];
        values[k]=y;sum+=y;sum2+=y*y;log+=Math.log(Math.max(y,1e-6));min=Math.min(min,y);max=Math.max(max,y);
        if(Math.max(...rgb)<=2)black++;if(Math.min(...rgb)>=253)white++;if(Math.max(...rgb)>=254)clipped++;
        histograms.luminance[Math.min(255,Math.round(display(y)*255))]++;
        for(let j=0;j<3;j++){sumRGB[j]+=rgb[j]/255;histograms[['red','green','blue'][j]][rgb[j]]++;}
    }
    values.sort();const percentile=p=>values[Math.round((N-1)*p/100)],mean=sum/N,geometricMean=Math.exp(log/N);
    return {schemaVersion:1,measurement:'linear-sRGB-luminance-v1',width,height,aspectRatio:width/height,
        sampleWidth:sample.width,sampleHeight:sample.height,samplePixels:N,
        luminance:{mean,geometricMean,median:percentile(50),stddev:Math.sqrt(Math.max(0,sum2/N-mean*mean)),min,max,
            percentiles:Object.fromEntries([1,5,10,25,50,75,90,95,99].map(p=>[p,percentile(p)]))},
        meanDisplayRGB:{r:sumRGB[0]/N,g:sumRGB[1]/N,b:sumRGB[2]/N},
        clipping:{blackPercent:black/N*100,whitePercent:white/N*100,anyChannelPercent:clipped/N*100},
        dynamicRangeP01P99EV:Math.log2(Math.max(percentile(99),1e-6)/Math.max(percentile(1),1e-6)),
        suggestedExposureTo18PercentGrayEV:Math.log2(0.18/Math.max(geometricMean,1e-6)),histograms};
}
const cache=new Map();
export function clearImageCache(){cache.clear();}
export async function loadImage(source){
    const key=source.path+source.sha256;
    if(!cache.has(key))cache.set(key,new Promise((resolve,reject)=>{
        const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error(`Cannot load ${source.path}`));img.src=url(source.path)+'?v='+source.sha256;
    }));return cache.get(key);
}
export async function evaluate(snapshot,size){
    const memo=new Map(),analysis=new Map();
    async function run(id){
        if(memo.has(id))return memo.get(id);
        const promise=(async()=>{
            const node=snapshot.nodes.find(n=>n.id===id);
            if(node.type==='source')return loadImage(node.source);
            const edge=snapshot.edges.find(e=>e.to===id);if(!edge)throw new Error(`${node.type.toUpperCase()} has no image input`);
            const input=await run(edge.from);
            if(node.type==='crop')return crop(input,node.settings,size);
            if(node.type==='light')return node.legacy?legacyGrade(input,node.legacy,size):light(input,node.settings,size);
            if(node.type==='info'){analysis.set(id,statistics(input));return input;}
            return crop(input,cropDefaults(),size);
        })();memo.set(id,promise);return promise;
    }
    const outputs=new Map();
    for(const face of FACES){try{outputs.set(face,await run(snapshot.nodes.find(n=>n.type==='face'&&n.face===face).id));}catch(e){outputs.set(face,{error:e.message});}}
    // Info nodes also run on independent branches not connected to an output face.
    for(const node of snapshot.nodes.filter(n=>n.type==='info')){try{await run(node.id);}catch(e){analysis.set(node.id,{error:e.message});}}
    return {outputs,analysis};
}
export function migrate(value){
    if(value.schemaVersion!==1)return value;
    if(value.renderer!=='canvas2d-cover-v1')throw new Error('Unsupported legacy renderer');
    const next=clone(value);next.schemaVersion=2;next.renderer=RENDERER;
    const ids=new Set(next.nodes.map(n=>n.id));
    for(const n of [...next.nodes]){
        if(n.type!=='transform')continue;
        let id=n.id+'-light';while(ids.has(id))id+='-';ids.add(id);
        const t=n.transforms;n.type='crop';n.settings=Object.fromEntries(Object.keys(cropDefaults()).map(k=>[k,t[k]]));delete n.transforms;
        const grade={id,type:'light',x:n.x+220,y:n.y,settings:lightDefaults(),legacy:{exposure:t.exposure,contrast:t.contrast,saturation:t.saturation}};
        for(const e of next.edges)if(e.from===n.id)e.from=id;
        next.edges.push({from:n.id,to:id});next.nodes.push(grade);
    }return next;
}
export function validate(value){
    if(!value||value.schemaVersion!==2||value.renderer!==RENDERER||!Array.isArray(value.nodes)||!Array.isArray(value.edges)||value.nodes.length>300)throw new Error('Invalid or unsupported pipeline JSON');
    if(![512,1024,2048].includes(value.size))throw new Error('Invalid output size');
    const ids=new Set();
    for(const n of value.nodes){
        if(!n||typeof n.id!=='string'||ids.has(n.id)||!['source','crop','light','info','face'].includes(n.type)||!Number.isFinite(n.x)||!Number.isFinite(n.y))throw new Error('Invalid node');ids.add(n.id);
        if(n.type==='source'&&(!n.source||typeof n.source.path!=='string'||!n.source.path.startsWith('raw/')||n.source.path.split('/').includes('..')||! /^[a-f0-9]{64}$/.test(n.source.sha256)))throw new Error('Invalid source');
        if(n.type==='crop'||n.type==='light'){
            if(!n.settings)throw new Error('Missing node settings');
            for(const [key,,min,max]of n.type==='crop'?CROP_FIELDS:LIGHT_FIELDS)if(!Number.isFinite(n.settings[key])||n.settings[key]<min||n.settings[key]>max)throw new Error('Invalid setting '+key);
            if(n.type==='crop')for(const key of ['flipX','flipY'])if(typeof n.settings[key]!=='boolean')throw new Error('Invalid flip');
            if(n.legacy&&(!Number.isFinite(n.legacy.exposure)||n.legacy.exposure< -3||n.legacy.exposure>3||!Number.isFinite(n.legacy.contrast)||n.legacy.contrast<0||n.legacy.contrast>3||!Number.isFinite(n.legacy.saturation)||n.legacy.saturation<0||n.legacy.saturation>3))throw new Error('Invalid legacy grade');
        }
    }
    for(const face of FACES)if(value.nodes.filter(n=>n.type==='face'&&n.face===face).length!==1)throw new Error('Exactly one node per face is required');
    if(value.nodes.filter(n=>n.type==='face').length!==6)throw new Error('Unexpected face node');
    const targets=new Set();for(const e of value.edges){
        const from=value.nodes.find(n=>n.id===e.from),to=value.nodes.find(n=>n.id===e.to);
        if(!from||!to||from.type==='face'||to.type==='source'||targets.has(e.to))throw new Error('Invalid image connection');targets.add(e.to);
    }
    const visiting=new Set(),done=new Set();function visit(id){if(visiting.has(id))throw new Error('Cycle in snapshot');if(done.has(id))return;visiting.add(id);for(const e of value.edges.filter(e=>e.from===id))visit(e.to);visiting.delete(id);done.add(id);}
    for(const id of ids)visit(id);
    if(!value.view||!Number.isFinite(value.view.x)||!Number.isFinite(value.view.y)||!Number.isFinite(value.view.scale)||value.view.scale<0.2||value.view.scale>1.5)value.view={x:20,y:20,scale:0.8};
    return value;
}
