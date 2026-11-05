import math,io,urllib.request,numpy as np
from PIL import Image
z=9
def tile(x,y):
    d=urllib.request.urlopen(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png").read()
    a=np.asarray(Image.open(io.BytesIO(d)).convert('RGB')).astype(float)
    return a[:,:,0]*256+a[:,:,1]+a[:,:,2]/256-32768
cache={}
def elev(lon,lat):
    n=2**z;fx=(lon+180)/360*n;r=math.radians(lat);fy=(1-math.log(math.tan(r)+1/math.cos(r))/math.pi)/2*n
    x,y=int(fx),int(fy)
    if (x,y) not in cache: cache[(x,y)]=tile(x,y)
    return cache[(x,y)][int((fy-y)*256),int((fx-x)*256)]
d=0.05;lon0,lat0,nl,nt=119.9,21.8,int((122.2-119.9)/d)+1,int((25.4-21.8)/d)+1
rows=[]
for j in range(nt):
  for i in range(nl):
    # block max-ish: mean of 3x3 samples
    v=np.mean([elev(lon0+i*d+a,lat0+j*d+b) for a in(-.02,0,.02) for b in(-.02,0,.02)])
    rows.append(max(0,int(round(v/10))))
print(nl,nt,max(rows)*10)
open('/workspace/typhoon-simulator/js/taiwan-elev-data.js','w').write(
"/** Taiwan elevation (terrarium z9, 3x3 mean, units 10 m), 0.05° grid. scripts: /tmp/twelev.py */\n(function(g){'use strict';g.TAIWAN_ELEV={lon0:%s,lat0:%s,d:%s,nlon:%d,nlat:%d,dm:[%s]};})(typeof window!=='undefined'?window:globalThis);\n"%(lon0,lat0,d,nl,nt,','.join(map(str,rows))))
