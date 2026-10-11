import {useEffect,useState} from 'react';
import {Link} from 'expo-router';
import {Platform,Pressable,Text,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {fetchPublishedBookDetail,PublishedBookHttpError} from '@folio/contracts';
import type {PublishedBookDetail} from '@folio/contracts';
import type {FolioLocale} from './shell-data';

/** Expo inlines this PUBLIC URL at bundle time; it is never a secret. */
declare const process:{env:{EXPO_PUBLIC_FOLIO_CATALOG_ORIGIN?:string}};
type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type Phase='loading'|'ready'|'unavailable'|'not-found'|'error';
const copy={
  tr:{
    loading:'Yayımlanmış eser bilgileri yükleniyor…',
    unavailable:'Güvenli katalog bağlantısı henüz yapılandırılmadı.',
    notFound:'Bu eser yayımlanmamış, geri çekilmiş veya bulunduğun bölgede kullanılamıyor.',
    error:'Katalog bilgileri alınamadı. Bağlantını kontrol edip tekrar dene.',
    author:'Yazar',edition:'Baskı',language:'Dil',
    audio:'Hazır ses',audioYes:'Onaylı ses kaydı mevcut. HTTPS web okuyucusundan Hazır ses modunu aç.',
    audioNo:'Bu baskı için yayımlanmış bir ses kaydı yok.',
    read:'Okuma ekranına geç',retry:'Yeniden dene',notReady:'Android/iOS ses oynatma henüz doğrulanmadı.',
  },
  en:{
    loading:'Loading published book information…',
    unavailable:'A secure catalog connection is not configured yet.',
    notFound:'This book is unpublished, withdrawn or unavailable in your region.',
    error:'Book details could not be loaded. Check your connection and retry.',
    author:'Author',edition:'Edition',language:'Language',
    audio:'Prepared audio',audioYes:'Approved audio is available. Open Prepared audio mode in the HTTPS web reader.',
    audioNo:'No published audio recording is available for this edition.',
    read:'Open reading screen',retry:'Retry',notReady:'Android/iOS playback has not yet been verified.',
  },
};

function configuredOrigin():string|null{
  if(Platform.OS==='web'){
    return typeof window!=='undefined'&&window.location.protocol==='https:'
      ?window.location.origin:null;
  }
  // Public catalog metadata only. Never place a credential in this Expo setting.
  return process.env.EXPO_PUBLIC_FOLIO_CATALOG_ORIGIN??null;
}

export function PublishedBookPanel({workId,locale,colors}:{
  workId:string;locale:FolioLocale;colors:Palette;
}){
  const origin=configuredOrigin();
  const [phase,setPhase]=useState<Phase>('loading');
  const [result,setResult]=useState<PublishedBookDetail|null>(null);
  const [epoch,setEpoch]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    setResult(null);
    if(!origin){setPhase('unavailable');return ()=>controller.abort();}
    setPhase('loading');
    void fetchPublishedBookDetail(origin,workId,{signal:controller.signal})
      .then(detail=>{if(controller.signal.aborted)return;setResult(detail);setPhase('ready');})
      .catch(error=>{
        if(controller.signal.aborted)return;
        setPhase(error instanceof PublishedBookHttpError&&error.status===404?'not-found':'error');
      });
    return ()=>controller.abort();
  },[origin,workId,epoch]);
  const t=copy[locale];
  return <View testID="folio-published-book-panel" style={{gap:14}}>
    {phase==='loading'&&<Text testID="folio-book-loading"
      style={{fontSize:15,color:colors.accessibleMuted}}>{t.loading}</Text>}
    {phase==='unavailable'&&<Text testID="folio-book-unavailable"
      style={{fontSize:15,color:colors.accessibleMuted}}>{t.unavailable}</Text>}
    {(phase==='not-found'||phase==='error')&&<View style={{gap:12}}>
      <Text testID="folio-book-not-found" accessibilityRole="alert"
        style={{fontSize:15,lineHeight:23,color:colors.ink}}>
        {phase==='not-found'?t.notFound:t.error}
      </Text>
      <Pressable testID="folio-book-retry" accessibilityRole="button"
        onPress={()=>setEpoch(value=>value+1)}
        style={{minHeight:48,alignSelf:'flex-start',borderWidth:1,borderColor:colors.line,
          borderRadius:9,paddingHorizontal:16,justifyContent:'center'}}>
        <Text style={{fontWeight:'600',color:colors.ink}}>{t.retry}</Text>
      </Pressable>
    </View>}
    {phase==='ready'&&result&&<View testID="folio-book-data" style={{gap:16}}>
      <Text accessibilityRole="header" testID="folio-book-title"
        style={{fontSize:24,fontWeight:'700',color:colors.ink}}>{result.title}</Text>
      <Text testID="folio-book-authors" style={{fontSize:15,color:colors.ink}}>
        {t.author+': '+result.authors.map(author=>author.name).join(', ')}
      </Text>
      {result.editions.map(edition=><View key={edition.id}
        style={{gap:12,borderWidth:1,borderColor:colors.line,borderRadius:12,padding:16}}>
        <Text style={{fontSize:17,fontWeight:'700',color:colors.ink}}>
          {t.edition+': '+edition.label}
        </Text>
        <Text style={{fontSize:14,color:colors.accessibleMuted}}>
          {t.language+': '+edition.language.toUpperCase()}
        </Text>
        <Text testID={'folio-book-audio-'+edition.id}
          style={{fontSize:14,lineHeight:22,color:colors.accessibleMuted}}>
          {t.audio+': '+(edition.audioAvailable?t.audioYes:t.audioNo)}
        </Text>
        <Link href={{pathname:'/reader/[revisionId]',params:{revisionId:edition.revisionId}}} asChild>
          <Pressable testID={'folio-book-read-'+edition.id} accessibilityRole="link"
            accessibilityLabel={t.read}
            style={{minHeight:48,alignSelf:'flex-start',borderRadius:10,
              paddingHorizontal:18,backgroundColor:colors.accent,justifyContent:'center'}}>
            <Text style={{fontSize:15,fontWeight:'700',color:colors.accentOn}}>{t.read}</Text>
          </Pressable>
        </Link>
        {edition.audioAvailable&&<Text style={{fontSize:13,color:colors.accessibleMuted}}>
          {t.notReady}
        </Text>}
      </View>)}
    </View>}
  </View>;
}
