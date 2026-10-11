import {useEffect,useRef,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import type {FolioLocale} from './shell-data';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type Props={origin:string;revisionId:string;chapterId:string;locale:FolioLocale;
  colors:Palette;hasNext:boolean;onNext:()=>void};
const copy={
  tr:{unavailable:'Bu bölüm için onaylı ses bulunamadı veya erişim izni kaldırıldı.',
    play:'Oynat',pause:'Duraklat',back:'10 saniye geri',forward:'10 saniye ileri',
    speed:'Hız',next:'Sonraki bölüm',retry:'Tekrar dene'},
  en:{unavailable:'No approved audio is available for this chapter, or access was withdrawn.',
    play:'Play',pause:'Pause',back:'Back 10 seconds',forward:'Forward 10 seconds',
    speed:'Speed',next:'Next chapter',retry:'Retry'},
} as const;

function readableTime(value:number):string{
  if(!Number.isFinite(value))return '0:00';
  const seconds=Math.max(0,Math.floor(value));
  return String(Math.floor(seconds/60))+':'+String(seconds%60).padStart(2,'0');
}

/** #35 Browser audio: direct, same-origin HTTPS; no bearer, key or signed URL. */
export function PreparedAudioPlayer({origin,revisionId,chapterId,locale,colors,hasNext,onNext}:Props){
  const media=useRef<HTMLAudioElement>(null);
  const [playing,setPlaying]=useState(false);
  const [position,setPosition]=useState(0);
  const [duration,setDuration]=useState(0);
  const [rate,setRate]=useState(1);
  const [missing,setMissing]=useState(false);
  const [retry,setRetry]=useState(0);
  const t=copy[locale];
  useEffect(()=>()=>{media.current?.pause();},[]);
  const src=origin+'/v1/catalog/audio/'+encodeURIComponent(revisionId)+'/'+
    encodeURIComponent(chapterId)+(retry?'?': ''); // no retry hints accepted by the API
  const safeSrc=retry?src.slice(0,-1):src;
  const toggle=()=>{
    const audio=media.current;
    if(!audio)return;
    if(playing){audio.pause();return;}
    if(audio.duration&&audio.currentTime>=audio.duration)audio.currentTime=0;
    void audio.play().catch(()=>{setPlaying(false);setMissing(true);});
  };
  const seek=(offset:number)=>{
    const audio=media.current;
    if(!audio||!Number.isFinite(audio.duration))return;
    audio.currentTime=Math.max(0,Math.min(audio.duration,audio.currentTime+offset));
    setPosition(audio.currentTime);
  };
  const changeRate=()=>{
    const next=rate===1?1.25:rate===1.25?1.5:rate===1.5?0.75:1;
    if(media.current)media.current.playbackRate=next;
    setRate(next);
  };
  return <View testID="folio-audio-player" style={{gap:12}}>
    <audio ref={media} src={safeSrc} preload="metadata"
      data-testid="folio-audio-element"
      onLoadedMetadata={event=>{
        setMissing(false);
        setDuration(event.currentTarget.duration);
      }}
      onTimeUpdate={event=>setPosition(event.currentTarget.currentTime)}
      onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}
      onEnded={()=>{setPlaying(false);if(hasNext)onNext();}}
      onError={()=>{setMissing(true);setPlaying(false);}}/>
    {missing&&<Text accessibilityRole="alert" testID="folio-audio-error"
      style={{color:colors.ink}}>{t.unavailable}</Text>}
    <Text testID="folio-audio-time" style={{color:colors.accessibleMuted,fontSize:13}}>
      {readableTime(position)+' / '+readableTime(duration)}
    </Text>
    <View style={{gap:8,flexDirection:'row',flexWrap:'wrap'}}>
      <Pressable testID="folio-audio-back" accessibilityRole="button"
        accessibilityLabel={t.back} onPress={()=>seek(-10)}
        style={{padding:13,borderWidth:1,borderColor:colors.line,borderRadius:8}}>
        <Text style={{color:colors.ink}}>{t.back}</Text>
      </Pressable>
      <Pressable testID="folio-audio-play" accessibilityRole="button"
        accessibilityLabel={playing?t.pause:t.play} onPress={toggle}
        style={{padding:13,backgroundColor:colors.accent,borderRadius:8}}>
        <Text style={{color:colors.accentOn,fontWeight:'700'}}>{playing?t.pause:t.play}</Text>
      </Pressable>
      <Pressable testID="folio-audio-forward" accessibilityRole="button"
        accessibilityLabel={t.forward} onPress={()=>seek(10)}
        style={{padding:13,borderWidth:1,borderColor:colors.line,borderRadius:8}}>
        <Text style={{color:colors.ink}}>{t.forward}</Text>
      </Pressable>
      <Pressable testID="folio-audio-speed" accessibilityRole="button"
        accessibilityLabel={t.speed} onPress={changeRate}
        style={{padding:13,borderWidth:1,borderColor:colors.line,borderRadius:8}}>
        <Text style={{color:colors.ink}}>{t.speed+': '+String(rate)+'×'}</Text>
      </Pressable>
      {hasNext&&<Pressable testID="folio-audio-next-chapter" accessibilityRole="button"
        accessibilityLabel={t.next} onPress={onNext}
        style={{padding:13,borderWidth:1,borderColor:colors.line,borderRadius:8}}>
        <Text style={{color:colors.ink}}>{t.next}</Text>
      </Pressable>}
    </View>
    {missing&&<Pressable accessibilityRole="button" testID="folio-audio-retry"
      onPress={()=>{setMissing(false);setRetry(n=>n+1);media.current?.load();}}>
      <Text style={{color:colors.ink}}>{t.retry}</Text>
    </Pressable>}
  </View>;
}
