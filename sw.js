// JARVIS Service Worker: Netzwerk zuerst, Cache nur als Offline-Rückfall.
// So erscheinen neue Deployments sofort, ohne dass vergessene Cache-Versionen alte Dateien festhalten.
// API-Anfragen an das Backend (andere Origin) werden nie zwischengespeichert.
const CACHE='jarvis-pwa-v10';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./js/system.js','./js/tasks.js','./js/shell.js'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('jarvis-pwa-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==location.origin)return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  try{
   const fresh=await fetch(request,{cache:'no-cache'});
   if(fresh.ok&&fresh.type==='basic')await cache.put(request,fresh.clone());
   return fresh;
  }catch(error){
   const cached=await cache.match(request,{ignoreSearch:true});
   if(cached)return cached;
   if(request.mode==='navigate')return (await cache.match('./index.html'))||Response.error();
   return Response.error();
  }
 })())
});
