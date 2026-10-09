/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Explicit local-export paths shared by Studio and the viewer. No arbitrary URL imports.
export function normalizeExportFolder(value) {
    if(typeof value!=='string')throw new Error('Invalid export folder');
    const match=/^\/?exports\/([a-zA-Z0-9_-]+)\/?$/.exec(value);
    if(!match)throw new Error('Select a folder inside exports/');
    return `exports/${match[1]}`;
}
export function exportFileURL(folder,file) {
    if(!/^(?:px|nx|py|ny|pz|nz)\.(?:png|jpe?g)$|^preview\.png$|^(?:manifest|pipeline)\.json$/.test(file))throw new Error('Invalid export file');
    return `/${normalizeExportFolder(folder)}/${file}`;
}
export function viewerURL(folder) {
    const url=new URL('/',location.origin);url.searchParams.set('skybox',normalizeExportFolder(folder));return url.href;
}
export function studioURL(folder) {
    const url=new URL('/studio/',location.origin);url.searchParams.set('pipeline',`${normalizeExportFolder(folder)}/pipeline.json`);return url.href;
}
