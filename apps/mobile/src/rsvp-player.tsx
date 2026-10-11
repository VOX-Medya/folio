import {useEffect,useMemo,useRef,useState} from 'react';
import {Platform,Pressable,Text,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import type {PublishedReaderText} from '@folio/contracts';
import type {FolioLocale} from './shell-data';
import {
  RSVP_MAX_WPM,RSVP_MIN_WPM,RSVP_WPM_STEP,
  tokenizeRsvpWords,rsvpGroup,rsvpNextStart,rsvpPreviousStart,rsvpTickMilliseconds,
} from './rsvp';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type Blocks=PublishedReaderText['chapters'][number]['blocks'];
const copy={
  tr:{
    empty:'Bu bölümde RSVP için uygun kelime bulunamadı.',
    play:'Başlat',pause:'Duraklat',slow:'Yavaşlat',fast:'Hızlandır',
    previous:'Önceki grup',next:'Sonraki grup',wordGroup:'Kelime grubu',
    keyboard:'Boşluk: başlat/duraklat, sol/sağ ok: geri/ileri',
  },
  en:{
    empty:'No approved RSVP words are available in this chapter.',
    play:'Play',pause:'Pause',slow:'Slower',fast:'Faster',
    previous:'Previous group',next:'Next group',wordGroup:'Word group',
    keyboard:'Space: play/pause, left/right arrows: step back/forward',
  },
} as const;

/** #36: report RSVP word movement without pushing per-tick network requests. */
export function RsvpPlayer({blocks,locale,colors,initialWordIndex=0,onCursorChange}:{
  blocks:Blocks;locale:FolioLocale;colors:Palette;
  initialWordIndex?:number;onCursorChange?:(wordIndex:number)=>void;
}){
  const t=copy[locale];
  const words=useMemo(()=>tokenizeRsvpWords(blocks),[blocks]);
  const [wpm,setWpm]=useState(250);
  const [groupSize,setGroupSize]=useState(1);
  const [cursor,setCursor]=useState(initialWordIndex);
  const [playing,setPlaying]=useState(false);
  // Parent renders while the cursor changes; only movement, not callback identity,
  // should report a new position (otherwise the two components update forever).
  const report=useRef(onCursorChange);
  useEffect(()=>{report.current=onCursorChange;},[onCursorChange]);
  useEffect(()=>{report.current?.(cursor);},[cursor]);
  const lastStart=words.length?Math.floor((words.length-1)/groupSize)*groupSize:0;
  useEffect(()=>{
    if(!playing||!words.length)return;
    const timer=setTimeout(()=>{
      const next=rsvpNextStart(words.length,cursor,groupSize);
      setCursor(next);
      if(next===cursor||next>=lastStart)setPlaying(false);
    },rsvpTickMilliseconds(wpm,groupSize));
    return ()=>clearTimeout(timer);
  },[playing,cursor,groupSize,wpm,words.length,lastStart]);
  useEffect(()=>{
    if(Platform.OS!=='web'||typeof window==='undefined')return;
    const onKey=(event:KeyboardEvent)=>{
      if(event.altKey||event.ctrlKey||event.metaKey||event.repeat)return;
      const target=event.target;
      if(target instanceof HTMLElement&&(target.isContentEditable||
        ['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(target.tagName)))return;
      if(event.code==='Space'||event.key===' '){
        if(!words.length)return;
        event.preventDefault();
        if(!playing&&cursor>=lastStart)setCursor(0);
        setPlaying(value=>!value);
      }else if(event.key==='ArrowRight'){
        event.preventDefault();
        setPlaying(false);
        setCursor(current=>rsvpNextStart(words.length,current,groupSize));
      }else if(event.key==='ArrowLeft'){
        event.preventDefault();
        setPlaying(false);
        setCursor(current=>rsvpPreviousStart(current,groupSize));
      }
    };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[words.length,groupSize,playing,cursor,lastStart]);
  const step=(direction:'forward'|'back')=>{
    setPlaying(false);
    setCursor(current=>direction==='forward'
      ?rsvpNextStart(words.length,current,groupSize)
      :rsvpPreviousStart(current,groupSize));
  };
  const changeGroup=()=>{
    const next=groupSize===3?1:groupSize+1;
    setPlaying(false);
    setCursor(current=>Math.floor(current/next)*next);
    setGroupSize(next);
  };
  const toggle=()=>{
    if(!words.length)return;
    if(!playing&&cursor>=lastStart)setCursor(0);
    setPlaying(value=>!value);
  };
  return <View testID="folio-rsvp-player" style={{gap:14}}>
    {!words.length&&<Text testID="folio-rsvp-empty" style={{color:colors.accessibleMuted}}>
      {t.empty}
    </Text>}
    {!!words.length&&<>
      <View testID="folio-rsvp-display" style={{borderWidth:1,borderColor:colors.line,
        minHeight:136,paddingHorizontal:14,borderRadius:10,
        justifyContent:'center',alignItems:'center'}}>
        <Text testID="folio-rsvp-current-words"
          style={{color:colors.ink,fontWeight:'700',fontSize:30,textAlign:'center',
            lineHeight:44}}>
          {rsvpGroup(words,cursor,groupSize)}
        </Text>
      </View>
      <Text testID="folio-rsvp-position" style={{color:colors.accessibleMuted,fontSize:13}}>
        {String(Math.min(words.length,cursor+groupSize))+' / '+String(words.length)}
      </Text>
      <View style={{gap:8,flexDirection:'row',flexWrap:'wrap',alignItems:'center'}}>
        <Pressable testID="folio-rsvp-wpm-down" accessibilityRole="button"
          accessibilityLabel={t.slow} disabled={wpm<=RSVP_MIN_WPM}
          onPress={()=>setWpm(n=>Math.max(RSVP_MIN_WPM,n-RSVP_WPM_STEP))}
          style={{minHeight:48,minWidth:48,alignItems:'center',justifyContent:'center',
            borderWidth:1,borderColor:colors.line,borderRadius:9}}>
          <Text style={{color:colors.ink,fontWeight:'700'}}>−</Text>
        </Pressable>
        <Text testID="folio-rsvp-wpm" style={{fontWeight:'700',fontSize:16,color:colors.ink}}>
          {String(wpm)+' WPM'}
        </Text>
        <Pressable testID="folio-rsvp-wpm-up" accessibilityRole="button"
          accessibilityLabel={t.fast} disabled={wpm>=RSVP_MAX_WPM}
          onPress={()=>setWpm(n=>Math.min(RSVP_MAX_WPM,n+RSVP_WPM_STEP))}
          style={{minHeight:48,minWidth:48,alignItems:'center',justifyContent:'center',
            borderWidth:1,borderColor:colors.line,borderRadius:9}}>
          <Text style={{color:colors.ink,fontWeight:'700'}}>+</Text>
        </Pressable>
        <Pressable testID="folio-rsvp-word-group" accessibilityRole="button"
          accessibilityLabel={t.wordGroup} onPress={changeGroup}
          style={{minHeight:48,paddingHorizontal:12,justifyContent:'center',
            borderWidth:1,borderColor:colors.line,borderRadius:9}}>
          <Text style={{color:colors.ink,fontWeight:'600'}}>
            {t.wordGroup+': '+String(groupSize)}
          </Text>
        </Pressable>
      </View>
      <View style={{gap:8,flexDirection:'row',flexWrap:'wrap'}}>
        <Pressable testID="folio-rsvp-previous" accessibilityRole="button"
          accessibilityLabel={t.previous} disabled={cursor===0}
          onPress={()=>step('back')}
          style={{minHeight:48,paddingHorizontal:14,justifyContent:'center',
            borderWidth:1,borderColor:colors.line,borderRadius:9}}>
          <Text style={{color:colors.ink,fontWeight:'600'}}>{t.previous}</Text>
        </Pressable>
        <Pressable testID="folio-rsvp-play-pause" accessibilityRole="button"
          accessibilityLabel={playing?t.pause:t.play} onPress={toggle}
          style={{minHeight:48,paddingHorizontal:18,justifyContent:'center',
            backgroundColor:colors.accent,borderRadius:9}}>
          <Text style={{color:colors.accentOn,fontWeight:'700'}}>
            {playing?t.pause:t.play}
          </Text>
        </Pressable>
        <Pressable testID="folio-rsvp-next" accessibilityRole="button"
          accessibilityLabel={t.next} disabled={cursor>=lastStart}
          onPress={()=>step('forward')}
          style={{minHeight:48,paddingHorizontal:14,justifyContent:'center',
            borderWidth:1,borderColor:colors.line,borderRadius:9}}>
          <Text style={{color:colors.ink,fontWeight:'600'}}>{t.next}</Text>
        </Pressable>
      </View>
      {Platform.OS==='web'&&<Text style={{color:colors.accessibleMuted,fontSize:12}}>
        {t.keyboard}
      </Text>}
    </>}
  </View>;
}
