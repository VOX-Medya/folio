import {useEffect,useState} from 'react';
import {Platform,Pressable,Text,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {fetchPublishedReaderText,PublishedReaderHttpError,fetchOwnWebReadingPosition,saveOwnWebReadingPosition,WebSessionHttpError} from '@folio/contracts';
import type {PublishedReaderText,ReadingPosition} from '@folio/contracts';
import type {FolioLocale} from './shell-data';
import {RsvpPlayer} from './rsvp-player';
import {PreparedAudioPlayer} from './prepared-audio-player';

declare const process:{env:{EXPO_PUBLIC_FOLIO_CATALOG_ORIGIN?:string}};
type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type Phase='loading'|'ready'|'unavailable'|'not-found'|'error';
type ReaderTheme='system'|'light'|'dark';
type ReaderMode='normal'|'rsvp'|'audio';
type Anchor=Pick<ReadingPosition,'chapterId'|'blockId'|'tokenOffset'|'audioPositionMs'|'mode'>;
type SavePhase='idle'|'saving'|'saved'|'sign-in'|'conflict'|'error';
function firstAnchor(chapter:PublishedReaderText['chapters'][number],mode:ReaderMode):Anchor{
  const block=(mode==='rsvp'?chapter.blocks.find(b=>b.includeRsvp):undefined)??chapter.blocks[0]!;
  return {chapterId:chapter.id,blockId:block.id,tokenOffset:0,
    audioPositionMs:mode==='audio'?0:null,mode};
}
function rsvpAnchor(chapter:PublishedReaderText['chapters'][number],index:number):Anchor{
  let remaining=index;
  for(const block of chapter.blocks){
    if(!block.includeRsvp)continue;
    const count=block.text.match(/\S+/gu)?.length??0;
    if(remaining<count)return {chapterId:chapter.id,blockId:block.id,
      tokenOffset:remaining,audioPositionMs:null,mode:'rsvp'};
    remaining-=count;
  }
  return firstAnchor(chapter,'rsvp');
}
function rsvpIndex(chapter:PublishedReaderText['chapters'][number],anchor:Anchor|null):number{
  if(!anchor||anchor.chapterId!==chapter.id||anchor.mode!=='rsvp')return 0;
  let index=0;
  for(const block of chapter.blocks){
    if(!block.includeRsvp)continue;
    if(block.id===anchor.blockId)return index+anchor.tokenOffset;
    index+=block.text.match(/\S+/gu)?.length??0;
  }
  return 0;
}
const copy={
  tr:{
    loading:'Yayımlanmış bölüm yükleniyor…',
    unavailable:'Güvenli HTTPS okuyucu bağlantısı henüz yapılandırılmadı.',
    missing:'Bu kitap yayımlanmamış, geri çekilmiş veya bölgenizde kullanılamıyor.',
    error:'Bölüm yüklenemedi. Bağlantını kontrol edip yeniden dene.',
    retry:'Yeniden yükle',previous:'Önceki bölüm',next:'Sonraki bölüm',
    fontDown:'Yazıyı küçült',fontUp:'Yazıyı büyüt',theme:'Okuma teması',
    system:'Sistem',light:'Açık',dark:'Koyu',chapter:'Bölüm',
    normal:'Normal okuma',rsvp:'RSVP akışı',audio:'Hazır ses',
    location:'Okuma konumunu güvenli hesabına kaydet.',save:'Konumu kaydet',saving:'Kaydediliyor…',saved:'Konum kaydedildi.',signIn:'Konumu kaydetmek için giriş yap.',conflict:'Konum başka oturumda değişti. Yeniden yükle.',saveError:'Konum kaydedilemedi.',current:'Kaydedilen konum',
  },
  en:{
    loading:'Loading the published chapter…',
    unavailable:'The secure HTTPS reader is not configured yet.',
    missing:'This book is unpublished, withdrawn or unavailable in your region.',
    error:'Chapter could not be loaded. Check the connection and retry.',
    retry:'Reload',previous:'Previous chapter',next:'Next chapter',
    fontDown:'Decrease font size',fontUp:'Increase font size',theme:'Reader theme',
    system:'System',light:'Light',dark:'Dark',chapter:'Chapter',
    normal:'Normal reading',rsvp:'RSVP stream',audio:'Prepared audio',
    location:'Save your reading position in your secure account.',save:'Save position',saving:'Saving…',saved:'Position saved.',signIn:'Sign in to save your position.',conflict:'Position changed in another session. Reload.',saveError:'Could not save position.',current:'Saved position',
  },
} as const;

function catalogOrigin():string|null{
  if(Platform.OS==='web'){
    return typeof window!=='undefined'&&window.location.protocol==='https:'
      ?window.location.origin:null;
  }
  // Native metadata/text transport uses only a public URL, never a bearer.
  return process.env.EXPO_PUBLIC_FOLIO_CATALOG_ORIGIN??null;
}

/** Render database text solely as React Native Text. Never WebView/HTML/raw DOM. */
export function PublishedReaderPanel({revisionId,locale,colors}:{
  revisionId:string;locale:FolioLocale;colors:Palette;
}){
  const origin=catalogOrigin();
  const t=copy[locale];
  const [phase,setPhase]=useState<Phase>('loading');
  const [book,setBook]=useState<PublishedReaderText|null>(null);
  const [chapterIndex,setChapterIndex]=useState(0);
  const [fontSize,setFontSize]=useState(18);
  const [theme,setTheme]=useState<ReaderTheme>('system');
  const [mode,setMode]=useState<ReaderMode>('normal');
  const [progress,setProgress]=useState<ReadingPosition|null>(null);
  const [anchor,setAnchor]=useState<Anchor|null>(null);
  const [savePhase,setSavePhase]=useState<SavePhase>('idle');
  const [retry,setRetry]=useState(0);
  const palette=theme==='system'?colors:theme==='dark'?paperbound.mobile.dark:paperbound.mobile.light;
  useEffect(()=>{
    const controller=new AbortController();
    setBook(null);
    setProgress(null);
    setAnchor(null);
    setSavePhase('idle');
    setChapterIndex(0);
    setMode('normal');
    if(!origin){setPhase('unavailable');return ()=>controller.abort();}
    setPhase('loading');
    void fetchPublishedReaderText(origin,revisionId,{signal:controller.signal})
      .then(async next=>{
        if(controller.signal.aborted)return;
        // Anonymous readers still work; private cursors never use public credentials.
        if(Platform.OS==='web'){
          try{
            const {progress:position}=await fetchOwnWebReadingPosition(origin,revisionId,{
              signal:controller.signal,
            });
            if(controller.signal.aborted)return;
            if(position){
              const index=next.chapters.findIndex(ch=>ch.id===position.chapterId&&
                ch.blocks.some(b=>b.id===position.blockId));
              if(index>=0){
                setProgress(position);
                setAnchor({chapterId:position.chapterId,blockId:position.blockId,
                  tokenOffset:position.tokenOffset,audioPositionMs:position.audioPositionMs,
                  mode:position.mode});
                setChapterIndex(index);
                setMode(position.mode);
              }
            }
          }catch(error){
            if(controller.signal.aborted)return;
            setSavePhase(error instanceof WebSessionHttpError&&
              (error.status===401||error.status===403)?'sign-in':'error');
          }
        }
        if(controller.signal.aborted)return;
        setBook(next);
        setPhase('ready');
      }).catch((cause:unknown)=>{
        if(controller.signal.aborted)return;
        setPhase(cause instanceof PublishedReaderHttpError&&cause.status===404
          ?'not-found':'error');
      });
    return ()=>controller.abort();
  },[origin,revisionId,retry]);
  const chapter=book?.chapters[chapterIndex];
  const available=phase==='ready'&&!!chapter;
  const chooseMode=(next:ReaderMode)=>{
    if(!chapter)return;
    setMode(next);
    setAnchor(firstAnchor(chapter,next));
    setSavePhase('idle');
  };
  const chooseChapter=(index:number)=>{
    const next=book?.chapters[index];
    if(!next)return;
    setChapterIndex(index);
    setAnchor(firstAnchor(next,mode));
    setSavePhase('idle');
  };
  const saveCurrent=async()=>{
    if(!origin||Platform.OS!=='web'||!chapter||savePhase==='saving')return;
    const pointer=anchor?.chapterId===chapter.id&&anchor.mode===mode
      ?anchor:firstAnchor(chapter,mode);
    setSavePhase('saving');
    try{
      const result=await saveOwnWebReadingPosition(origin,revisionId,{
        ...pointer,expectedVersion:progress?.version??0,
      });
      if(result.progress){
        setProgress(result.progress);
        setAnchor(pointer);
        setSavePhase('saved');
      }
    }catch(error){
      setSavePhase(error instanceof WebSessionHttpError&&error.status===409
        ?'conflict':error instanceof WebSessionHttpError&&
          (error.status===401||error.status===403)?'sign-in':'error');
    }
  };
  return <View testID="folio-published-reader-panel"
    style={{backgroundColor:palette.surface,borderRadius:12,padding:16,gap:16,
      borderColor:palette.line,borderWidth:1}}>
    {phase==='loading'&&<Text testID="folio-reader-loading"
      style={{color:palette.accessibleMuted,fontSize:14}}>{t.loading}</Text>}
    {phase==='unavailable'&&<Text testID="folio-reader-unavailable"
      style={{color:palette.accessibleMuted,fontSize:14}}>{t.unavailable}</Text>}
    {(phase==='not-found'||phase==='error')&&<View style={{gap:12}}>
      <Text testID="folio-reader-error" accessibilityRole="alert"
        style={{color:palette.ink,fontSize:15}}>
        {phase==='not-found'?t.missing:t.error}
      </Text>
      <Pressable testID="folio-reader-retry" accessibilityRole="button"
        accessibilityLabel={t.retry} onPress={()=>setRetry(n=>n+1)}
        style={{minHeight:48,alignSelf:'flex-start',borderColor:palette.line,
          borderWidth:1,borderRadius:9,paddingHorizontal:16,justifyContent:'center'}}>
        <Text style={{color:palette.ink,fontWeight:'600'}}>{t.retry}</Text>
      </Pressable>
    </View>}
    {available&&book&&chapter&&<>
      <Text testID="folio-reader-book-title" accessibilityRole="header"
        style={{color:palette.ink,fontSize:20,fontWeight:'700'}}>{book.title}</Text>
      <Text style={{color:palette.accessibleMuted,fontSize:13}}>
        {t.chapter+' '+String(chapterIndex+1)+' / '+String(book.chapters.length)}
      </Text>
      <View style={{gap:8,flexDirection:'row',flexWrap:'wrap',alignItems:'center'}}>
        <Pressable testID="folio-reader-font-decrease" accessibilityRole="button"
          accessibilityLabel={t.fontDown} disabled={fontSize<=14}
          onPress={()=>setFontSize(n=>Math.max(14,n-2))}
          style={{minHeight:48,minWidth:48,alignItems:'center',justifyContent:'center',
            borderWidth:1,borderColor:palette.line,borderRadius:8}}>
          <Text style={{color:palette.ink,fontSize:17}}>A−</Text>
        </Pressable>
        <Pressable testID="folio-reader-font-increase" accessibilityRole="button"
          accessibilityLabel={t.fontUp} disabled={fontSize>=26}
          onPress={()=>setFontSize(n=>Math.min(26,n+2))}
          style={{minHeight:48,minWidth:48,alignItems:'center',justifyContent:'center',
            borderWidth:1,borderColor:palette.line,borderRadius:8}}>
          <Text style={{color:palette.ink,fontSize:17}}>A+</Text>
        </Pressable>
        <Text testID={'folio-reader-current-theme-'+theme}
          style={{color:palette.accessibleMuted,fontSize:13}}>{t.theme}</Text>
        {(['system','light','dark'] as const).map(value=><Pressable
          key={value} testID={'folio-reader-theme-'+value} accessibilityRole="button"
          accessibilityState={{selected:theme===value}}
          accessibilityLabel={t[value]} onPress={()=>setTheme(value)}
          style={{minHeight:48,minWidth:55,alignItems:'center',justifyContent:'center',
            paddingHorizontal:9,borderWidth:1,borderRadius:8,borderColor:palette.line,
            backgroundColor:theme===value?palette.tint:palette.surface}}>
          <Text style={{color:palette.ink,fontSize:13}}>{t[value]}</Text>
        </Pressable>)}
      </View>
      <View style={{gap:8,flexDirection:'row',flexWrap:'wrap'}}>
        <Pressable testID="folio-reader-mode-normal" accessibilityRole="button"
          accessibilityLabel={t.normal} onPress={()=>chooseMode('normal')}
          style={{minHeight:48,paddingHorizontal:14,justifyContent:'center',
            borderRadius:9,borderColor:palette.line,borderWidth:1,
            backgroundColor:mode==='normal'?palette.tint:palette.surface}}>
          <Text style={{color:palette.ink,fontWeight:'600'}}>{t.normal}</Text>
        </Pressable>
        <Pressable testID="folio-reader-mode-rsvp" accessibilityRole="button"
          accessibilityLabel={t.rsvp} onPress={()=>chooseMode('rsvp')}
          style={{minHeight:48,paddingHorizontal:14,justifyContent:'center',
            borderRadius:9,borderColor:palette.line,borderWidth:1,
            backgroundColor:mode==='rsvp'?palette.tint:palette.surface}}>
          <Text style={{color:palette.ink,fontWeight:'600'}}>{t.rsvp}</Text>
        </Pressable>
        <Pressable testID="folio-reader-mode-audio" accessibilityRole="button"
          accessibilityLabel={t.audio} onPress={()=>chooseMode('audio')}
          style={{minHeight:48,paddingHorizontal:14,justifyContent:'center',
            borderRadius:9,borderColor:palette.line,borderWidth:1,
            backgroundColor:mode==='audio'?palette.tint:palette.surface}}>
          <Text style={{color:palette.ink,fontWeight:'600'}}>{t.audio}</Text>
        </Pressable>
      </View>
      <Text testID="folio-reader-chapter-title" accessibilityRole="header"
        style={{color:palette.ink,fontSize:22,fontWeight:'700',lineHeight:31}}>
        {chapter.heading}
      </Text>
      {mode==='normal'
        ? <View testID="folio-reader-chapter-body" style={{gap:14}}>
          {chapter.blocks.map(block=><Pressable key={block.id}
            accessibilityRole="button"
            accessibilityLabel={t.current}
            testID={'folio-reader-block-select-'+block.id}
            onPress={()=>{setAnchor({chapterId:chapter.id,blockId:block.id,
              tokenOffset:0,audioPositionMs:null,mode:'normal'});setSavePhase('idle');}}>
            <Text testID={'folio-reader-block-'+block.id}
              style={{fontSize,lineHeight:Math.round(fontSize*1.6),color:palette.ink}}>
              {block.text}
            </Text>
          </Pressable>)}
        </View>
        : mode==='rsvp'
          ? <RsvpPlayer key={chapter.id} blocks={chapter.blocks} locale={locale}
              colors={palette} initialWordIndex={rsvpIndex(chapter,anchor)}
              onCursorChange={index=>{
                setAnchor(rsvpAnchor(chapter,index));
                setSavePhase('idle');
              }}/>
          : <PreparedAudioPlayer key={chapter.id} origin={origin??''}
              revisionId={revisionId} chapterId={chapter.id} locale={locale} colors={palette}
              initialPositionMs={anchor?.mode==='audio'&&anchor.chapterId===chapter.id
                ?anchor.audioPositionMs??0:0}
              onPositionChange={ms=>{
                setAnchor({chapterId:chapter.id,blockId:chapter.blocks[0]!.id,
                  tokenOffset:0,audioPositionMs:ms,mode:'audio'});
                setSavePhase('idle');
              }}
              hasNext={chapterIndex<book.chapters.length-1}
              onNext={()=>chooseChapter(chapterIndex+1)}/>}

      <View style={{gap:10,flexDirection:'row',flexWrap:'wrap'}}>
        <Pressable testID="folio-reader-prev" accessibilityRole="button"
          accessibilityLabel={t.previous} disabled={chapterIndex===0}
          onPress={()=>chooseChapter(chapterIndex-1)}
          style={{minHeight:48,borderRadius:9,paddingHorizontal:14,
            borderWidth:1,borderColor:palette.line,justifyContent:'center'}}>
          <Text style={{color:palette.ink,fontWeight:'600'}}>{t.previous}</Text>
        </Pressable>
        <Pressable testID="folio-reader-next" accessibilityRole="button"
          accessibilityLabel={t.next} disabled={chapterIndex>=book.chapters.length-1}
          onPress={()=>chooseChapter(chapterIndex+1)}
          style={{minHeight:48,borderRadius:9,paddingHorizontal:14,
            backgroundColor:palette.accent,justifyContent:'center'}}>
          <Text style={{color:palette.accentOn,fontWeight:'700'}}>{t.next}</Text>
        </Pressable>
      </View>
      <View style={{gap:8}}>
        <Pressable testID="folio-reader-save-progress" accessibilityRole="button"
          accessibilityLabel={t.save} disabled={savePhase==='saving'||Platform.OS!=='web'}
          onPress={()=>{void saveCurrent();}}
          style={{minHeight:48,borderRadius:9,backgroundColor:palette.accent,
            alignSelf:'flex-start',paddingHorizontal:16,justifyContent:'center'}}>
          <Text style={{fontWeight:'700',color:palette.accentOn}}>
            {savePhase==='saving'?t.saving:t.save}
          </Text>
        </Pressable>
        <Text testID="folio-reader-progress-status"
          style={{fontSize:12,color:palette.accessibleMuted}}>
          {savePhase==='saved'?t.saved:savePhase==='saving'?t.saving:
            savePhase==='sign-in'?t.signIn:savePhase==='conflict'?t.conflict:
            savePhase==='error'?t.saveError:t.location}
        </Text>
        {savePhase==='conflict'&&<Pressable testID="folio-reader-progress-reload"
          onPress={()=>setRetry(n=>n+1)} accessibilityRole="button"
          accessibilityLabel={t.retry}>
          <Text style={{color:palette.ink}}>{t.retry}</Text>
        </Pressable>}
      </View>
    </>}
  </View>;
}
