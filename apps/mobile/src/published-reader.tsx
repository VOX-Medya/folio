import {useEffect,useState} from 'react';
import {Platform,Pressable,Text,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {fetchPublishedReaderText,PublishedReaderHttpError} from '@folio/contracts';
import type {PublishedReaderText} from '@folio/contracts';
import type {FolioLocale} from './shell-data';

declare const process:{env:{EXPO_PUBLIC_FOLIO_CATALOG_ORIGIN?:string}};
type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type Phase='loading'|'ready'|'unavailable'|'not-found'|'error';
type ReaderTheme='system'|'light'|'dark';
const copy={
  tr:{
    loading:'Yayımlanmış bölüm yükleniyor…',
    unavailable:'Güvenli HTTPS okuyucu bağlantısı henüz yapılandırılmadı.',
    missing:'Bu kitap yayımlanmamış, geri çekilmiş veya bölgenizde kullanılamıyor.',
    error:'Bölüm yüklenemedi. Bağlantını kontrol edip yeniden dene.',
    retry:'Yeniden yükle',previous:'Önceki bölüm',next:'Sonraki bölüm',
    fontDown:'Yazıyı küçült',fontUp:'Yazıyı büyüt',theme:'Okuma teması',
    system:'Sistem',light:'Açık',dark:'Koyu',chapter:'Bölüm',
    location:'Son okuma konumu henüz sunucuya kaydedilmiyor.',
  },
  en:{
    loading:'Loading the published chapter…',
    unavailable:'The secure HTTPS reader is not configured yet.',
    missing:'This book is unpublished, withdrawn or unavailable in your region.',
    error:'Chapter could not be loaded. Check the connection and retry.',
    retry:'Reload',previous:'Previous chapter',next:'Next chapter',
    fontDown:'Decrease font size',fontUp:'Increase font size',theme:'Reader theme',
    system:'System',light:'Light',dark:'Dark',chapter:'Chapter',
    location:'Last reading position is not yet saved to the server.',
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
  const [retry,setRetry]=useState(0);
  const palette=theme==='system'?colors:theme==='dark'?paperbound.mobile.dark:paperbound.mobile.light;
  useEffect(()=>{
    const controller=new AbortController();
    setBook(null);
    setChapterIndex(0);
    if(!origin){setPhase('unavailable');return ()=>controller.abort();}
    setPhase('loading');
    void fetchPublishedReaderText(origin,revisionId,{signal:controller.signal})
      .then(next=>{
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
      <Text testID="folio-reader-chapter-title" accessibilityRole="header"
        style={{color:palette.ink,fontSize:22,fontWeight:'700',lineHeight:31}}>
        {chapter.heading}
      </Text>
      <View testID="folio-reader-chapter-body" style={{gap:14}}>
        {chapter.blocks.map(block=><Text key={block.id}
          testID={'folio-reader-block-'+block.id}
          style={{fontSize,lineHeight:Math.round(fontSize*1.6),color:palette.ink}}>
          {block.text}
        </Text>)}
      </View>
      <View style={{gap:10,flexDirection:'row',flexWrap:'wrap'}}>
        <Pressable testID="folio-reader-prev" accessibilityRole="button"
          accessibilityLabel={t.previous} disabled={chapterIndex===0}
          onPress={()=>setChapterIndex(n=>Math.max(0,n-1))}
          style={{minHeight:48,borderRadius:9,paddingHorizontal:14,
            borderWidth:1,borderColor:palette.line,justifyContent:'center'}}>
          <Text style={{color:palette.ink,fontWeight:'600'}}>{t.previous}</Text>
        </Pressable>
        <Pressable testID="folio-reader-next" accessibilityRole="button"
          accessibilityLabel={t.next} disabled={chapterIndex>=book.chapters.length-1}
          onPress={()=>setChapterIndex(n=>Math.min(book.chapters.length-1,n+1))}
          style={{minHeight:48,borderRadius:9,paddingHorizontal:14,
            backgroundColor:palette.accent,justifyContent:'center'}}>
          <Text style={{color:palette.accentOn,fontWeight:'700'}}>{t.next}</Text>
        </Pressable>
      </View>
      <Text style={{fontSize:12,color:palette.accessibleMuted}}>{t.location}</Text>
    </>}
  </View>;
}
