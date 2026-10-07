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
