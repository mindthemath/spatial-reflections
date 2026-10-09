/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Pure pixel-budget tests: no browser, Canvas, source files or dependencies required.
const assert=require('node:assert/strict');
(async()=>{
    const {analyzeResolution,planResolution}=await import('./resolution.js');
    const faces=['px','nx','py','ny','pz','nz'];
    const source=(id,width,height)=>({id,type:'source',source:{path:`raw/${id}.jpg`,width,height}});
    const readSource=async source=>source;
    const pipeline={nodes:[source('large',8000,6000),source('other',4000,5000),source('unused-tiny',20,10),
        {id:'crop',type:'crop',settings:{zoom:4,rotation:45,panX:0.8}},
        {id:'crop2',type:'crop',settings:{zoom:1.5}},
        {id:'light',type:'light'}, {id:'info',type:'info'}, {id:'cube',type:'skybox'}],
        edges:[{from:'large',to:'crop'},{from:'crop',to:'crop2'},{from:'crop2',to:'light'},{from:'light',to:'info'},
            ...faces.map(face=>({from:face==='px'?'info':'other',to:'cube',input:face}))]};
    let report=await analyzeResolution(pipeline,readSource);
    assert.equal(report.maxSide,1000);assert.equal(report.faces.px.nativeWidth,8000);assert.deepEqual(report.limitingFaces,['px']);
    const plan=planResolution(pipeline,1000,report);
    assert.equal(plan.get('crop2'),1000);assert.equal(plan.get('crop'),1500);assert.equal(plan.get('large'),6000);assert.equal(plan.get('light'),1000);
    // Zooming an already-cropped stage further lowers the common output ceiling.
    pipeline.nodes.find(n=>n.id==='crop2').settings.zoom=3;
    report=await analyzeResolution(pipeline,readSource);assert.equal(report.maxSide,500);
    // Branch demands are combined, not independently downsized too early.
    const branching={nodes:[source('photo',8000,6000),{id:'shared-light',type:'light'},
        {id:'near',type:'crop',settings:{zoom:2}},{id:'far',type:'crop',settings:{zoom:4}},{id:'cube',type:'skybox'}],
        edges:[{from:'photo',to:'shared-light'},{from:'shared-light',to:'near'},{from:'shared-light',to:'far'},
            ...faces.map(face=>({from:face==='px'?'far':'near',to:'cube',input:face}))]};
    report=await analyzeResolution(branching,readSource);assert.equal(report.maxSide,1500);
    assert.equal(planResolution(branching,1500,report).get('shared-light'),6000);
    // Incomplete cubes cannot be exported; even very small complete images work.
    branching.edges=branching.edges.filter(e=>e.input!=='ny');report=await analyzeResolution(branching,readSource);assert.equal(report.complete,false);assert.equal(report.maxSide,0);
    const tiny={nodes:[source('tiny',48,31),{id:'cube',type:'skybox'}],edges:faces.map(face=>({from:'tiny',to:'cube',input:face}))};
    report=await analyzeResolution(tiny,readSource);assert.equal(report.maxSide,31);
    console.log('PASS: native dimensions, chained zoom, rotation/pan, branch sizing, incomplete cube, tiny sources and unused-source exclusion.');
})().catch(error=>{console.error(error);process.exitCode=1;});
