import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'arb-radar-http-'));
const db=join(dir,'missing.sqlite');
const port=4300 + (process.pid % 1000);
const child=spawn(process.execPath,['dist/dashboard/server.js'],{
  env:{...process.env,RADAR_DB:db,DASHBOARD_HOST:'127.0.0.1',DASHBOARD_PORT:String(port)},
  stdio:['ignore','pipe','pipe']
});
let stdout='',stderr='';
child.stdout.on('data',d=>stdout+=d);
child.stderr.on('data',d=>stderr+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
  let ready=false;
  for(let i=0;i<40;i++){
    if(child.exitCode!==null) throw new Error(`dashboard exited ${child.exitCode}: ${stderr}`);
    try{
      const health=await fetch(`http://127.0.0.1:${port}/api/health`);
      if(health.ok){ready=true;break}
    }catch{}
    await sleep(50);
  }
  if(!ready) throw new Error(`dashboard did not become ready: ${stdout} ${stderr}`);
  const snapshotResponse=await fetch(`http://127.0.0.1:${port}/api/snapshot?limit=10`);
  if(!snapshotResponse.ok) throw new Error(`snapshot HTTP ${snapshotResponse.status}`);
  const snapshot=await snapshotResponse.json();
  if(snapshot.paperOnly!==true || snapshot.database?.exists!==false) throw new Error('unexpected empty snapshot');
  const page=await fetch(`http://127.0.0.1:${port}/`);
  const html=await page.text();
  if(!page.ok || !html.includes('Arb Radar') || !html.includes('PAPER RESEARCH')) throw new Error('dashboard HTML missing');
  console.log('dashboard smoke passed', {port,paperOnly:snapshot.paperOnly});
} finally {
  child.kill('SIGTERM');
  rmSync(dir,{recursive:true,force:true});
}
