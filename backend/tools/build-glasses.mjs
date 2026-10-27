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
const acetate = new T.MeshPhysicalMaterial({ name: 'Matte graphite acetate', color: '#121315', roughness: .28, metalness: 0, clearcoat: .35, clearcoatRoughness: .22 });
const lens = new T.MeshPhysicalMaterial({ name: 'Clear optical lenses', color: '#b8c8ca', roughness: .055, metalness: 0, transparent: true, opacity: .115, side: T.DoubleSide, depthWrite: false, clearcoat: 1, clearcoatRoughness: .035, reflectivity: .65 });
const silver = new T.MeshStandardMaterial({ name: 'Graphite titanium hardware', color: '#35393b', metalness: .78, roughness: .3 });
const camera = new T.MeshPhysicalMaterial({ name: 'Camera glass', color: '#070b10', metalness: .15, roughness: .035, clearcoat: 1 });
const reflection = new T.MeshStandardMaterial({ name: 'Camera optical coating', color: '#263e4b', metalness: .5, roughness: .12 });
function mesh(name, geometry, material, x=0, y=0, z=0) {
  const object = new T.Mesh(geometry, material); object.name = name; object.position.set(x,y,z); glasses.add(object); return object;
}
function outline(inner=false) {
  const p = new T.Shape();
  if (!inner) {
    p.moveTo(.32,.54); p.bezierCurveTo(.79,.68,2.12,.68,2.76,.53);
    p.bezierCurveTo(2.84,.49,2.72,-.2,2.48,-.76);
    p.bezierCurveTo(2.32,-1.02,1.45,-1.07,1.01,-.88);
    p.bezierCurveTo(.61,-.71,.4,-.06,.32,.54);
  } else {
    p.moveTo(.6,.38); p.bezierCurveTo(1.01,.51,2.03,.51,2.46,.36);
    p.bezierCurveTo(2.56,.27,2.43,-.21,2.26,-.67);
    p.bezierCurveTo(2.13,-.88,1.49,-.91,1.12,-.75);
    p.bezierCurveTo(.83,-.61,.65,-.08,.6,.38);
  }
  p.closePath(); return p;
}
const signedPow=(v,p)=>Math.sign(v)*Math.pow(Math.abs(v),p);
const outer=outline().getPoints(40).slice(0,-1), inner=outline(true).getPoints(40).slice(0,-1);
// A continuous rounded rectangular section creates smoothly polished acetate,
// with no flat extrusion caps, bevel seams or separate toy-like rim pieces.
function frameGeometry() {
  const positions=[],indices=[],segments=24,n=outer.length;
  for(let i=0;i<n;i++) {
    const o=outer[i],q=inner[i], cx=(o.x+q.x)/2,cy=(o.y+q.y)/2;
    for(let j=0;j<segments;j++) {
      const angle=j/segments*Math.PI*2,rad=signedPow(Math.cos(angle),.58);
      const x=cx+(o.x-q.x)*.5*rad,y=cy+(o.y-q.y)*.5*rad;
      const z=.2-.095*Math.pow(x/2.8,2)+.025*y+.105*signedPow(Math.sin(angle),.58);
      positions.push(x,y,z);
    }
  }
  for(let i=0;i<n;i++)for(let j=0;j<segments;j++) {
    const a=i*segments+j,b=((i+1)%n)*segments+j,c=((i+1)%n)*segments+(j+1)%segments,d=i*segments+(j+1)%segments;
    indices.push(a,d,b,b,d,c);
  }
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(positions,3));g.setIndex(indices);g.computeVertexNormals();return g;
}
function opticalLens() {
  const g=new T.ShapeGeometry(outline(true),40);
  const p=g.attributes.position;
  for(let i=0;i<p.count;i++) {
    const x=p.getX(i),y=p.getY(i);p.setZ(i,.205-.095*Math.pow(x/2.8,2)+.025*y);
  }
  // Slight front curvature is visible in the softbox reflections.
  g.computeVertexNormals();return g;
}
function templeGeometry(side) {
  const curve=new T.CatmullRomCurve3([
    new T.Vector3(side*2.72,.38,.12),new T.Vector3(side*2.76,.38,-.5),
    new T.Vector3(side*2.72,.39,-1.6),new T.Vector3(side*2.61,.37,-2.8),
    new T.Vector3(side*2.36,.22,-4.05),new T.Vector3(side*2.2,-.75,-4.57),
    new T.Vector3(side*2.18,-.9,-4.62)
  ]);
  const positions=[],indices=[],rings=100,segments=20;
  for(let i=0;i<=rings;i++) {
    const t=i/rings,p=curve.getPointAt(t),tangent=curve.getTangentAt(t);
    const horizontal=new T.Vector3(1,0,0),vertical=new T.Vector3().crossVectors(tangent,horizontal).normalize();
    const taper=t<.62 ? 1 : 1-(t-.62)/.38*.62;
    const cap=Math.min(1,Math.sin(Math.min(t*20,1)*Math.PI/2),Math.sin(Math.min((1-t)*30,1)*Math.PI/2));
    for(let j=0;j<segments;j++) {
      const angle=j/segments*Math.PI*2;
      const v=p.clone().addScaledVector(horizontal,signedPow(Math.cos(angle),.5)*.105*taper*cap).addScaledVector(vertical,signedPow(Math.sin(angle),.5)*.19*taper*cap);
      positions.push(v.x,v.y,v.z);
    }
  }
  for(let i=0;i<rings;i++)for(let j=0;j<segments;j++) {
    const a=i*segments+j,b=(i+1)*segments+j,c=(i+1)*segments+(j+1)%segments,d=i*segments+(j+1)%segments;indices.push(a,d,b,b,d,c);
  }
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(positions,3));g.setIndex(indices);g.computeVertexNormals();return g;
}
for(const side of [-1,1]) {
  mesh(side>0?'Right acetate front':'Left acetate front',frameGeometry(),acetate).scale.x=side;
  mesh('Clear optical lens',opticalLens(),lens).scale.x=side;
  mesh('Tapered smart temple',templeGeometry(side),acetate);
  const hinge=mesh('Recessed hinge',new T.BoxGeometry(.1,.19,.14),silver,side*2.72,.36,.06);
  const x=side*2.62,y=.445,z=.2-.095*Math.pow(x/2.8,2)+.025*y+.108;
  mesh('Camera inset rim',new T.TorusGeometry(.067,.007,12,40),silver,x,y,z);
  mesh('Camera lens',new T.CylinderGeometry(.059,.059,.012,40),camera,x,y,z-.002).rotation.x=Math.PI/2;
  mesh('Optical coating',new T.CylinderGeometry(.027,.027,.013,32),reflection,x,y,z+.001).rotation.x=Math.PI/2;
  mesh('Camera specular glint',new T.SphereGeometry(.007,12,8),silver,x-.014,y+.023,z+.012);
  // Small hinge screw sits on the inside, never a manufacturer logo.
  mesh('Hinge screw',new T.CylinderGeometry(.022,.022,.012,20),silver,side*2.7,.588,-.03);
}
const bridgeShape=new T.Shape();
bridgeShape.moveTo(-.48,.5);bridgeShape.bezierCurveTo(-.27,.51,-.2,.45,0,.45);bridgeShape.bezierCurveTo(.2,.45,.27,.51,.48,.5);
bridgeShape.lineTo(.45,.28);bridgeShape.bezierCurveTo(.2,.33,.13,.34,0,.34);bridgeShape.bezierCurveTo(-.13,.34,-.2,.33,-.45,.28);bridgeShape.closePath();
const bridgeGeometry=new T.ExtrudeGeometry(bridgeShape,{depth:.1,bevelEnabled:true,bevelThickness:.035,bevelSize:.025,bevelSegments:8,curveSegments:24});
mesh('Integrated saddle bridge',bridgeGeometry,acetate,0,0,.17);
for(const side of [-1,1]) {
  const pad=mesh('Integrated nose rest',new T.SphereGeometry(.095,24,16),acetate,side*.47,.06,.02);pad.scale.set(.7,1.9,1.2);pad.rotation.z=side*.3;
}
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
