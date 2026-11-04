import * as THREE from 'three';
// @ts-ignore Virtual module provided by render-visual-server.mjs.
import { Renderer as Before } from 'visual-baseline/renderer';
import { Renderer as After } from '../src/render/renderer';
import { buildArenaGeometry } from '../src/sim/arena';
import { BOOST_PADS, UU } from '../src/sim/rl';
import { OverviewCamera } from '../src/spectator/cameras';
import { loadMaskwaArt } from '../src/render/maskwa';
await loadMaskwaArt();
import type { BodyState, BoostPad } from '../src/sim/game';
import type { CarRenderState } from '../src/net/session';
const seed = () => { let n=12345; Math.random=()=>((n=Math.imul(n,1664525)+1013904223>>>0)/4294967296); };
const random=Math.random;
const pads=():BoostPad[]=>[...BOOST_PADS.bigLocations.map(([x,z])=>({x:x*UU,y:73*UU,z:z*UU,big:true,cooldown:0})),...BOOST_PADS.smallLocations.map(([x,z])=>({x:x*UU,y:70*UU,z:z*UU,big:false,cooldown:0}))];
const pair=[Before,After].map((R,i)=>{seed();const p=pads();const r:After=new R(document.getElementById(i?'after':'before')!,buildArenaGeometry(),p); Math.random=random; return {r,p,overview:new OverviewCamera()};});
const body=(x:number,y:number,z:number):BodyState=>({px:x,py:y,pz:z,qx:0,qy:0,qz:0,qw:1});
const fit=()=>document.querySelectorAll<HTMLElement>('.viewport').forEach(el=>{const scale=el.parentElement!.clientWidth/el.clientWidth;el.style.transform=`scale(${scale})`;el.parentElement!.style.height=`${el.clientHeight*scale}px`;}); fit(); window.addEventListener('resize',fit);
const cases: {name:string; quality:number; arena:number; view:string; event?:string; frames?:number; portrait?:boolean}[] = [
 {name:'day-low-broadcast',quality:0,arena:0,view:'broadcast'},
 {name:'day-medium-trails',quality:1,arena:0,view:'close'},
 {name:'day-high-shadows',quality:2,arena:0,view:'close'},
 {name:'night-medium-bloom',quality:1,arena:1,view:'close'},
 {name:'indoor-high-field',quality:2,arena:2,view:'field'},
 {name:'maskwa-high-free',quality:2,arena:3,view:'free'},
 {name:'pad-pickup',quality:1,arena:0,view:'pads',event:'pickup'},
 {name:'pad-respawn',quality:1,arena:0,view:'pads',event:'respawn'},
 {name:'follow-hidden-name',quality:1,arena:0,view:'close',event:'follow'},
 {name:'overview-name-restored',quality:1,arena:0,view:'close',event:'restore'},
 {name:'rename-hidden-then-show',quality:1,arena:0,view:'close',event:'rename'},
 {name:'demolition',quality:1,arena:1,view:'close',event:'demo'},
 {name:'respawn',quality:1,arena:1,view:'close',event:'undemo'},
 {name:'goal-explosion',quality:1,arena:1,view:'close',event:'goal'},
 {name:'portrait-high-follow-hidden',quality:2,arena:0,view:'close',event:'follow',portrait:true},
 {name:'portrait-medium-broadcast',quality:1,arena:1,view:'broadcast',portrait:true},
 {name:'trail-motion-early',quality:1,arena:0,view:'close',frames:5},
 {name:'trail-motion-middle',quality:1,arena:0,view:'close',frames:20},
 {name:'trails-faded',quality:1,arena:0,view:'close',event:'fade'},
];
const results:any[]=[];
async function run(index:number) {
 const c=cases[index]; if(!c)throw Error('Unknown case'); document.getElementById('status')!.textContent=c.name;
 const width=c.portrait?600:960, height=c.portrait?960:600;
 const pixels:Uint8Array[]=[]; const images:any={}; const stats:any[]=[];
 for (const [i,{r,p,overview}] of pair.entries()) {
  const container=document.getElementById(i?'after':'before')!; container.style.width=`${width}px`;container.style.height=`${height}px`;r.resize(container);fit();
  seed(); r.setQuality(c.quality); r.setArena(c.arena); r.setScore(2,1,'3:24');
  for(let id=0;id<8;id++)r.removeCar(id);
  // Reset dynamic history so every case has the same inputs independently of prior runs.
  (r as any).ballTrail.clear(); (r as any).prevBallPos.set(0,0,0); (r as any).padTime=0; (r as any).prevPadCooldown=[];
  for(const e of (r as any).explosions){r.scene.remove(e.group);e.dispose();}(r as any).explosions.length=0;
  for(const pop of (r as any).padPops){pop.age=99;pop.sprite.visible=false;}
  p.forEach(p=>p.cooldown=0); overview.reset(); overview.style=c.view==='field'?'field':'broadcast';
  const frames=c.frames??(c.event==='fade'?100:40);
  for(let f=0;f<frames;f++) {
   const t=Math.min(f,39)/60; const ball=body(-4+20*t,3+Math.sin(t*3),-3+8*t);
   if(c.view==='broadcast'||c.view==='field')overview.update(r.camera,new THREE.Vector3(ball.px,ball.py,ball.pz),1/60);
   else {r.camera.fov=65;r.camera.position.set(...(c.view==='free'?[18,12,21]:c.view==='pads'?[p[0].x+8,6,p[0].z+9]:[10,6,14]) as [number,number,number]);r.camera.lookAt(...(c.view==='pads'?[p[0].x,0,p[0].z]:[0,1,0]) as [number,number,number]);r.camera.updateProjectionMatrix();}
   const states:CarRenderState[]=Array.from({length:8},(_,id)=>{const pos=body((id%4-1.5)*5+4*t,0.5,Math.floor(id/4)*10-5-6*t);return {id,team:id%2===0?'blue':'orange',body:id%3,name:id===0&&c.event==='rename'&&f>10?'Renamed player':`Player ${id+1}`,prev:pos,curr:pos,alpha:1,forwardSpeed:28,steer:Math.sin(t)*0.4,boosting:f<40,supersonic:id%2===0,demoed:id===0&&(c.event==='demo'||c.event==='undemo'&&f<20),offsetPos:null,offsetQuat:null,wheelY:null};});
   const hidden=c.event==='follow'||(c.event==='restore'||c.event==='rename')&&f<20;
   r.syncCars(states,hidden?0:-1,1/60);
   r.syncBall(ball,ball,1,c.event!=='goal'||f<38,null,1/60);
   if(c.event==='pickup'&&f>=30||c.event==='respawn'&&f<30)p[0].cooldown=5;else p[0].cooldown=0;
   r.syncPads(p,1/60);
   if(c.event==='goal'&&f===38){seed();r.goalExplosion('blue');}
   // Update explosion animation without submitting 40 identical intermediate frames to the GPU.
   if(f<frames-1)for(const e of (r as any).explosions)e.update(1/60);
  }
  r.render(1/60);Math.random=random;
  const gl=r.gl.getContext();const data=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);if(gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw Error('Invalid WebGL capture');
  const unique=new Set<number>();for(let k=0;k<data.length;k+=4)unique.add(data[k]*65536+data[k+1]*256+data[k+2]);if(unique.size<100)throw Error('Blank or implausible render');pixels.push(data);
  images[i?'candidate':'baseline']=r.gl.domElement.toDataURL('image/png');
  stats.push({calls:r.gl.info.render.calls,triangles:r.gl.info.render.triangles,textures:r.gl.info.memory.textures,geometries:r.gl.info.memory.geometries,renderer:gl.getParameter(gl.RENDERER),quality:c.quality});
 }
 let differentPixels=0,maxChannelDelta=0,totalDelta=0;for(let p=0;p<pixels[0].length;p+=4){let changed=false;for(let k=0;k<4;k++){const d=Math.abs(pixels[0][p+k]-pixels[1][p+k]);if(d)changed=true;maxChannelDelta=Math.max(maxChannelDelta,d);totalDelta+=d;}if(changed)differentPixels++;}
 const report={...c,width,height,passed:differentPixels===0,differentPixels,maxChannelDelta,meanChannelDelta:totalDelta/pixels[0].length,stats};results.push(report);
 const response=await fetch('/__visual_evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:c.name,images,report})});if(!response.ok)throw Error(await response.text());
 document.getElementById('results')!.textContent=JSON.stringify(report,null,2); return report;
}
for(const [i,c] of cases.entries()){const b=document.createElement('button');b.textContent=c.name;b.onclick=()=>run(i);document.getElementById('controls')!.append(b);}
(window as any).visualQA={run,cases,results};document.getElementById('status')!.textContent='Ready';
