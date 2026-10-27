import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Decorative background: all product actions remain in the DOM above the model.
const stage = document.getElementById('glasses-stage');
if (stage) {
  const fallback = document.createElement('img');
  fallback.src = '/tv/models/wink-glasses.svg';
  fallback.alt = 'Matte black smart glasses';
  fallback.className = 'glasses-fallback';
  fallback.style.cssText = 'width:100%;height:100%;object-fit:contain;position:absolute;inset:0';
  stage.append(fallback);
  if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
  const toggle = document.getElementById('rotateGlasses');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let renderer, environment, scene, model, frame = 0, disposed = false;
  let enabled = !reducedMotion.matches, visible = true, dragging = false, previousX = 0, offset = 0, phase = 0, previousTime = 0;
  const syncButton = () => {
    if (!toggle) return;
    toggle.setAttribute('aria-pressed',String(enabled));
    toggle.setAttribute('aria-label',enabled ? 'Pause glasses rotation' : 'Rotate glasses');
    toggle.title = enabled ? 'Pause glasses rotation' : 'Rotate glasses';
    const label=toggle.querySelector('[data-rotation-label]');
    if(label) label.textContent=enabled ? 'Pause rotation' : 'Rotate glasses';
  };
  syncButton();
  try {
    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, powerPreference:'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,2));
    renderer.setClearColor(0x000000,0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;position:absolute;inset:0;cursor:grab;touch-action:pan-y';
    renderer.domElement.setAttribute('aria-hidden','true');
    scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(29,1,.1,60);
    camera.position.set(0,2.1,6.6); camera.lookAt(0,-.35,-1.3);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    environment = pmrem.fromScene(room,.04); scene.environment=environment.texture;
    room.dispose(); pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff,0x71767d,.6));
    const key = new THREE.DirectionalLight(0xffffff,.75); key.position.set(-3,7,5);scene.add(key);
    // A broad, feathered studio contact shadow avoids a hard duplicate silhouette.
    const shadowCanvas=document.createElement('canvas');shadowCanvas.width=256;shadowCanvas.height=256;
    const shadowContext=shadowCanvas.getContext('2d');
    const gradient=shadowContext.createRadialGradient(128,128,12,128,128,124);
    gradient.addColorStop(0,'rgba(20,22,25,.23)');gradient.addColorStop(.4,'rgba(20,22,25,.12)');gradient.addColorStop(1,'rgba(20,22,25,0)');
    shadowContext.fillStyle=gradient;shadowContext.fillRect(0,0,256,256);
    const shadowTexture=new THREE.CanvasTexture(shadowCanvas);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(8,6.5),new THREE.MeshBasicMaterial({map:shadowTexture,transparent:true,opacity:.7,depthWrite:false}));
    floor.rotation.x=-Math.PI/2;floor.position.set(0,-1.09,-1.6);scene.add(floor);
    const rim = new THREE.DirectionalLight(0xdce5ee,.45); rim.position.set(-4,1,-3); scene.add(rim);
    const render = () => { if (!disposed && visible && !document.hidden) renderer.render(scene,camera); };
    const resize = () => {
      const {width,height} = stage.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width,height,false); camera.aspect=width/height;
      // Keep full temples in view on narrow layouts too.
      camera.position.z = Math.max(camera.aspect > 3 ? 5.8 : 6.6,11.8/camera.aspect);
      camera.position.y = camera.aspect > 3 ? 1.25 : 2.1;
      camera.lookAt(0,-.35,-1.3); camera.updateProjectionMatrix(); render();
    };
    const animate = now => {
      frame=0;
      if(disposed || !enabled || !visible || document.hidden || !model) return;
      const delta=previousTime ? Math.min((now-previousTime)/1000,.05) : 0; previousTime=now;
      if(!dragging) phase+=delta*.16;
      model.rotation.y = -.62 + offset + Math.sin(phase)*.12;
      model.rotation.z = 0;
      render(); frame=requestAnimationFrame(animate);
    };
    const start = () => { if(!frame && enabled && visible && !document.hidden && model) {previousTime=0;frame=requestAnimationFrame(animate)} else render(); };
    const stop = () => {cancelAnimationFrame(frame);frame=0;previousTime=0};
    const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(stage);
    const observer = new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;visible?start():stop()}); observer.observe(stage);
    const onVisibility = () => document.hidden ? stop() : start();
    const onMotion = () => { enabled=!reducedMotion.matches;syncButton();enabled?start():stop(); };
    const onToggle = () => {enabled=!enabled;syncButton();enabled?start():stop();};
    document.addEventListener('visibilitychange',onVisibility);
    reducedMotion.addEventListener('change',onMotion);
    toggle?.addEventListener('click',onToggle);
    renderer.domElement.addEventListener('pointerdown',event=>{if(event.pointerType==='touch')return;dragging=true;previousX=event.clientX;renderer.domElement.setPointerCapture(event.pointerId);renderer.domElement.style.cursor='grabbing'});
    renderer.domElement.addEventListener('pointermove',event=>{if(!dragging||!model)return;offset+=(event.clientX-previousX)*.008;previousX=event.clientX;model.rotation.y=-.62+offset+Math.sin(phase)*.12;render()});
    const endDrag=()=>{dragging=false;renderer.domElement.style.cursor='grab'};
    renderer.domElement.addEventListener('pointerup',endDrag);
    renderer.domElement.addEventListener('pointercancel',endDrag);
    const cleanup = () => {
      if(disposed)return;disposed=true;stop();resizeObserver.disconnect();observer.disconnect();
      document.removeEventListener('visibilitychange',onVisibility);reducedMotion.removeEventListener('change',onMotion);toggle?.removeEventListener('click',onToggle);
      model?.traverse(object=>{object.geometry?.dispose(); if(object.material) for(const material of Array.isArray(object.material)?object.material:[object.material])material.dispose()});
      floor.geometry.dispose();floor.material.dispose();shadowTexture.dispose();environment.dispose();renderer.dispose();
    };
    window.addEventListener('pagehide',event=>{if(event.persisted)stop();else cleanup()});
    window.addEventListener('pageshow',()=>{if(!disposed)start()});
    renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();stop();renderer.domElement.style.display='none';fallback.hidden=false;if(toggle)toggle.disabled=true;stage.dataset.model='fallback'});
    new GLTFLoader().load('/tv/models/wink-glasses.glb',gltf=>{
      if(disposed)return;
      model=gltf.scene;model.position.x=-.65;model.traverse(object=>{if(object.isMesh){object.castShadow=!object.material.transparent;object.receiveShadow=true}});model.rotation.set(0,-.62,0);scene.add(model);
      stage.append(renderer.domElement);fallback.hidden=true;stage.dataset.model='ready';resize();start();
    },undefined,()=>{cleanup();if(toggle)toggle.disabled=true;stage.dataset.model='fallback'});
  } catch {
    renderer?.dispose();environment?.dispose();if(toggle)toggle.disabled=true;stage.dataset.model='fallback';
  }
}
