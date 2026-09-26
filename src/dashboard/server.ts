import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDashboardSnapshot } from './data.js';

const here = dirname(fileURLToPath(import.meta.url));
const assetRoot = join(here, '..', '..', 'dashboard');
const host = process.env.DASHBOARD_HOST ?? '127.0.0.1';
const rawPort = Number(process.env.DASHBOARD_PORT ?? 4173);
const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 4173;
const databasePath = process.env.RADAR_DB ?? 'data/radar.sqlite';

const assets: Record<string,{file:string,type:string}> = {
  '/': { file:'index.html', type:'text/html; charset=utf-8' },
  '/index.html': { file:'index.html', type:'text/html; charset=utf-8' },
  '/app.js': { file:'app.js', type:'text/javascript; charset=utf-8' },
  '/styles.css': { file:'styles.css', type:'text/css; charset=utf-8' },
};

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request,response)=>{
  try {
    if (request.method !== 'GET') {
      sendJson(response,405,{error:'method-not-allowed'});
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    if (url.pathname === '/api/health') {
      sendJson(response,200,{ok:true,paperOnly:true,databasePath,at:Date.now()});
      return;
    }
    if (url.pathname === '/api/snapshot') {
      const requested=Number(url.searchParams.get('limit') ?? 100);
      const limit=Number.isFinite(requested) ? Math.min(500,Math.max(1,Math.floor(requested))) : 100;
      const requestedWindowSeconds=Number(url.searchParams.get('windowSeconds') ?? 60);
      const windowSeconds=Number.isFinite(requestedWindowSeconds) ? Math.min(900,Math.max(10,Math.floor(requestedWindowSeconds))) : 60;
      try {
        sendJson(response,200,buildDashboardSnapshot(databasePath,limit,Date.now(),windowSeconds*1000));
      } catch (error) {
        sendJson(response,503,{paperOnly:true,error:'snapshot-unavailable',detail:String(error),at:Date.now()});
      }
      return;
    }
    const asset=assets[url.pathname];
    if (!asset) {
      sendJson(response,404,{error:'not-found'});
      return;
    }
    const body=await readFile(join(assetRoot,asset.file));
    response.writeHead(200,{
      'content-type':asset.type,
      'cache-control':asset.file === 'index.html' ? 'no-store' : 'public, max-age=60',
      'x-content-type-options':'nosniff',
      'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(body);
  } catch (error) {
    sendJson(response,500,{error:'server-error',detail:String(error)});
  }
});

server.listen(port,host,()=>{
  console.log(`Arb Radar dashboard — PAPER ONLY — http://${host}:${port}`);
  console.log(`SQLite: ${databasePath}`);
});

function shutdown(): void {
  server.close(()=>process.exit(0));
}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
