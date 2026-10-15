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
const context = { THREE: { ShaderMaterial: class { constructor(options) { Object.assign(this, options); } }, DoubleSide: 2 }, currentLighting: 'diagonal', lightDistance: 3, surfaceGrain: false, dirtyMirrors: false, currentShape: 'tesseract', envMap: null };
vm.runInNewContext(helpers, context);
const shaders = ['rough', 'iridescent'].map(type => context.createShaderMaterial(type));
(async () => {
    const THREE = await import('three');
    const lighting = vm.createContext({physicalLights: Array.from({length:4}, () => new THREE.PointLight()),
        shadowState:'', renderer:{shadowMap:{needsUpdate:false}}, currentLighting:'diagonal', lightDistance:3,
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
        const result = await page.evaluate(async ({ shaders, utilities, helpers, textureHelper }) => {
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
            const createMaterial = new Function('THREE', 'envMap', `
                const currentLighting='diagonal', lightDistance=3, surfaceGrain=true, dirtyMirrors=true, currentShape='tesseract';
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
            uniforms.backFaceTest.value = true;
            uniforms.worldNormal.value.set(0, 0, 2);
            const front = measure();
            uniforms.winding.value = -1;
            uniforms.worldNormal.value.set(0, 0, -2);
            const back = measure();
            renderer.dispose();
            return { displaySide, roundTrip, metalPixel, unlitMetal, litMetal, clearLight, blockedLight, highlights, near, far, oblique, unlit, translated, orbited, diagonal, quad, front, back };
        }, { shaders, utilities: context.shaderUtilities(), helpers, textureHelper });
        assert.deepEqual(errors, [], 'all viewer shaders compile without WebGL errors');
        assert.equal(result.displaySide,16,'tiny source images are safely resized for physical environment filtering');
        for (const channel of result.roundTrip.slice(0, 3)) assert(Math.abs(channel - 128) <= 1, 'sRGB texture → linear → sRGB preserves middle gray');
        assert(result.highlights[0] < result.highlights[1] && result.highlights[1] < result.highlights[2] && result.highlights[2] < 255, 'HDR highlights retain distinct levels instead of clipping to white');
        assert(result.clearLight > result.blockedLight + 20, `occlusion darkens illumination: ${result.clearLight} > ${result.blockedLight}`);
        assert(result.metalPixel[0] > 0 && result.metalPixel[0] < 255, 'physical aged metal renders');
        assert(result.unlitMetal[0] > 0, 'metal reflects the environment without local lights');
        assert(Math.abs(result.litMetal[0] - result.unlitMetal[0]) < 3, 'off-specular point light does not brighten the entire reflection');
        const close = (key, expected) => assert(Math.abs(result[key] - expected) <= 1.5 / 255, `${key}: ${result[key]} ≈ ${expected}`);
        close('near', 0.92); close('far', 0.245); // direct contribution falls by four
        close('oblique', 0.47); close('unlit', 0.02); // cosine law, no negative light
        close('translated', 0.245); // actual surface position, not distance to origin
        close('orbited', 0.92); // rotating the camera does not move lights
        close('diagonal', 0.92); close('quad', 0.245); // radius and total intensity
        close('front', 0.9); close('back', 0.9); // symmetric two-sided illumination
        console.log('PASS: shader compilation, sRGB round-trip, inverse-square/cosine laws, world-fixed lights, two-sided normals');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
