// Runs without Electron or a Windows desktop. It validates the source files and
// exercises the same FFmpeg remux/transcode command family on a 10-second sample.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {spawnSync} = require('child_process');
const root=path.resolve(__dirname,'..'), out=path.join(root,'demo');
function assert(condition,message){if(!condition)throw Error(message)}
function run(command,args){
 const p=spawnSync(command,args,{stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:10*1024*1024});
 if(p.error)throw new Error(command+': '+p.error.message);
 if(p.status!==0)throw new Error(command+' returned '+p.status+'\n'+(p.stderr||'').slice(-2500));
 return p.stdout.trim();
}
function ffmpegBinary(){try{const p=require('ffmpeg-static');if(p&&fs.existsSync(p))return p}catch(_){}return 'ffmpeg'}
function checkFiles(){for(const f of ['main.js','index.html','bar.html','package.json','start.bat','build.bat']){
 assert(fs.existsSync(path.join(root,f)),'Missing '+f)}
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const bar=fs.readFileSync(path.join(root,'bar.html'),'utf8');
 for(const [name,source] of [['index',html],['bar',bar]]){
 const scripts=[...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];assert(scripts.length===1,name+' does not have exactly one inline script');
 new vm.Script(scripts[0][1],{filename:name+'.js'});
 }
 const main=fs.readFileSync(path.join(root,'main.js'),'utf8');new vm.Script(main,{filename:'main.js'});
 for(const text of ["setContentProtection(true)","record-chunk","export-chunk","uiohook-napi","F8","F9"])
 assert(main.includes(text),'Feature missing: '+text);
 assert(!main.includes("globalShortcut.register('Space'")&&!main.includes('setIgnoreMouseEvents(true)'),'Forbidden global Space / mouse click-through hook');
}
function makeLog(){const clicks=[1.55,3.35,5.7,8.15].map((t,i)=>({t,x:[.24,.73,.65,.31][i],y:[.32,.28,.73,.68][i]}));
 const cursor=[];for(let i=0;i<=600;i++){
  const t=i/60;let anchor=clicks[0];for(const c of clicks){if(c.t<=t)anchor=c}
  const x=anchor.x+Math.sin(t*1.7)*.05,y=anchor.y+Math.cos(t*1.3)*.03;
  cursor.push([+t.toFixed(3),+Math.max(0,Math.min(1,x)).toFixed(5),+Math.max(0,Math.min(1,y)).toFixed(5)])
 }
 return {version:1,created:new Date().toISOString(),fps:30,width:640,height:360,area:{x:0,y:0,w:1,h:1},
 cursor,clicks,manual:[{t:7.15,x:.5,y:.5}],keys:[1.7,1.88,3.6,5.95,6.1,8.3]};
}
function main(){checkFiles();fs.mkdirSync(out,{recursive:true});
 const ffmpeg=ffmpegBinary(),raw=path.join(out,'recording.raw.webm'),ready=path.join(out,'recording-ready.webm'),mp4=path.join(out,'exported-sample.mp4');
 // 10-second simulated display recording: moving video test pattern, click flashes,
 // and an audio tone. This is a media pipeline test, NOT a physical Windows capture.
 const filter="drawgrid=width=80:height=60:thickness=1:color=white@0.28,"+
  "drawbox=x=145:y=110:w=24:h=24:color=white@0.9:t=fill:enable='between(t,1.53,1.70)',"+
  "drawbox=x=460:y=100:w=24:h=24:color=white@0.9:t=fill:enable='between(t,3.33,3.50)',"+
  "drawbox=x=415:y=245:w=24:h=24:color=white@0.9:t=fill:enable='between(t,5.68,5.85)',"+
  "drawbox=x=185:y=240:w=24:h=24:color=white@0.9:t=fill:enable='between(t,8.13,8.30)'";
 run(ffmpeg,['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=10',
  '-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=10',
  '-vf',filter,'-t','10','-c:v','libvpx','-deadline','realtime','-cpu-used','8','-b:v','500k',
  '-c:a','libopus','-b:a','96k',raw]);
 run(ffmpeg,['-y','-hide_banner','-loglevel','error','-i',raw,'-map','0','-c','copy',ready]);
 run(ffmpeg,['-y','-hide_banner','-loglevel','error','-i',ready,'-c:v','libx264',
  '-preset','medium','-crf','18','-pix_fmt','yuv420p','-r','60','-c:a','aac',
  '-b:a','192k','-movflags','+faststart',mp4]);
 const log=makeLog();fs.writeFileSync(path.join(out,'session.json'),JSON.stringify(log,null,2));
 const probe=(f)=>JSON.parse(run('ffprobe',['-v','error','-show_format','-show_streams','-of','json',f]));
 const before=probe(ready),after=probe(mp4);
 assert(Math.abs(+before.format.duration-10)<.15,'Recording is not 10 s');
 assert(Math.abs(+after.format.duration-10)<.15,'Export is not 10 s');
 assert(after.streams.some(s=>s.codec_type==='video'&&s.codec_name==='h264'),'No H.264 export video');
 assert(after.streams.some(s=>s.codec_type==='audio'&&s.codec_name==='aac'),'No AAC export audio');
 assert(log.clicks.length===4&&log.manual.length===1,'Missing simulated clicks');
 fs.rmSync(raw,{force:true});
 console.log('PASS: JS syntax, required files, 10 s WebM recording/remux, 4 simulated clicks, 1 F8 marker, H.264/AAC MP4 encoding.');
 console.log('Sample:',ready);console.log('Export:',mp4);
}
main();
