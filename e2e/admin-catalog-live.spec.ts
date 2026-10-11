import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

/** This file is ONLY launched inside the Folio-only PostgreSQL/direct-TLS
 * catalog smoke. No API mocks, no stubbed database, no seeded permissions
 * inside the browser and no production credentials. The test process receives
 * synthetic credentials through its private child-process environment. */
function needed(name:string):string{
  const value=process.env[name];
  if(!value)throw Error('Required synthetic Folio live-browser fixture absent: '+name);
  return value;
}
test('real browser -> same-origin direct TLS Nest -> Folio PostgreSQL, conflict/audit/CRUD',async({browser})=>{
  test.setTimeout(110_000);
  const origin=needed('FOLIO_LIVE_BROWSER_ORIGIN');
  const workId=needed('FOLIO_LIVE_BROWSER_WORK_ID');
  const sourceTitle=needed('FOLIO_LIVE_BROWSER_TITLE');
  const alternate=needed('FOLIO_LIVE_BROWSER_ALTERNATE');
  const peerName=needed('FOLIO_LIVE_BROWSER_PEER_NAME');
  const editionLabel=needed('FOLIO_LIVE_BROWSER_EDITION_LABEL');
  const peerToken=needed('FOLIO_LIVE_BROWSER_PEER_TOKEN');
  const editorToken=needed('FOLIO_LIVE_BROWSER_EDITOR_TOKEN');
  const viewerToken=needed('FOLIO_LIVE_BROWSER_VIEWER_TOKEN');
  const revisedTitle=sourceTitle+' Updated';
  const revisedAlternate=alternate+' Updated';
  const base='/v1/admin/catalog/works/'+workId;
  const cookie=(value:string)=>[{
    name:'__Host-folio_session',value,url:origin,httpOnly:true,
    secure:true,sameSite:'Strict' as const,
  }];
  const ctx=await browser.newContext({
    ignoreHTTPSErrors:true,viewport:{width:390,height:844},
  });
  await ctx.addCookies(cookie(editorToken));
  const peer=await browser.newContext({ignoreHTTPSErrors:true});
  await peer.addCookies(cookie(peerToken));
  const viewer=await browser.newContext({ignoreHTTPSErrors:true});
  await viewer.addCookies(cookie(viewerToken));
  try{
    // Unauthenticated / read-only paths are actually evaluated by Nest +
    // the database, not fulfilled by a page.route() mock.
    const anonymous=await browser.newContext({ignoreHTTPSErrors:true});
    try{
      const denied=await anonymous.request.get(origin+base);
      expect(denied.status()).toBe(401);
    }finally{await anonymous.close();}
    const readonly=await viewer.request.get(origin+base,{
      headers:{origin,'sec-fetch-site':'same-origin'},
    });
    expect(readonly.status()).toBe(200);
    const viewerCsrf=await viewer.request.get(origin+'/v1/auth/web/csrf',{
      headers:{origin,'sec-fetch-site':'same-origin'},
    });
    expect(viewerCsrf.status()).toBe(204);
    const deniedWrite=await viewer.request.patch(origin+base,{
      headers:{origin,'sec-fetch-site':'same-origin',
        'x-folio-csrf':neededHeader(viewerCsrf.headers(),'x-folio-csrf')},
      data:{expectedVersion:0,firstPublicationYear:1888},
    });
    expect(deniedWrite.status()).toBe(403);

    const page=await ctx.newPage();
    const writes:string[]=[];
    page.on('request',request=>{
      if(request.url().startsWith(origin+'/v1/')&&
        ['POST','PATCH','DELETE'].includes(request.method())){
        writes.push(request.method()+' '+new URL(request.url()).pathname);
      }
    });
    await page.goto(origin+'/admin/works');
    const panel=page.getByTestId('admin-catalog-panel');
    await expect(panel).toBeVisible();
    await page.getByRole('searchbox',{name:'Yazar veya eser metni'})
      .fill(sourceTitle);
    await page.getByRole('button',{name:'Ara',exact:true}).click();
    await page.getByRole('button',{name:new RegExp(sourceTitle)}).click();
    const detail=page.getByTestId('admin-catalog-detail');
    await expect(detail).toContainText('Metadata sürümü: 0');
    await expect(detail).toContainText(alternate);
    await expect(detail).toContainText(peerName);
    await expect(detail).toContainText(editionLabel);
    // A different real MFA-authenticated editor commits while the browser
    // still shows v0. This is a real PATCH (not route.fulfill).
    const token=await peer.request.get(origin+'/v1/auth/web/csrf',{
      headers:{origin,'sec-fetch-site':'same-origin'},
    });
    expect(token.status()).toBe(204);
    const fromPeer=await peer.request.patch(origin+base,{
      headers:{origin,'sec-fetch-site':'same-origin',
        'x-folio-csrf':neededHeader(token.headers(),'x-folio-csrf')},
      data:{expectedVersion:0,firstPublicationYear:1872},
    });
    expect(fromPeer.status()).toBe(200);
    // Browser's stale optimistic form must be denied; no silent replay.
    await page.getByRole('button',{name:'Metadata düzenle'}).click();
    await page.getByLabel('Özgün başlık').fill('Unauthorized Stale Update');
    await page.getByRole('button',{name:'Sürüm kontrolüyle kaydet'}).click();
    await expect(detail.getByRole('alert'))
      .toContainText('Kaydı sessizce tekrar göndermeyin');
    expect(writes.filter(x=>x==='PATCH '+base)).toHaveLength(1);
    await page.getByRole('button',{name:'Güncel sürümü sunucudan yükle'}).click();
    await expect(detail).toContainText('Metadata sürümü: 1');
    await expect(detail).toContainText('1872');
    expect(writes.filter(x=>x==='PATCH '+base)).toHaveLength(1);
    await page.getByRole('button',{name:'Metadata düzenle'}).click();
    await page.getByLabel('Özgün başlık').fill(revisedTitle);
    await page.getByRole('button',{name:'Sürüm kontrolüyle kaydet'}).click();
    await expect(detail).toContainText('Metadata sürümü: 2');
    await expect(detail).toContainText(revisedTitle);
    // Optional relation and author-role changes remain real HTTP+DB writes.
    let rel=page.getByTestId('admin-work-relations');
    await rel.getByRole('button',{name:'Alternatif başlığı düzenle: '+alternate}).click();
    await rel.getByRole('textbox',{name:'Başlık',exact:true})
      .fill(revisedAlternate);
    await rel.getByRole('button',{name:'Değişikliği sürüm kontrolüyle kaydet'}).click();
    await expect(detail).toContainText('Metadata sürümü: 3');
    await expect(detail).toContainText(revisedAlternate);
    rel=page.getByTestId('admin-work-relations');
    await rel.getByRole('button',{name:'Yazarın rolünü/sırasını düzenle: '+peerName}).click();
    await rel.getByRole('combobox',{name:'Katkı türü'}).selectOption('editor');
    await rel.getByRole('textbox',{name:'Sıra'}).fill('5');
    await rel.getByRole('button',{name:'Değişikliği sürüm kontrolüyle kaydet'}).click();
    await expect(detail).toContainText('Metadata sürümü: 4');
    await expect(detail).toContainText(peerName+' (editor, 5)');
    rel=page.getByTestId('admin-work-relations');
    const deletesBefore=writes.filter(x=>x.startsWith('DELETE ')).length;
    await rel.getByRole('button',{name:'Boş taslak baskıyı kaldır: '+editionLabel}).click();
    await expect(rel.getByTestId('admin-work-relation-unlink-confirm')).toBeVisible();
    expect(writes.filter(x=>x.startsWith('DELETE '))).toHaveLength(deletesBefore);
    await rel.getByRole('button',{name:'İlişkiyi kaldırmayı onayla'}).click();
    await expect(detail).toContainText('Metadata sürümü: 5');
    await expect(detail).not.toContainText(editionLabel);
    expect(writes.filter(x=>x==='DELETE '+base+'/editions/'+
      needed('FOLIO_LIVE_BROWSER_EDITION_ID'))).toHaveLength(1);
    // No token was readable by the application and no horizontal overflow.
    expect(await page.evaluate(()=>document.cookie)).not.toContain('__Host-folio_session');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth))
      .toBeLessThanOrEqual(1);
    await page.getByRole('button',{name:'EN',exact:true}).click();
    await expect(detail).toContainText('Metadata version: 5');
    const visualDir=join(process.cwd(),'artifacts','live-catalog-visual');
    await mkdir(visualDir,{recursive:true});
    // Live visual/responsive evidence: the same authenticated browser remains
    // backed by real HTTPS and PostgreSQL across breakpoints and color schemes.
    // These captures contain synthetic catalogue data only, never session IDs.
    for(const language of ['en','tr'] as const){
      await page.getByRole('button',{name:language.toUpperCase(),exact:true}).click();
      const queryLabel=language==='tr'?'Yazar veya eser metni':'Author or work text';
      const versionLabel=language==='tr'?'Metadata sürümü: 5':'Metadata version: 5';
      for(const colorScheme of ['light','dark'] as const){
        await page.emulateMedia({colorScheme});
        await expect(page.locator('[data-paperbound-theme]'))
          .toHaveAttribute('data-paperbound-theme',colorScheme);
        for(const width of [320,390,768,1024,1440,1920]){
          await page.setViewportSize({width,height:900});
          await expect(detail).toContainText(versionLabel);
          await expect(page.getByRole('searchbox',{name:queryLabel})).toBeVisible();
          const overflow=await page.evaluate(
            ()=>document.documentElement.scrollWidth-window.innerWidth);
          expect(overflow,`${language}/${colorScheme}/${width}px document overflow`)
            .toBeLessThanOrEqual(1);
          if(colorScheme==='dark'&&[320,768,1440].includes(width)){
            const name=`live-catalog-${language}-dark-${width}`;
            const path=join(visualDir,name+'.png');
            await page.screenshot({path,fullPage:true});
            await test.info().attach(name,{path,contentType:'image/png'});
          }
        }
      }
    }
    expect(await page.evaluate(()=>document.cookie))
      .not.toContain('__Host-folio_session');
    console.log('LIVE CATALOG RESPONSIVE QA: 24 TR/EN x theme x viewport combinations, no document overflow.');
    // Fresh browser GET with the same cookie confirms durable persistence.
    const fresh=await ctx.request.get(origin+base,{
      headers:{origin,'sec-fetch-site':'same-origin'},
    });
    expect(fresh.status()).toBe(200);
    const item=(await fresh.json()) as {
      work:{id:string;metadataVersion:number;originalTitle:string;
        firstPublicationYear:number};
      authors:Array<{name:string;role:string;sortOrder:number}>;
      titles:Array<{title:string}>;
      editions:Array<{id:string}>;
    };
    expect(item.work).toMatchObject({
      id:workId,metadataVersion:5,originalTitle:revisedTitle,
      firstPublicationYear:1872,
    });
    expect(item.authors).toEqual(expect.arrayContaining([
      expect.objectContaining({name:peerName,role:'editor',sortOrder:5}),
    ]));
    expect(item.titles).toEqual(expect.arrayContaining([
      expect.objectContaining({title:revisedAlternate}),
    ]));
    expect(item.editions.map(x=>x.id))
      .not.toContain(needed('FOLIO_LIVE_BROWSER_EDITION_ID'));
    console.log('LIVE ADMIN BROWSER -> NEST TLS -> POSTGRES PASS: 401/403/409, real MFA two-device writes, versioned CRUD, no retry, TR/EN 390px.');
  }finally{
    await viewer.close();
    await peer.close();
    await ctx.close();
  }
});
function neededHeader(headers:Record<string,string>,name:string):string{
  const found=headers[name];
  if(!found)throw Error('Missing real HTTPS response '+name);
  return found;
}
