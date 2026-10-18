/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Compatibility entry point. Prefer the individually selectable domain tests.
const {ensureGuard}=require('./test_lifecycle.cjs');
ensureGuard(__filename,{network:true,timeout:360});
const {spawnSync}=require('node:child_process'),path=require('node:path');
for(const [file,mode] of [['test_studio_browser.cjs'],['test_app_browser.cjs'],['test_video_browser.cjs','resumable'],['test_video_browser.cjs','simple']]){
 const result=spawnSync(process.execPath,[path.join(__dirname,file)],{stdio:'inherit',env:{...process.env,...(mode?{TESSERACT_TEST_VIDEO_MODE:mode}:{})}});
 if(result.status!==0){process.exitCode=result.status||1;break;}
}
