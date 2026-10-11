import {expect,test} from '@playwright/test';
function required(key:string):string{
  const value=process.env[key];if(!value)throw Error('Missing synthetic Folio fixture '+key);return value;
}
test('verified owner private profile, CAS conflict, other-user isolation and deletion request',async({browser})=>{
  test.setTimeout(110_000);
  const origin=required('FOLIO_LIVE_SHELF_ORIGIN');
  const owner=required('FOLIO_LIVE_SHELF_OWNER_TOKEN'),other=required('FOLIO_LIVE_SHELF_OTHER_TOKEN');
  const cookie=(value:string)=>[{name:'__Host-folio_session',value,url:origin,
    httpOnly:true,secure:true,sameSite:'Strict' as const}];
  const first=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
  const second=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
  try{
    await first.addCookies(cookie(owner));await second.addCookies(cookie(other));
    const page=await first.newPage(),different=await second.newPage();
    await page.goto(origin+'/profile');
    await different.goto(origin+'/profile');
    await expect(page.getByTestId('folio-profile-display-name')).toBeVisible();
    await expect(page.getByTestId('folio-profile-visibility')).toContainText('private');
    await expect(different.getByTestId('folio-profile-display-name')).toBeVisible();
    const identifier='Synthetic Reader Private '+Date.now();
    await page.getByTestId('folio-profile-display-name').fill(identifier);
    await page.getByTestId('folio-profile-save').click();
    await expect(page.getByTestId('folio-profile-display-name')).toHaveValue(identifier);
    // The controlled input changes before the HTTPS PATCH commits. Wait for
    // server-confirmed persistence, not the already-updated input value.
    await expect.poll(async()=>page.evaluate(async()=>{
      const response=await fetch('/v1/me/profile',{credentials:'same-origin'});
      if(!response.ok)return '';
      const data=await response.json();
      return data.displayName as string;
    }),{timeout:10000}).toBe(identifier);
    const own=await page.evaluate(async()=>{
      const response=await fetch('/v1/me/profile',{credentials:'same-origin'});
      return {status:response.status,data:await response.json()};
    });
    expect(own.status).toBe(200);
    expect(own.data).toMatchObject({displayName:identifier,visibility:'private'});
    expect(own.data.version).toBeGreaterThan(0);
    const unrelated=await different.evaluate(async()=>{
      const response=await fetch('/v1/me/profile',{credentials:'same-origin'});
      return {status:response.status,data:await response.json()};
    });
    expect(unrelated.status).toBe(200);
    expect(unrelated.data.userId).not.toBe(own.data.userId);
    expect(unrelated.data.displayName).not.toBe(identifier);
    const forged=await different.evaluate(async userId=>{
      const response=await fetch('/v1/me/profile?userId='+encodeURIComponent(userId),
        {credentials:'same-origin'});
      return response.status;
    },own.data.userId as string);
    expect(forged).toBe(400);
    const stale=await page.evaluate(async(userId)=>{
      const proof=await fetch('/v1/auth/web/csrf',{credentials:'same-origin'});
      const csrf=proof.headers.get('x-folio-csrf')!;
      const response=await fetch('/v1/me/profile',{
        method:'PATCH',credentials:'same-origin',headers:{
          'content-type':'application/json','x-folio-csrf':csrf,
        },body:JSON.stringify({expectedVersion:0,displayName:'Clobber',
          locale:'tr',visibility:'private'}),
      });
      const invalid=await fetch('/v1/me/profile',{
        method:'PATCH',credentials:'same-origin',headers:{
          'content-type':'application/json','x-folio-csrf':csrf,
        },body:JSON.stringify({expectedVersion:0,displayName:'Clobber',
          locale:'tr',visibility:'private',userId}),
      });
      return {stale:response.status,invalid:invalid.status};
    },own.data.userId as string);
    expect(stale).toEqual({stale:409,invalid:400});
    await page.getByTestId('folio-profile-delete').click();
    const deletionResponse=page.waitForResponse(response=>
      response.url().endsWith('/v1/me/profile/deletion-request')&&
      response.request().method()==='POST');
    await page.getByTestId('folio-profile-delete-confirm').click();
    expect((await deletionResponse).status()).toBe(200);
    await expect(page.getByTestId('folio-profile-deletion-requested')).toBeVisible();
    const recorded=await page.evaluate(async()=>{
      const response=await fetch('/v1/me/profile',{credentials:'same-origin'});
      return {status:response.status,data:await response.json()};
    });
    expect(recorded.status).toBe(200);
    expect(recorded.data.deletionRequestedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const afterOther=await different.evaluate(async()=>{
      const response=await fetch('/v1/me/profile',{credentials:'same-origin'});
      return await response.json();
    });
    expect(afterOther.deletionRequestedAt).toBeNull();
    // A request does NOT delete the account, its sessions, or any user data.
    await expect(page.getByTestId('folio-web-session-verified')).toBeVisible();
  }finally{await first.close();await second.close();}
});
