import {useEffect,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {
  fetchOwnFriends,rotateOwnFriendInvite,sendOwnFriendRequest,
  acceptOwnFriend,blockOwnFriend,WebSessionHttpError,
} from '@folio/contracts';
import type {FriendList} from '@folio/contracts';
import type {FolioLocale} from './shell-data';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type Item=FriendList['items'][number];
export function FriendPanel({origin,locale,colors,onSessionExpired}:{
  origin:string;locale:FolioLocale;colors:Palette;onSessionExpired:()=>void;
}){
  const [items,setItems]=useState<Item[]>([]);
  const [code,setCode]=useState('');
  const [entered,setEntered]=useState('');
  const [busy,setBusy]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const [message,setMessage]=useState('');
  const tr=locale==='tr';
  function handle(error:unknown){
    if(error instanceof WebSessionHttpError&&error.status===401){onSessionExpired();return;}
    setMessage(tr?'İşlem yapılamadı. Kodu ve oturumunu kontrol et.':
      'Action denied. Check the invite and your session.');
  }
  async function refresh(){
    const next=await fetchOwnFriends(origin);
    setItems(next.items);setLoaded(true);
  }
  useEffect(()=>{
    const controller=new AbortController();
    setLoaded(false);
    void fetchOwnFriends(origin,{signal:controller.signal}).then(next=>{
      if(controller.signal.aborted)return;
      setItems(next.items);setLoaded(true);
    }).catch(error=>{
      if(controller.signal.aborted)return;
      handle(error);setLoaded(true);
    });
    return ()=>controller.abort();
  },[origin]);
  async function run(action:()=>Promise<unknown>,success:string){
    if(busy)return;
    setBusy(true);setMessage('');
    try{await action();await refresh();setMessage(success);}
    catch(error){handle(error);}
    finally{setBusy(false);}
  }
  const button=(title:string,id:string,onPress:()=>void,disabled=false)=>
    <Pressable testID={id} accessibilityRole="button" accessibilityLabel={title}
      disabled={disabled||busy} onPress={onPress}
      style={{minHeight:44,borderRadius:8,borderWidth:1,borderColor:colors.line,
        paddingHorizontal:12,justifyContent:'center',alignSelf:'flex-start'}}>
      <Text style={{color:colors.ink,fontWeight:'600'}}>{title}</Text>
    </Pressable>;
  return <View testID="folio-friends-panel" style={{borderRadius:12,padding:16,
    borderWidth:1,borderColor:colors.line,backgroundColor:colors.surface2,gap:12}}>
    <Text accessibilityRole="header" style={{color:colors.ink,fontSize:17,fontWeight:'700'}}>
      {tr?'Davet kodlu arkadaşlık':'Invite-only friends'}
    </Text>
    <Text style={{color:colors.accessibleMuted,fontSize:13}}>
      {tr?'Kullanıcı araması yok. Yalnız paylaşılan davet koduyla istek gönderilir.':
        'No people search. Requests require a shared invite code.'}
    </Text>
    {button(tr?'Yeni davet kodu oluştur':'Generate invite code','folio-friends-rotate',
      ()=>{void run(async()=>{const result=await rotateOwnFriendInvite(origin);setCode(result.code);},
        tr?'Yeni kod hazır. Önceki kod geçersiz.':'New code ready. Old code revoked.');})}
    {!!code&&<Text testID="folio-friends-code" selectable style={{color:colors.ink,
      fontSize:15,fontWeight:'700'}}>{code}</Text>}
    <TextInput testID="folio-friends-enter-code" accessibilityLabel={tr?'Arkadaş davet kodu':'Friend invite code'}
      value={entered} onChangeText={setEntered} autoCapitalize="none" autoCorrect={false}
      maxLength={32} placeholder={tr?'32 karakterli davet kodu':'32-character invite code'}
      placeholderTextColor={colors.accessibleMuted}
      style={{minHeight:48,paddingHorizontal:12,borderRadius:9,borderWidth:1,
        borderColor:colors.line,color:colors.ink}}/>
    {button(tr?'İstek gönder':'Send request','folio-friends-request',
      ()=>{void run(async()=>{
        await sendOwnFriendRequest(origin,{code:entered});setEntered('');
      },tr?'Arkadaşlık isteği gönderildi.':'Friend request sent.');},entered.trim().length!==32)}
    <View style={{flexDirection:'row',alignItems:'center',gap:10,flexWrap:'wrap'}}>
      <Text style={{color:colors.ink,fontWeight:'700'}}>{tr?'İstekler ve arkadaşlar':'Requests and friends'}</Text>
      {button(tr?'Yenile':'Refresh','folio-friends-refresh',()=>{
        void run(async()=>{},tr?'Liste yenilendi.':'List refreshed.');
      })}
    </View>
    {!loaded&&<Text style={{color:colors.accessibleMuted}}>
      {tr?'Yükleniyor…':'Loading…'}
    </Text>}
    {loaded&&items.length===0&&<Text testID="folio-friends-empty"
      style={{color:colors.accessibleMuted}}>
      {tr?'Henüz arkadaşlık isteği yok.':'No friend requests yet.'}
    </Text>}
    {items.map(item=><View key={item.peerId} testID={'folio-friends-row-'+item.peerId}
      style={{padding:10,borderWidth:1,borderColor:colors.line,borderRadius:9,gap:8}}>
      <Text style={{color:colors.ink,fontSize:13}}>
        {item.state==='incoming'?(tr?'Gelen istek':'Incoming request'):
          item.state==='outgoing'?(tr?'Gönderilen istek':'Sent request'):
          item.state==='accepted'?(tr?'Karşılıklı arkadaş':'Mutual friend'):
          (tr?'Engellendi':'Blocked')}
        {' · '+item.peerId.slice(0,8)}
      </Text>
      <View style={{flexDirection:'row',gap:8,flexWrap:'wrap'}}>
        {item.state==='incoming'&&button(tr?'Kabul et':'Accept',
          'folio-friends-accept-'+item.peerId,()=>{void run(
            ()=>acceptOwnFriend(origin,item.peerId),tr?'Arkadaşlık kabul edildi.':'Friend accepted.');})}
        {item.state!=='blocked'&&button(tr?'Engelle':'Block',
          'folio-friends-block-'+item.peerId,()=>{void run(
            ()=>blockOwnFriend(origin,item.peerId),tr?'İlişki engellendi.':'Relationship blocked.');})}
      </View>
    </View>)}
    {!!message&&<Text testID="folio-friends-message" accessibilityRole="alert"
      style={{color:colors.ink,fontSize:13}}>{message}</Text>}
  </View>;
}
