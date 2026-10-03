import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { installSkyboxLibrary } from './viewer-skyboxes.js';

// Main Three.js scene setup
let scene, camera, renderer, controls;
let tesseract;
let rotationSpeed = 0.005;
let time = 0;
let animationPaused = true;
let timelineFrame = 0;
let exportFps = 60;
let loopTiming = { period: 0, frameCount: 1, timeStep: 0, exact: true };
let lastAnimationTimestamp = null;
let frameAccumulator = 0;
// Track object references
let vertices = [];
let edges = [];
let faces = [];
// Rotation coefficients
let rotationCoefficients = {
    xw: 0.0,
    yw: 0.0,
    zw: 0.0
};
// Shader options
let currentShader = 'chrome';
// Lighting options
let currentLighting = 'diagonal';
let lightDistance = 0.1;
// UI elements
let controlPanel;
let showVertices = false;
let showOverlay = true;
let cameraInfoDisplay;
let motionStepSlider;
let motionStepLabel;
let loopInfoDisplay;
let timelineSlider;
let timelineFrameDisplay;
let exportFpsSelect;
let panelExpanded = true;
let videoTimingExpanded = false;
let savedCameraPosition = { x: 3, y: 3, z: 3 };
let savedCameraTarget = { x: 0, y: 0, z: 0 };
const VIEWER_SETTINGS_KEY = 'tesseract.viewer-settings.v1';

function loadViewerSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(VIEWER_SETTINGS_KEY));
        if (!saved || typeof saved !== 'object') return;
        const clamp = (value, min, max, fallback) => {
            const number = Number(value);
            return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
        };
        rotationSpeed = clamp(saved.rotationSpeed, 0, 0.01, rotationSpeed);
        lightDistance = clamp(saved.lightDistance, 0.1, 20, lightDistance);
        for (const axis of ['xw', 'yw', 'zw']) {
            rotationCoefficients[axis] = clamp(saved.rotationCoefficients?.[axis], -1, 1, rotationCoefficients[axis]);
        }
        if (['rough', 'iridescent', 'chrome'].includes(saved.shader)) currentShader = saved.shader;
        if (['diagonal', 'topdown', 'quad'].includes(saved.lighting)) currentLighting = saved.lighting;
        if ([24, 25, 30, 50, 60].includes(Number(saved.exportFps))) exportFps = Number(saved.exportFps);
        if (typeof saved.showVertices === 'boolean') showVertices = saved.showVertices;
        if (typeof saved.animationPaused === 'boolean') animationPaused = saved.animationPaused;
        if (typeof saved.panelExpanded === 'boolean') panelExpanded = saved.panelExpanded;
        if (typeof saved.videoTimingExpanded === 'boolean') videoTimingExpanded = saved.videoTimingExpanded;
        const vector = (value, fallback) => {
            if (!value || !['x', 'y', 'z'].every(axis => Number.isFinite(Number(value[axis])))) return fallback;
            return { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
        };
        savedCameraPosition = vector(saved.camera?.position, savedCameraPosition);
        savedCameraTarget = vector(saved.camera?.target, savedCameraTarget);
        timelineFrame = Math.max(0, Math.trunc(Number(saved.timelineFrame) || 0));
    } catch {
        // Keep defaults when local storage is unavailable or contains invalid data.
    }
}

function persistViewerSettings() {
    try {
        localStorage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify({
            rotationSpeed,
            rotationCoefficients,
            shader: currentShader,
            lighting: currentLighting,
            lightDistance,
            showVertices,
            animationPaused,
            exportFps,
            timelineFrame,
            panelExpanded,
            videoTimingExpanded,
            camera: {
                position: camera ? { x: camera.position.x, y: camera.position.y, z: camera.position.z } : savedCameraPosition,
                target: controls ? { x: controls.target.x, y: controls.target.y, z: controls.target.z } : savedCameraTarget
            }
        }));
    } catch {
        // The viewer remains usable when local storage is blocked or full.
    }
}

loadViewerSettings();
window.addEventListener('pagehide', persistViewerSettings);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistViewerSettings();
});
// File drop zone
let dropZone;
let dropZoneVisible = false;
// Environment map for reflections
let envMap;
let skyboxLibrary;

// Initialize the scene
function init() {
    console.log("Initializing...");
    
    // Create scene
    scene = new THREE.Scene();
    
    // Create camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(savedCameraPosition.x, savedCameraPosition.y, savedCameraPosition.z);
    
    // Create renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    
    // Add orbit controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(savedCameraTarget.x, savedCameraTarget.y, savedCameraTarget.z);
    controls.addEventListener('end', persistViewerSettings);
    
    // Create the tesseract
    createTesseract();
    
    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);
    
    // Add keyboard controls
    window.addEventListener('keydown', onKeyDown, false);
    
    // Add UI controls, then connect the export library to the existing Chrome environment.
    createControls();
    createEnvironmentMap();
    
    // Initialize file upload for loading views
    initFileUpload();
    
    // Create drop zone for file dropping
    createDropZone();
    
    // Setup drag and drop handlers
    setupDragAndDropHandlers();
    
    // Start animation loop
    animate();
    
    console.log("Initialization complete");
}

// Create environment map for reflections
function createEnvironmentMap() {
    skyboxLibrary = installSkyboxLibrary({
        mount: document.getElementById('controlPanelContent'),
        renderer,
        getShader: () => currentShader,
        onTexture: texture => {
            const previous = envMap;
            envMap = texture;
            updateMaterialsWithEnvMap();
            previous?.dispose();
        },
        onSwitchChrome: () => {
            const select = document.getElementById('viewer-shader');
            select.value = 'chrome';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
}

// Setup drag and drop handlers for loading views
function setupDragAndDropHandlers() {
    const dropZone = document.getElementById('drop-zone');
    if (!dropZone) return;
    
    // Handle drag over
    window.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.style.display = 'block';
    });
    
    // Handle drag leave
    window.addEventListener('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const rect = document.body.getBoundingClientRect();
        if (e.clientX <= rect.left || e.clientX >= rect.right || 
            e.clientY <= rect.top || e.clientY >= rect.bottom) {
            dropZone.style.display = 'none';
        }
    });
    
    // Handle drop
    window.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.style.display = 'none';
        
        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.type === 'image/png') {
                readMetadataFromPNG(file);
            } else {
                alert('Please drop a PNG image file.');
            }
        }
    });
}

// Create a visual drop zone for dragging and dropping files
function createDropZone() {
    const dropZone = document.createElement('div');
    dropZone.id = 'drop-zone';
    dropZone.innerHTML = 'Drop PNG here to load view';
    dropZone.style.display = 'none';
    dropZone.style.position = 'absolute';
    dropZone.style.top = '0';
    dropZone.style.left = '0';
    dropZone.style.width = '100%';
    dropZone.style.height = '100%';
    dropZone.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    dropZone.style.color = 'white';
    dropZone.style.textAlign = 'center';
    dropZone.style.paddingTop = '45vh';
    dropZone.style.fontSize = '24px';
    dropZone.style.zIndex = '1000';
    dropZone.style.pointerEvents = 'none';
    document.body.appendChild(dropZone);
}

// Read metadata from a PNG file
function readMetadataFromPNG(file) {
    console.log("Reading metadata from PNG file:", file.name);
    
    const reader = new FileReader();
    
    reader.onload = function(event) {
        const img = new Image();
        
        img.onload = function() {
            let metadataSource = "embedded";
            let success = false;
            
            try {
                // Create a canvas to read the PNG data
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                
                // Try to extract metadata - first from pixel data
                let metadata = null;
                
                try {
                    // Method 1: Try to read from pixel data
                    const imgData = ctx.getImageData(0, 0, canvas.width, 1);
                    const pixelData = imgData.data;
                    
                    // Check for our marker pixel
                    if (pixelData[0] === 254 && pixelData[1] === 0 && pixelData[2] === 254) {
                        console.log("Found marker pixel, trying to extract metadata from pixels");
                        
                        // Reconstruct string from pixel data
                        let dataString = "";
                        for (let i = 1; i < 500; i++) { // Limit to reasonable number of pixels
                            const pixelIndex = i * 4;
                            if (pixelIndex >= pixelData.length) break;
                            
                            const charCode = pixelData[pixelIndex];
                            if (charCode === 0) break; // End of data
                            dataString += String.fromCharCode(charCode);
                        }
                        
                        console.log("Extracted data string:", dataString);
                        
                        // Check if we found our metadata marker
                        const marker = "tESSdata=";
                        if (dataString.startsWith(marker)) {
                            const jsonStr = dataString.substring(marker.length);
                            try {
                                // Extract only the valid JSON part by finding the last closing brace
                                let jsonEnd = jsonStr.lastIndexOf('}');
                                if (jsonEnd > 0) {
                                    const cleanJsonStr = jsonStr.substring(0, jsonEnd + 1);
                                    metadata = JSON.parse(cleanJsonStr);
                                    console.log("Successfully extracted metadata from pixels:", metadata);
                                } else {
                                    console.error("Failed to find valid JSON end delimiter in pixel data");
                                }
                            } catch (e) {
                                console.error("Failed to parse pixel metadata JSON:", e);
                            }
                        }
                    }
                } catch (pixelError) {
                    console.error("Error reading pixel data:", pixelError);
                }
                
                // If we have valid metadata, apply it
                if (metadata) {
                    console.log("Applying extracted metadata from PNG");
                    success = applyViewSettings(metadata);
                    if (success) {
                        alert("Successfully loaded view settings from embedded metadata!");
                        return;
                    }
                }
                
                // Fallback to filename parsing if no metadata found
                console.log("No embedded metadata found, falling back to filename parsing");
                metadataSource = "filename";
                success = parseMetadataFromFilename(file.name);
                if (success) {
                    alert("Successfully loaded view settings from filename!");
                } else {
                    alert("Could not load view settings from either embedded metadata or filename.");
                }
                
            } catch (error) {
                console.error('Error reading PNG metadata:', error);
                
                // Fallback to filename parsing
                console.log("Error reading PNG, falling back to filename parsing");
                metadataSource = "filename (after error)";
                success = parseMetadataFromFilename(file.name);
                
                if (success) {
                    alert("Successfully loaded view settings from filename (after error)!");
                } else {
                    alert("Failed to load view settings from either method.\nError: " + error.message);
                }
            }
        };
        
        img.onerror = function() {
            alert('Failed to load the image.');
        };
        
        img.src = event.target.result;
    };
    
    reader.onerror = function() {
        alert('Failed to read the file.');
    };
    
    reader.readAsDataURL(file);
}

// Parse metadata from filename for backward compatibility
function parseMetadataFromFilename(filename) {
    console.log("Parsing metadata from filename:", filename);
    
    try {
        // First, remove any file extension
        const cleanName = filename.replace(/\.png$/i, '');
        
        // Expected format: tesseract_TIMESTAMP_pos_X_Y_Z_rot_XW_YW_ZW_time_T_target_TX_TY_TZ
        const parts = cleanName.split('_');
        console.log("Filename parts:", parts);
        
        // Extract data from filename parts
        let metadata = {
            camera: { position: {} },
            rotation: {},
            time: 0, // Default time value
            target: { x: 0, y: 0, z: 0 } // Default target at origin
        };
        
        // Find position values
        const posIndex = parts.indexOf('pos');
        if (posIndex > 0 && posIndex + 3 < parts.length) {
            metadata.camera.position.x = parseFloat(parts[posIndex + 1]);
            metadata.camera.position.y = parseFloat(parts[posIndex + 2]);
            metadata.camera.position.z = parseFloat(parts[posIndex + 3]);
            console.log("Found position:", metadata.camera.position);
        }
        
        // Find rotation values
        const rotIndex = parts.indexOf('rot');
        if (rotIndex > 0 && rotIndex + 3 < parts.length) {
            metadata.rotation.xw = parseFloat(parts[rotIndex + 1]);
            metadata.rotation.yw = parseFloat(parts[rotIndex + 2]);
            metadata.rotation.zw = parseFloat(parts[rotIndex + 3]);
            console.log("Found rotation:", metadata.rotation);
        }
        
        // Find time value
        const timeIndex = parts.indexOf('time');
        if (timeIndex > 0 && timeIndex + 1 < parts.length) {
            metadata.time = parseFloat(parts[timeIndex + 1]);
            console.log("Found time:", metadata.time);
        }
        
        // Find target values
        const targetIndex = parts.indexOf('target');
        if (targetIndex > 0 && targetIndex + 3 < parts.length) {
            metadata.target.x = parseFloat(parts[targetIndex + 1]);
            metadata.target.y = parseFloat(parts[targetIndex + 2]);
            metadata.target.z = parseFloat(parts[targetIndex + 3]);
            console.log("Found target:", metadata.target);
        }
        
        console.log("Extracted metadata from filename:", metadata);
        
        // Apply the extracted settings
        return applyViewSettings(metadata);
    } catch (error) {
        console.error("Error parsing metadata from filename:", error);
        return false;
    }
}

// Apply view settings from extracted metadata
function applyViewSettings(metadata) {
    console.log("Applying view settings from metadata:", metadata);
    
    try {
        // Set camera position
        if (metadata.camera && metadata.camera.position) {
            camera.position.set(
                parseFloat(metadata.camera.position.x),
                parseFloat(metadata.camera.position.y),
                parseFloat(metadata.camera.position.z)
            );
            console.log("Set camera position to:", camera.position);
        }
        
        // Set rotation coefficients
        if (metadata.rotation) {
            rotationCoefficients.xw = parseFloat(metadata.rotation.xw) || 0;
            rotationCoefficients.yw = parseFloat(metadata.rotation.yw) || 0;
            rotationCoefficients.zw = parseFloat(metadata.rotation.zw) || 0;
            console.log("Set rotation coefficients to:", rotationCoefficients);
            
            // Update UI sliders if they exist
            updateRotationSliders();
        }
        
        // Restore video timing before mapping the saved time onto the deterministic timeline.
        if (metadata.animation?.fps) {
            exportFps = parseInt(metadata.animation.fps, 10) || exportFps;
            if (exportFpsSelect) exportFpsSelect.value = String(exportFps);
        }
        if (metadata.animation?.motionStep !== undefined) {
            rotationSpeed = Math.max(0, parseFloat(metadata.animation.motionStep) || 0);
            if (motionStepSlider) motionStepSlider.value = String(rotationSpeed * 1000);
            if (motionStepLabel) motionStepLabel.textContent = `Motion Step: ${rotationSpeed.toFixed(3)} / frame`;
        }
        refreshLoopTiming({ preserveTime: false });
        if (metadata.animation?.frame !== undefined) {
            setTimelineFrame(parseInt(metadata.animation.frame, 10) || 0);
        } else if (metadata.time !== undefined) {
            setTimelineTime(parseFloat(metadata.time) || 0);
        }
        console.log("Set animation time to:", time);
        
        // Set camera target
        if (metadata.target) {
            controls.target.set(
                parseFloat(metadata.target.x) || 0,
                parseFloat(metadata.target.y) || 0,
                parseFloat(metadata.target.z) || 0
            );
            console.log("Set camera target to:", controls.target);
        }
        
        // Update controls and camera
        controls.update();
        camera.updateProjectionMatrix();
        
        // Ensure all material uniforms are updated correctly
        // For backward compatibility - reapply current lighting parameters
        const materials = [];
        faces.forEach(face => {
            if (face.material && !materials.includes(face.material)) {
                materials.push(face.material);
            }
        });
        
        vertices.forEach(vertex => {
            if (vertex.material && !materials.includes(vertex.material)) {
                materials.push(vertex.material);
            }
        });
        
        // Convert lighting type to integer for shader
        let lightingTypeInt;
        switch(currentLighting) {
            case 'topdown':
                lightingTypeInt = 1;
                break;
            case 'quad':
                lightingTypeInt = 2;
                break;
            case 'diagonal':
            default:
                lightingTypeInt = 0;
                break;
        }
        
        // Update the uniform values in all materials
        materials.forEach(material => {
            if (material.uniforms) {
                if (material.uniforms.lightDistance) {
                    material.uniforms.lightDistance.value = lightDistance;
                }
                if (material.uniforms.lightingType) {
                    material.uniforms.lightingType.value = lightingTypeInt;
                }
            }
        });
        
        // If no materials were found, create new ones
        if (materials.length === 0) {
            updateMaterials();
        }
        
        // Pause animation when a view is restored
        animationPaused = true;
        persistViewerSettings();
        
        console.log("Successfully applied view settings");
        return true;
    } catch (error) {
        console.error("Error applying view settings:", error);
        return false;
    }
}

// Update rotation sliders in the UI
function updateRotationSliders() {
    console.log("Updating rotation sliders to:", rotationCoefficients);
    
    try {
        // Look specifically for the rotation sliders in the rotationControls container
        const rotationControls = document.getElementById('rotationControls');
        if (!rotationControls) {
            console.warn("Could not find rotation controls container - skipping slider update");
            return;
        }
        
        const sliders = rotationControls.querySelectorAll('input[type="range"]');
        if (sliders.length < 3) {
            console.warn("Could not find enough rotation sliders, found:", sliders.length);
            return;
        }
        
        // The sliders are now directly identified by their index in the rotation controls section
        const xwSlider = sliders[0]; 
        const ywSlider = sliders[1];
        const zwSlider = sliders[2];
        
        console.log("Found rotation sliders");
        
        // Set slider values - using 20 as the multiplier for a step of 0.05 (1/20 = 0.05)
        xwSlider.value = rotationCoefficients.xw * 20;
        ywSlider.value = rotationCoefficients.yw * 20;
        zwSlider.value = rotationCoefficients.zw * 20;
        
        console.log("Set slider values to:", xwSlider.value, ywSlider.value, zwSlider.value);
        
        // Update displayed values - with two decimal places
        const valueDisplays = rotationControls.querySelectorAll('span');
        if (valueDisplays.length >= 3) {
            // Values are now directly targeted
            valueDisplays[0].textContent = rotationCoefficients.xw.toFixed(2);
            valueDisplays[1].textContent = rotationCoefficients.yw.toFixed(2);
            valueDisplays[2].textContent = rotationCoefficients.zw.toFixed(2);
            console.log("Updated value displays");
        } else {
            console.warn("Could not find enough value display elements, found:", valueDisplays.length);
        }
        
        // Force the slider input event to ensure any attached handlers run
        try {
            const event = new Event('input', { bubbles: true });
            xwSlider.dispatchEvent(event);
            ywSlider.dispatchEvent(event);
            zwSlider.dispatchEvent(event);
        } catch (e) {
            console.warn("Could not dispatch events to sliders:", e);
        }
    } catch (error) {
        console.warn("Error updating rotation sliders:", error);
        // Continue execution, this is not a critical error
    }
}

// Create UI controls
function createControls() {
    controlPanel = document.createElement('div');
    controlPanel.id = 'controlPanel';
    controlPanel.style.position = 'absolute';
    controlPanel.style.top = '10px';
    controlPanel.style.left = '10px';
    controlPanel.style.width = '205px';
    controlPanel.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    controlPanel.style.color = 'white';
    controlPanel.style.padding = '10px';
    controlPanel.style.borderRadius = '0';
    controlPanel.style.fontFamily = 'Arial, sans-serif';
    controlPanel.style.fontSize = '14px';
    controlPanel.style.zIndex = '100';
    controlPanel.style.maxHeight = 'calc(100vh - 20px)';
    controlPanel.style.overflowY = 'auto';
    
    // Create camera info display
    cameraInfoDisplay = document.createElement('div');
    cameraInfoDisplay.id = 'viewer-camera-info';
    cameraInfoDisplay.style.marginBottom = '10px';
    controlPanel.appendChild(cameraInfoDisplay);
    
    // Create speed control
    const speedContainer = document.createElement('div');
    speedContainer.style.marginBottom = '10px';
    
    motionStepLabel = document.createElement('div');
    motionStepLabel.textContent = `Motion Step: ${rotationSpeed.toFixed(3)} / frame`;
    motionStepLabel.style.marginBottom = '5px';
    speedContainer.appendChild(motionStepLabel);
    
    motionStepSlider = document.createElement('input');
    motionStepSlider.type = 'range';
    motionStepSlider.min = '0';
    motionStepSlider.max = '10';
    motionStepSlider.step = '1';
    motionStepSlider.value = rotationSpeed * 1000;
    motionStepSlider.style.width = '100%';
    
    motionStepSlider.addEventListener('input', function() {
        rotationSpeed = this.value / 1000;
        motionStepLabel.textContent = `Motion Step: ${rotationSpeed.toFixed(3)} / frame`;
        refreshLoopTiming();
    });
    
    speedContainer.appendChild(motionStepSlider);
    controlPanel.appendChild(speedContainer);
    
    // Create vertex visibility toggle (moved above rotation controls)
    const vertexToggle = document.createElement('div');
    vertexToggle.style.marginBottom = '10px';
    
    const vertexCheckbox = document.createElement('input');
    vertexCheckbox.type = 'checkbox';
    vertexCheckbox.id = 'vertexToggle';
    vertexCheckbox.checked = showVertices;
    
    vertexCheckbox.addEventListener('change', function() {
        showVertices = this.checked;
        vertices.forEach(vertex => {
            vertex.visible = showVertices;
        });
    });
    
    const vertexLabel = document.createElement('label');
    vertexLabel.htmlFor = 'vertexToggle';
    vertexLabel.textContent = 'Show Vertices';
    vertexLabel.style.marginLeft = '5px';
    
    vertexToggle.appendChild(vertexCheckbox);
    vertexToggle.appendChild(vertexLabel);
    controlPanel.appendChild(vertexToggle);
    
    // Create shader selection
    const shaderContainer = document.createElement('div');
    shaderContainer.style.marginBottom = '10px';
    
    const shaderLabel = document.createElement('div');
    shaderLabel.textContent = 'Shader Type:';
    shaderLabel.style.marginBottom = '5px';
    shaderContainer.appendChild(shaderLabel);
    
    const shaderSelect = document.createElement('select');
    shaderSelect.id = 'viewer-shader';
    shaderSelect.style.width = '100%';
    shaderSelect.style.padding = '3px';
    shaderSelect.style.backgroundColor = '#222';
    shaderSelect.style.color = 'white';
    shaderSelect.style.border = '1px solid #555';
    
    // Add shader options
    const roughOption = document.createElement('option');
    roughOption.value = 'rough';
    roughOption.textContent = 'Rough (debug)';
    roughOption.selected = currentShader === 'rough';
    shaderSelect.appendChild(roughOption);
    
    const iridescientOption = document.createElement('option');
    iridescientOption.value = 'iridescent';
    iridescientOption.textContent = 'Iridescent (debug)';
    iridescientOption.selected = currentShader === 'iridescent';
    shaderSelect.appendChild(iridescientOption);
    
    const chromeOption = document.createElement('option');
    chromeOption.value = 'chrome';
    chromeOption.textContent = 'Reflective Chrome';
    chromeOption.selected = currentShader === 'chrome';
    shaderSelect.appendChild(chromeOption);
    
    // Handle shader changes
    shaderSelect.addEventListener('change', function() {
        currentShader = this.value;
        updateMaterials();
        skyboxLibrary?.refreshShaderHint();
    });
    
    shaderContainer.appendChild(shaderSelect);
    controlPanel.appendChild(shaderContainer);
    
    // Create lighting control
    const lightingContainer = document.createElement('div');
    lightingContainer.style.marginBottom = '10px';
    
    const lightingLabel = document.createElement('div');
    lightingLabel.textContent = 'Lighting:';
    lightingLabel.style.marginBottom = '5px';
    lightingContainer.appendChild(lightingLabel);
    
    // Lighting type selector
    const lightingSelect = document.createElement('select');
    lightingSelect.style.width = '100%';
    lightingSelect.style.padding = '3px';
    lightingSelect.style.backgroundColor = '#222';
    lightingSelect.style.color = 'white';
    lightingSelect.style.border = '1px solid #555';
    lightingSelect.style.marginBottom = '5px';
    
    // Add lighting options
    const diagonalOption = document.createElement('option');
    diagonalOption.value = 'diagonal';
    diagonalOption.textContent = 'Diagonal (1,1,1)';
    diagonalOption.selected = currentLighting === 'diagonal';
    lightingSelect.appendChild(diagonalOption);
    
    const topdownOption = document.createElement('option');
    topdownOption.value = 'topdown';
    topdownOption.textContent = 'Top-Down';
    topdownOption.selected = currentLighting === 'topdown';
    lightingSelect.appendChild(topdownOption);
    
    const quadOption = document.createElement('option');
    quadOption.value = 'quad';
    quadOption.textContent = 'Spot Quadrants (4)';
    quadOption.selected = currentLighting === 'quad';
    lightingSelect.appendChild(quadOption);
    
    // Light distance control
    const distanceLabel = document.createElement('div');
    distanceLabel.textContent = `Light Distance: ${lightDistance.toFixed(1)}`;
    distanceLabel.style.marginTop = '5px';
    distanceLabel.style.marginBottom = '5px';
    
    const distanceSlider = document.createElement('input');
    distanceSlider.type = 'range';
    distanceSlider.min = '0.1';
    distanceSlider.max = '20';
    distanceSlider.step = '0.1';
    distanceSlider.value = lightDistance;
    distanceSlider.style.width = '100%';
    
    // Handle lighting changes
    lightingSelect.addEventListener('change', function() {
        currentLighting = this.value;
        
        // Convert lighting type to integer for shader
        let lightingTypeInt;
        switch(currentLighting) {
            case 'topdown':
                lightingTypeInt = 1;
                break;
            case 'quad':
                lightingTypeInt = 2;
                break;
            case 'diagonal':
            default:
                lightingTypeInt = 0;
                break;
        }
        
        // Update existing materials' uniforms directly
        const materials = [];
        faces.forEach(face => {
            if (face.material && !materials.includes(face.material)) {
                materials.push(face.material);
            }
        });
        
        vertices.forEach(vertex => {
            if (vertex.material && !materials.includes(vertex.material)) {
                materials.push(vertex.material);
            }
        });
        
        // Update the uniform value in all materials
        materials.forEach(material => {
            if (material.uniforms && material.uniforms.lightingType) {
                material.uniforms.lightingType.value = lightingTypeInt;
            }
        });
        
        // If there are no existing materials or the update fails, create new ones
        if (materials.length === 0) {
            updateMaterials();
        }
    });
    
    distanceSlider.addEventListener('input', function() {
        lightDistance = parseFloat(this.value);
        distanceLabel.textContent = `Light Distance: ${lightDistance.toFixed(1)}`;
        
        // Update existing materials' uniforms directly
        const materials = [];
        faces.forEach(face => {
            if (face.material && !materials.includes(face.material)) {
                materials.push(face.material);
            }
        });
        
        vertices.forEach(vertex => {
            if (vertex.material && !materials.includes(vertex.material)) {
                materials.push(vertex.material);
            }
        });
        
        // Update the uniform value in all materials
        materials.forEach(material => {
            if (material.uniforms && material.uniforms.lightDistance) {
                material.uniforms.lightDistance.value = lightDistance;
            }
        });
        
        // If there are no existing materials or the update fails, create new ones
        if (materials.length === 0) {
            updateMaterials();
        }
    });
    
    lightingContainer.appendChild(lightingSelect);
    lightingContainer.appendChild(distanceLabel);
    lightingContainer.appendChild(distanceSlider);
    controlPanel.appendChild(lightingContainer);
    
    // Helper function to update all materials
    function updateMaterials() {
        const previousMaterials = new Set([...faces, ...vertices].map(object => object.material));
        const newMaterial = createShaderMaterial();
        
        faces.forEach(face => {
            face.material = newMaterial;
        });
        
        vertices.forEach(vertex => {
            vertex.material = newMaterial;
        });
        previousMaterials.forEach(material => material.dispose());
    }
    
    // Add rotation controls
    const rotationControls = document.createElement('div');
    rotationControls.id = 'rotationControls';
    rotationControls.innerHTML = `
        <h3>4D Rotation</h3>
        <div class="rotation-row">
            <label for="rotation-xw">XW: <span>${rotationCoefficients.xw.toFixed(2)}</span></label>
            <input id="rotation-xw" type="range" min="-20" max="20" value="${rotationCoefficients.xw * 20}" step="1">
        </div>
        <div class="rotation-row">
            <label for="rotation-yw">YW: <span>${rotationCoefficients.yw.toFixed(2)}</span></label>
            <input id="rotation-yw" type="range" min="-20" max="20" value="${rotationCoefficients.yw * 20}" step="1">
        </div>
        <div class="rotation-row">
            <label for="rotation-zw">ZW: <span>${rotationCoefficients.zw.toFixed(2)}</span></label>
            <input id="rotation-zw" type="range" min="-20" max="20" value="${rotationCoefficients.zw * 20}" step="1">
        </div>
    `;
    rotationControls.querySelectorAll('.rotation-row').forEach(row => {
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '7.5em minmax(0, 1fr)',
            alignItems: 'center',
            gap: '6px'
        });
        row.querySelector('label').style.fontVariantNumeric = 'tabular-nums';
        row.querySelector('input').style.width = '100%';
        row.querySelector('input').style.minWidth = '0';
    });
    
    // Update rotation coefficient when sliders change
    const rotationSliders = rotationControls.querySelectorAll('input[type="range"]');
    rotationSliders[0].addEventListener('input', function() {
        rotationCoefficients.xw = this.value / 20; // Divide by 20 for a step of 0.05
        rotationControls.querySelectorAll('span')[0].textContent = rotationCoefficients.xw.toFixed(2);
        refreshLoopTiming();
        updateCameraInfo();
    });
    
    rotationSliders[1].addEventListener('input', function() {
        rotationCoefficients.yw = this.value / 20; // Divide by 20 for a step of 0.05
        rotationControls.querySelectorAll('span')[1].textContent = rotationCoefficients.yw.toFixed(2);
        refreshLoopTiming();
        updateCameraInfo();
    });
    
    rotationSliders[2].addEventListener('input', function() {
        rotationCoefficients.zw = this.value / 20; // Divide by 20 for a step of 0.05
        rotationControls.querySelectorAll('span')[2].textContent = rotationCoefficients.zw.toFixed(2);
        refreshLoopTiming();
        updateCameraInfo();
    });
    controlPanel.appendChild(rotationControls);

    // Keep video-oriented controls collapsed until they are needed.
    const videoTimingDetails = document.createElement('details');
    videoTimingDetails.open = videoTimingExpanded;
    videoTimingDetails.addEventListener('toggle', () => {
        videoTimingExpanded = videoTimingDetails.open;
        persistViewerSettings();
    });
    videoTimingDetails.style.marginTop = '10px';
    videoTimingDetails.style.paddingTop = '8px';
    videoTimingDetails.style.borderTop = '1px solid #555';

    const videoTimingSummary = document.createElement('summary');
    videoTimingSummary.textContent = 'Video timing';
    videoTimingSummary.style.cursor = 'pointer';
    videoTimingDetails.appendChild(videoTimingSummary);

    const videoTimingContent = document.createElement('div');
    videoTimingContent.style.marginTop = '8px';

    const fpsRow = document.createElement('label');
    fpsRow.style.display = 'flex';
    fpsRow.style.justifyContent = 'space-between';
    fpsRow.style.alignItems = 'center';
    fpsRow.textContent = 'FPS';

    exportFpsSelect = document.createElement('select');
    exportFpsSelect.style.background = '#222';
    exportFpsSelect.style.color = 'white';
    exportFpsSelect.style.border = '1px solid #555';
    [24, 25, 30, 50, 60].forEach(fps => {
        const option = document.createElement('option');
        option.value = String(fps);
        option.textContent = String(fps);
        option.selected = fps === exportFps;
        exportFpsSelect.appendChild(option);
    });
    exportFpsSelect.addEventListener('change', function() {
        exportFps = parseInt(this.value, 10);
        lastAnimationTimestamp = null;
        frameAccumulator = 0;
        updateLoopTimingUI();
    });
    fpsRow.appendChild(exportFpsSelect);
    videoTimingContent.appendChild(fpsRow);

    loopInfoDisplay = document.createElement('div');
    loopInfoDisplay.style.marginTop = '7px';
    loopInfoDisplay.style.fontSize = '11px';
    loopInfoDisplay.style.lineHeight = '1.45';
    loopInfoDisplay.style.color = '#c5cfdb';
    videoTimingContent.appendChild(loopInfoDisplay);

    timelineSlider = document.createElement('input');
    timelineSlider.type = 'range';
    timelineSlider.min = '0';
    timelineSlider.max = '0';
    timelineSlider.step = '1';
    timelineSlider.value = '0';
    timelineSlider.style.width = '100%';
    timelineSlider.style.marginTop = '7px';
    timelineSlider.addEventListener('input', function() {
        setTimelineFrame(parseInt(this.value, 10));
        frameAccumulator = 0;
    });
    videoTimingContent.appendChild(timelineSlider);

    timelineFrameDisplay = document.createElement('div');
    timelineFrameDisplay.style.fontSize = '11px';
    timelineFrameDisplay.style.textAlign = 'center';
    videoTimingContent.appendChild(timelineFrameDisplay);

    const frameButtons = document.createElement('div');
    frameButtons.style.display = 'flex';
    frameButtons.style.gap = '5px';
    frameButtons.style.marginTop = '6px';
    [['− Frame', -1], ['+ Frame', 1]].forEach(([label, direction]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.flex = '1';
        button.style.padding = '4px';
        button.addEventListener('click', () => {
            animationPaused = true;
            setTimelineFrame(timelineFrame + direction);
            persistViewerSettings();
        });
        frameButtons.appendChild(button);
    });
    videoTimingContent.appendChild(frameButtons);

    const videoTimingHint = document.createElement('div');
    videoTimingHint.textContent = 'Exact frame timeline for a seamless future export.';
    videoTimingHint.style.marginTop = '7px';
    videoTimingHint.style.fontSize = '10px';
    videoTimingHint.style.color = '#9cadc3';
    videoTimingContent.appendChild(videoTimingHint);

    videoTimingDetails.appendChild(videoTimingContent);
    controlPanel.appendChild(videoTimingDetails);
    
    // Add control buttons below rotation sliders
    const buttonContainer = document.createElement('div');
    buttonContainer.style.marginTop = '10px';
    buttonContainer.style.marginBottom = '10px';
    
    // First row of buttons: Play/Pause and Reset Time
    const buttonRow1 = document.createElement('div');
    buttonRow1.style.display = 'flex';
    buttonRow1.style.justifyContent = 'space-between';
    buttonRow1.style.marginBottom = '5px';
    
    // Play/Pause button
    const playPauseButton = document.createElement('button');
    playPauseButton.textContent = 'Play/Pause';
    playPauseButton.style.flex = '1';
    playPauseButton.style.marginRight = '5px';
    playPauseButton.style.padding = '5px';
    playPauseButton.addEventListener('click', function() {
        animationPaused = !animationPaused;
        lastAnimationTimestamp = null;
        frameAccumulator = 0;
        persistViewerSettings();
    });
    
    // Reset Time button
    const resetTimeButton = document.createElement('button');
    resetTimeButton.textContent = 'Reset Time';
    resetTimeButton.style.flex = '1';
    resetTimeButton.style.padding = '5px';
    resetTimeButton.addEventListener('click', function() {
        setTimelineFrame(0);
        updateCameraInfo();
        persistViewerSettings();
    });
    
    buttonRow1.appendChild(playPauseButton);
    buttonRow1.appendChild(resetTimeButton);
    buttonContainer.appendChild(buttonRow1);
    
    // Second row of buttons: Reset Position and Reset Target
    const buttonRow2 = document.createElement('div');
    buttonRow2.style.display = 'flex';
    buttonRow2.style.justifyContent = 'space-between';
    buttonRow2.style.marginBottom = '5px';
    
    // Reset Position button
    const resetPositionButton = document.createElement('button');
    resetPositionButton.textContent = 'Reset Camera';
    resetPositionButton.style.flex = '1';
    resetPositionButton.style.marginRight = '5px';
    resetPositionButton.style.padding = '5px';
    resetPositionButton.addEventListener('click', function() {
        // Reset camera to initial position
        camera.position.set(3, 3, 3);
        updateCameraInfo();
        controls.update();
        persistViewerSettings();
    });
    
    // Reset Target button
    const resetTargetButton = document.createElement('button');
    resetTargetButton.textContent = 'Reset Target';
    resetTargetButton.style.flex = '1';
    resetTargetButton.style.padding = '5px';
    resetTargetButton.addEventListener('click', function() {
        // Reset target to origin (0, 0, 0)
        controls.target.set(0, 0, 0);
        updateCameraInfo();
        controls.update();
        persistViewerSettings();
    });
    
    buttonRow2.appendChild(resetPositionButton);
    buttonRow2.appendChild(resetTargetButton);
    buttonContainer.appendChild(buttonRow2);
    
    // Third row: Save button on its own
    const buttonRow3 = document.createElement('div');
    buttonRow3.style.display = 'flex';
    buttonRow3.style.justifyContent = 'center';
    
    // Save button
    const saveButton = document.createElement('button');
    saveButton.textContent = 'Save';
    saveButton.style.width = '100%';
    saveButton.style.padding = '5px';
    saveButton.addEventListener('click', function() {
        saveScreenshot();
    });
    
    buttonRow3.appendChild(saveButton);
    buttonContainer.appendChild(buttonRow3);
    
    controlPanel.appendChild(buttonContainer);
    
    // Create controls info
    const controlsInfo = document.createElement('div');
    controlsInfo.style.marginTop = '15px';
    controlsInfo.style.fontSize = '12px';
    controlsInfo.innerHTML = `
        <div>Space: Play/Pause</div>
        <div>R: Reset Time</div>
        <div>O: Toggle UI</div>
        <div>S: Save Screenshot</div>
    `;
    controlPanel.appendChild(controlsInfo);
    
    const panelContent = document.createElement('div');
    panelContent.id = 'controlPanelContent';
    while (controlPanel.firstChild) {
        panelContent.appendChild(controlPanel.firstChild);
    }

    const panelToggle = document.createElement('button');
    panelToggle.type = 'button';
    panelToggle.textContent = '▾ Controls';
    panelContent.hidden = !panelExpanded;
    panelToggle.setAttribute('aria-expanded', String(panelExpanded));
    panelToggle.setAttribute('aria-controls', panelContent.id);
    Object.assign(panelToggle.style, {
        width: '100%',
        background: 'transparent',
        color: 'inherit',
        border: 'none',
        padding: '0',
        textAlign: 'left',
        font: 'inherit',
        fontWeight: 'bold',
        cursor: 'pointer',
        marginBottom: panelExpanded ? '10px' : '0'
    });
    panelToggle.textContent = panelExpanded ? '▾ Controls' : '▸ Controls';
    panelToggle.addEventListener('click', () => {
        panelContent.hidden = !panelContent.hidden;
        panelExpanded = !panelContent.hidden;
        panelToggle.setAttribute('aria-expanded', String(panelExpanded));
        panelToggle.textContent = panelExpanded ? '▾ Controls' : '▸ Controls';
        panelToggle.style.marginBottom = panelExpanded ? '10px' : '0';
        persistViewerSettings();
    });
    controlPanel.append(panelToggle, panelContent);
    document.body.appendChild(controlPanel);

    // Input handlers update the application state first; bubbling then saves it.
    controlPanel.addEventListener('input', persistViewerSettings);
    controlPanel.addEventListener('change', persistViewerSettings);
    
    // Initialize the exact loop timeline and camera display.
    const restoredTimelineFrame = timelineFrame;
    refreshLoopTiming({ preserveTime: false });
    setTimelineFrame(restoredTimelineFrame);
    updateCameraInfo();
}

const COEFFICIENT_SCALE = 1000000;

function greatestCommonDivisor(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b !== 0) {
        [a, b] = [b, a % b];
    }
    return a;
}

function calculateLoopPeriod() {
    const scaledCoefficients = Object.values(rotationCoefficients).map(value => {
        const scaled = Math.round(value * COEFFICIENT_SCALE);
        return Math.abs(value - scaled / COEFFICIENT_SCALE) < 1e-10 ? Math.abs(scaled) : null;
    });

    if (scaledCoefficients.some(value => value === null)) return null;
    const activeCoefficients = scaledCoefficients.filter(value => value !== 0);
    if (activeCoefficients.length === 0) return 0;

    const divisor = activeCoefficients.reduce(greatestCommonDivisor);
    return 2 * Math.PI * COEFFICIENT_SCALE / divisor;
}

function refreshLoopTiming({ preserveTime = true } = {}) {
    const previousTime = preserveTime ? time : 0;
    const period = calculateLoopPeriod();

    if (period === null) {
        loopTiming = { period: null, frameCount: 1, timeStep: 0, exact: false };
    } else if (period === 0 || rotationSpeed === 0) {
        loopTiming = { period, frameCount: 1, timeStep: 0, exact: true };
    } else {
        const frameCount = Math.max(1, Math.round(period / rotationSpeed));
        loopTiming = {
            period,
            frameCount,
            timeStep: period / frameCount,
            exact: true
        };
    }

    setTimelineTime(previousTime);
}

function setTimelineTime(requestedTime) {
    if (loopTiming.frameCount <= 1 || !loopTiming.timeStep) {
        timelineFrame = 0;
        time = 0;
    } else {
        setTimelineFrame(Math.round(requestedTime / loopTiming.timeStep));
        return;
    }
    updateLoopTimingUI();
}

function setTimelineFrame(requestedFrame) {
    const count = loopTiming.frameCount;
    timelineFrame = count > 1 ? ((requestedFrame % count) + count) % count : 0;
    time = timelineFrame * loopTiming.timeStep;
    updateLoopTimingUI();
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    if (seconds < 60) return `${seconds.toFixed(2)} s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds - minutes * 60;
    return `${minutes}:${remainingSeconds.toFixed(2).padStart(5, '0')}`;
}

function updateLoopTimingUI() {
    if (timelineSlider) {
        timelineSlider.max = String(Math.max(0, loopTiming.frameCount - 1));
        timelineSlider.value = String(timelineFrame);
        timelineSlider.disabled = loopTiming.frameCount <= 1;
    }
    if (timelineFrameDisplay) {
        timelineFrameDisplay.textContent = `Frame ${timelineFrame + 1} / ${loopTiming.frameCount}`;
    }
    if (!loopInfoDisplay) return;

    if (!loopTiming.exact) {
        loopInfoDisplay.textContent = 'No practical exact loop for these coefficients.';
        return;
    }
    if (loopTiming.period === 0) {
        loopInfoDisplay.textContent = 'Stationary · 1 frame';
        return;
    }
    if (rotationSpeed === 0) {
        loopInfoDisplay.textContent = 'Speed is zero · 1 frame';
        return;
    }

    const duration = loopTiming.frameCount / exportFps;
    loopInfoDisplay.innerHTML = `
        <div>${loopTiming.frameCount.toLocaleString()} frames · ${formatDuration(duration)}</div>
        <div>Loop period ${loopTiming.period.toFixed(4)} · Δt ${loopTiming.timeStep.toFixed(6)}</div>
    `;
}

// Function to update camera information display
function updateCameraInfo() {
    if (!cameraInfoDisplay) return;
    
    const pos = camera.position;
    // const rot = camera.rotation;
    const target = controls.target;
    
    // Calculate time in units of π
    const timeInPi = time / Math.PI;
    const timeInPiDisplay = timeInPi.toFixed(2) + "π";
    
    cameraInfoDisplay.innerHTML = `
        <div style="display: grid; grid-template-columns: auto auto; grid-gap: 5px;">
            <div style="text-align: right;">Camera:</div>
            <div style="text-align: right;">${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}</div>
            
            <div style="text-align: right;">Target:</div>
            <div style="text-align: right;">${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}</div>
            
            <div style="text-align: right;">Time:</div>
            <div style="text-align: right;">${time.toFixed(2)} (${timeInPiDisplay})</div>
        </div>
    `;
}

// Create sliders for rotation coefficients
function createRotationSliders() {
    const container = document.createElement('div');
    container.style.display = 'grid';
    container.style.gridTemplateColumns = 'auto 1fr auto';
    container.style.gridGap = '5px';
    container.style.alignItems = 'center';
    container.style.marginBottom = '5px';
    
    // Create slider for XW rotation
    const xwLabel = document.createElement('span');
    xwLabel.textContent = 'XW:';
    xwLabel.style.gridColumn = '1';
    
    const xwSlider = document.createElement('input');
    xwSlider.type = 'range';
    xwSlider.min = '-10';
    xwSlider.max = '10';
    xwSlider.step = '0.1';
    xwSlider.value = (rotationCoefficients.xw * 10).toString();
    xwSlider.style.gridColumn = '2';
    xwSlider.style.width = '100%';
    
    const xwValue = document.createElement('span');
    xwValue.textContent = rotationCoefficients.xw.toFixed(1);
    xwValue.style.gridColumn = '3';
    xwValue.style.minWidth = '30px';
    xwValue.style.textAlign = 'right';
    
    xwSlider.addEventListener('input', (e) => {
        rotationCoefficients.xw = parseFloat(e.target.value) / 10;
        xwValue.textContent = rotationCoefficients.xw.toFixed(1);
        updateCameraInfo();
    });
    
    // Create slider for YW rotation
    const ywLabel = document.createElement('span');
    ywLabel.textContent = 'YW:';
    ywLabel.style.gridColumn = '1';
    
    const ywSlider = document.createElement('input');
    ywSlider.type = 'range';
    ywSlider.min = '-10';
    ywSlider.max = '10';
    ywSlider.step = '0.1';
    ywSlider.value = (rotationCoefficients.yw * 10).toString();
    ywSlider.style.gridColumn = '2';
    ywSlider.style.width = '100%';
    
    const ywValue = document.createElement('span');
    ywValue.textContent = rotationCoefficients.yw.toFixed(1);
    ywValue.style.gridColumn = '3';
    ywValue.style.minWidth = '30px';
    ywValue.style.textAlign = 'right';
    
    ywSlider.addEventListener('input', (e) => {
        rotationCoefficients.yw = parseFloat(e.target.value) / 10;
        ywValue.textContent = rotationCoefficients.yw.toFixed(1);
        updateCameraInfo();
    });
    
    // Create slider for ZW rotation
    const zwLabel = document.createElement('span');
    zwLabel.textContent = 'ZW:';
    zwLabel.style.gridColumn = '1';
    
    const zwSlider = document.createElement('input');
    zwSlider.type = 'range';
    zwSlider.min = '-10';
    zwSlider.max = '10';
    zwSlider.step = '0.1';
    zwSlider.value = (rotationCoefficients.zw * 10).toString();
    zwSlider.style.gridColumn = '2';
    zwSlider.style.width = '100%';
    
    const zwValue = document.createElement('span');
    zwValue.textContent = rotationCoefficients.zw.toFixed(1);
    zwValue.style.gridColumn = '3';
    zwValue.style.minWidth = '30px';
    zwValue.style.textAlign = 'right';
    
    zwSlider.addEventListener('input', (e) => {
        rotationCoefficients.zw = parseFloat(e.target.value) / 10;
        zwValue.textContent = rotationCoefficients.zw.toFixed(1);
        updateCameraInfo();
    });
    
    // Add all sliders to the container
    container.appendChild(xwLabel);
    container.appendChild(xwSlider);
    container.appendChild(xwValue);
    
    container.appendChild(ywLabel);
    container.appendChild(ywSlider);
    container.appendChild(ywValue);
    
    container.appendChild(zwLabel);
    container.appendChild(zwSlider);
    container.appendChild(zwValue);
    
    return container;
}

// Save screenshot with embedded metadata
function saveScreenshot() {
    // Temporarily hide the overlay
    const overlayWasVisible = showOverlay;
    if (overlayWasVisible) {
        controlPanel.style.display = 'none';
    }
    
    // Render the scene
    renderer.render(scene, camera);
    
    // Get metadata for saving
    const metadata = {
        camera: {
            position: {
                x: camera.position.x,
                y: camera.position.y,
                z: camera.position.z
            }
        },
        rotation: {
            xw: rotationCoefficients.xw,
            yw: rotationCoefficients.yw,
            zw: rotationCoefficients.zw
        },
        time: time, // Include the current animation time for backward compatibility
        animation: {
            frame: timelineFrame,
            frameCount: loopTiming.frameCount,
            fps: exportFps,
            motionStep: rotationSpeed
        },
        target: {
            x: controls.target.x,
            y: controls.target.y,
            z: controls.target.z
        }
    };
    
    // Convert canvas to data URL
    let imageData = renderer.domElement.toDataURL('image/png');
    
    // Create a canvas to embed metadata in the PNG
    const canvas = document.createElement('canvas');
    const img = new Image();
    
    img.onload = function() {
        canvas.width = img.width;
        canvas.height = img.height;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        // Store metadata in tEXt chunk using a hidden canvas trick
        // We'll create a special metadata tag in the canvas
        const metadataStr = JSON.stringify(metadata);
        console.log("Embedding metadata:", metadataStr);
        
        // Encode metadata in the canvas
        // We use a data URI with Base64 encoding of metadata
        const dataURI = canvas.toDataURL('image/png');
        
        // Add metadata as a custom attribute to the canvas
        // This is a hack that some browsers support - metadata is stored in the PNG chunks
        canvas.setAttribute('tESSdata', metadataStr);
        
        // Get the PNG with metadata
        let modifiedImageData;
        try {
            // Try the modern approach with custom attributes
            modifiedImageData = canvas.toDataURL('image/png');
            
            // As a fallback, embed metadata in first row of pixels
            // Some browsers don't properly encode custom attributes in PNG chunks
            const imgData = ctx.getImageData(0, 0, canvas.width, 1);
            const pixelData = imgData.data;
            
            // First pixel is the marker (magenta)
            pixelData[0] = 254; // Almost full red
            pixelData[1] = 0;   // No green
            pixelData[2] = 254; // Almost full blue
            pixelData[3] = 255; // Full alpha
            
            // Add metadata marker
            const marker = "tESSdata=";
            const fullData = marker + metadataStr;
            
            // Encode the string in subsequent pixels
            for (let i = 0; i < fullData.length; i++) {
                const charCode = fullData.charCodeAt(i);
                const pixelIndex = (i + 1) * 4; // Start at second pixel
                
                if (pixelIndex < pixelData.length) {
                    pixelData[pixelIndex] = charCode; // Store in red channel
                    pixelData[pixelIndex + 1] = 0;    // Green is 0
                    pixelData[pixelIndex + 2] = 0;    // Blue is 0
                    pixelData[pixelIndex + 3] = 255;  // Full alpha
                }
            }
            
            // Write the modified pixel data back to the canvas
            ctx.putImageData(imgData, 0, 0);
            
            // Get the modified image with both methods applied
            modifiedImageData = canvas.toDataURL('image/png');
        } catch (e) {
            console.error("Error embedding metadata, falling back to basic method:", e);
            modifiedImageData = dataURI;
        }
        
        // Create a filename with metadata in it as fallback
        const pos = camera.position;
        const target = controls.target;
        const posStr = `pos_${pos.x.toFixed(2)}_${pos.y.toFixed(2)}_${pos.z.toFixed(2)}`;
        const rotStr = `rot_${rotationCoefficients.xw.toFixed(2)}_${rotationCoefficients.yw.toFixed(2)}_${rotationCoefficients.zw.toFixed(2)}`;
        const timeStr = `time_${time.toFixed(2)}`;
        const targetStr = `target_${target.x.toFixed(2)}_${target.y.toFixed(2)}_${target.z.toFixed(2)}`;
        const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
        const filename = `tesseract_${timestamp}_${posStr}_${rotStr}_${timeStr}_${targetStr}.png`;
        
        // Create a download link
        const link = document.createElement('a');
        link.href = modifiedImageData;
        link.download = filename;
        link.click();
        
        // Restore the overlay if it was visible
        if (overlayWasVisible) {
            controlPanel.style.display = 'block';
        }
    };
    
    img.src = imageData;
}

// Handle keyboard input
function onKeyDown(event) {
    switch (event.code) {
        case 'Space':
            // Toggle animation pause
            animationPaused = !animationPaused;
            lastAnimationTimestamp = null;
            frameAccumulator = 0;
            persistViewerSettings();
            break;
        case 'KeyR':
            // Reset animation time
            setTimelineFrame(0);
            persistViewerSettings();
            break;
        case 'KeyO':
            // Toggle overlay visibility
            showOverlay = !showOverlay;
            controlPanel.style.display = showOverlay ? 'block' : 'none';
            break;
        case 'KeyV':
            // Toggle vertex visibility
            showVertices = !showVertices;
            vertices.forEach(vertex => {
                vertex.visible = showVertices;
            });
            const vertexToggle = document.getElementById('vertexToggle');
            if (vertexToggle) vertexToggle.checked = showVertices;
            persistViewerSettings();
            break;
        case 'KeyS':
            // Save screenshot
            saveScreenshot();
            break;
    }
}

// Create vertex and fragment shaders based on the selected type
function createShaderMaterial() {
    // Common vertex shader for all types
    const vertexShader = `
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying vec3 vViewPosition;
        varying vec3 vWorldPosition;
        
        void main() {
            vNormal = normalize(normalMatrix * normal);
            vPosition = position;
            
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            vViewPosition = -mvPosition.xyz;
            
            gl_Position = projectionMatrix * mvPosition;
        }
    `;
    
    let fragmentShader;
    
    // Select fragment shader based on current type
    switch(currentShader) {
        case 'iridescent':
            fragmentShader = createIridescentShader();
            break;
        case 'chrome':
            fragmentShader = createChromeShader();
            break;
        case 'rough':
        default:
            fragmentShader = createRoughShader();
            break;
    }
    
    // Convert lighting type to integer for shader
    let lightingTypeInt;
    switch(currentLighting) {
        case 'topdown':
            lightingTypeInt = 1;
            break;
        case 'quad':
            lightingTypeInt = 2;
            break;
        case 'diagonal':
        default:
            lightingTypeInt = 0;
            break;
    }
    
    const uniforms = {
        lightingType: { value: lightingTypeInt },
        lightDistance: { value: lightDistance }
    };
    
    // Add environment map for chrome shader
    if (currentShader === 'chrome') {
        uniforms.envMap = { value: envMap };
    }
    
    return new THREE.ShaderMaterial({
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
        wireframe: false,
        side: THREE.DoubleSide,
        uniforms: uniforms
    });
}

// Common shader utility functions
function shaderUtilities() {
    return `
        // Utility function for noise
        float random(vec2 st) {
            return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
        }
        
        // Utility to calculate fresnel effect
        float fresnel(vec3 viewDirection, vec3 normal, float power) {
            return pow(1.0 - clamp(dot(viewDirection, normal), 0.0, 1.0), power);
        }
        
        // Light contribution calculation
        vec3 calculateLighting(vec3 normal, vec3 viewDir, float lightDist, int lightingType) {
            vec3 lightDir;
            float diffuse = 0.0;
            float specular = 0.0;
            float ambient = 0.1; // Base ambient light
            
            // Apply distance attenuation (inverse square law simplified)
            float distanceAttenuation = 1.0 / (1.0 + 0.1 * lightDist * lightDist);
            
            // Diagonal light (original)
            if (lightingType == 0) {
                // For diagonal light, apply the distance to the light position
                vec3 lightPos = vec3(lightDist, lightDist, lightDist);
                lightDir = normalize(lightPos);
                
                diffuse = max(0.0, dot(normal, lightDir));
                vec3 halfwayDir = normalize(lightDir + viewDir);
                specular = pow(max(0.0, dot(normal, halfwayDir)), 32.0);
                
                return vec3(ambient + (diffuse * 0.99 + specular * 0.01) * distanceAttenuation);
            }
            
            // Top-down light
            else if (lightingType == 1) {
                // Position the light directly above at the specified distance
                vec3 lightPos = vec3(0.0, lightDist, 0.0);
                lightDir = normalize(lightPos);
                
                diffuse = max(0.0, dot(normal, lightDir));
                vec3 halfwayDir = normalize(lightDir + viewDir);
                specular = pow(max(0.0, dot(normal, halfwayDir)), 32.0);
                
                return vec3(ambient + (diffuse * 0.75 + specular * 0.35) * distanceAttenuation);
            }
            
            // Quad lights from unit dimensions
            else if (lightingType == 2) {
                vec3 lightPositions[4];
                lightPositions[0] = vec3(lightDist, 0.0, 0.0);
                lightPositions[1] = vec3(0.0, 0.0, lightDist);
                lightPositions[2] = vec3(-lightDist, 0.0, 0.0);
                lightPositions[3] = vec3(0.0, 0.0, -lightDist);
                
                vec3 totalLight = vec3(ambient);
                
                for (int i = 0; i < 4; i++) {
                    vec3 lightDir = normalize(lightPositions[i]);
                    float diff = max(0.0, dot(normal, lightDir)) * 0.25; // Divide by number of lights
                    vec3 halfwayDir = normalize(lightDir + viewDir);
                    float spec = pow(max(0.0, dot(normal, halfwayDir)), 32.0) * 0.25;
                    
                    totalLight += vec3(diff * 0.75 + spec * 0.35) * distanceAttenuation;
                }
                
                return totalLight;
            }
            
            // Fallback
            return vec3(1.0);
        }
    `;
}

// Create the original rough black and white shader
function createRoughShader() {
    return `
        uniform int lightingType;
        uniform float lightDistance;
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying vec3 vViewPosition;
        
        ${shaderUtilities()}
        
        void main() {
            // Normalized vectors
            vec3 normal = normalize(vNormal);
            vec3 viewDir = normalize(vViewPosition);
            
            // Calculate lighting using common function
            vec3 lighting = calculateLighting(normal, viewDir, lightDistance, lightingType);
            
            // Add rough texture
            float noise = random(vPosition.xy * 10.0) * 0.15;
            lighting *= (1.0 - noise);
            
            // Black and white shader
            gl_FragColor = vec4(lighting, 1.0);
        }
    `;
}

// Create iridescent shader (formerly reflective mirror)
function createIridescentShader() {
    return `
        uniform int lightingType;
        uniform float lightDistance;
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying vec3 vViewPosition;
        
        ${shaderUtilities()}
        
        void main() {
            // Normalized vectors
            vec3 normal = normalize(vNormal);
            vec3 viewDir = normalize(vViewPosition);
            vec3 reflection = reflect(-viewDir, normal);
            
            // Calculate base lighting
            vec3 lighting = calculateLighting(normal, viewDir, lightDistance, lightingType);
            
            // Create iridescent color effect
            vec3 reflectionColor = normalize(reflection) * 0.5 + 0.5;
            
            // Add color shifts based on viewing angle for iridescence
            float fresnelFactor = fresnel(viewDir, normal, 2.0);
            vec3 iridescence = mix(
                vec3(0.4, 0.6, 1.0),  // Blue base
                vec3(1.0, 0.4, 0.8),  // Pink/purple highlight
                fresnelFactor
            );
            
            // Apply iridescent effect with lighting
            vec3 baseColor = mix(reflectionColor, iridescence, 0.7);
            vec3 final = baseColor * lighting;
            
            gl_FragColor = vec4(final, 1.0);
        }
    `;
}

// Create reflective chrome shader
function createChromeShader() {
    return `
        uniform int lightingType;
        uniform float lightDistance;
        uniform samplerCube envMap;
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying vec3 vViewPosition;
        varying vec3 vWorldPosition;
        
        ${shaderUtilities()}
        
        void main() {
            // Normalized vectors
            vec3 normal = normalize(vNormal);
            vec3 viewDir = normalize(vViewPosition);
            
            // World space reflection for environment mapping
            vec3 worldNormal = normalize(mat3(viewMatrix) * normal);
            vec3 worldViewDir = normalize(cameraPosition - vWorldPosition);
            vec3 worldReflection = reflect(-worldViewDir, worldNormal);
            
            // Environment map lookup
            vec4 envColor = textureCube(envMap, worldReflection);
            
            // Get base lighting
            vec3 lighting = calculateLighting(normal, viewDir, lightDistance, lightingType);
            
            // Create chrome effect with high contrast and metallic feel
            float fresnelFactor = fresnel(viewDir, normal, 5.0);
            
            // Add subtle noise for surface imperfection
            float noisePattern = random(vPosition.xy * 20.0) * 0.05;
            
            // Chrome color - mix environment map with base chrome color
            vec3 chromeColor = mix(
                vec3(0.9, 0.9, 0.9),      // Base silver-gray
                envColor.rgb,              // Environment reflection
                0.8                        // Higher reflection ratio
            );
            
            // Enhance reflectivity at glancing angles (Fresnel effect)
            chromeColor = mix(
                chromeColor,
                envColor.rgb,
                fresnelFactor * 0.8
            );
            
            // Apply lighting with less influence to preserve reflections
            vec3 final = chromeColor * (lighting * 0.7 + 0.3) - noisePattern;
            
            gl_FragColor = vec4(final, 1.0);
        }
    `;
}

// Function to project 4D to 3D using simple projection
function project4Dto3D(vertex4D, w_factor = 0.5) {
    const distance = 2 + vertex4D.w * w_factor;
    const scale = 1 / distance;
    
    return {
        x: vertex4D.x * scale,
        y: vertex4D.y * scale,
        z: vertex4D.z * scale
    };
}

// Create the tesseract
function createTesseract() {
    // A tesseract is the 4D analog of a cube - we'll visualize it as a projection to 3D
    tesseract = new THREE.Group();
    scene.add(tesseract);
    
    const material = createShaderMaterial();
    
    // Generate the vertices for the tesseract
    // In 4D, tesseract has 16 vertices, 32 edges, 24 faces, and 8 cells
    const vertices4D = [];
    
    // Generate 16 vertices of a 4D hypercube (all combinations of ±1 in 4D)
    for (let x = -1; x <= 1; x += 2) {
        for (let y = -1; y <= 1; y += 2) {
            for (let z = -1; z <= 1; z += 2) {
                for (let w = -1; w <= 1; w += 2) {
                    vertices4D.push({ x, y, z, w });
                }
            }
        }
    }
    
    // Create edges between vertices that differ by exactly one coordinate
    const edgeList = [];
    for (let i = 0; i < vertices4D.length; i++) {
        for (let j = i + 1; j < vertices4D.length; j++) {
            const v1 = vertices4D[i];
            const v2 = vertices4D[j];
            
            // Count how many coordinates differ
            let diffCount = 0;
            if (v1.x !== v2.x) diffCount++;
            if (v1.y !== v2.y) diffCount++;
            if (v1.z !== v2.z) diffCount++;
            if (v1.w !== v2.w) diffCount++;
            
            // If exactly one coordinate differs, add an edge
            if (diffCount === 1) {
                edgeList.push([i, j]);
            }
        }
    }
    
    // First create vertex objects
    vertices = [];
    for (let i = 0; i < vertices4D.length; i++) {
        const vertex3D = project4Dto3D(vertices4D[i]);
        
        // Create a small sphere to visually represent the vertex
        const vertexGeometry = new THREE.SphereGeometry(0.03, 8, 8);
        const vertexMesh = new THREE.Mesh(vertexGeometry, material);
        
        vertexMesh.position.set(vertex3D.x, vertex3D.y, vertex3D.z);
        vertexMesh.userData = { vertexIndex: i, vertex4D: {...vertices4D[i]} };
        vertexMesh.visible = showVertices;
        
        tesseract.add(vertexMesh);
        vertices.push(vertexMesh);
    }
    
    // Create edges as line segments (not cylinders) to ensure precise connections
    edges = [];
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
    
    for (let i = 0; i < edgeList.length; i++) {
        const [startIdx, endIdx] = edgeList[i];
        const start4D = vertices4D[startIdx];
        const end4D = vertices4D[endIdx];
        
        const start3D = project4Dto3D(start4D);
        const end3D = project4Dto3D(end4D);
        
        const points = [];
        points.push(new THREE.Vector3(start3D.x, start3D.y, start3D.z));
        points.push(new THREE.Vector3(end3D.x, end3D.y, end3D.z));
        
        const edgeGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const edge = new THREE.Line(edgeGeometry, edgeMaterial);
        
        edge.userData = { 
            startIdx, 
            endIdx, 
            start4D: {...start4D}, 
            end4D: {...end4D} 
        };
        
        tesseract.add(edge);
        edges.push(edge);
    }
    
    // Create faces for the tesseract
    createFaces(vertices4D, edgeList, material);
}

// Create faces for the tesseract
function createFaces(vertices4D, edgeList, material) {
    // Identify faces (square faces in the tesseract)
    const facesList = [];
    const edgePairs = {};
    
    // Map edges to vertices for faster lookup
    edgeList.forEach(([a, b]) => {
        if (!edgePairs[a]) edgePairs[a] = [];
        if (!edgePairs[b]) edgePairs[b] = [];
        
        edgePairs[a].push(b);
        edgePairs[b].push(a);
    });
    
    // Find all 4-cycles (squares) in the edge graph
    for (let a = 0; a < vertices4D.length; a++) {
        if (!edgePairs[a]) continue;
        
        for (let bIdx = 0; bIdx < edgePairs[a].length; bIdx++) {
            const b = edgePairs[a][bIdx];
            
            for (let cIdx = 0; cIdx < edgePairs[b].length; cIdx++) {
                const c = edgePairs[b][cIdx];
                if (c === a) continue; // Skip if we're going back to a
                
                for (let dIdx = 0; dIdx < edgePairs[c].length; dIdx++) {
                    const d = edgePairs[c][dIdx];
                    if (d === b) continue; // Skip if we're going back to b
                    
                    // Check if d connects back to a, forming a 4-cycle
                    if (edgePairs[d] && edgePairs[d].includes(a)) {
                        // Found a face: a-b-c-d
                        const faceKey = [a, b, c, d].sort().join('-');
                        if (!facesList.includes(faceKey)) {
                            facesList.push(faceKey);
                            
                            // Create the face geometry
                            const aPos = project4Dto3D(vertices4D[a]);
                            const bPos = project4Dto3D(vertices4D[b]);
                            const cPos = project4Dto3D(vertices4D[c]);
                            const dPos = project4Dto3D(vertices4D[d]);
                            
                            const geometry = new THREE.BufferGeometry();
                            
                            // Create face with two triangles (a-b-c and a-c-d)
                            const vertices = new Float32Array([
                                aPos.x, aPos.y, aPos.z,
                                bPos.x, bPos.y, bPos.z,
                                cPos.x, cPos.y, cPos.z,
                                
                                aPos.x, aPos.y, aPos.z,
                                cPos.x, cPos.y, cPos.z,
                                dPos.x, dPos.y, dPos.z
                            ]);
                            
                            geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
                            geometry.computeVertexNormals();
                            
                            const face = new THREE.Mesh(geometry, material);
                            face.userData = { vertices: [a, b, c, d] };
                            
                            tesseract.add(face);
                            faces.push(face);
                        }
                    }
                }
            }
        }
    }
}

// Project the 4D tesseract to 3D dynamically
function updateTesseractProjection() {
    // Apply rotation coefficients to current time
    const w_rotation1 = time * rotationCoefficients.xw;  // XW rotation
    const w_rotation2 = time * rotationCoefficients.yw;  // YW rotation
    const w_rotation3 = time * rotationCoefficients.zw;  // ZW rotation
    
    // First update vertex positions
    for (let i = 0; i < vertices.length; i++) {
        const vertex = vertices[i];
        const vertex4D = vertex.userData.vertex4D;
        const rotated4D = rotate4D(vertex4D, w_rotation1, w_rotation2, w_rotation3);
        const projected3D = project4Dto3D(rotated4D);
        
        // Update vertex position
        vertex.position.set(projected3D.x, projected3D.y, projected3D.z);
    }
    
    // Then update edges
    for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const startIdx = edge.userData.startIdx;
        const endIdx = edge.userData.endIdx;
        
        // Get the updated vertex positions
        const startPos = vertices[startIdx].position;
        const endPos = vertices[endIdx].position;
        
        // Update the edge geometry
        const points = [
            new THREE.Vector3(startPos.x, startPos.y, startPos.z),
            new THREE.Vector3(endPos.x, endPos.y, endPos.z)
        ];
        
        // Replace the old geometry
        if (edge.geometry) edge.geometry.dispose();
        edge.geometry = new THREE.BufferGeometry().setFromPoints(points);
    }
    
    // Finally update face geometries
    for (let i = 0; i < faces.length; i++) {
        const face = faces[i];
        const faceVertices = face.userData.vertices;
        
        const positions = [];
        for (let j = 0; j < faceVertices.length; j++) {
            const vertexIdx = faceVertices[j];
            const pos = vertices[vertexIdx].position;
            positions.push(new THREE.Vector3(pos.x, pos.y, pos.z));
        }
        
        // Update the face geometry
        const geometry = new THREE.BufferGeometry();
        const vertexArray = new Float32Array([
            positions[0].x, positions[0].y, positions[0].z,
            positions[1].x, positions[1].y, positions[1].z,
            positions[2].x, positions[2].y, positions[2].z,
            
            positions[0].x, positions[0].y, positions[0].z,
            positions[2].x, positions[2].y, positions[2].z,
            positions[3].x, positions[3].y, positions[3].z
        ]);
        
        geometry.setAttribute('position', new THREE.BufferAttribute(vertexArray, 3));
        geometry.computeVertexNormals();
        
        if (face.geometry) face.geometry.dispose();
        face.geometry = geometry;
    }
}

// 4D rotation functions
function rotate4D(point4D, angleXW, angleYW, angleZW) {
    // Clone the point to avoid modifying the original
    const p = {x: point4D.x, y: point4D.y, z: point4D.z, w: point4D.w};
    
    // Rotate in XW plane
    const xw_x = p.x * Math.cos(angleXW) - p.w * Math.sin(angleXW);
    const xw_w = p.x * Math.sin(angleXW) + p.w * Math.cos(angleXW);
    p.x = xw_x;
    p.w = xw_w;
    
    // Rotate in YW plane
    const yw_y = p.y * Math.cos(angleYW) - p.w * Math.sin(angleYW);
    const yw_w = p.y * Math.sin(angleYW) + p.w * Math.cos(angleYW);
    p.y = yw_y;
    p.w = yw_w;
    
    // Rotate in ZW plane
    const zw_z = p.z * Math.cos(angleZW) - p.w * Math.sin(angleZW);
    const zw_w = p.z * Math.sin(angleZW) + p.w * Math.cos(angleZW);
    p.z = zw_z;
    p.w = zw_w;
    
    return p;
}

// Function to handle window resize
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Animation loop. Time is derived from an integer frame so frame 0 follows the
// final frame exactly, without accumulating floating-point additions.
function animate(timestamp) {
    requestAnimationFrame(animate);
    
    // Update controls
    controls.update();
    
    if (!animationPaused && loopTiming.frameCount > 1) {
        if (lastAnimationTimestamp !== null) {
            frameAccumulator += (timestamp - lastAnimationTimestamp) * exportFps / 1000;
            const framesToAdvance = Math.floor(frameAccumulator);
            if (framesToAdvance > 0) {
                setTimelineFrame(timelineFrame + framesToAdvance);
                frameAccumulator -= framesToAdvance;
            }
        }
        lastAnimationTimestamp = timestamp;
    } else {
        lastAnimationTimestamp = null;
        frameAccumulator = 0;
    }

    // Update camera information
    updateCameraInfo();
    
    // Update the tesseract projection
    updateTesseractProjection();
    
    // Render the scene
    renderer.render(scene, camera);
}

// Initialize file upload handler for loading views
function initFileUpload() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    
    fileInput.addEventListener('change', function(event) {
        if (event.target.files.length > 0) {
            const file = event.target.files[0];
            console.log("Loading view from file:", file.name);
            
            // Read the metadata from the PNG file
            readMetadataFromPNG(file);
        }
    });
    
    // Create a load button container
    const loadButtonContainer = document.createElement('div');
    loadButtonContainer.style.marginTop = '10px';
    loadButtonContainer.style.marginBottom = '10px';
    loadButtonContainer.style.textAlign = 'center';
    
    // Add a load view button to the control panel
    const loadButton = document.createElement('button');
    loadButton.textContent = 'Load';
    loadButton.style.width = '100%';
    loadButton.style.padding = '5px';
    loadButton.addEventListener('click', function() {
        fileInput.click();
    });
    
    loadButtonContainer.appendChild(loadButton);
    document.getElementById('controlPanelContent').appendChild(loadButtonContainer);
}

// Start the visualization
init(); 

// Update materials with the new environment map
function updateMaterialsWithEnvMap() {
    // Only needed for the chrome shader which uses environment mapping
    if (currentShader === 'chrome') {
        const materials = [];
        faces.forEach(face => {
            if (face.material && !materials.includes(face.material)) {
                materials.push(face.material);
            }
        });
        
        vertices.forEach(vertex => {
            if (vertex.material && !materials.includes(vertex.material)) {
                materials.push(vertex.material);
            }
        });
        
        materials.forEach(material => {
            if (material.uniforms && material.uniforms.envMap) {
                material.uniforms.envMap.value = envMap;
            }
        });
    }
} 
