"""Build an editable anatomical assembly and compact WebGL buffers from official meshes."""
import bpy, bmesh, json, struct, gzip, base64, math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parent
OUT=ROOT.parent/'models'
OUT.mkdir(exist_ok=True)
mapping=json.loads((ROOT/'anatomy-map.json').read_text())
# The cerebral aqueduct is a cavity, not an opaque tissue block.
mapping['midbrain']=[c for c in mapping['midbrain'] if c!='FJ1738']
education=json.loads((ROOT/'education.json').read_text())
palette={m['id']:m['color'] for m in education};palette['context']='#dca695'
for obj in list(bpy.data.objects):bpy.data.objects.remove(obj,do_unlink=True)
raw={}
for codes in mapping.values():
 for code in codes:
  verts=[];faces=[]
  for line in (ROOT/'meshes'/f'{code}.obj').read_text().splitlines():
   if line.startswith('v '):verts.append(tuple(map(float,line.split()[1:4])))
   elif line.startswith('f '):
    f=[int(x.split('/')[0])-1 for x in line.split()[1:]]
    faces.extend((f[0],f[i],f[i+1]) for i in range(1,len(f)-1))
  raw[code]=(verts,faces)
allv=[v for vs,fs in raw.values() for v in vs]
lo=[min(v[i] for v in allv) for i in range(3)];hi=[max(v[i] for v in allv) for i in range(3)]
center=[0,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2];scale=.018
print('BODY AXES:',lo,hi,'center',center,flush=True)
def canon(v):return (-(v[0]-center[0])*scale,(v[1]-center[1])*scale,(v[2]-center[2])*scale)
def color(hex):return tuple(int(hex[i:i+2],16)/255 for i in (1,3,5))
def linear(c):return c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
materials={}
for id,c in palette.items():
 mat=bpy.data.materials.new(id);mat.diffuse_color=(*color(c),1);mat.use_nodes=True
 node=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
 node.inputs['Base Color'].default_value=(*map(linear,color(c)),1)
 node.inputs['Roughness'].default_value=.54
 materials[id]=mat
groups={}
for id,codes in mapping.items():
 for code in codes:
  vs,fs=raw[code];cx=sum(v[0] for v in vs)/len(vs)
  side='M' if id=='callosum' else ('L' if cx>0 else 'R')
  key=(id,side)
  if key not in groups:groups[key]=[[],[],[]]
  verts,faces,parts=groups[key];off=len(verts)
  verts.extend(canon(v) for v in vs);faces.extend(tuple(i+off for i in f) for f in fs);parts.append(code)

def offset(id,side):
 s=-1 if side=='L' else 1 if side=='R' else 0
 # Values are in browser space: left/right, superior/inferior, anterior/posterior.
 return {'frontal':[s*.86,.35,.56],'parietal':[s*.88,.79,-.24],
 'temporal':[s*1.22,-.16,.24],'occipital':[s*.64,.16,-.91],
 'insula':[s*.85,.05,.10],'callosum':[0,1.14,0],
 'thalamus':[s*.38,.20,-.06],'hypothalamus':[s*.24,-.20,.39],
 'basal':[s*.58,.36,.23],'hippocampus':[s*.70,-.18,-.18],
 'amygdala':[s*.56,-.25,.48],'cerebellum':[s*.38,-.45,-.55],
 'midbrain':[0,-.15,.42],'pons':[0,-.36,.54],'medulla':[0,-.62,.63],
 'context':[s*.18,.45,0]}[id]
binary=bytearray();components=[]
for (id,side),(verts,faces,codes) in groups.items():
 mesh=bpy.data.meshes.new(id+'_'+side);mesh.from_pydata(verts,[],faces);mesh.update()
 bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(mesh);bm.free();mesh.update()
 obj=bpy.data.objects.new(id+'_'+side,mesh);bpy.context.collection.objects.link(obj);obj.data.materials.append(materials[id])
 obj['module']=id;obj['hemisphere']=side;obj['BodyParts3D_ids']=','.join(codes)
 for p in mesh.polygons:p.use_smooth=True
 mesh.calc_loop_triangles()
 normals=[v.normal.copy() for v in mesh.vertices]
 adjacency=[set() for v in mesh.vertices]
 for e in mesh.edges:
  a,b=e.vertices;adjacency[a].add(b);adjacency[b].add(a)
 start=len(binary)
 for i,v in enumerate(mesh.vertices):
  n=normals[i];neighbors=adjacency[i]
  lap=sum((mesh.vertices[j].co-v.co for j in neighbors),Vector())/max(1,len(neighbors))
  curvature=lap.dot(n)
  ao=max(.42,min(1.0,1-max(0,curvature)*22))
  # Blender is Z-up, browser is Y-up; front is positive browser Z.
  binary.extend(struct.pack('<7f',v.co.x,v.co.z,-v.co.y,n.x,n.z,-n.y,ao))
 indexOffset=len(binary)
 for f in mesh.loop_triangles:binary.extend(struct.pack('<3I',*f.vertices))
 bbox=[list(min(v.co[j] for v in mesh.vertices) for j in range(3)),list(max(v.co[j] for v in mesh.vertices) for j in range(3))]
 midpoint=[sum(v.co[j] for v in mesh.vertices)/len(mesh.vertices) for j in range(3)]
 c=[midpoint[0],midpoint[2],-midpoint[1]]
 ex=offset(id,side)
 components.append({'id':id,'side':side,'codes':codes,'vertexOffset':start,'vertexCount':len(mesh.vertices),'indexOffset':indexOffset,'indexCount':len(mesh.loop_triangles)*3,'center':c,'offset':ex,'color':palette[id]})
 for frame,amount in [(1,0),(30,0),(116,1),(190,1),(276,0),(300,0)]:
  obj.location=(ex[0]*amount,-ex[2]*amount,ex[1]*amount);obj.keyframe_insert(data_path='location',frame=frame)
 print(id,side,len(mesh.vertices),len(mesh.loop_triangles),flush=True)
manifest={'source':'BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International','sourceURL':'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/','components':components,'format':'float32 xyz normalXYZ occlusion; uint32 triangle indices','scale':scale,'originalCenter':center}
(ROOT/'geometry.json').write_text(json.dumps(manifest,separators=(',',':')))
(ROOT/'geometry.bin').write_bytes(binary)
(ROOT/'geometry.gz.b64').write_text(base64.b64encode(gzip.compress(binary,compresslevel=9)).decode())
scene=bpy.context.scene;scene.frame_start=1;scene.frame_end=300;scene.render.fps=30;scene.frame_set(1)
# A separate scene floor and camera are for the editable Blender deliverable only.
bpy.ops.mesh.primitive_cylinder_add(vertices=96,radius=2.25,depth=.10,location=(0,0,-1.92));base=bpy.context.object;base.name='Display plinth'
stone=bpy.data.materials.new('Warm stone');stone.diffuse_color=(.83,.85,.76,1);base.data.materials.append(stone)
bevel=base.modifiers.new('Soft edge','BEVEL');bevel.width=.035;bevel.segments=3
def point_at(obj,p):obj.rotation_euler=(Vector(p)-obj.location).to_track_quat('-Z','Y').to_euler()
camdata=bpy.data.cameras.new('Atlas camera');cam=bpy.data.objects.new('Atlas camera',camdata);scene.collection.objects.link(cam);cam.location=(-5,-7,4);point_at(cam,(0,0,.0));camdata.type='ORTHO';camdata.ortho_scale=7;scene.camera=cam
for name,loc,power,size in [('Key',(-4,-5,7),1100,5),('Fill',(4,-2,4),500,4),('Rim',(1,5,5),850,4)]:
 data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size
 ob=bpy.data.objects.new(name,data);scene.collection.objects.link(ob);ob.location=loc;point_at(ob,(0,0,0))
scene.world.color=(.65,.65,.59)
scene.render.resolution_x=1200;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
try:scene.render.engine='CYCLES'
except TypeError:pass
if scene.render.engine=='CYCLES':scene.cycles.samples=24;scene.cycles.use_denoising=True
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=True
scene['Asset license']=manifest['source'];scene['Source']=manifest['sourceURL'];scene['Animation']='Folded → exploded → folded; source anatomical coordinates preserved'
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'brain-atlas-3d.blend'))
scene.render.filepath=str(OUT/'blender-model-preview.png')
import sys
if '--no-render' not in sys.argv:bpy.ops.render.render(write_still=True)
print('EXPORTED',len(components),'components',len(binary),'bytes',flush=True)
