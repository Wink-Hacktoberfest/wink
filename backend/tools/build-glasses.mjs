// Original Wink smart-glasses study. Run `npm run build:glasses` to regenerate.
import * as T from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'public/tv/models');
await fs.mkdir(destination, { recursive: true });
globalThis.FileReader = class {
  async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
  async readAsDataURL(blob) { this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`; this.onloadend?.(); }
};
const scene = new T.Scene();
const glasses = new T.Group();
glasses.name = 'Wink original smart glasses';
scene.add(glasses);
const acetate = new T.MeshStandardMaterial({ name: 'Matte graphite acetate', color: '#101113', roughness: .32, metalness: .12 });
const lens = new T.MeshStandardMaterial({ name: 'Clear smoke lenses', color: '#aebec0', roughness: .1, metalness: .08, transparent: true, opacity: .16, side: T.DoubleSide, depthWrite: false });
const silver = new T.MeshStandardMaterial({ name: 'Satin hardware', color: '#81878b', metalness: .75, roughness: .28 });
const camera = new T.MeshStandardMaterial({ name: 'Camera glass', color: '#090c0e', metalness: .5, roughness: .12 });
const reflection = new T.MeshStandardMaterial({ name: 'Camera highlight', color: '#4b6270', metalness: .6, roughness: .13 });
function mesh(name, geometry, material, x=0, y=0, z=0) {
  const object = new T.Mesh(geometry, material); object.name = name; object.position.set(x,y,z); glasses.add(object); return object;
}
function outline(inner=false) {
  const p = new T.Shape();
  if (!inner) {
    p.moveTo(.25,.58); p.bezierCurveTo(.7,.81,1.94,.81,2.58,.64);
    p.bezierCurveTo(2.78,.56,2.64,-.12,2.47,-.61);
    p.bezierCurveTo(2.32,-1.02,1.48,-1.01,.96,-.82);
    p.bezierCurveTo(.52,-.65,.29,-.02,.25,.58);
  } else {
    p.moveTo(.55,.42); p.bezierCurveTo(1.04,.62,1.91,.63,2.28,.47);
    p.bezierCurveTo(2.47,.36,2.35,-.15,2.21,-.53);
    p.bezierCurveTo(2.1,-.81,1.48,-.81,1.08,-.65);
    p.bezierCurveTo(.73,-.51,.57,-.02,.55,.42);
  }
  p.closePath(); return p;
}
for (const side of [-1,1]) {
  const shape = outline(); shape.holes.push(new T.Path(outline(true).getPoints(32).reverse()));
  const rim = mesh(`${side === 1 ? 'Right' : 'Left'} sculpted frame`, new T.ExtrudeGeometry(shape,{ depth:.2, bevelEnabled:true, bevelThickness:.045, bevelSize:.045, bevelSegments:3, curveSegments:28 }),acetate,0,0,.15);
  rim.scale.x=side;
  const glass = mesh('Clear lens',new T.ShapeGeometry(outline(true),32),lens,0,0,.21); glass.scale.x=side;
  // The open temples arc inward, then turn gently down behind the ear.
  const temple = new T.Shape();
  temple.moveTo(.34,.59); temple.bezierCurveTo(-.35,.59,-1.5,.51,-2.55,.28);
  temple.bezierCurveTo(-2.87,.2,-2.9,-.2,-2.94,-.65);
  temple.bezierCurveTo(-2.93,-.8,-2.72,-.83,-2.69,-.64);
  temple.lineTo(-2.52,-.09); temple.bezierCurveTo(-1.6,.15,-.58,.19,.34,.21); temple.closePath();
  const arm = mesh('Sculpted temple',new T.ExtrudeGeometry(temple,{depth:.16,bevelEnabled:true,bevelThickness:.055,bevelSize:.05,bevelSegments:3,curveSegments:24}),acetate,side*2.54,0,0);
  arm.rotation.y=-Math.PI/2; if(side===-1) arm.position.x-=.16;
  mesh('Hinge',new T.BoxGeometry(.13,.19,.22),silver,side*2.57,.36,.14);
  const ring = mesh('Camera bezel',new T.TorusGeometry(.105,.018,10,32),silver,side*2.48,.48,.408);
  mesh('Camera',new T.CylinderGeometry(.088,.088,.018,32),camera,side*2.48,.48,.412).rotation.x=Math.PI/2;
  mesh('Camera glint',new T.SphereGeometry(.023,12,8),reflection,side*2.46,.506,.427);
}
const bridgePath = new T.CatmullRomCurve3([new T.Vector3(-.43,.41,.27),new T.Vector3(-.22,.48,.31),new T.Vector3(0,.49,.33),new T.Vector3(.22,.48,.31),new T.Vector3(.43,.41,.27)]);
mesh('Saddle bridge',new T.TubeGeometry(bridgePath,24,.115,10,false),acetate);
// Small nose rests remain part of the acetate structure.
for(const side of [-1,1]) mesh('Nose rest',new T.SphereGeometry(.13,16,12),acetate,side*.39,.09,.04).scale.set(.7,1.7,1);
scene.updateMatrixWorld(true);
const binary = await new GLTFExporter().parseAsync(scene,{binary:true});
await fs.writeFile(path.join(destination,'wink-glasses.glb'),Buffer.from(binary));

// Portable Collada export uses the identical baked meshes for the iOS SceneKit hero.
const meshes=[]; glasses.traverse(obj=>{if(obj.isMesh)meshes.push(obj)});
const materials=[acetate,lens,silver,camera,reflection];
const number = x => Number(x.toFixed(6));
let geometries='',nodes='';
meshes.forEach((obj,i)=>{
  const geometry=obj.geometry.clone().applyMatrix4(obj.matrixWorld);
  const expanded=geometry.index ? geometry.toNonIndexed() : geometry;
  // Baking a mirrored frame requires reversing winding for SceneKit's culling.
  if (obj.matrixWorld.determinant() < 0) {
    for (const attribute of [expanded.attributes.position, expanded.attributes.normal]) {
      for (let triangle=0;triangle<attribute.count;triangle+=3) {
        for (let axis=0;axis<3;axis++) {
          const a=(triangle+1)*3+axis, b=(triangle+2)*3+axis;
          [attribute.array[a],attribute.array[b]]=[attribute.array[b],attribute.array[a]];
        }
      }
    }
  }
  const positions=Array.from(expanded.attributes.position.array,number);
  const normals=Array.from(expanded.attributes.normal.array,number);
  const count=positions.length/3;
  geometries+=`<geometry id="g${i}"><mesh><source id="p${i}"><float_array id="pa${i}" count="${positions.length}">${positions.join(' ')}</float_array><technique_common><accessor source="#pa${i}" count="${count}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><source id="n${i}"><float_array id="na${i}" count="${normals.length}">${normals.join(' ')}</float_array><technique_common><accessor source="#na${i}" count="${count}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="v${i}"><input semantic="POSITION" source="#p${i}"/></vertices><triangles material="material" count="${count/3}"><input semantic="VERTEX" source="#v${i}" offset="0"/><input semantic="NORMAL" source="#n${i}" offset="1"/><p>${Array.from({length:count},(_,j)=>`${j} ${j}`).join(' ')}</p></triangles></mesh></geometry>`;
  nodes+=`<node id="mesh${i}" name="${obj.name}"><instance_geometry url="#g${i}"><bind_material><technique_common><instance_material symbol="material" target="#m${materials.indexOf(obj.material)}"/></technique_common></bind_material></instance_geometry></node>`;
});
const effects=materials.map((m,i)=>`<effect id="e${i}"><profile_COMMON><technique sid="common"><phong><diffuse><color>${[m.color.r,m.color.g,m.color.b,1].join(' ')}</color></diffuse><specular><color>0.45 0.45 0.45 1</color></specular><shininess><float>55</float></shininess><transparent opaque="A_ONE"><color>1 1 1 ${m.opacity}</color></transparent><transparency><float>1</float></transparency></phong></technique></profile_COMMON></effect>`).join('');
const materialXML=materials.map((m,i)=>`<material id="m${i}" name="${m.name}"><instance_effect url="#e${i}"/></material>`).join('');
const dae=`<?xml version="1.0" encoding="utf-8"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><contributor><author>Wink contributors</author><authoring_tool>Wink original parametric model</authoring_tool></contributor><created>2026-10-27T00:00:00Z</created><modified>2026-10-27T00:00:00Z</modified><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset><library_effects>${effects}</library_effects><library_materials>${materialXML}</library_materials><library_geometries>${geometries}</library_geometries><library_visual_scenes><visual_scene id="Scene"><node id="glasses">${nodes}</node></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>`;
await fs.writeFile(path.join(destination,'wink-glasses.dae'),dae);
await fs.copyFile(path.join(root,'node_modules/three/LICENSE'),path.join(destination,'THREE-LICENSE.txt'));
await build({entryPoints:[path.join(root,'ui/glasses.js')],outfile:path.join(root,'public/tv/glasses.js'),bundle:true,minify:true,format:'esm',target:'es2020',legalComments:'linked'});
console.log(`Generated original GLB (${binary.byteLength} bytes), DAE and local viewer.`);
