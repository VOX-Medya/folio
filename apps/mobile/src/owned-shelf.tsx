import {useEffect,useState} from 'react';
import {Link} from 'expo-router';
import {Platform,Pressable,Text,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {fetchOwnWebShelf,removeOwnWebShelf,WebSessionHttpError} from '@folio/contracts';
import type {ShelfList} from '@folio/contracts';
import type {FolioLocale} from './shell-data';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
const words={
  tr:{unavailable:'Kişisel raf için güvenli HTTPS oturumu gerekli.',
    signIn:'Rafını görmek için Profil sayfasından giriş yap.',
    loading:'Rafın sunucudan yükleniyor…',empty:'Rafında yayımlanmış kitap yok.',
    error:'Raf alınamadı.',retry:'Yeniden yükle',resume:'Okuma ekranına geç',
    remove:'Raftan kaldır',toRead:'Okunacak',reading:'Okunuyor'},
  en:{unavailable:'Your shelf requires a secure HTTPS session.',
    signIn:'Sign in from Profile to see your shelf.',
    loading:'Loading your shelf from the server…',empty:'No published books on your shelf.',
    error:'Shelf could not be loaded.',retry:'Reload',resume:'Open reading screen',
    remove:'Remove from shelf',toRead:'To read',reading:'Reading'},
};
export function OwnedShelfPanel({locale,colors}:{locale:FolioLocale;colors:Palette}){
  const t=words[locale];
  const origin=Platform.OS==='web'&&typeof window!=='undefined'&&
    window.location.protocol==='https:'?window.location.origin:null;
  const [phase,setPhase]=useState<'loading'|'ready'|'empty'|'signed-out'|'unavailable'|'error'>('loading');
  const [data,setData]=useState<ShelfList|null>(null);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    setData(null);
    if(!origin){setPhase('unavailable');return ()=>controller.abort();}
    setPhase('loading');
    void fetchOwnWebShelf(origin,{signal:controller.signal}).then(next=>{
      if(controller.signal.aborted)return;
      setData(next);setPhase(next.items.length?'ready':'empty');
    }).catch((cause:unknown)=>{
      if(controller.signal.aborted)return;
      setPhase(cause instanceof WebSessionHttpError&&cause.status===401?'signed-out':'error');
    });
    return ()=>controller.abort();
  },[origin,revision]);
  async function remove(workId:string){
    if(!origin)return;
    try{await removeOwnWebShelf(origin,workId);setRevision(x=>x+1);}
    catch{setPhase('error');}
  }
  return <View testID="folio-owned-shelf" style={{gap:12,padding:16,
    backgroundColor:colors.surface,borderWidth:1,borderColor:colors.line,borderRadius:14}}>
    <Text testID="folio-shelf-state" style={{fontSize:14,lineHeight:22,
      color:colors.accessibleMuted}}>
      {phase==='loading'?t.loading:phase==='unavailable'?t.unavailable:
        phase==='signed-out'?t.signIn:phase==='empty'?t.empty:
          phase==='error'?t.error:''}
    </Text>
    {(phase==='error'||phase==='empty')&&<Pressable testID="folio-shelf-reload"
      accessibilityRole="button" onPress={()=>setRevision(x=>x+1)}
      style={{minHeight:48,alignSelf:'flex-start',borderRadius:9,
        borderColor:colors.line,borderWidth:1,paddingHorizontal:16,justifyContent:'center'}}>
      <Text style={{color:colors.ink,fontWeight:'600'}}>{t.retry}</Text>
    </Pressable>}
    {phase==='ready'&&data?.items.map(item=><View key={item.id}
      style={{gap:10,borderRadius:10,borderWidth:1,borderColor:colors.line,padding:12}}>
      <Text style={{fontSize:17,fontWeight:'700',color:colors.ink}}>{item.title}</Text>
      <Text style={{color:colors.accessibleMuted}}>
        {(item.status==='reading'?t.reading:t.toRead)+' · '+item.authors.join(', ')}
      </Text>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
        <Link href={{pathname:'/reader/[revisionId]',params:{revisionId:item.revisionId}}} asChild>
          <Pressable testID={'folio-shelf-continue-'+item.id} accessibilityRole="link"
            style={{minHeight:48,justifyContent:'center',backgroundColor:colors.accent,
              borderRadius:8,paddingHorizontal:12}}>
            <Text style={{color:colors.accentOn,fontWeight:'700'}}>{t.resume}</Text>
          </Pressable>
        </Link>
        <Pressable testID={'folio-shelf-remove-'+item.id}
          accessibilityRole="button" onPress={()=>{void remove(item.id);}}
          style={{minHeight:48,justifyContent:'center',borderWidth:1,
            borderColor:colors.line,borderRadius:8,paddingHorizontal:12}}>
          <Text style={{color:colors.ink}}>{t.remove}</Text>
        </Pressable>
      </View>
    </View>)}
  </View>;
}
