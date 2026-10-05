const {chromium}=require(process.env.PRISM_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.PRISM_SCAN_OUTPUT || '.scan-check';
const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 const counts={};let releaseMe,releasePower,meDone=false,powerDone=false;const meHeld=new Promise(r=>releaseMe=r),powerHeld=new Promise(r=>releasePower=r);
 const machine={publicId:'demo',name:'测试机台',kind:'machine',coinAfterSwipe:false,capabilities:{card:true,power:true,coin:false,door:false,mahjong:true},shop:{publicId:'demo',name:'测试店铺',billingEnabled:false,locationEnabled:false,heroUrl:null}};
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());counts[url.pathname]=(counts[url.pathname]||0)+1;let data;
 if(url.pathname==='/api/v1/me'){await meHeld;meDone=true;data={user:{id:'u',username:'test',displayName:'测试玩家',role:'user',hasShops:false}};}
 else if(url.pathname==='/api/v1/machines/session') data={machine};
 else if(url.pathname==='/api/v1/cards') data={cards:[{id:'card',label:'测试 Aime',accessCode:'12345678901234567890',disabledAt:null}],authorizationRequired:false};
 else if(url.pathname==='/api/v1/devices/session/state') data={gate:'ready',power:'unmanaged',coinUsed:false,mahjong:{capacity:4,seats:[]}};
 else if(url.pathname==='/api/v1/devices/session/power'){await powerHeld;powerDone=true;data={power:'unknown'};}
 else if(url.pathname==='/api/v1/shops/demo')data={shop:{publicId:'demo',name:'测试店铺',billingEnabled:false,locationEnabled:false},membership:null,pricing:[]};
 else data={};
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});});
 await page.goto(`${process.env.PRISM_SCAN_ORIGIN || 'http://127.0.0.1:4173'}/m#ticket=opaque-test`);await page.getByText('测试店铺',{exact:true}).waitFor();assert.equal(meDone,false);
 fs.mkdirSync(output,{recursive:true});await page.screenshot({path:`${output}/scan-auth-loading.png`,fullPage:true});
 releaseMe();await page.getByText('测试 Aime',{exact:true}).waitFor();assert.equal(powerDone,false);await page.screenshot({path:`${output}/scan-cards-before-power.png`,fullPage:true});
 await page.waitForTimeout(7000);assert.equal(counts['/api/v1/shops/demo'],1);assert.ok(counts['/api/v1/devices/session/state']>=2);assert.equal(counts['/api/v1/devices/session/power'],1);
 console.log('PASS hero before auth, cards before HA, one shop metadata GET during dynamic polling',counts);releasePower();await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
