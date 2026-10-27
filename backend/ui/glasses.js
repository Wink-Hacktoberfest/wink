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
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;position:absolute;inset:0;cursor:grab;touch-action:pan-y';
    renderer.domElement.setAttribute('aria-hidden','true');
    scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30,1,.1,60);
    camera.position.set(0,2.1,6); camera.lookAt(0,-.4,-.8);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    environment = pmrem.fromScene(room,.04); scene.environment=environment.texture;
    room.dispose(); pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff,0x71767d,1.3));
    const key = new THREE.DirectionalLight(0xffffff,2); key.position.set(2,5,7); scene.add(key);
    const rim = new THREE.DirectionalLight(0xdce5ee,1.5); rim.position.set(-4,1,-3); scene.add(rim);
    const render = () => { if (!disposed && visible && !document.hidden) renderer.render(scene,camera); };
    const resize = () => {
      const {width,height} = stage.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width,height,false); camera.aspect=width/height;
      // Keep full temples in view on narrow layouts too.
      camera.position.z = Math.max(6,8.5/camera.aspect);
      camera.lookAt(0,-.4,-.8); camera.updateProjectionMatrix(); render();
    };
    const animate = now => {
      frame=0;
      if(disposed || !enabled || !visible || document.hidden || !model) return;
      const delta=previousTime ? Math.min((now-previousTime)/1000,.05) : 0; previousTime=now;
      if(!dragging) phase+=delta*.25;
      model.rotation.y = -.52 + offset + Math.sin(phase)*.25;
      model.rotation.z = -.035 + Math.sin(phase*.7)*.018;
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
    renderer.domElement.addEventListener('pointermove',event=>{if(!dragging||!model)return;offset+=(event.clientX-previousX)*.008;previousX=event.clientX;model.rotation.y=-.52+offset+Math.sin(phase)*.25;render()});
    const endDrag=()=>{dragging=false;renderer.domElement.style.cursor='grab'};
    renderer.domElement.addEventListener('pointerup',endDrag);
    renderer.domElement.addEventListener('pointercancel',endDrag);
    const cleanup = () => {
      if(disposed)return;disposed=true;stop();resizeObserver.disconnect();observer.disconnect();
      document.removeEventListener('visibilitychange',onVisibility);reducedMotion.removeEventListener('change',onMotion);toggle?.removeEventListener('click',onToggle);
      model?.traverse(object=>{object.geometry?.dispose(); if(object.material) for(const material of Array.isArray(object.material)?object.material:[object.material])material.dispose()});
      environment.dispose();renderer.dispose();
    };
    window.addEventListener('pagehide',event=>{if(event.persisted)stop();else cleanup()});
    window.addEventListener('pageshow',()=>{if(!disposed)start()});
    renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();stop();renderer.domElement.style.display='none';fallback.hidden=false;if(toggle)toggle.disabled=true;stage.dataset.model='fallback'});
    new GLTFLoader().load('/tv/models/wink-glasses.glb',gltf=>{
      if(disposed)return;
      model=gltf.scene;model.rotation.set(0,-.52,-.035);scene.add(model);
      stage.append(renderer.domElement);fallback.hidden=true;stage.dataset.model='ready';resize();start();
    },undefined,()=>{cleanup();if(toggle)toggle.disabled=true;stage.dataset.model='fallback'});
  } catch {
    renderer?.dispose();environment?.dispose();if(toggle)toggle.disabled=true;stage.dataset.model='fallback';
  }
}
