/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Compile the actual viewer shaders and test color/lighting numerically on the GPU.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'tesseract.js'), 'utf8');
const helpers = source.slice(source.indexOf('function createShaderMaterial('), source.indexOf('// Function to project 4D to 3D'));
const context = { THREE: { ShaderMaterial: class { constructor(options) { Object.assign(this, options); } }, DoubleSide: 2 }, currentLighting: 'diagonal', lightDistance: 3, surfaceGrain: false, dirtyMirrors: false, currentShape: 'tesseract', envMap: null };
vm.runInNewContext(helpers, context);
const shaders = ['rough', 'iridescent', 'chrome'].map(type => context.createShaderMaterial(type));
(async () => {
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
        const result = await page.evaluate(async shaders => {
            const THREE = await import('/vendor/three.module.js');
            const renderer = new THREE.WebGLRenderer();
            renderer.setSize(32, 32);
            const scene = new THREE.Scene();
            const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
            camera.position.z = 2;
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
            scene.add(mesh);
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 4;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 4, 4);
            const cube = new THREE.CubeTexture(Array(6).fill(canvas));
            cube.colorSpace = THREE.SRGBColorSpace; cube.needsUpdate = true;
            const pixel = () => {
                const data = new Uint8Array(4);
                renderer.getContext().readPixels(16, 16, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, data);
                return Array.from(data);
            };
            mesh.material = new THREE.ShaderMaterial({
                uniforms: { envMap: { value: cube } },
                vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
                fragmentShader: 'uniform samplerCube envMap; void main(){gl_FragColor=textureCube(envMap,vec3(1.0,0.0,0.0));\n#include <colorspace_fragment>\n}'
            });
            renderer.render(scene, camera);
            const roundTrip = pixel();
            for (const shader of shaders) {
                if (shader.uniforms.envMap) shader.uniforms.envMap.value = cube;
                mesh.material = new THREE.ShaderMaterial(shader);
                renderer.render(scene, camera);
            }
            renderer.dispose();
            return { roundTrip };
        }, shaders);
        assert.deepEqual(errors, [], 'all viewer shaders compile without WebGL errors');
        for (const channel of result.roundTrip.slice(0, 3)) assert(Math.abs(channel - 128) <= 1, 'sRGB texture → linear → sRGB preserves middle gray');
        console.log('PASS: shader compilation and GPU sRGB round-trip');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
