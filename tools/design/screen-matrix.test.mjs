import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';

const manifest=JSON.parse(readFileSync('packages/ui-tokens/src/screen-matrix.generated.json','utf8'));
const all=[...manifest.mobile,...manifest.admin];

test('design reference captures all 58/30 screens, 52/22 V1 and 6/8 future-only routes',()=>{
  assert.equal(manifest.mobile.length,58);
  assert.equal(manifest.admin.length,30);
  assert.equal(manifest.mobile.filter(s=>s.scope==='V1').length,52);
  assert.equal(manifest.admin.filter(s=>s.scope==='V1').length,22);
  assert.equal(manifest.mobile.filter(s=>s.scope==='AFTER-V1').length,6);
  assert.equal(manifest.admin.filter(s=>s.scope==='AFTER-V1').length,8);
  assert.equal(new Set(all.map(s=>`${s.platform}:${s.id}`)).size,88);
});

test('all 74 active V1 routes have an actionable design state policy and responsive layout',()=>{
  const v1=all.filter(screen=>screen.scope==='V1');
  assert.equal(v1.length,74);
  for(const screen of v1){
    assert.ok(screen.id && screen.title && screen.groupId && screen.action,`${screen.id} missing a design contract`);
    assert.ok(!screen.action.startsWith('Pasif'),`${screen.id} is accidentally disabled`);
    for(const required of ['loading','error','offline','permission']){
      assert.ok(screen.states.includes(required),`${screen.platform}:${screen.id} lacks ${required}`);
    }
    assert.ok(screen.states.includes('empty') || screen.states.includes('validation'),`${screen.id} lacks read or write states`);
    assert.match(screen.layout,/Phone:.*tablet:.*desktop:/i,`${screen.id} incomplete responsive layout`);
  }
});

test('every future-only route is disabled; prohibited user discovery is absent',()=>{
  for(const screen of all.filter(s=>s.scope==='AFTER-V1')){
    assert.deepEqual(screen.states,['disabled']);
    assert.match(screen.action,/Pasif: V1 navigasyonu ve API bağlantısı yok/);
  }
  for(const screen of all){
    assert.ok(!/^(people-search|user-search|user-discover|friend-recommendations)$/i.test(screen.id));
  }
  const actions=all.filter(s=>s.scope==='V1').map(s=>s.action).join(' ');
  assert.ok(!/kullanıcı ara|arkadaş önerisi al/i.test(actions),'V1 cannot have a people discovery feature');
});
