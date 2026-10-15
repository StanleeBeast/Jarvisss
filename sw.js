const CACHE='jarvis-pwa-v08';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('jarvis-pwa-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==location.origin)return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  const isPage=request.mode==='navigate'||url.pathname.endsWith('.html')||url.pathname.endsWith('/');
  if(isPage){
   try{
    const fresh=await fetch(request);
    if(fresh.ok&&fresh.type==='basic')await cache.put(request,fresh.clone());
    return fresh;
   }catch(error){
    return (await cache.match(request))||(await cache.match('./index.html'))||Response.error();
   }
  }
  const cached=await cache.match(request);
  if(cached)return cached;
  try{
   const response=await fetch(request);
   if(response.ok&&response.type==='basic')await cache.put(request,response.clone());
   return response;
  }catch(error){throw error}
 })())
});
