import {useEffect,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {
  fetchOwnWebProfile,updateOwnWebProfile,requestOwnWebDeletion,WebSessionHttpError,
} from '@folio/contracts';
import type {OwnProfile} from '@folio/contracts';
import type {FolioLocale} from './shell-data';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type State='loading'|'ready'|'saving'|'error'|'requested';
export function OwnProfilePanel({origin,locale,colors,onLocaleSaved,onSessionExpired}:{
  origin:string;locale:FolioLocale;colors:Palette;
  onLocaleSaved:(next:FolioLocale)=>void;onSessionExpired:()=>void;
}){
  const [snapshot,setSnapshot]=useState<OwnProfile|null>(null);
  const [name,setName]=useState('');
  const [language,setLanguage]=useState<FolioLocale>('tr');
  const [visibility,setVisibility]=useState<'private'|'friends'>('private');
  const [state,setState]=useState<State>('loading');
  const [error,setError]=useState('');
  const [deletionConfirmation,setDeletionConfirmation]=useState(false);
  function accept(value:OwnProfile){
    setSnapshot(value);setName(value.displayName);setLanguage(value.locale);
    setVisibility(value.visibility);setDeletionConfirmation(false);
  }
  useEffect(()=>{
    const controller=new AbortController();
    setState('loading');
    void fetchOwnWebProfile(origin,{signal:controller.signal}).then(next=>{
      if(controller.signal.aborted)return;
      accept(next);setState('ready');
    }).catch(cause=>{
      if(controller.signal.aborted)return;
      if(cause instanceof WebSessionHttpError&&cause.status===401){
        onSessionExpired();return;
      }
      setError(locale==='tr'?'Profil okunamadı.':'Profile unavailable.');
      setState('error');
    });
    return ()=>controller.abort();
  },[origin]);
  async function reload(){
    setState('loading');setError('');
    try{const next=await fetchOwnWebProfile(origin);accept(next);setState('ready');}
    catch{setError(locale==='tr'?'Profil okunamadı.':'Profile unavailable.');setState('error');}
  }
  async function save(){
    if(!snapshot||state!=='ready')return;
    setError('');setState('saving');
    try{
      const updated=await updateOwnWebProfile(origin,{
        expectedVersion:snapshot.version,displayName:name,
        locale:language,visibility,
      });
      accept(updated);setState('ready');onLocaleSaved(updated.locale);
    }catch(cause){
      if(cause instanceof WebSessionHttpError&&cause.status===401){
        onSessionExpired();return;
      }
      setError(cause instanceof WebSessionHttpError&&cause.status===409
        ?locale==='tr'?'Profil başka oturumda değişti. Sunucudan yenile.':'Profile changed elsewhere. Reload.'
        :locale==='tr'?'Profil kaydedilemedi.':'Profile could not be saved.');
      setState('error');
    }
  }
  async function deletion(){
    if(!deletionConfirmation||!snapshot||state!=='ready')return;
    setState('saving');
    try{await requestOwnWebDeletion(origin,{confirm:true});
      setDeletionConfirmation(false);setState('requested');
    }catch{
      setDeletionConfirmation(false);
      setError(locale==='tr'?'Silme talebi gönderilemedi.':'Deletion request failed.');
      setState('error');
    }
  }
  const action=(label:string,onPress:()=>void,id:string,disabled=false)=>
    <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label}
      disabled={disabled} onPress={onPress}
      style={{paddingHorizontal:14,minHeight:44,borderWidth:1,borderColor:colors.line,
        borderRadius:8,alignItems:'center',justifyContent:'center'}}>
      <Text style={{color:colors.ink,fontWeight:'600'}}>{label}</Text>
    </Pressable>;
  return <View testID="folio-private-profile" style={{borderWidth:1,borderColor:colors.line,
    backgroundColor:colors.surface2,borderRadius:12,padding:16,gap:12}}>
    <Text accessibilityRole="header" style={{fontSize:17,fontWeight:'700',color:colors.ink}}>
      {locale==='tr'?'Gizli profilim':'My private profile'}
    </Text>
    {state==='loading'&&<Text testID="folio-profile-loading"
      style={{color:colors.accessibleMuted}}>{locale==='tr'?'Yükleniyor…':'Loading…'}</Text>}
    {snapshot&&state!=='loading'&&<View style={{gap:10}}>
      <Text testID="folio-profile-visibility" style={{color:colors.accessibleMuted}}>
        {locale==='tr'?'Görünürlük: ':'Visibility: '}{snapshot.visibility}
      </Text>
      <TextInput testID="folio-profile-display-name" accessibilityLabel={locale==='tr'?'Görünen ad':'Display name'}
        value={name} maxLength={80} onChangeText={setName}
        placeholder={locale==='tr'?'Görünen ad':'Display name'}
        placeholderTextColor={colors.accessibleMuted}
        style={{borderWidth:1,borderColor:colors.line,borderRadius:8,
          padding:10,color:colors.ink,minHeight:48}}/>
      <View style={{flexDirection:'row',gap:8,flexWrap:'wrap'}}>
        {action('TR',()=>setLanguage('tr'),'folio-profile-tr',state!=='ready')}
        {action('EN',()=>setLanguage('en'),'folio-profile-en',state!=='ready')}
        {action(locale==='tr'?'Gizli':'Private',()=>setVisibility('private'),
          'folio-profile-private',state!=='ready')}
        {action(locale==='tr'?'Arkadaşlar (paylaşım henüz kapalı)':'Friends (sharing not active)',
          ()=>setVisibility('friends'),'folio-profile-friends',state!=='ready')}
      </View>
      {action(locale==='tr'?'Profili kaydet':'Save profile',()=>{void save();},
        'folio-profile-save',state!=='ready')}
      {!snapshot.deletionRequestedAt&&state!=='requested'&&
        (deletionConfirmation
          ?action(locale==='tr'?'Silme talebini onayla':'Confirm deletion request',
            ()=>{void deletion();},'folio-profile-delete-confirm',state!=='ready')
          :action(locale==='tr'?'Hesap silme talebi':'Request account deletion',
            ()=>setDeletionConfirmation(true),'folio-profile-delete',state!=='ready'))}
      {(!!snapshot.deletionRequestedAt||state==='requested')&&
        <Text testID="folio-profile-deletion-requested" style={{color:colors.accessibleMuted}}>
          {locale==='tr'?'Hesap silme talebin kaydedildi; hesap henüz silinmedi.'
            :'Deletion request recorded; your account has not been deleted.'}
        </Text>}
    </View>}
    {state==='error'&&<View style={{gap:8}}>
      <Text testID="folio-profile-error" accessibilityRole="alert" style={{color:colors.ink}}>{error}</Text>
      {action(locale==='tr'?'Sunucudan yenile':'Reload',()=>{void reload();},'folio-profile-reload')}
    </View>}
  </View>;
}
