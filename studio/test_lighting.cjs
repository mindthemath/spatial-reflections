/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Compile the actual viewer shaders and test color/lighting numerically on the GPU.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'tesseract.js'), 'utf8');
const skyboxes = fs.readFileSync(path.join(root, 'viewer-skyboxes.js'), 'utf8');
const textureHelper = skyboxes.slice(skyboxes.indexOf('function textureFromImages('), skyboxes.indexOf('function slugify('));
const helpers = source.slice(source.indexOf('function createShaderMaterial('), source.indexOf('// Function to project 4D to 3D'));
const context = { THREE: { ShaderMaterial: class { constructor(options) { Object.assign(this, options); } }, DoubleSide: 2 }, currentLighting: 'diagonal', lightDistance: 3, surfaceGrain: false, dirtyMirrors: false, mirrorReflections: true, currentShape: 'tesseract', envMap: null };
vm.runInNewContext(helpers, context);
const shaders = ['rough', 'iridescent'].map(type => context.createShaderMaterial(type));
const topologyHelpers = source.slice(source.indexOf('function project4Dto3D('),source.indexOf('function setViewerShape('));
const rotationHelpers = source.slice(source.indexOf('function rotate4D('),source.indexOf('// Function to handle window resize'));
(async () => {
    const THREE = await import('three');
    const lighting = vm.createContext({physicalLights: Array.from({length:4}, () => new THREE.PointLight()),
        diffuseOverheadLight:new THREE.HemisphereLight(), shadowState:'', renderer:{shadowMap:{needsUpdate:false}}, currentLighting:'diagonal', lightDistance:3,
        time:0, currentShape:'tesseract', showVertices:false});
    vm.runInContext(source.slice(source.indexOf('function updatePhysicalLighting('), source.indexOf('// Initialize the scene')), lighting);
    lighting.updatePhysicalLighting();
    assert(lighting.renderer.shadowMap.needsUpdate);
    assert.equal(lighting.physicalLights.filter(light=>light.visible).length,1);
    assert(Math.abs(lighting.physicalLights[0].position.length()-3)<1e-10);
    assert.equal(lighting.physicalLights[0].matrixWorld.elements[12],lighting.physicalLights[0].position.x,'light matrices update in the same frame');
    lighting.renderer.shadowMap.needsUpdate=false;
    lighting.updatePhysicalLighting();
    assert.equal(lighting.renderer.shadowMap.needsUpdate,false,'camera-only renders reuse shadows');
    lighting.time=1;
    lighting.updatePhysicalLighting();
    assert(lighting.renderer.shadowMap.needsUpdate,'moving geometry invalidates shadows');
    lighting.currentLighting='quad';
    lighting.updatePhysicalLighting();
    assert.equal(lighting.physicalLights.filter(light=>light.visible && light.castShadow).length,4);
    assert.equal(lighting.physicalLights.reduce((sum,light)=>sum+light.intensity,0),4*Math.PI);
    lighting.currentLighting='diffuse';
    lighting.updatePhysicalLighting();
    assert(lighting.diffuseOverheadLight.visible);
    assert(lighting.physicalLights.every(light=>!light.visible && !light.castShadow && light.intensity===0));
    lighting.currentLighting='topdown';
    lighting.updatePhysicalLighting();
    assert.equal(lighting.diffuseOverheadLight.visible,false);
    assert.equal(lighting.physicalLights[0].intensity,4*Math.PI);
    context.currentLighting='diffuse';
    assert.equal(context.createShaderMaterial('rough').uniforms.lightingType.value,3);
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.route('http://viewer.test/**', route => {
            const name = new URL(route.request().url()).pathname;
            if (name === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' });
            if (!['/vendor/three.module.js', '/vendor/three.core.js'].includes(name)) return route.abort();
            return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, name)) });
        });
        await page.goto('http://viewer.test/');
        const result = await page.evaluate(async ({ shaders, utilities, helpers, textureHelper, topologyHelpers, rotationHelpers }) => {
            const THREE = await import('/vendor/three.module.js');
            const renderer = new THREE.WebGLRenderer();
            renderer.setSize(32, 32);
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            const scene = new THREE.Scene();
            const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
            camera.position.z = 2;
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
            scene.add(mesh);
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 4;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 4, 4);
            const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
            const loadTexture = new Function('THREE', `${textureHelper}; return textureFromImages;`)(THREE);
            const {texture:cube, displaySide} = loadTexture(Array(6).fill(image), renderer);
            const pixel = () => {
                const data = new Uint8Array(4);
                renderer.getContext().readPixels(16, 16, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, data);
                return Array.from(data);
            };
            mesh.material = new THREE.ShaderMaterial({
                toneMapped: false,
                uniforms: { envMap: { value: cube } },
                vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
                fragmentShader: 'uniform samplerCube envMap; void main(){gl_FragColor=textureCube(envMap,vec3(1.0,0.0,0.0));\n#include <colorspace_fragment>\n}'
            });
            renderer.render(scene, camera);
            const roundTrip = pixel();
            // Exercise the actual material hook, not a serialized approximation.
            mesh.geometry.setAttribute('surface', new THREE.BufferAttribute(new Float32Array(12).fill(0.5), 3));
            mesh.geometry.setAttribute('mirrorFace',new THREE.BufferAttribute(new Float32Array(4).fill(-1),1));
            const createMaterial = new Function('THREE', 'envMap', `
                let mirrorTraceState=null;
                const mirrorReflections=true, currentLighting='diagonal', lightDistance=3, surfaceGrain=true, dirtyMirrors=true, currentShape='tesseract';
                ${helpers}
                return createShaderMaterial('chrome');
            `);
            const metal = createMaterial(THREE, cube);
            mesh.material = metal;
            renderer.render(scene, camera);
            const metalPixel = pixel();
            // Reflected environment must not be multiplied by local illumination.
            const point = new THREE.PointLight(0xffffff, 0);
            point.position.set(3, 3, 3); scene.add(point);
            metal.uniforms.surfaceGrain.value = 0;
            metal.uniforms.dirtyMirrors.value = 0;
            renderer.render(scene, camera);
            const unlitMetal = pixel();
            point.intensity = 4 * Math.PI;
            renderer.render(scene, camera);
            const litMetal = pixel();
            point.intensity = 0;
            const overhead = new THREE.HemisphereLight(0xffffff,0x000000,1);
            scene.add(overhead);
            renderer.render(scene,camera);
            const diffuseMetal = pixel();
            scene.remove(overhead);
            point.intensity = 4 * Math.PI;
            const framePixels = () => {
                renderer.render(scene,camera);
                const values=new Uint8Array(32*32*4),gl=renderer.getContext();
                gl.readPixels(0,0,32,32,gl.RGBA,gl.UNSIGNED_BYTE,values);
                return values;
            };
            point.intensity=0;
            const cleanFrame=framePixels();
            metal.uniforms.surfaceGrain.value=1;
            const grainFrame=framePixels();
            metal.uniforms.surfaceGrain.value=0;
            metal.uniforms.dirtyMirrors.value=1;
            const dirtyFrame=framePixels();
            let grainDifference=0,dirtyDifference=0,cleanEnergy=0,dirtyEnergy=0;
            for(let i=0;i<cleanFrame.length;i+=4){
                grainDifference+=Math.abs(grainFrame[i]-cleanFrame[i]);
                dirtyDifference+=Math.abs(dirtyFrame[i]-cleanFrame[i]);
                cleanEnergy+=cleanFrame[i];dirtyEnergy+=dirtyFrame[i];
            }
            metal.uniforms.dirtyMirrors.value=0;
            point.intensity=4*Math.PI;
            // A blocker outside the center camera ray must still block the light.
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFShadowMap;
            point.castShadow = true;
            point.shadow.mapSize.set(256, 256);
            point.shadow.camera.near = 0.01;
            point.shadow.camera.far = 40;
            point.shadow.bias = -0.00005;
            point.position.set(2, 0, 2);
            mesh.receiveShadow = true;
            metal.metalness = 0; metal.roughness = 0.7; metal.envMapIntensity = 0;
            metal.needsUpdate = true;
            const blocker = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.2), new THREE.MeshBasicMaterial());
            blocker.position.set(1, 0, 1); scene.add(blocker);
            renderer.render(scene, camera);
            const clearLight = pixel()[0];
            blocker.castShadow = true;
            renderer.render(scene, camera);
            const blockedLight = pixel()[0];
            scene.remove(blocker);
            const selfShadowErrors=[];
            point.shadow.normalBias=0;
            for(const side of [1,-1])for(const height of [0.02,0.1,0.5,2]) {
                camera.position.z=side*2; camera.lookAt(0,0,0);
                point.position.set(2,0,side*height);
                mesh.castShadow=false;
                const reference=framePixels();
                mesh.castShadow=true;
                const shadowed=framePixels();
                let error=0;
                for(let i=0;i<reference.length;i+=4)error+=Math.abs(reference[i]-shadowed[i]);
                selfShadowErrors.push({side,height,error});
            }
            mesh.castShadow=false;
            camera.position.z=2; camera.lookAt(0,0,0);
            scene.remove(point);
            for (const shader of shaders) {
                if (shader.uniforms.envMap) shader.uniforms.envMap.value = cube;
                mesh.material = new THREE.ShaderMaterial(shader);
                renderer.render(scene, camera);
            }
            const hdrUniforms = { radiance: { value: 1 } };
            mesh.material = new THREE.ShaderMaterial({
                uniforms: hdrUniforms,
                vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
                fragmentShader: 'uniform float radiance; void main(){gl_FragColor=vec4(vec3(radiance),1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}'
            });
            const highlights = [1, 2, 4].map(value => {
                hdrUniforms.radiance.value = value;
                renderer.render(scene, camera);
                return pixel()[0];
            });
            // Read linear shader values directly, bypassing display encoding.
            const uniforms = {
                worldNormal: { value: new THREE.Vector3(0, 1, 0) },
                worldPosition: { value: new THREE.Vector3() },
                radius: { value: 2 }, preset: { value: 1 },
                winding: { value: 1 }, backFaceTest: { value: false }
            };
            mesh.material = new THREE.ShaderMaterial({
                side: THREE.DoubleSide, toneMapped: false, uniforms,
                vertexShader: 'uniform float winding; void main(){gl_Position=vec4(position.x*winding,position.y,0.0,1.0);}',
                fragmentShader: `uniform vec3 worldNormal; uniform vec3 worldPosition;
                    uniform float radius; uniform int preset; uniform bool backFaceTest;
                    ${utilities}
                    void main(){
                        vec3 viewNormal = normalize((viewMatrix * vec4(worldNormal,0.0)).xyz);
                        vec3 value = calculateLighting(viewNormal,worldPosition,radius,preset);
                        if(backFaceTest) value=vec3(pointIllumination(visibleNormal(vec3(0.0,0.0,1.0)),vec3(0.0),worldNormal,1.0));
                        gl_FragColor=vec4(value,1.0);
                    }`
            });
            const measure = () => { renderer.render(scene, camera); return pixel()[0] / 255; };
            const near = measure();
            uniforms.radius.value = 4;
            const far = measure();
            uniforms.radius.value = 2;
            uniforms.worldNormal.value.set(Math.sqrt(3)/2, 0.5, 0);
            const oblique = measure();
            uniforms.worldNormal.value.set(0, -1, 0);
            const unlit = measure();
            uniforms.worldNormal.value.set(0, 1, 0);
            uniforms.worldPosition.value.set(0, -2, 0);
            const translated = measure();
            uniforms.worldPosition.value.set(0, 0, 0);
            camera.position.set(2, 1, 3); camera.lookAt(0, 0, 0);
            const orbited = measure();
            uniforms.preset.value = 0;
            uniforms.worldNormal.value.set(1, 1, 1).normalize();
            const diagonal = measure();
            uniforms.preset.value = 2;
            uniforms.worldNormal.value.set(1, 0, 0);
            const quad = measure();
            uniforms.preset.value = 3;
            uniforms.worldNormal.value.set(0,1,0);
            const diffuseUp = measure();
            uniforms.radius.value = 20;
            uniforms.worldPosition.value.set(10,-10,5);
            const diffuseMoved = measure();
            uniforms.worldNormal.value.set(1,0,0);
            const diffuseSide = measure();
            uniforms.worldNormal.value.set(0,-1,0);
            const diffuseDown = measure();
            uniforms.preset.value = 2;
            uniforms.backFaceTest.value = true;
            uniforms.worldNormal.value.set(0, 0, 2);
            const front = measure();
            uniforms.winding.value = -1;
            uniforms.worldNormal.value.set(0, 0, -2);
            const back = measure();
            // A high-frequency environment distinguishes source sampling from
            // the standard material's minimum-roughness filtered reflection.
            const pattern = document.createElement('canvas'); pattern.width = pattern.height = 512;
            const paint = pattern.getContext('2d');
            for (let x=0;x<512;x+=8) {
                paint.fillStyle = (x/8)%2 ? '#ffffff' : '#000000';
                paint.fillRect(x,0,8,512);
            }
            const detailedCube = new THREE.CubeTexture(Array(6).fill(pattern));
            detailedCube.colorSpace = THREE.SRGBColorSpace; detailedCube.needsUpdate = true;
            camera.position.set(0,0,2); camera.lookAt(0,0,0);
            const sharpMetal = createMaterial(THREE,detailedCube);
            sharpMetal.uniforms.surfaceGrain.value=0; sharpMetal.uniforms.dirtyMirrors.value=0;
            const filteredMetal = new THREE.MeshStandardMaterial({color:sharpMetal.color, metalness:1, roughness:0.005, envMap:detailedCube, side:THREE.DoubleSide});
            renderer.setSize(256,256);
            const contrast = material => {
                mesh.material=material; renderer.render(scene,camera);
                const pixels=new Uint8Array(256*256*4),gl=renderer.getContext();
                gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
                let sum=0;
                for(let y=64;y<192;y++)for(let x=40;x<216;x++)sum+=(pixels[(y*256+x)*4]-pixels[(y*256+x-1)*4])**2;
                return sum;
            };
            const sharpContrast=contrast(sharpMetal),filteredContrast=contrast(filteredMetal);
            // +Z is blue; -X is red. A 45-degree secondary sheet turns a
            // +Z reflected ray toward +X (image cubemaps flip the lookup X).
            const colorFaces=['#00ff00','#ff0000','#444444','#444444','#0000ff','#444444'].map(color=>{
                const face=document.createElement('canvas');face.width=face.height=32;
                const ctx=face.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,32,32);return face;
            });
            const colorCube=new THREE.CubeTexture(colorFaces);colorCube.colorSpace=THREE.SRGBColorSpace;colorCube.needsUpdate=true;
            const tracedMetal=createMaterial(THREE,colorCube);
            tracedMetal.uniforms.surfaceGrain.value=0;tracedMetal.uniforms.dirtyMirrors.value=0;
            const trace=tracedMetal.userData.mirrorTraceState;
            const setTriangle=(index,points)=>{
                const a=new THREE.Vector3(...points[0]),b=new THREE.Vector3(...points[1]),c=new THREE.Vector3(...points[2]);
                const normal=b.sub(a).cross(c.sub(a)).normalize();
                for(let corner=0;corner<3;corner++){
                    trace.data.set(points[corner],(index*6+corner)*4);
                    trace.data[(index*6+corner)*4+3]=normal.getComponent(corner);
                    trace.data.set([0.5,0.5,0.17],(index*6+corner+3)*4);
                }
                trace.texture.needsUpdate=true;
            };
            renderer.setSize(32,32);mesh.material=tracedMetal;
            const reflectionPixel=()=>{renderer.render(scene,camera);return pixel();};
            const emptyReflection=reflectionPixel();
            const angled=[[-2,-2,-1],[2,-2,3],[0,2,1]];
            setTriangle(0,angled);trace.count.value=1;
            const faceReflection=reflectionPixel();
            tracedMetal.uniforms.mirrorReflections.value=0;
            const disabledReflection=reflectionPixel();
            tracedMetal.uniforms.mirrorReflections.value=1;
            setTriangle(0,[angled[2],angled[1],angled[0]]);
            const reverseReflection=reflectionPixel();
            setTriangle(1,[[-4,-4,2],[4,-4,2],[0,4,2]]);trace.count.value=2;
            const nearestReflection=reflectionPixel();
            trace.count.value=1;
            setTriangle(0,[[-2,-2,0],[2,-2,0],[0,2,0]]);
            const selfReflection=reflectionPixel();
            setTriangle(0,[[100,0,1],[101,0,1],[100,1,1]]);
            const missedReflection=reflectionPixel();
            // Informational microbenchmark on an actual rotated tesseract.
            // Readback awaits GPU completion; no universal FPS assertion.
            const topology=new Function(`${topologyHelpers};return polytopeTopology('tesseract');`)();
            const project=new Function(`${topologyHelpers};${rotationHelpers};return point=>project4Dto3D(rotate4D(point,0.7,1.2,0.9));`)();
            const projected=topology.vertices.map(project),positions=[];
            let triangle=0;
            for(const face of topology.faces)for(let k=1;k<face.length-1;k++){
                const points=[face[0],face[k],face[k+1]].map(index=>projected[index]);
                const coords=points.map(p=>[p.x,p.y,p.z]);
                setTriangle(triangle++,coords);positions.push(...coords.flat());
            }
            trace.count.value=triangle;
            mesh.geometry.dispose();mesh.geometry=new THREE.BufferGeometry();
            mesh.geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(positions),3));
            mesh.geometry.setAttribute('surface',new THREE.BufferAttribute(new Float32Array(positions.length).fill(0.5),3));
            mesh.geometry.setAttribute('mirrorFace',new THREE.BufferAttribute(Float32Array.from({length:positions.length/3},(_,i)=>Math.floor(i/6)),1));
            mesh.geometry.computeVertexNormals();
            renderer.setSize(640,360);
            const gl=renderer.getContext();
            const completedPixel=new Uint8Array(4);
            const completedRender=()=>{renderer.render(scene,camera);gl.readPixels(16,16,1,1,gl.RGBA,gl.UNSIGNED_BYTE,completedPixel);};
            const benchmark=(enabled,material=tracedMetal)=>{
                mesh.material=material;
                material.uniforms.mirrorReflections.value=enabled;
                completedRender();
                const samples=[];
                for(let i=0;i<6;i++){
                    const start=performance.now();completedRender();samples.push(performance.now()-start);
                }
                samples.sort((a,b)=>a-b);return samples[3];
            };
            const programs=renderer.info.programs.length;
            const reflectionOffMs=benchmark(0),reflectionOnMs=benchmark(1);
            const reflectionRecompiled=renderer.info.programs.length!==programs;
            renderer.dispose();
            return { diffuseMetal, diffuseUp, diffuseMoved, diffuseSide, diffuseDown, reflectionOffMs, reflectionOnMs, reflectionRecompiled, emptyReflection, faceReflection, disabledReflection, reverseReflection, nearestReflection, selfReflection, missedReflection, selfShadowErrors, grainDifference, dirtyDifference, cleanEnergy, dirtyEnergy, sharpContrast, filteredContrast, displaySide, roundTrip, metalPixel, unlitMetal, litMetal, clearLight, blockedLight, highlights, near, far, oblique, unlit, translated, orbited, diagonal, quad, front, back };
        }, { shaders, utilities: context.shaderUtilities(), helpers, textureHelper, topologyHelpers, rotationHelpers });
        assert.deepEqual(errors, [], 'all viewer shaders compile without WebGL errors');
        assert.equal(result.reflectionRecompiled,false,'toggling reflections does not recompile shaders');
        console.log(`Reflection microbenchmark (640×360, rotated tesseract, this test GPU): off ${result.reflectionOffMs.toFixed(1)} ms, on ${result.reflectionOnMs.toFixed(1)} ms`);
        assert(result.emptyReflection[2]>result.emptyReflection[0]+40,'unobstructed mirror reflects blue environment');
        assert(result.faceReflection[0]>result.faceReflection[2]+40,'secondary mirror redirects the reflection to the red environment');
        for(const key of ['disabledReflection','selfReflection','missedReflection'])assert.deepEqual(result[key],result.emptyReflection,`${key} preserves the original reflection`);
        assert.deepEqual(result.reverseReflection,result.faceReflection,'secondary sheets reflect on either side');
        assert.deepEqual(result.nearestReflection,result.faceReflection,'only the nearest secondary face is used');
        for (const sample of result.selfShadowErrors) assert(sample.error <= 32, `a lone sheet cannot shadow itself: side=${sample.side}, light height=${sample.height}, error=${sample.error}`);
        assert(result.grainDifference > 32*32*2,'grain has a visible pixel-level effect, not just sub-threshold roughness');
        assert(result.dirtyDifference > 32*32*0.1,'dirt remains visible');
        assert(result.dirtyEnergy > result.cleanEnergy*0.5,'dirt retains most reflected light instead of making the surface matte');
        assert(result.sharpContrast > result.filteredContrast * 1.2, `polished reflections retain detail: ${result.sharpContrast} > ${result.filteredContrast}`);
        assert.equal(result.displaySide,16,'tiny source images are safely resized for physical environment filtering');
        for (const channel of result.roundTrip.slice(0, 3)) assert(Math.abs(channel - 128) <= 1, 'sRGB texture → linear → sRGB preserves middle gray');
        assert(result.highlights[0] < result.highlights[1] && result.highlights[1] < result.highlights[2] && result.highlights[2] < 255, 'HDR highlights retain distinct levels instead of clipping to white');
        assert(result.clearLight > result.blockedLight + 20, `occlusion darkens illumination: ${result.clearLight} > ${result.blockedLight}`);
        assert(result.metalPixel[0] > 0 && result.metalPixel[0] < 255, 'physical aged metal renders');
        assert(result.unlitMetal[0] > 0, 'metal reflects the environment without local lights');
        assert(Math.abs(result.litMetal[0] - result.unlitMetal[0]) < 3, 'off-specular point light does not brighten the entire reflection');
        const close = (key, expected) => assert(Math.abs(result[key] - expected) <= 1.5 / 255, `${key}: ${result[key]} ≈ ${expected}`);
        assert.deepEqual(result.diffuseMetal,result.unlitMetal,'diffuse fill preserves clean chrome reflections without specular bulbs');
        close('diffuseUp',0.92); close('diffuseMoved',0.92);
        close('diffuseSide',0.47); close('diffuseDown',0.02);
        close('near', 0.92); close('far', 0.245); // direct contribution falls by four
        close('oblique', 0.47); close('unlit', 0.02); // cosine law, no negative light
        close('translated', 0.245); // actual surface position, not distance to origin
        close('orbited', 0.92); // rotating the camera does not move lights
        close('diagonal', 0.92); close('quad', 0.245); // radius and total intensity
        close('front', 0.9); close('back', 0.9); // symmetric two-sided illumination
        console.log('PASS: shader compilation, sRGB round-trip, lighting laws, polished detail, grain/dirt, real shadows without planar self-shadow bands, bounded face reflections');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
