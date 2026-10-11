import {expect,test} from '@playwright/test';
const need=(key:string)=>{const v=process.env[key];if(!v)throw Error('Missing Folio synthetic '+key);return v;};

/** One verified browser->Nest direct TLS->isolated PostgreSQL end-to-end friendship. */
test('two real accounts invite, accept, block; third-party and revoked code denied',async({browser})=>{
  test.setTimeout(110_000);
  const origin=need('FOLIO_LIVE_SHELF_ORIGIN');
  const tokens=[need('FOLIO_LIVE_SHELF_OWNER_TOKEN'),
    need('FOLIO_LIVE_SHELF_OTHER_TOKEN'),need('FOLIO_LIVE_FRIEND_THIRD_TOKEN')];
  const contexts=await Promise.all(tokens.map(async token=>{
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
    await context.addCookies([{name:'__Host-folio_session',value:token,url:origin,
      httpOnly:true,secure:true,sameSite:'Strict'}]);
    return context;
  }));
  try{
    const [first,second,third]=await Promise.all(contexts.map(async context=>{
      const page=await context.newPage();await page.goto(origin+'/profile');return page;
    }));
    await expect(first.getByTestId('folio-friends-rotate')).toBeVisible();
    await expect(second.getByTestId('folio-friends-code-input')).toBeVisible();
    await first.getByTestId('folio-friends-rotate').click();
    const oldCode=(await first.getByTestId('folio-friends-code').innerText()).trim();
    expect(oldCode).toMatch(/^[A-Z2-9]{16}$/);
    await first.getByTestId('folio-friends-rotate').click();
    await expect(first.getByTestId('folio-friends-code')).not.toHaveText(oldCode);
    const currentCode=(await first.getByTestId('folio-friends-code').innerText()).trim();
    expect(currentCode).toMatch(/^[A-Z2-9]{16}$/);
    // No code, account ID or email can be used to enumerate the social graph.
    const expired=await second.evaluate(async code=>{
      const proof=await fetch('/v1/auth/web/csrf',{credentials:'same-origin'});
      const csrf=proof.headers.get('x-folio-csrf')!;
      const response=await fetch('/v1/me/friends/request',{
        method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json','x-folio-csrf':csrf},
        body:JSON.stringify({code}),
      });return response.status;
    },oldCode);
    expect(expired).toBe(404);
    await second.getByTestId('folio-friends-code-input').fill(currentCode);
    await second.getByTestId('folio-friends-request').click();
    await expect(second.getByTestId('folio-friends-feedback'))
      .toContainText('Arkadaşlık isteği gönderildi.');
    await first.getByTestId('folio-friends-refresh').click();
    const incoming=first.locator('[data-testid^="folio-friend-accept-"]');
    await expect(incoming).toBeVisible();
    const requestId=(await incoming.getAttribute('data-testid'))!.split('folio-friend-accept-')[1]!;
    const thirdParty=await third.evaluate(async id=>{
      const proof=await fetch('/v1/auth/web/csrf',{credentials:'same-origin'});
      const csrf=proof.headers.get('x-folio-csrf')!;
      const response=await fetch('/v1/me/friends/decision',{
        method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json','x-folio-csrf':csrf},
        body:JSON.stringify({requestId:id,action:'accept'}),
      });return response.status;
    },requestId);
    expect(thirdParty).toBe(404);
    await first.getByTestId('folio-friend-accept-'+requestId).click();
    await expect(first.getByTestId('folio-friends-feedback'))
      .toContainText('Arkadaşlık kabul edildi.');
    await second.getByTestId('folio-friends-refresh').click();
    await expect(second.getByTestId('folio-friends-item-'+requestId))
      .toContainText('accepted');
    await second.getByTestId('folio-friend-block-'+requestId).click();
    await expect(second.getByTestId('folio-friends-feedback'))
      .toContainText('Kullanıcı engellendi.');
    await first.getByTestId('folio-friends-refresh').click();
    await expect(first.getByTestId('folio-friends-item-'+requestId)).toHaveCount(0);
    await second.getByTestId('folio-friends-code-input').fill(currentCode);
    await second.getByTestId('folio-friends-request').click();
    await expect(second.getByTestId('folio-friends-feedback')).toContainText('İstek zaten var veya engellendi.');
    const anonymous=await browser.newContext({ignoreHTTPSErrors:true});
    try{
      const response=await anonymous.request.get(origin+'/v1/me/friends');
      expect(response.status()).toBe(401);
    }finally{await anonymous.close();}
  }finally{await Promise.all(contexts.map(c=>c.close()));}
});
