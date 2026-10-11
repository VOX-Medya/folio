import {describe,expect,it} from 'vitest';
import {
  RSVP_MAX_WPM,RSVP_MIN_WPM,tokenizeRsvpWords,rsvpGroup,
  rsvpNextStart,rsvpPreviousStart,rsvpTickMilliseconds,
} from './rsvp';

describe('MVP deterministic TR/EN RSVP word grouping',()=>{
  it('keeps source words and punctuation, skips excluded footnotes and respects TR/EN',()=>{
    const tokens=tokenizeRsvpWords([
      {text:'İstanbul’da   güneş vardı.\nŞimdi',includeRsvp:true},
      {text:'DİPNOT Gizli değil ama RSVP dışı',includeRsvp:false},
      {text:'English: words, too!',includeRsvp:true},
    ]);
    expect(tokens).toEqual([
      'İstanbul’da','güneş','vardı.','Şimdi','English:','words,','too!',
    ]);
    expect(rsvpGroup(tokens,0,3)).toBe('İstanbul’da güneş vardı.');
    expect(rsvpGroup(tokens,6,3)).toBe('too!');
  });
  it('stops at final word without dropping or looping and keeps pause cursor',()=>{
    const words=['one','two','three','four','five'];
    expect(rsvpNextStart(words.length,0,2)).toBe(2);
    expect(rsvpNextStart(words.length,2,2)).toBe(4);
    expect(rsvpNextStart(words.length,4,2)).toBe(4);
    expect(rsvpPreviousStart(4,2)).toBe(2);
    expect(rsvpPreviousStart(0,1)).toBe(0);
    expect(tokenizeRsvpWords([{text:'   ',includeRsvp:true}])).toEqual([]);
  });
  it('maintains WPM bounds and true word-rate group timing',()=>{
    expect(rsvpTickMilliseconds(300,1)).toBe(200);
    expect(rsvpTickMilliseconds(300,3)).toBe(600);
    expect(rsvpTickMilliseconds(RSVP_MIN_WPM,1)).toBe(600);
    expect(rsvpTickMilliseconds(RSVP_MAX_WPM,1)).toBe(86);
    expect(()=>rsvpTickMilliseconds(0,1)).toThrow();
    expect(()=>rsvpTickMilliseconds(750,1)).toThrow();
    expect(()=>rsvpTickMilliseconds(200,4)).toThrow();
  });
});
