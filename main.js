'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, dialog, shell, session, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
let mainWindow, barWindow, overlayWindow, capture, exportJob, hook, hookError = '';
let recording = null;
let cursorTimer = null;
let ffmpegPath = 'ffmpeg';
let pendingRegion = null;
let isQuitting = false;

try {
  let bundled = require('ffmpeg-static');
  if (bundled && fs.existsSync(bundled.replace('app.asar', 'app.asar.unpacked')))
    ffmpegPath = bundled.replace('app.asar', 'app.asar.unpacked');
  else if (bundled && fs.existsSync(bundled)) ffmpegPath = bundled;
} catch (_) { /* ffmpeg from PATH is a supported fallback */ }
try {
  hook = require('uiohook-napi').uIOhook;
} catch (e) { hookError = String(e.message || e); }

function makeWindow(file, options) {
  const win = new BrowserWindow({
    show: false, frame: false, backgroundColor: '#0b0b0e',
    webPreferences: {
      nodeIntegration: true, contextIsolation: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }, ...options
  });
  win.loadFile(file);
  return win;
}
function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}
function sendBar(channel, ...args) {
  if (barWindow && !barWindow.isDestroyed()) barWindow.webContents.send(channel, ...args);
}
function safeFloat(n) { return Number.isFinite(n) ? n : 0; }
function inBounds(p, b) { return p.x >= b.x && p.x < b.x+b.width && p.y >= b.y && p.y < b.y+b.height; }
function pointOnDisplay() {
  if (!recording) return null;
  const p = screen.getCursorScreenPoint(), b = recording.display.bounds;
  if (!inBounds(p, b)) return null;
  return {
    x: Math.max(0, Math.min(1, (p.x-b.x)/b.width)),
    y: Math.max(0, Math.min(1, (p.y-b.y)/b.height)), p
  };
}
function stamp() { return recording ? Math.max(0, (performance.now()-recording.t0)/1000) : 0; }
function startTracking() {
  if (!recording || recording.t0) return;
  recording.t0 = performance.now();
  recording.active = true;
  cursorTimer = setInterval(() => {
    const pt = pointOnDisplay();
    if (pt && recording && recording.active) recording.log.cursor.push([+stamp().toFixed(3), +pt.x.toFixed(5), +pt.y.toFixed(5)]);
  }, 1000/60);
  if (hook) {
    try { hook.start(); }
    catch (e) { hookError = String(e.message || e); send('hook-state', hookError); }
  }
  globalShortcut.register('F8', () => {
    if (!recording || !recording.active) return;
    const pt = pointOnDisplay();
    if (pt) recording.log.manual.push({ t: stamp(), x: pt.x, y: pt.y });
    sendBar('click-flash');
  });
  sendBar('bar-active');
}
function endTracking() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
  globalShortcut.unregister('F8');
  if (recording) recording.active = false;
  if (hook) { try { hook.stop(); } catch (_) {} }
}
function createBar(display) {
  if (barWindow && !barWindow.isDestroyed()) barWindow.destroy();
  const bw = 364, bh = 62;
  barWindow = makeWindow('bar.html', {
    width: bw, height: bh, x: Math.round(display.bounds.x+(display.bounds.width-bw)/2),
    y: display.bounds.y+18, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: true,
    minimizable: false, maximizable: false, focusable: true
  });
  barWindow.setContentProtection(true);
  barWindow.setAlwaysOnTop(true, 'screen-saver');
  barWindow.once('ready-to-show', () => barWindow.show());
}
function closeBar() {
  if (barWindow && !barWindow.isDestroyed()) barWindow.destroy();
  barWindow = null;
}
function ffmpeg(args, onProgress) {
  const runWith = binary => new Promise((resolve, reject) => {
    const p = spawn(binary, ['-y', '-hide_banner', '-nostdin', ...args], {windowsHide:true});
    let stderr = '', failedToLaunch = false;
    p.stderr.on('data', b => {
      const s = b.toString(); stderr = (stderr+s).slice(-12000);
      if (onProgress) onProgress(s);
    });
    p.on('error', err => { failedToLaunch = true; reject(Object.assign(new Error(`Cannot launch ffmpeg (${binary}): ${err.message}`),{launchError:true})); });
    p.on('close', code => {
      if (!failedToLaunch) (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2400)}`)));
    });
    if (exportJob && onProgress) exportJob.process = p;
  });
  return runWith(ffmpegPath).catch(error => {
    if (ffmpegPath !== 'ffmpeg' && error.launchError) return runWith('ffmpeg');
    throw error;
  });
}
function newTemp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), `screencap-${prefix}-`)); }
function desktopDir() { const p = app.getPath('desktop'); return fs.existsSync(p) ? p : app.getPath('documents'); }
function isH264(mime) { return /h264|avc1/i.test(mime || ''); }
function validJob(job, id) { if (!job || job.id !== id) throw new Error('No matching job'); }

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  mainWindow = makeWindow('index.html', {width: 1440, height: 900, minWidth: 1040, minHeight: 700, title: 'ScreenCap Video', show:false});
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', e => {
    if (recording && !isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; if (!isQuitting) app.quit(); });
  globalShortcut.register('F9', () => {
    if (recording) { if (recording.active) send('stop-request'); }
    else send('start-request');
  });
  if (hook) {
    hook.on('mousedown', e => {
      if (!recording || !recording.active || e.button !== 1) return;
      const pt = pointOnDisplay();
      if (!pt) return;
      if (barWindow && !barWindow.isDestroyed() && inBounds(pt.p, barWindow.getBounds())) return;
      recording.log.clicks.push({ t: stamp(), x: pt.x, y: pt.y });
      sendBar('click-flash');
    });
    hook.on('keydown', () => {
      if (recording && recording.active) recording.log.keys.push(+stamp().toFixed(3));
    });
  }
});
app.on('before-quit', () => {
  isQuitting = true; endTracking();
  if (exportJob && exportJob.process) exportJob.process.kill();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow) mainWindow.show(); });

ipcMain.handle('app-info', () => ({hookError, ffmpegPath, version:app.getVersion()}));
ipcMain.handle('displays', async () => {
  const sources = await desktopCapturer.getSources({types:['screen'], thumbnailSize:{width:480,height:270}});
  return screen.getAllDisplays().map((d, i) => {
    const source = sources.find(s => s.display_id === String(d.id)) || sources[i];
    return { id:String(d.id), index:i, name:d.label || `Display ${i+1}`, bounds:d.bounds,
      scaleFactor:d.scaleFactor, width:Math.round(d.size.width*d.scaleFactor),
      height:Math.round(d.size.height*d.scaleFactor),
      sourceId:source ? source.id : null, thumbnail:source ? source.thumbnail.toDataURL() : null };
  });
});
ipcMain.handle('select-area', (_evt, displayId) => new Promise(resolve => {
  if (pendingRegion) { resolve(null); return; }
  const d = screen.getAllDisplays().find(x => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
  pendingRegion = resolve;
  overlayWindow = new BrowserWindow({
    x:d.bounds.x, y:d.bounds.y, width:d.bounds.width, height:d.bounds.height,
    frame:false, transparent:true, alwaysOnTop:true, resizable:false, skipTaskbar:true,
    backgroundColor:'#00000000', webPreferences:{nodeIntegration:true, contextIsolation:false, webSecurity:false}
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.on('closed', () => { overlayWindow = null; if (pendingRegion) { pendingRegion(null); pendingRegion=null; } });
  const html = `<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;font:600 14px Arial;background:#09081255;overflow:hidden;cursor:crosshair;user-select:none}
    #help{position:absolute;top:22px;left:50%;transform:translateX(-50%);border:1px solid #ffffff40;border-radius:12px;padding:12px 22px;color:white;background:#0b0b0edd;pointer-events:none}
    #box{position:absolute;display:none;border:2px solid #ad68ff;background:#a855f724;box-shadow:0 0 0 100vw #05040a33;pointer-events:none}#size{position:absolute;left:0;top:-27px;background:#16111f;color:white;padding:4px 7px;border-radius:4px;white-space:nowrap}
  </style></head><body><div id="help">Drag to select • Hold Shift for 16:9 • Esc to cancel • Release to apply</div><div id="box"><div id="size"></div></div><script>
    const {ipcRenderer}=require('electron');const box=document.getElementById('box'),size=document.getElementById('size');let start=null;
    document.onpointerdown=e=>{start={x:e.clientX,y:e.clientY};box.style.display='block'};
    function rectangle(e){let dx=e.clientX-start.x,dy=e.clientY-start.y;if(e.shiftKey){let w=Math.max(Math.abs(dx),Math.abs(dy)*16/9);let h=w*9/16;dx=(dx<0?-1:1)*w;dy=(dy<0?-1:1)*h}let x=Math.min(start.x,start.x+dx),y=Math.min(start.y,start.y+dy),w=Math.abs(dx),h=Math.abs(dy);x=Math.max(0,x);y=Math.max(0,y);w=Math.min(w,innerWidth-x);h=Math.min(h,innerHeight-y);return{x,y,w,h}}
    document.onpointermove=e=>{if(!start)return;const r=rectangle(e);Object.assign(box.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px'});size.textContent=Math.round(r.w)+' × '+Math.round(r.h)};
    document.onpointerup=e=>{if(!start)return;const r=rectangle(e);start=null;if(r.w<24||r.h<24)return;ipcRenderer.send('area-result',{x:r.x/innerWidth,y:r.y/innerHeight,w:r.w/innerWidth,h:r.h/innerHeight})};
    document.onkeydown=e=>{if(e.key==='Escape')ipcRenderer.send('area-result',null)};
  <\/script></body></html>`;
  overlayWindow.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  overlayWindow.show(); overlayWindow.focus();
}));
ipcMain.on('area-result', (_event, value) => {
  if (pendingRegion) { pendingRegion(value); pendingRegion=null; }
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
});

ipcMain.handle('record-prepare', (_evt, config) => {
  if (recording) throw new Error('Already recording');
  const d = screen.getAllDisplays().find(x => String(x.id) === String(config.displayId));
  if (!d) throw new Error('Display disconnected');
  const dir = newTemp('record');
  recording = {
    id:Date.now().toString(36), dir, raw:path.join(dir,'recording.webm'),
    fd:fs.openSync(path.join(dir,'recording.webm'),'w'), active:false, t0:0,
    display:{id:String(d.id),bounds:d.bounds,scaleFactor:d.scaleFactor},
    config, mime:config.mime || '',
    log:{version:1, created:new Date().toISOString(),fps:config.fps || 60,
      width:config.width,height:config.height,area:config.area || {x:0,y:0,w:1,h:1},
      cursor:[],clicks:[],manual:[],keys:[]}
  };
  mainWindow.hide(); createBar(d);
  sendBar('bar-countdown', config.countdown ? 3 : 0);
  // The bar reports that its DOM is ready before beginning the countdown.
  return {id:recording.id};
});
ipcMain.on('bar-ready', () => { if (recording && !recording.t0) sendBar('bar-countdown', recording.config.countdown ? 3 : 0); });
ipcMain.on('countdown-done', () => { if (recording && !recording.t0) send('record-now'); });
ipcMain.handle('record-active', () => { startTracking(); return {t0:recording ? recording.t0 : 0}; });
ipcMain.on('record-chunk', (_evt, data) => {
  if (!recording || recording.fd === null) return;
  try { fs.writeSync(recording.fd, Buffer.from(data)); }
  catch (e) { send('record-error', e.message); }
});
ipcMain.on('bar-stop', () => send('stop-request'));
ipcMain.on('bar-discard', () => send('discard-request'));
ipcMain.handle('record-finish', async (_event, discarded=false) => {
  if (!recording) return null;
  endTracking();
  const job = recording; recording = null;
  closeBar();
  if (job.fd !== null) { fs.closeSync(job.fd); job.fd = null; }
  if (discarded) {
    fs.rmSync(job.dir,{recursive:true,force:true});
    mainWindow.show(); return null;
  }
  const finalPath = path.join(job.dir, isH264(job.mime) ? 'recording.mp4' : 'recording-ready.webm');
  let videoPath = job.raw, error = '';
  try {
    await ffmpeg(isH264(job.mime)
      ? ['-i',job.raw,'-map','0:v:0','-map','0:a?','-c:v','copy','-c:a','aac','-movflags','+faststart',finalPath]
      : ['-i',job.raw,'-map','0','-c','copy',finalPath]);
    videoPath = finalPath;
  } catch (e) { error = e.message; }
  const logPath = path.join(job.dir,'session.json');
  fs.writeFileSync(logPath,JSON.stringify(job.log,null,2),'utf8');
  mainWindow.show(); mainWindow.focus();
  return {path:videoPath,logPath,log:job.log,error};
});
ipcMain.handle('open-video', async () => {
  const response = await dialog.showOpenDialog(mainWindow, {
    title:'Open an existing video',properties:['openFile'],
    filters:[{name:'Video files',extensions:['mp4','webm','mov','mkv','m4v']}] });
  if (response.canceled || !response.filePaths.length) return null;
  const filepath = response.filePaths[0];
  let log = null;
  const logPath = path.join(path.dirname(filepath),'session.json');
  try { if (fs.existsSync(logPath)) log=JSON.parse(fs.readFileSync(logPath,'utf8')); } catch (_) {}
  return {path:filepath,log};
});
ipcMain.handle('choose-images', async () => {
  const r = await dialog.showOpenDialog(mainWindow,{title:'Choose background images',properties:['openFile','multiSelections'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','bmp']}]});
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('export-dialog', async () => {
  const r = await dialog.showSaveDialog(mainWindow,{
    title:'Export MP4', defaultPath:path.join(desktopDir(),`ScreenCap-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.mp4`),
    filters:[{name:'MP4 Video',extensions:['mp4']}]});
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('export-begin', (_evt, dest, seconds) => {
  if (exportJob) throw new Error('An export is already running');
  const dir = newTemp('export');
  exportJob = {id:Date.now().toString(36),dir,raw:path.join(dir,'render.webm'),fd:fs.openSync(path.join(dir,'render.webm'),'w'),
    dest, seconds, process:null, cancelled:false};
  return exportJob.id;
});
ipcMain.on('export-chunk',(_evt, id, bytes) => {
  if (exportJob && exportJob.id === id && exportJob.fd !== null && !exportJob.cancelled) {
    try { fs.writeSync(exportJob.fd,Buffer.from(bytes)); } catch(e) { send('export-error',e.message); }
  }
});
ipcMain.handle('export-cancel', (_evt,id) => {
  if (!exportJob || exportJob.id !== id) return;
  const job = exportJob;
  job.cancelled = true;
  if (job.process) job.process.kill();
  if (job.fd !== null) { fs.closeSync(job.fd); job.fd=null; }
  exportJob = null;
  const clean = () => { try { fs.rmSync(job.dir,{recursive:true,force:true}); } catch (_) {} };
  if (job.process) job.process.once('close',clean);
  else clean();
});
ipcMain.handle('export-finish', async (_evt,id) => {
  const job=exportJob; validJob(job,id);
  if (job.fd!==null) {fs.closeSync(job.fd); job.fd=null;}
  const timeRx = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
  let destination = job.dest, fallback=false, warning='';
  try {
    await ffmpeg(['-i',job.raw,'-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-r','60',
      '-c:a','aac','-b:a','192k','-movflags','+faststart',job.dest], output => {
      let match;
      while ((match=timeRx.exec(output))) {
        const current=+match[1]*3600 + +match[2]*60 + +match[3];
        send('export-progress',Math.min(99,80+20*current/Math.max(.1,job.seconds)));
      }
    });
  } catch (e) {
    if (job.cancelled) return {cancelled:true};
    warning=e.message; fallback=true;
    destination=job.dest.replace(/\.mp4$/i,'')+'.webm';
    fs.copyFileSync(job.raw,destination);
  } finally {
    if (exportJob === job) exportJob=null;
    try {fs.rmSync(job.dir,{recursive:true,force:true});}catch(_){}
  }
  if (job.cancelled) return {cancelled:true};
  send('export-progress',100);
  try {
    new Notification({title:'ScreenCap Video',body:fallback?'WebM saved (MP4 conversion failed)':'Your MP4 export is ready'}).show();
  } catch (_) {}
  return {path:destination,fallback,warning};
});
ipcMain.handle('show-in-folder', (_evt,filepath) => shell.showItemInFolder(filepath));
ipcMain.handle('window-control', (_evt,cmd) => {
  if (!mainWindow) return;
  if (cmd==='minimize') mainWindow.minimize();
  else if (cmd==='maximize') mainWindow.isMaximized()?mainWindow.unmaximize():mainWindow.maximize();
  else if (cmd==='close') { isQuitting=true; app.quit(); }
});
ipcMain.handle('uri',(_evt,p) => pathToFileURL(p).href);
