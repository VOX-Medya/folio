import {describe,expect,it} from 'vitest';
import {mobileSections,screenCopy} from './shell-data';

describe('Folio V1 mobile navigation policy',()=>{
  it('includes only V1 book, library, reader and personal sections',()=>{
    expect(mobileSections.map(section=>section.id)).toEqual(['home','library','catalog','goals','profile']);
    expect(mobileSections.map(section=>section.href)).toEqual(['/','/library','/catalog','/goals','/profile']);
    expect(new Set(mobileSections.map(section=>section.href)).size).toBe(mobileSections.length);
    expect(mobileSections.some(section=>/user-search|people|friend-suggestion|ai|generate/i.test(section.href))).toBe(false);
  });
  it('preserves actual inactive state and bilingual UI without imaginary totals',()=>{
    for(const section of mobileSections){
      expect(screenCopy[section.id].tr.heading).toBeTruthy();
      expect(screenCopy[section.id].en.heading).toBeTruthy();
      expect(screenCopy[section.id].tr.message).toBeTruthy();
      expect(screenCopy[section.id].en.message).toBeTruthy();
      expect(screenCopy[section.id].tr.detail).not.toMatch(/1000 eser|1000 kitap/);
    }
    expect(screenCopy.home.tr.message).toBe('Okuyucu henüz geliştirme aşamasında.');
    expect(screenCopy.catalog.tr.detail).toContain('Kullanıcı araması bulunmaz');
  });
});
