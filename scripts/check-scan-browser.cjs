const {chromium}=require(process.env.PRISM_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.PRISM_SCAN_OUTPUT || '.scan-check';
const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{
 const executablePath=process.env.PRISM_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
 const browser=await chromium.launch({headless:true,...(executablePath ? {executablePath} : {}),args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 const origin=process.env.PRISM_SCAN_ORIGIN || 'http://127.0.0.1:4173';
 const head={shop:'测试店铺',shopCode:'demo',heroUrl:null,resource:'测试机台',publicId:'demo',billingActive:false};
 const cards={kind:'cards',id:'cards',enabled:true,capture:false,action:'card.swipe',needsLocation:false};
 const user={user:{id:'u',username:'test',displayName:'测试玩家',role:'user',hasShops:false}};
 const reply=(route,data)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
 // The hero is on screen before sign-in is known, and the page is one read however long it stays open.
 {
  const counts={};let releaseMe,meDone=false;const meHeld=new Promise(r=>releaseMe=r);
  await page.route('**/api/**',async route=>{const url=new URL(route.request().url());counts[url.pathname]=(counts[url.pathname]||0)+1;
   if(url.pathname==='/api/v1/me'){await meHeld;meDone=true;return reply(route,user);}
   if(url.pathname==='/api/v1/devices/session/page')return reply(route,{...head,blocks:[cards]});
   if(url.pathname==='/api/v1/cards')return reply(route,{cards:[{id:'card',label:'测试 Aime',accessCode:'12345678901234567890',disabledAt:null}],authorizationRequired:false});
   return reply(route,{});});
  await page.goto(`${origin}/m#ticket=opaque-test`);await page.getByText('测试店铺',{exact:true}).waitFor();assert.equal(meDone,false);
  fs.mkdirSync(output,{recursive:true});await page.screenshot({path:`${output}/scan-auth-loading.png`,fullPage:true});
  releaseMe();await page.getByText('测试 Aime',{exact:true}).waitFor();
  await page.screenshot({path:`${output}/scan-cards.png`,fullPage:true});
  await page.waitForTimeout(7000);
  assert.equal(counts['/api/v1/devices/session/page'],1);
  for(const old of ['bootstrap','state','device','power'])assert.equal(counts[`/api/v1/devices/session/${old}`],undefined,`${old} is not read any more`);
  console.log('PASS hero before auth, and one read of the page while nothing changes',counts);
 }
 // Told the page changed, it reads itself and shows what it reads; the channel carries nothing else.
 {
  const live=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,locale:'zh-CN'});const seen={};let off=true,socket;
  await live.routeWebSocket(/\/api\/v1\/devices\/session\/ws/,ws=>{assert.ok(ws.url().includes('v=2'));socket=ws;ws.onMessage(m=>{if(m==='ping')ws.send('pong');});});
  await live.route('**/api/**',async route=>{const url=new URL(route.request().url());seen[url.pathname]=(seen[url.pathname]||0)+1;
   if(url.pathname==='/api/v1/me')return reply(route,user);
   if(url.pathname==='/api/v1/devices/session/page')return reply(route,{...head,blocks:off
     ?[{kind:'text',id:'power-off',text:'设备尚未开机',style:'heading'},{kind:'button',id:'power',label:'开机',icon:'power',style:'primary',enabled:true,action:'power.on',needsLocation:false}]
     :[cards]});
   if(url.pathname==='/api/v1/cards')return reply(route,{cards:[{id:'card',label:'测试 Aime',accessCode:'12345678901234567890',disabledAt:null}],authorizationRequired:false});
   return reply(route,{});});
  await live.goto(`${origin}/m#ticket=v1.opaque-test`);
  await live.getByText('设备尚未开机',{exact:true}).waitFor();
  await live.waitForTimeout(500);while(!socket)await live.waitForTimeout(100);
  const before=seen['/api/v1/devices/session/page'];
  off=false;socket.send(JSON.stringify({method:'event.pageChanged',params:{reason:'device'}}));
  await live.getByText('测试 Aime',{exact:true}).waitFor();
  assert.equal(seen['/api/v1/devices/session/page'],before+1);
  await live.screenshot({path:`${output}/scan-pushed.png`,fullPage:true});await live.close();
  console.log('PASS the page reads itself once when told it changed',seen);
 }
 // A read that stalls gives up, says so, and tries again.
 {
  const slow=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,locale:'zh-CN'});let reads=0;
  await slow.route('**/api/**',async route=>{const url=new URL(route.request().url());
   if(url.pathname==='/api/v1/me')return reply(route,user);
   if(url.pathname==='/api/v1/devices/session/page'){if(++reads<=2)return;return reply(route,{...head,blocks:[{kind:'text',id:'empty',text:'这里没有可操作的设备'}]});}
   return reply(route,{});});
  await slow.goto(`${origin}/m#ticket=v1.opaque-test`);
  await slow.getByText('网络较慢，正在重试',{exact:true}).waitFor({timeout:9000});
  await slow.getByText('这里没有可操作的设备',{exact:true}).waitFor();
  await slow.getByText('网络较慢，正在重试',{exact:true}).waitFor({state:'detached'});
  assert.equal(reads,3);await slow.close();
  console.log('PASS a stalled read is retried and the player is told');
 }
 for (const [locale,copy,checkout,billing] of [['zh-CN','余额不足，请充值后再结账，计费会继续','结账','计费中'],['en-US','Not enough balance. Top up and check out again; billing continues.','Check out','Billing in progress']]) {
  const checkoutPage=await browser.newPage({viewport:{width:390,height:844},locale});let confirmations=0;
  await checkoutPage.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let data;
   if(path==='/api/v1/me')data={user:{id:'u',username:'test',displayName:'测试玩家',role:'user',hasShops:false}};
   else if(path==='/api/v1/shops/demo')data={shop:{publicId:'demo',name:'测试店铺',billingEnabled:true,locationEnabled:false,identityBindingRequired:false},membership:{playerId:'p',identityBound:true},entryPricing:[]};
   else if(path.endsWith('/player/me'))data={wallet:[],activeSession:{id:'visit',startedAt:'2026-10-05T06:00:00Z'}};
   else if(path.endsWith('/player/billing-inputs'))data={playerId:'player',billingSnapshot:{version:1,capturedAt:'2026-10-05T07:00:00Z',assetDefinitions:[],currentPricingConfigs:[{id:'fixed',kind:'charge.fixed',name:'入场',enabled:true,status:'active',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',provider:{id:'fixed',amount:12}}],pricingReleases:[],players:[{playerId:'player',sessions:[{id:'visit',playerId:'player',startedAt:'2026-10-05T06:00:00Z',status:'active',paymentStatus:'unpaid',pricingConfigIds:['fixed'],metadata:{}}],holdings:[],pastAppliedAdjustments:[],pricingPaidHistory:{},capPaidHistory:{}}]}};
   else if(path.endsWith('/checkout/preview'))data={settlementPreview:{total:12},chargeItems:[],adjustments:[]};
   else if(path.endsWith('/checkout/confirm')){confirmations++;// As the server answers: player text in the request's language, the diagnostic only in reason.
    await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'INSUFFICIENT_BALANCE',message:copy,reason:'Insufficient currency holdings for this operation.',notice:{code:'INSUFFICIENT_BALANCE',level:'warning',display:'dialog',flow:'none',title:locale==='en-US'?'Insufficient balance':'余额不足',body:copy,actions:[{kind:'dismiss',label:locale==='en-US'?'OK':'知道了'}]}}})});return;}
   else data={};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
  });
  await checkoutPage.goto(`${process.env.PRISM_SCAN_ORIGIN || 'http://127.0.0.1:4173'}/t/demo`);
  const button=checkoutPage.getByRole('button',{name:checkout,exact:true});await button.click();await checkoutPage.getByRole('dialog').filter({hasText:copy}).waitFor();
  assert.equal(await checkoutPage.getByText('Insufficient currency holdings for this operation.',{exact:true}).count(),0);
  assert.equal(await button.isEnabled(),true);assert.equal(confirmations,1);
  assert.equal(await checkoutPage.getByText(billing,{exact:true}).count()>0,true);
  await checkoutPage.screenshot({path:`${output}/checkout-insufficient-${locale}.png`,fullPage:true});await checkoutPage.close();
 }
 {
  const seatPage=await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN'});
  const writes=[];let seated=false;
  const seatPageOf=()=>({...head,billingActive:seated,blocks:seated
    ?[{kind:'mahjong',id:'mahjong',title:'麻将桌',status:'等待玩家',capacity:4,emptyLabel:'空位',mineLabel:'你',seats:[{name:'测试玩家',mine:true}]},{kind:'button',id:'seat',label:'下桌',enabled:true,action:'mahjong.leave',needsLocation:false}]
    :[{kind:'consent',id:'consent',text:'确认开始计费，离店前请结账。关闭页面不会停止计费。'},{kind:'button',id:'entry',label:'确认',style:'primary',enabled:true,action:'mahjong.join',payload:{expectedRevision:'seat-preview'},requires:'consent',needsLocation:false}]});
  await seatPage.routeWebSocket(/\/api\/v1\/devices\/session\/ws/,()=>{});
  await seatPage.route('**/api/**',async route=>{const req=route.request(),p=new URL(req.url()).pathname;
   if(req.method()==='POST'&&p==='/api/v1/devices/session/action'){writes.push({path:p,body:JSON.parse(req.postData())});seated=true;return reply(route,{ok:true,page:seatPageOf(),notices:[]});}
   if(p==='/api/v1/me')return reply(route,user);
   if(p==='/api/v1/devices/session/page')return reply(route,seatPageOf());
   return reply(route,{});});
  await seatPage.goto(`${origin}/m#ticket=v1.seat-ticket`);
  await seatPage.getByRole('checkbox').check();
  await seatPage.getByRole('button',{name:'确认',exact:true}).click();
  await seatPage.getByRole('button',{name:'下桌',exact:true}).waitFor();
  assert.equal(writes.length,1);
  assert.equal(writes[0].path,'/api/v1/devices/session/action');
  assert.equal(writes[0].body.action,'mahjong.join');
  assert.equal(writes[0].body.payload.consent,true);
  assert.equal(writes[0].body.payload.expectedRevision,'seat-preview');
  await seatPage.close();
  console.log('PASS scanned mahjong confirmation seats through one atomic action without an earlier session start');
 }
 console.log('PASS localized balance rejection retains the bill and permits manual retry');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
