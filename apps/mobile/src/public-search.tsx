import {useState} from 'react';
import {Link} from 'expo-router';
import {Platform,Pressable,Text,TextInput,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {searchPublicCatalog,saveOwnWebShelf} from '@folio/contracts';
import type {PublishedCatalogSearchPage} from '@folio/contracts';
import type {FolioLocale} from './shell-data';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
declare const process:{env:{EXPO_PUBLIC_FOLIO_CATALOG_ORIGIN?:string}};
function origin(){
  return Platform.OS==='web'
    ?typeof window!=='undefined'&&window.location.protocol==='https:'?window.location.origin:null
    :process.env.EXPO_PUBLIC_FOLIO_CATALOG_ORIGIN??null;
}
const words={
  tr:{placeholder:'Kitap veya yazar adı',search:'Kitap ara',ready:'Aramayı başlatın.',
    empty:'Bu aramada yayımlanmış bir eser bulunamadı.',invalid:'En az bir harf yazın.',
    unavailable:'Kitap araması güvenli HTTPS ortamında etkinleşir.',
    error:'Katalog yüklenemedi.',view:'Eser ayrıntıları',add:'Rafıma ekle',
    reading:'Okuyorum',saved:'Raf kaydedildi.',signIn:'Raf için önce giriş yapın.'},
  en:{placeholder:'Book or author',search:'Search books',ready:'Enter a title or author.',
    empty:'No published books matched this search.',invalid:'Enter at least one character.',
    unavailable:'Book search requires a secure HTTPS service.',
    error:'Catalog could not be loaded.',view:'Book details',add:'Add to shelf',
    reading:'Reading',saved:'Saved to your shelf.',signIn:'Sign in before saving a book.'},
};
export function PublicCatalogSearchPanel({locale,colors}:{locale:FolioLocale;colors:Palette}){
  const [q,setQ]=useState('');
  const [phase,setPhase]=useState<'idle'|'loading'|'ready'|'empty'|'error'|'unavailable'>('idle');
  const [data,setData]=useState<PublishedCatalogSearchPage|null>(null);
  const [notice,setNotice]=useState('');
  const base=origin();
  const t=words[locale];
  async function search(){
    setData(null);setNotice('');
    if(!base){setPhase('unavailable');return;}
    if(q.trim().length<1||q.trim().length>120){setNotice(t.invalid);return;}
    setPhase('loading');
    try{
      const next=await searchPublicCatalog(base,{q:q.trim(),limit:20});
      setData(next);setPhase(next.items.length?'ready':'empty');
    }catch{setPhase('error');}
  }
  async function save(id:string,status:'to-read'|'reading'){
    if(!base){setNotice(t.unavailable);return;}
    try{await saveOwnWebShelf(base,id,{status});setNotice(t.saved);}
    catch{setNotice(t.signIn);}
  }
  return <View testID="folio-public-search" style={{gap:12,
    padding:16,borderWidth:1,borderColor:colors.line,borderRadius:14,backgroundColor:colors.surface}}>
    <TextInput testID="folio-public-search-input" accessibilityLabel={t.placeholder}
      placeholder={t.placeholder} value={q} onChangeText={setQ}
      autoCorrect={false} placeholderTextColor={colors.accessibleMuted}
      onSubmitEditing={()=>{void search();}}
      style={{minHeight:48,borderColor:colors.line,borderWidth:1,borderRadius:10,
        paddingHorizontal:12,fontSize:16,color:colors.ink,backgroundColor:colors.bg}}/>
    <Pressable testID="folio-public-search-submit" accessibilityRole="button"
      accessibilityLabel={t.search} disabled={phase==='loading'}
      onPress={()=>{void search();}}
      style={{minHeight:48,backgroundColor:colors.accent,borderRadius:10,
        justifyContent:'center',alignItems:'center'}}>
      <Text style={{color:colors.accentOn,fontWeight:'700'}}>{t.search}</Text>
    </Pressable>
    {(notice||phase==='unavailable'||phase==='empty'||phase==='error'||phase==='loading')&&
      <Text testID="folio-public-search-status" accessibilityRole="text"
        style={{color:colors.accessibleMuted,lineHeight:22,fontSize:14}}>
        {notice||(
          phase==='unavailable'?t.unavailable:
            phase==='empty'?t.empty:phase==='error'?t.error:
              phase==='loading'?'…':t.ready)}
      </Text>}
    {phase==='ready'&&data?.items.map(item=><View key={item.id}
      style={{padding:12,gap:8,borderColor:colors.line,borderWidth:1,borderRadius:10}}>
      <Text style={{color:colors.ink,fontWeight:'700',fontSize:17}}>{item.title}</Text>
      <Text style={{fontSize:14,color:colors.accessibleMuted}}>{item.authors.join(', ')}</Text>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
        <Link href={{pathname:'/books/[workId]',params:{workId:item.id}}} asChild>
          <Pressable testID={'folio-public-book-'+item.id} accessibilityRole="link"
            style={{minHeight:48,paddingHorizontal:12,borderRadius:8,borderWidth:1,
              borderColor:colors.line,justifyContent:'center'}}>
            <Text style={{color:colors.ink}}>{t.view}</Text>
          </Pressable>
        </Link>
        <Pressable accessibilityRole="button" testID={'folio-shelf-add-'+item.id}
          onPress={()=>{void save(item.id,'to-read');}}
          style={{minHeight:48,paddingHorizontal:12,borderRadius:8,borderWidth:1,
            borderColor:colors.line,justifyContent:'center'}}>
          <Text style={{color:colors.ink}}>{t.add}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" testID={'folio-shelf-reading-'+item.id}
          onPress={()=>{void save(item.id,'reading');}}
          style={{minHeight:48,paddingHorizontal:12,borderRadius:8,borderWidth:1,
            borderColor:colors.line,justifyContent:'center'}}>
          <Text style={{color:colors.ink}}>{t.reading}</Text>
        </Pressable>
      </View>
    </View>)}
  </View>;
}
