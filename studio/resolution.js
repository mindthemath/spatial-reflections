// Pixel budgets, independent of Canvas/UI. Only cube-connected sources limit export.
export const MAX_CANVAS_SIDE = 32767;
export const RESOLUTION_PRESETS = [128,256,512,1024,2048,4096,8192,16384];

export async function analyzeResolution(pipeline, readSource) {
    const nodes = new Map(pipeline.nodes.map(node => [node.id, node]));
    const memo = new Map();
    async function budget(id) {
        if (memo.has(id)) return memo.get(id);
        const result = (async () => {
            const node = nodes.get(id);
            if (!node) throw new Error('Missing upstream node');
            if (node.type === 'source') {
                const {width,height} = await readSource(node.source);
                if (!(width > 0 && height > 0)) throw new Error('Source has no pixels');
                return {width,height,sourceNode:id,sourcePath:node.source.path,nativeWidth:width,nativeHeight:height,crops:[]};
            }
            const edge = pipeline.edges.find(edge => edge.to === id);
            if (!edge) throw new Error(`${node.type.toUpperCase()} has no image input`);
            const upstream = await budget(edge.from);
            if (node.type === 'crop') {
                // Match the cover-crop scale. Flooring at each stage also avoids rounding-induced upscaling.
                const side = Math.floor(Math.min(upstream.width,upstream.height) / node.settings.zoom);
                return {...upstream,width:side,height:side,crops:[...upstream.crops,{nodeId:id,zoom:node.settings.zoom,maxSide:side}]};
            }
            if (node.type === 'light' && node.legacy) {
                const side = Math.min(upstream.width,upstream.height);
                return {...upstream,width:side,height:side};
            }
            return upstream;
        })();
        memo.set(id,result);
        return result;
    }
    const cube = pipeline.nodes.find(node => node.type === 'skybox');
    const faces = {};
    for (const face of ['px','nx','py','ny','pz','nz']) {
        try {
            const edge = pipeline.edges.find(edge => edge.to === cube?.id && edge.input === face);
            if (!edge) throw new Error('Not connected');
            const info = await budget(edge.from);
            faces[face] = {...info,maxSide:Math.min(info.width,info.height),upstreamNode:edge.from};
        } catch (error) { faces[face] = {error:error.message,maxSide:0}; }
    }
    for (const node of pipeline.nodes.filter(node => node.type === 'info')) {
        try { await budget(node.id); } catch { /* Disconnected analysis does not limit cube export. */ }
    }
    const nodeMaxSides = {};
    for (const [id,promise] of memo) {
        try { const info = await promise; nodeMaxSides[id] = Math.min(info.width,info.height); } catch { nodeMaxSides[id] = 0; }
    }
    const complete = Object.values(faces).every(face => !face.error && face.maxSide >= 1);
    const nativeMax = complete ? Math.min(...Object.values(faces).map(face => face.maxSide)) : 0;
    const maxSide = Math.min(nativeMax,MAX_CANVAS_SIDE);
    return {policy:'no-upscale-v1',complete,nativeMax,maxSide,canvasSideLimit:MAX_CANVAS_SIDE,
        limitingFaces:complete ? Object.keys(faces).filter(face => faces[face].maxSide === nativeMax) : [],faces,nodeMaxSides};
}

// Propagate output demand backwards so earlier stages retain the pixels later zooms need.
export function planResolution(pipeline, side, profile) {
    const required = new Map();
    function demand(id, pixels) {
        pixels = Math.ceil(pixels);
        if ((required.get(id) || 0) >= pixels) return;
        required.set(id,pixels);
        const node = pipeline.nodes.find(node => node.id === id);
        if (node.type === 'source') return;
        const edge = pipeline.edges.find(edge => edge.to === id);
        if (edge) demand(edge.from,node.type === 'crop' ? pixels * node.settings.zoom : pixels);
    }
    const cube = pipeline.nodes.find(node => node.type === 'skybox');
    for (const edge of pipeline.edges.filter(edge => edge.to === cube.id)) demand(edge.from,side);
    // Info branches retain up to 512 native pixels, without inflating the cube's export size.
    for (const node of pipeline.nodes.filter(node => node.type === 'info')) {
        demand(node.id,Math.max(1,Math.min(512,profile.nodeMaxSides[node.id] || 1)));
    }
    return required;
}
