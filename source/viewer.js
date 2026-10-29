// Native WebGL anatomical viewer. No CDN, framework, library, texture or remote asset.
const canvas=$('#brain3d'),stage=$('#stage'),ground=$('#ground3d'),ctx=ground.getContext('2d');
let gl,program,loc,pickProgram,pickLoc,pickFbo,pickTex,pickDepth;
let parts=[],ready=false,width=1,height=1,dpr=1,selected=null,expanded=false,busy=false;
let yaw=.67,pitch=.30,zoom=1,half=[3,3],openAmount=0,animation=null,frameId=0;
let visited=new Set();const reduced=matchMedia('(prefers-reduced-motion:reduce)');
const modules=EDUCATION,byId=Object.fromEntries(modules.map(m=>[m.id,m]));
modules.forEach((m,i)=>{m.num=String(i+1).padStart(2,'0');m.deep=['insula','callosum','thalamus','hypothalamus','basal','hippocampus','amygdala','midbrain'].includes(m.id);});
const groupNames=['大脑皮层','深部结构','小脑与脑干'];
try{visited=new Set(JSON.parse(localStorage.getItem('brain3d-visited')||'[]').filter(x=>byId[x]));}catch(e){}
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v)),mix=(a,b,t)=>a+(b-a)*t;
const hex=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)/255);
function rotation(){const a=Math.cos(yaw),b=Math.sin(yaw),c=Math.cos(pitch),d=Math.sin(pitch);return new Float32Array([a,d*b,-c*b,0,c,d,b,-d*a,c*a]);}
function rotate(v,r){return [r[0]*v[0]+r[3]*v[1]+r[6]*v[2],r[1]*v[0]+r[4]*v[1]+r[7]*v[2],r[2]*v[0]+r[5]*v[1]+r[8]*v[2]];}
function project(v,r){const p=rotate(v,r);return [(p[0]/half[0]*.5+.5)*width,(-p[1]/half[1]*.5+.5)*height,p[2]];}
function makeShader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
function makeProgram(v,f){const p=gl.createProgram();gl.attachShader(p,makeShader(gl.VERTEX_SHADER,v));gl.attachShader(p,makeShader(gl.FRAGMENT_SHADER,f));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));return p;}
const VS=`precision highp float;
attribute vec3 aPosition;attribute vec3 aNormal;attribute float aAO;
uniform mat3 uRotation;uniform vec3 uShift;uniform vec2 uHalf;uniform float uOutline;
varying vec3 vNormal;varying vec3 vPosition;varying float vAO;
void main(){vec3 n=normalize(uRotation*aNormal);vec3 p=uRotation*(aPosition+uShift)+n*uOutline;vNormal=n;vPosition=p;vAO=aAO;gl_Position=vec4(p.x/uHalf.x,p.y/uHalf.y,-p.z/12.0,1.0);}`;
const FS=`precision highp float;varying vec3 vNormal;varying vec3 vPosition;varying float vAO;
uniform vec3 uColor;uniform float uAlpha;uniform float uOutline;
void main(){vec3 n=normalize(vNormal);if(uOutline>0.0){gl_FragColor=vec4(uColor*.34+vec3(.07,.055,.045),uAlpha*.52);return;}
vec3 key=normalize(vec3(-.60,.85,1.10));vec3 fill=normalize(vec3(.8,.2,.5));vec3 rim=normalize(vec3(.1,.5,-1.));
float d=max(0.,dot(n,key));float f=max(0.,dot(n,fill));float r=max(0.,dot(n,rim));
float hemi=.45+.11*(n.y*.5+.5);float light=hemi+.46*d+.15*f+.10*r;
float ao=mix(.58,1.,vAO);float highlight=max(dot(n,normalize(key+vec3(0.,0.,1.))),0.);
float spec=pow(highlight,46.)*.16+pow(highlight,10.)*.028;
float edge=pow(1.-abs(n.z),3.)*.035;
vec3 col=uColor*(light*ao-edge)+vec3(1.,.97,.93)*spec;
gl_FragColor=vec4(clamp(col,0.,1.),uAlpha);}`;
const PICKVS=`attribute vec3 aPosition;uniform mat3 uRotation;uniform vec3 uShift;uniform vec2 uHalf;void main(){vec3 p=uRotation*(aPosition+uShift);gl_Position=vec4(p.x/uHalf.x,p.y/uHalf.y,-p.z/12.,1.);}`;
const PICKFS=`precision mediump float;uniform vec3 uColor;void main(){gl_FragColor=vec4(uColor,1.);}`;
function locations(p){const o={};for(const n of ['aPosition','aNormal','aAO'])o[n]=gl.getAttribLocation(p,n);for(const n of ['uRotation','uShift','uHalf','uColor','uAlpha','uOutline'])o[n]=gl.getUniformLocation(p,n);return o;}
async function boot(){try{
 gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,preserveDrawingBuffer:true});if(!gl)throw Error('WebGL unavailable');
 program=makeProgram(VS,FS);loc=locations(program);pickProgram=makeProgram(PICKVS,PICKFS);pickLoc=locations(pickProgram);
 const bytes=Uint8Array.from(atob(GEOMETRY),c=>c.charCodeAt(0));const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));const bin=await new Response(stream).arrayBuffer();
 for(const [i,meta]of META.components.entries()){
  const p={...meta,index:i,pose:[0,0,0],alpha:1,color:hex(byId[meta.id]?.color||meta.color)};
  const v=new Float32Array(bin,meta.vertexOffset,meta.vertexCount*7);const indices=new Uint32Array(bin,meta.indexOffset,meta.indexCount);
  if(meta.vertexCount>65535)throw Error('Mesh exceeds portable index range');
  p.vbo=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,p.vbo);gl.bufferData(gl.ARRAY_BUFFER,v,gl.STATIC_DRAW);
  p.ibo=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,p.ibo);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);
  p.bounds=[[-Infinity,-Infinity,-Infinity],[Infinity,Infinity,Infinity]];
  for(let j=0;j<v.length;j+=7)for(let k=0;k<3;k++){p.bounds[0][k]=Math.max(p.bounds[0][k],v[j+k]);p.bounds[1][k]=Math.min(p.bounds[1][k],v[j+k]);}
  parts.push(p);
 }
 pickFbo=gl.createFramebuffer();pickTex=gl.createTexture();pickDepth=gl.createRenderbuffer();
 gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);
 ready=true;document.body.dataset.ready='true';stage.dataset.renderer='WebGL';stage.dataset.triangles=String(parts.reduce((s,p)=>s+p.indexCount/3,0));
 $('#loading').hidden=true;$('#explode').disabled=false;$('#reset').disabled=false;
 new ResizeObserver(resize).observe(stage);resize();sync();
 }catch(e){$('#loading').textContent='无法启动 3D 视图，请用新版 Chrome、Edge 或 Safari 打开，并启用硬件加速。';console.error(e);document.body.dataset.ready='failed';}}
function resize(){const b=canvas.getBoundingClientRect();width=Math.max(1,b.width);height=Math.max(1,b.height);dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ground.width=canvas.width;ground.height=canvas.height;
 gl.bindTexture(gl.TEXTURE_2D,pickTex);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,canvas.width,canvas.height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
 gl.bindRenderbuffer(gl.RENDERBUFFER,pickDepth);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,canvas.width,canvas.height);gl.bindFramebuffer(gl.FRAMEBUFFER,pickFbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,pickTex,0);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,pickDepth);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
 drawGround();requestDraw();}
function updateHalf(){const aspect=width/height;const vertical=width<500?3.1:2.9;const h=Math.max(vertical,3.25/aspect)/zoom;half=[h*aspect,h];stage.dataset.camera=[yaw.toFixed(4),pitch.toFixed(4),zoom.toFixed(4),half[0].toFixed(4),half[1].toFixed(4)].join(',');}
function drawGround(){ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);const cx=width*.5,cy=height*.83,rx=Math.min(width*.30,height*.43),ry=rx*.23;
 const shadow=ctx.createRadialGradient(cx,cy,rx*.08,cx,cy,rx);shadow.addColorStop(0,'#76625221');shadow.addColorStop(1,'#76625200');ctx.save();ctx.translate(cx,cy+ry*.30);ctx.scale(1,.25);ctx.fillStyle=shadow;ctx.fillRect(-width,-height,width*2,height*2);ctx.restore();
 ctx.beginPath();ctx.ellipse(cx,cy+5,rx,ry,0,0,Math.PI*2);ctx.fillStyle='#e4dbd2';ctx.fill();ctx.strokeStyle='#c4b5a9';ctx.lineWidth=.7;ctx.stroke();
 const g=ctx.createLinearGradient(0,cy-ry,0,cy+ry);g.addColorStop(0,'#fffdf7');g.addColorStop(1,'#eee7de');ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();ctx.strokeStyle='#cfc2b5';ctx.stroke();ctx.beginPath();ctx.ellipse(cx,cy,rx*.93,ry*.88,0,0,Math.PI*2);ctx.strokeStyle='#e0d5ca';ctx.stroke();}
function attributes(p,l){gl.bindBuffer(gl.ARRAY_BUFFER,p.vbo);gl.enableVertexAttribArray(l.aPosition);gl.vertexAttribPointer(l.aPosition,3,gl.FLOAT,false,28,0);if(l.aNormal>=0){gl.enableVertexAttribArray(l.aNormal);gl.vertexAttribPointer(l.aNormal,3,gl.FLOAT,false,28,12);}if(l.aAO>=0){gl.enableVertexAttribArray(l.aAO);gl.vertexAttribPointer(l.aAO,1,gl.FLOAT,false,28,24);}gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,p.ibo);}
function drawPart(p,l,picking=false,outline=false){attributes(p,l);gl.uniform3fv(l.uShift,p.pose);gl.uniform3fv(l.uColor,picking?[(p.index+1)/255,0,0]:p.color);if(!picking){gl.uniform1f(l.uAlpha,p.alpha);gl.uniform1f(l.uOutline,outline?.009:0);}gl.drawElements(gl.TRIANGLES,p.indexCount,gl.UNSIGNED_SHORT,0);}
function draw(picking=false){if(!ready)return;updateHalf();const r=rotation(),l=picking?pickLoc:loc;gl.bindFramebuffer(gl.FRAMEBUFFER,picking?pickFbo:null);gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(picking?pickProgram:program);gl.uniformMatrix3fv(l.uRotation,false,r);gl.uniform2fv(l.uHalf,half);gl.depthMask(true);gl.disable(gl.BLEND);gl.cullFace(gl.BACK);
 const visible=parts.filter(p=>p.alpha>.025);if(picking){for(const p of visible.filter(p=>p.alpha>.2&&p.id!=='context'))drawPart(p,l,true);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return;}
 const opaque=visible.filter(p=>p.alpha>.995),ghost=visible.filter(p=>p.alpha<=.995).sort((a,b)=>rotate(a.center.map((v,i)=>v+a.pose[i]),r)[2]-rotate(b.center.map((v,i)=>v+b.pose[i]),r)[2]);
 for(const p of opaque)drawPart(p,l);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
 gl.cullFace(gl.FRONT);for(const p of opaque)drawPart(p,l,false,true);gl.cullFace(gl.BACK);for(const p of ghost)drawPart(p,l);gl.depthMask(true);gl.disable(gl.BLEND);
 updateLabels(r);stage.dataset.bounds=JSON.stringify(screenBounds(r));stage.dataset.maxDisplacement=Math.max(...parts.flatMap(p=>p.pose.map(Math.abs))).toFixed(6);stage.dataset.opacityRestored=String(parts.every(p=>p.alpha===1));}
function screenBounds(r){let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const p of parts){if(p.alpha<.1)continue;for(let i=0;i<8;i++){const v=[0,1,2].map(k=>p.bounds[(i>>k)&1][k]+p.pose[k]);const s=project(v,r);x0=Math.min(x0,s[0]);y0=Math.min(y0,s[1]);x1=Math.max(x1,s[0]);y1=Math.max(y1,s[1]);}}return [x0,y0,x1,y1].map(x=>Math.round(x));}
function requestDraw(){if(!frameId)frameId=requestAnimationFrame(tick);}
function ease(q){if(q<.84){let u=q/.84;return 1.018*u*u*(3-2*u);}let u=(q-.84)/.16;return 1.018-.018*u*u*(3-2*u);}
function tick(now){frameId=0;if(animation){let t=clamp((now-animation.start)/animation.duration,0,1);parts.forEach((p,i)=>{let delay=reduced.matches?0:(byId[p.id]?.deep?.09:i*.003);let q=clamp((t-delay)/(1-delay),0,1),v=ease(q),a=q*q*(3-2*q);p.pose=animation.from[i].pose.map((x,k)=>mix(x,animation.to[i].pose[k],v));p.alpha=mix(animation.from[i].alpha,animation.to[i].alpha,a);});openAmount=mix(animation.openStart,animation.openEnd,t);$('#amount').value=Math.round(openAmount*100);if(t>=1){parts.forEach((p,i)=>Object.assign(p,animation.to[i]));animation=null;busy=false;$('#explode').disabled=false;$('#reset').disabled=false;stage.dataset.state=selected?'selected':expanded?'expanded':'assembled';stage.setAttribute('aria-busy','false');}else requestDraw();}draw();}
function targets(amount=expanded?1:0){return parts.map(p=>{let pose=p.offset.map(v=>v*amount),alpha=1;const deep=selected&&byId[selected].deep;if(selected){if(p.id===selected){pose=p.offset.map(v=>v*(deep?1.48:1));alpha=1;if(deep){const s=p.side==='L'?-1:p.side==='R'?1:0;pose[0]+=s*.52;pose[2]+=.3;}}else if(deep){const outer=['frontal','parietal','temporal','occipital','insula','cerebellum','context'].includes(p.id);pose=p.offset.map(v=>v*(outer?1.05:.1));alpha=outer?.12:.20;}else{pose=[0,0,0];alpha=.28;}}if(p.id==='context'&&!selected)alpha=amount>.1?.35:1;return{pose,alpha};});}
function transition(duration=2850){if(!ready)return;animation={from:parts.map(p=>({pose:[...p.pose],alpha:p.alpha})),to:targets(),start:performance.now(),duration:reduced.matches?1:duration,openStart:openAmount,openEnd:expanded?1:0};busy=true;stage.dataset.state='animating';stage.setAttribute('aria-busy','true');$('#explode').disabled=true;$('#reset').disabled=true;requestDraw();}
function select(id){if(!ready||busy)return;if(selected===id){reset();return;}selected=id;expanded=false;visited.add(id);sync();transition(1800);$('#announce').textContent=`已选中${byId[id].name}，左右同名结构共同高亮。${byId[id].location}`;}
function reset(){if(!ready||busy)return;selected=null;expanded=false;sync();transition();}
function explode(){if(!ready||busy)return;selected=null;expanded=!expanded;sync();transition();}
function progress(){for(const m of modules)m.button.classList.toggle('visited',visited.has(m.id));$('#progress-text').textContent=`已探索 ${visited.size} / 15`;$('#progress-fill').style.width=visited.size/15*100+'%';try{localStorage.setItem('brain3d-visited',JSON.stringify([...visited]));}catch(e){}}
function sync(){for(const m of modules)m.button.setAttribute('aria-pressed',String(selected===m.id));stage.dataset.selected=selected||'';$('#explode').setAttribute('aria-expanded',String(expanded));$('#explode-text').textContent=expanded?'合上脑结构':'展开脑结构';$('#explode .control-icon').textContent=expanded?'−':'＋';$('#stage-status').textContent=selected?`${byId[selected].num} / ${byId[selected].name} · 三维分离`:expanded?'结构已展开 · 拖动查看内部':'完整脑体 · 拖动旋转，点击探索';$('#layer-note').textContent=selected&&byId[selected].deep?'外层淡化 · 虚线连接原位':'左右半球 · 真实解剖网格';renderInfo();progress();}
groupNames.forEach((name,i)=>{const section=document.createElement('div');section.className='group';section.innerHTML=`<p class="group-label">${name}</p><div class="group-buttons"></div>`;for(const m of modules.filter(m=>m.group===i)){const b=document.createElement('button');b.className='module';b.dataset.id=m.id;b.style.setProperty('--color',m.color);b.setAttribute('aria-pressed','false');b.innerHTML=`<span class="dot"></span><span>${m.name}</span><span class="num">${m.num}</span>`;b.addEventListener('click',()=>select(m.id));m.button=b;section.lastElementChild.append(b);}$('#groups').append(section);});
function updateLabels(r){const labels=$('#labels3d'),lines=$('#links3d');labels.replaceChildren();lines.replaceChildren();if(!selected)return;for(const p of parts.filter(p=>p.id===selected)){const end=project(p.center.map((v,i)=>v+p.pose[i]),r),start=project(p.center,r);const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d',`M${start[0]} ${start[1]}L${end[0]} ${end[1]}`);lines.append(line);const b=document.createElement('span');b.className='label3d';b.textContent=(p.side==='L'?'左侧 · ':p.side==='R'?'右侧 · ':'')+byId[p.id].name;b.style.left=clamp(end[0],64,width-64)+'px';b.style.top=clamp(end[1]-32,28,height-35)+'px';labels.append(b);}
 $('#links3d').setAttribute('viewBox',`0 0 ${width} ${height}`);}
function pick(x,y){draw(true);gl.bindFramebuffer(gl.FRAMEBUFFER,pickFbo);const pixel=new Uint8Array(4);gl.readPixels(Math.floor(x*dpr),canvas.height-1-Math.floor(y*dpr),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);gl.bindFramebuffer(gl.FRAMEBUFFER,null);requestDraw();return pixel[0]>0?parts[pixel[0]-1]?.id:null;}
let pointers=new Map(),last=null,moved=false,startPoint=null,pinch=0;
canvas.addEventListener('pointerdown',e=>{if(!ready)return;canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,[e.clientX,e.clientY]);last=[e.clientX,e.clientY];startPoint=[...last];moved=false;if(pointers.size===2){const a=[...pointers.values()];pinch=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);moved=true;}canvas.style.cursor='grabbing';});
canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;const old=pointers.get(e.pointerId);pointers.set(e.pointerId,[e.clientX,e.clientY]);if(pointers.size===2){const a=[...pointers.values()],dist=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);zoom=clamp(zoom*dist/Math.max(1,pinch),.7,1.8);pinch=dist;moved=true;}else{const dx=e.clientX-old[0],dy=e.clientY-old[1];if(Math.hypot(e.clientX-startPoint[0],e.clientY-startPoint[1])>5)moved=true;if(moved){document.querySelectorAll('[data-view]').forEach(x=>x.setAttribute('aria-pressed','false'));yaw+=dx*.009;pitch=clamp(pitch+dy*.009,-1.4,1.4);}}requestDraw();});
canvas.addEventListener('pointerup',e=>{const wasSingle=pointers.size===1;pointers.delete(e.pointerId);canvas.style.cursor='grab';if(wasSingle&&!moved&&!busy){const b=canvas.getBoundingClientRect(),id=pick(e.clientX-b.left,e.clientY-b.top);if(id)select(id);}last=null;});
canvas.addEventListener('pointercancel',e=>pointers.delete(e.pointerId));
canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=clamp(zoom*Math.exp(-e.deltaY*.001),.7,1.8);requestDraw();},{passive:false});
const views={three:[.67,.30],front:[0,.05],left:[Math.PI/2,.05],right:[-Math.PI/2,.05],top:[0,Math.PI/2]};
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{[yaw,pitch]=views[b.dataset.view];zoom=1;requestDraw();document.querySelectorAll('[data-view]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));}));
$('#home-view').addEventListener('click',()=>{[yaw,pitch]=views.three;zoom=1;document.querySelectorAll('[data-view]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.view==='three')));requestDraw();});
$('#amount').addEventListener('input',e=>{if(!ready)return;animation=null;busy=false;selected=null;openAmount=+e.target.value/100;expanded=openAmount>.001;const t=targets(openAmount);parts.forEach((p,i)=>Object.assign(p,t[i]));$('#explode').disabled=false;$('#reset').disabled=false;stage.dataset.state=openAmount>.001?'expanded':'assembled';stage.setAttribute('aria-busy','false');sync();requestDraw();});
$('#explode').addEventListener('click',explode);$('#reset').addEventListener('click',reset);
document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select'))return;if(e.key==='Escape')reset();else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const i=selected?modules.findIndex(m=>m.id===selected):(e.key==='ArrowRight'?-1:0);select(modules[(i+(e.key==='ArrowRight'?1:14)+15)%15].id);}else if(e.code==='Space'&&!e.target.closest('button,a')){e.preventDefault();explode();}});
$('#sources-toggle').addEventListener('click',()=>{const open=$('#sources').hidden;$('#sources').hidden=!open;$('#sources-toggle').setAttribute('aria-expanded',String(open));});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();ready=false;$('#loading').hidden=false;$('#loading').textContent='图形上下文暂时中断，请刷新页面恢复。';});
boot();
