/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Pure geometry tests; no browser, server or GPU.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','tesseract.js'),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function polytopeTopology('),source.indexOf('function setViewerShape(')),context);
for(const [shape,v,e,tri,quad,cells] of [['tesseract',16,32,0,24,8],['rectified-5-cell',10,30,30,0,10]]){
 const topology=vm.runInContext(`polytopeTopology('${shape}')`,context);
 assert.equal(topology.vertices.length,v);assert.equal(topology.edges.length,e);
 assert.equal(topology.faces.filter(face=>face.length===3).length,tri);
 assert.equal(topology.faces.filter(face=>face.length===4).length,quad);
 assert.equal(v-e+tri+quad-cells,0);
 const edges=new Set(topology.edges.map(pair=>[...pair].sort((a,b)=>a-b).join('-')));
 for(const [a,b] of topology.edges){
  const length=Math.hypot(...['x','y','z','w'].map(axis=>topology.vertices[a][axis]-topology.vertices[b][axis]));
  assert(Math.abs(length-2)<1e-10);
 }
 for(const face of topology.faces){
  assert.equal(new Set(face).size,face.length);
  for(let i=0;i<face.length;i++)assert(edges.has([face[i],face[(i+1)%face.length]].sort((a,b)=>a-b).join('-')));
 }
 for(let i=0;i<v;i++)assert.equal(topology.edges.filter(pair=>pair.includes(i)).length,shape==='rectified-5-cell'?6:4);
}
context.vertices=[{position:{x:0,y:0,z:0}},{position:{x:1,y:0,z:0}},{position:{x:1,y:1,z:0}},{position:{x:0,y:1,z:0}}];
vm.runInContext(source.slice(source.indexOf('function facePositionArray('),source.indexOf('// Build the currently selected')),context);
assert.equal(vm.runInContext('facePositionArray([0,1,2]).length',context),9);
assert.equal(vm.runInContext('facePositionArray([0,1,2,3]).length',context),18);
console.log('PASS: tesseract and all-triangular rectified 5-cell topology.');

(async () => {
 const THREE = await import('three');
 for (const shape of ['tesseract','rectified-5-cell']) {
  const topology = vm.runInContext(`polytopeTopology('${shape}')`,context);
  const vertices = topology.vertices.map(point => ({position:new THREE.Vector3(), userData:{vertex4D:point}}));
  const faces = topology.faces.map(indices => {
   const geometry = new THREE.BufferGeometry();
   geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array((indices.length-2)*9),3));
   return {geometry,userData:{vertices:indices}};
  });
  const shadowGeometry = new THREE.BufferGeometry();
  shadowGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(faces.reduce((n,face)=>n+face.geometry.getAttribute('position').array.length,0)),3));
  const projection = vm.createContext({time:0,rotationCoefficients:{xw:0,yw:0,zw:0},vertices,faces,edges:[],tesseract:{userData:{shadowMesh:{geometry:shadowGeometry}}},
   rotate4D:point=>point, project4Dto3D:point=>({x:point.x/2,y:point.y/2,z:point.z/2})});
  vm.runInContext(source.slice(source.indexOf('function updateTesseractProjection('),source.indexOf('// 4D rotation functions')),projection);
  const buffers = faces.map(face=>face.geometry.getAttribute('position'));
  for (let frame=0;frame<100;frame++) vm.runInContext('updateTesseractProjection()',projection);
  assert.deepEqual(Array.from(shadowGeometry.getAttribute('position').array),Array.from(faces).flatMap(face=>Array.from(face.geometry.getAttribute('position').array)),'merged shadow caster matches the visible faces');
  faces.forEach((face,i)=>{
   assert.equal(face.geometry.getAttribute('position'),buffers[i],'animation reuses position buffers');
   const expected=[];
   const indices=face.userData.vertices;
   for(let k=1;k<indices.length-1;k++)for(const index of [indices[0],indices[k],indices[k+1]])expected.push(...vertices[index].position.toArray());
   assert.deepEqual(Array.from(buffers[i].array),Array.from(new Float32Array(expected)));
   assert(face.geometry.boundingSphere.radius>0);
  });
 }
 console.log('PASS: animation reuses face buffers, with correct triangles and current bounds.');
})().catch(error=>{console.error(error);process.exitCode=1;});
