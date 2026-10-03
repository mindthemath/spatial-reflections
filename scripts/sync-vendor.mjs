import {copyFile, mkdir, readFile, readdir, rm} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const threeRoot=resolve(root,'node_modules/three');
const vendorRoot=resolve(root,'vendor');
const modules=new Map();

function inside(parent,path) {
    const child=relative(parent,path);
    return child!==''&&!child.startsWith(`..${sep}`)&&child!=='..';
}

async function collectModule(source,destination) {
    source=resolve(source);destination=resolve(destination);
    if(!inside(threeRoot,source)||!inside(vendorRoot,destination))throw new Error(`Refusing path outside Three.js/vendor: ${source}`);
    const previous=modules.get(source);
    if(previous){
        if(previous!==destination)throw new Error(`One Three.js module maps to two vendor paths: ${source}`);
        return;
    }
    modules.set(source,destination);
    const code=await readFile(source,'utf8');
    const imports=[...code.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g)].map(match=>match[1]);
    for(const specifier of imports)await collectModule(resolve(dirname(source),specifier),resolve(dirname(destination),specifier));
}

async function filesBelow(directory) {
    const files=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const path=resolve(directory,entry.name);
        if(entry.isDirectory())files.push(...await filesBelow(path));else if(entry.isFile())files.push(path);
    }
    return files;
}

await collectModule(resolve(threeRoot,'build/three.module.js'),resolve(vendorRoot,'three.module.js'));
await collectModule(resolve(threeRoot,'examples/jsm/controls/OrbitControls.js'),resolve(vendorRoot,'controls/OrbitControls.js'));
const licenseSource=resolve(threeRoot,'LICENSE'),licenseDestination=resolve(vendorRoot,'THREE-LICENSE.txt');
const expected=new Map([...modules.entries()].map(([source,destination])=>[destination,source]));
expected.set(licenseDestination,licenseSource);

if(process.argv.includes('--check')){
    const actual=new Set(await filesBelow(vendorRoot));
    const missing=[],changed=[];
    for(const [destination,source] of expected){
        if(!actual.delete(destination)){missing.push(relative(root,destination));continue;}
        const [sourceBytes,destinationBytes]=await Promise.all([readFile(source),readFile(destination)]);
        if(!sourceBytes.equals(destinationBytes))changed.push(relative(root,destination));
    }
    if(missing.length||changed.length||actual.size){
        const details=[missing.length&&`missing: ${missing.join(', ')}`,changed.length&&`out of sync: ${changed.join(', ')}`,actual.size&&`stale: ${[...actual].map(path=>relative(root,path)).join(', ')}`].filter(Boolean).join('\n');
        throw new Error(`Vendored Three.js does not match the Bun-locked package. Run make sync.\n${details}`);
    }
    console.log(`Verified ${modules.size} vendored Three.js modules and the license.`);
}else{
    await rm(vendorRoot,{recursive:true,force:true});
    for(const [source,destination] of modules){await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);}
    await copyFile(licenseSource,licenseDestination);
    console.log(`Synchronized ${modules.size} Three.js modules and the license into vendor/.`);
}
