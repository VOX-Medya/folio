import {describe,expect,it} from 'vitest';
import {mobileSections,readingRouteCopy,validReadingRouteId} from './shell-data';

describe('MVP book and reader route shell',()=>{
  it('accepts actual UUID-shaped deep links only',()=>{
    expect(validReadingRouteId('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(validReadingRouteId('123')).toBe(false);
    expect(validReadingRouteId('../private/text')).toBe(false);
    expect(validReadingRouteId(['11111111-1111-4111-8111-111111111111'])).toBe(false);
    expect(validReadingRouteId(undefined)).toBe(false);
  });
  it('provides TR and EN routing copy without exposing private data or future goals tab',()=>{
    for(const kind of ['book','reader'] as const){
      for(const language of ['tr','en'] as const){
        expect(readingRouteCopy[kind][language].heading).toBeTruthy();
        expect(readingRouteCopy[kind][language].invalid).toBeTruthy();
        expect(readingRouteCopy[kind][language].back).toBeTruthy();
      }
    }
    expect(mobileSections.map(s=>s.id)).toEqual(['home','library','catalog','profile']);
    expect(mobileSections.some(s=>s.href.includes('goals'))).toBe(false);
  });
});
