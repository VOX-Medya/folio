import {expect,test} from '@playwright/test';

function required(name:string):string{
  const value=process.env[name];
  if(!value)throw Error('Missing Folio-only synthetic live browser fixture: '+name);
  return value;
}

test('actual Expo Chrome search -> owner shelf -> reader route; other user sees empty shelf',
  async({browser})=>{
  test.setTimeout(110_000);
  const origin=required('FOLIO_LIVE_SHELF_ORIGIN');
  const workId=required('FOLIO_LIVE_SHELF_WORK_ID');
  const title=required('FOLIO_LIVE_SHELF_TITLE');
  const owner=required('FOLIO_LIVE_SHELF_OWNER_TOKEN');
  const other=required('FOLIO_LIVE_SHELF_OTHER_TOKEN');
  const cookie=(token:string)=>[{
    name:'__Host-folio_session',value:token,url:origin,
    httpOnly:true,secure:true,sameSite:'Strict' as const,
  }];
  const first=await browser.newContext({
    ignoreHTTPSErrors:true,viewport:{width:390,height:844},
  });
  const second=await browser.newContext({
    ignoreHTTPSErrors:true,viewport:{width:390,height:844},
  });
  try{
    await first.addCookies(cookie(owner));
    await second.addCookies(cookie(other));
    const page=await first.newPage();
    await page.goto(origin+'/catalog');
    await expect(page.getByTestId('folio-public-search')).toBeVisible();
    await page.getByTestId('folio-public-search-input').fill(title);
    await page.getByTestId('folio-public-search-submit').click();
    await expect(page.getByTestId('folio-public-book-'+workId)).toBeVisible();
    await page.getByTestId('folio-shelf-add-'+workId).click();
    await expect(page.getByTestId('folio-public-search-status')).toHaveText('Raf kaydedildi.');
    await page.getByTestId('folio-tab-library').click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByTestId('folio-owned-shelf')).toBeVisible();
    await expect(page.getByTestId('folio-shelf-continue-'+workId)).toBeVisible();
    const otherPage=await second.newPage();
    await otherPage.goto(origin+'/library');
    await expect(otherPage.getByText('Rafında yayımlanmış kitap yok.')).toBeVisible();
    await page.getByTestId('folio-shelf-continue-'+workId).click();
    await expect(page).toHaveURL(/\/reader\/[0-9a-f-]+$/);
    await expect(page.getByTestId('folio-reader-route')).toBeVisible();
    await expect(page.getByTestId('folio-reader-chapter-title')).toHaveText('Prepared text');
    await expect(page.getByTestId('folio-reader-chapter-body'))
      .toContainText('Synthetic unpublished Folio source');
    await page.getByTestId('folio-reader-next').click();
    await expect(page.getByTestId('folio-reader-chapter-title')).toHaveText('Additional plaintext');
    await expect(page.getByTestId('folio-reader-chapter-body'))
      .toContainText('<script>window.__folioReaderInjected=true;</script>');
    // #36: server cursor survives browser reload and never appears for another account.
    await page.getByTestId('folio-reader-save-progress').click();
    await expect(page.getByTestId('folio-reader-progress-status')).toHaveText('Konum kaydedildi.');
    const revisionId=page.url().split('/').at(-1)!;
    const unrelated=await otherPage.evaluate(async id=>{
      const response=await fetch('/v1/me/progress/'+id,{credentials:'same-origin'});
      return {status:response.status,data:await response.json()};
    },revisionId);
    expect(unrelated.status).toBe(200);
    expect(unrelated.data).toEqual({progress:null});
    const conflict=await page.evaluate(async id=>{
      const current=await fetch('/v1/me/progress/'+id,{credentials:'same-origin'});
      const {progress}=await current.json();
      const proof=await fetch('/v1/auth/web/csrf',{credentials:'same-origin'});
      const csrf=proof.headers.get('x-folio-csrf')!;
      const response=await fetch('/v1/me/progress/'+id,{
        method:'PUT',credentials:'same-origin',
        headers:{'content-type':'application/json','x-folio-csrf':csrf},
        body:JSON.stringify({expectedVersion:0,
          chapterId:progress.chapterId,blockId:progress.blockId,
          tokenOffset:0,audioPositionMs:null,mode:'normal'}),
      });
      return response.status;
    },revisionId);
    expect(conflict).toBe(409);
    await page.reload();
    await expect(page.getByTestId('folio-reader-chapter-title')).toHaveText('Additional plaintext');

    expect(await page.evaluate(()=>Object.prototype.hasOwnProperty.call(
      window,'__folioReaderInjected'))).toBe(false);
    await page.getByTestId('folio-reader-font-increase').click();
    await page.getByTestId('folio-reader-theme-dark').click();
    await expect(page.getByTestId('folio-reader-current-theme-dark')).toBeVisible();
    await page.getByTestId('folio-reader-prev').click();
    await expect(page.getByTestId('folio-reader-chapter-title')).toHaveText('Prepared text');
    await page.getByTestId('folio-reader-mode-rsvp').click();
    await expect(page.getByTestId('folio-rsvp-current-words')).toHaveText('Synthetic');
    await page.getByTestId('folio-rsvp-next').click();
    await expect(page.getByTestId('folio-rsvp-current-words')).toHaveText('unpublished');
    await page.getByTestId('folio-rsvp-previous').click();
    await expect(page.getByTestId('folio-rsvp-current-words')).toHaveText('Synthetic');
    await page.getByTestId('folio-rsvp-word-group').click();
    await expect(page.getByTestId('folio-rsvp-current-words'))
      .toHaveText('Synthetic unpublished');
    await page.getByTestId('folio-rsvp-wpm-up').click();
    await expect(page.getByTestId('folio-rsvp-wpm')).toHaveText('300 WPM');
    await page.getByTestId('folio-rsvp-display').click();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('folio-rsvp-current-words')).toHaveText('Folio source');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('folio-rsvp-current-words'))
      .toHaveText('Synthetic unpublished');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('folio-rsvp-play-pause')).toHaveText('Duraklat');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('folio-rsvp-play-pause')).toHaveText('Başlat');
    // RSVP cursor can be persisted independently from normal page position.
    await page.getByTestId('folio-reader-save-progress').click();
    await expect(page.getByTestId('folio-reader-progress-status')).toHaveText('Konum kaydedildi.');
    await page.reload();
    await expect(page.getByTestId('folio-rsvp-player')).toBeVisible();
    await page.getByTestId('folio-reader-mode-normal').click();
    await expect(page.getByTestId('folio-reader-chapter-body')).toBeVisible();
    // #35: genuine HTTPS Opus media from the approved Folio vault, no fixture-mocked player.
    await page.getByTestId('folio-reader-mode-audio').click();
    const audio=page.getByTestId('folio-audio-element');
    await expect.poll(async()=>audio.evaluate(el=>(el as HTMLAudioElement).duration))
      .toBeGreaterThan(5);
    await page.getByTestId('folio-audio-play').click();
    await expect.poll(async()=>audio.evaluate(el=>(el as HTMLAudioElement).paused))
      .toBe(false);
    await page.getByTestId('folio-audio-speed').click();
    await expect.poll(async()=>audio.evaluate(el=>(el as HTMLAudioElement).playbackRate))
      .toBe(1.25);
    await page.getByTestId('folio-audio-forward').click();
    await expect.poll(async()=>audio.evaluate(el=>(el as HTMLAudioElement).currentTime))
      .toBeGreaterThan(5);
    await page.getByTestId('folio-audio-play').click();
    await expect.poll(async()=>audio.evaluate(el=>(el as HTMLAudioElement).paused))
      .toBe(true);
    await page.getByTestId('folio-reader-save-progress').click();
    await expect(page.getByTestId('folio-reader-progress-status')).toHaveText('Konum kaydedildi.');
    await page.reload();
    await expect(page.getByTestId('folio-audio-player')).toBeVisible();
    const restored=page.getByTestId('folio-audio-element');
    await expect.poll(async()=>restored.evaluate(el=>(el as HTMLAudioElement).currentTime))
      .toBeGreaterThan(5);
    await page.getByTestId('folio-audio-next-chapter').click();
    await expect(page.getByTestId('folio-reader-chapter-title'))
      .toHaveText('Additional plaintext');
    await expect(page.getByTestId('folio-audio-error')).toBeVisible();
    await page.getByTestId('folio-reader-mode-normal').click();
    await expect(page.getByTestId('folio-reader-chapter-body')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.setViewportSize({width:1024,height:768});
    await expect(page.getByTestId('folio-layout-desktop').filter({visible:true}).first()).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  }finally{
    await first.close();
    await second.close();
  }
});


test('Chrome verified account login, onboarding, sessions and CSRF-protected logout',async({browser})=>{
  test.setTimeout(110_000);
  const origin=required('FOLIO_LIVE_SHELF_ORIGIN');
  const email=required('FOLIO_LIVE_WEB_LOGIN_EMAIL');
  const password=required('FOLIO_LIVE_WEB_LOGIN_PASSWORD');
  const context=await browser.newContext({
    ignoreHTTPSErrors:true,viewport:{width:390,height:844},
  });
  try{
    const page=await context.newPage();
    await page.goto(origin+'/profile');
    await expect(page.getByTestId('folio-login-email')).toBeVisible();
    const denied=await page.evaluate(async()=>{
      const response=await fetch('/v1/me/shelf',{credentials:'same-origin'});
      return response.status;
    });
    expect(denied).toBe(401);

    await page.getByTestId('folio-login-email').fill(email);
    await page.getByTestId('folio-login-password').fill('Incorrect-Strong-Password-2026!');
    await page.getByTestId('folio-login-submit').click();
    await expect(page.getByTestId('folio-web-auth-error')).toContainText('doğrulanamadı');
    await expect(page.getByTestId('folio-web-session-verified')).toHaveCount(0);
    await page.getByTestId('folio-login-password').fill(password);
    await page.getByTestId('folio-login-submit').click();
    await expect(page.getByTestId('folio-web-session-verified')).toBeVisible();
    const cookie=(await context.cookies(origin)).find(c=>c.name==='__Host-folio_session');
    expect(cookie).toMatchObject({httpOnly:true,secure:true,sameSite:'Strict'});
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(page.getByTestId('folio-web-onboarding-panel')).toBeVisible();
    await page.getByTestId('folio-device-sessions-load').click();
    await expect(page.getByTestId('folio-devices-list')).toBeVisible();
    const before=await page.evaluate(async()=>{
      const response=await fetch('/v1/me/shelf',{credentials:'same-origin'});
      return response.status;
    });
    expect(before).toBe(200);
    // No role/MFA is gained from successful ordinary password authentication.
    const admin=await page.evaluate(async()=>{
      const response=await fetch('/v1/admin/catalog/works?q=Folio&limit=10',{credentials:'same-origin'});
      return response.status;
    });
    expect([401,403,404]).toContain(admin);

    await page.getByTestId('folio-logout-submit').click();
    await expect(page.getByTestId('folio-login-submit')).toBeVisible();
    const after=await page.evaluate(async()=>{
      const response=await fetch('/v1/me/shelf',{credentials:'same-origin'});
      return response.status;
    });
    expect(after).toBe(401);
    expect((await context.cookies(origin)).filter(c=>c.name==='__Host-folio_session'))
      .toHaveLength(0);
  }finally{await context.close();}
});
