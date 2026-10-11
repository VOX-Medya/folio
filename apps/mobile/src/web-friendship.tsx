import {useEffect,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {
  fetchOwnWebFriendships,rotateOwnWebFriendInvite,requestOwnWebFriendship,
  decideOwnWebFriendship,WebSessionHttpError,
} from '@folio/contracts';
import type {FriendshipList,FriendInviteIssued,FriendshipAction} from '@folio/contracts';
import type {FolioLocale} from './shell-data';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type Phase='loading'|'ready'|'busy'|'error';
export function WebFriendshipPanel({origin,locale,colors,onSessionExpired}:{
  origin:string;locale:FolioLocale;colors:Palette;onSessionExpired:()=>void;
}){
  const [phase,setPhase]=useState<Phase>('loading');
  const [items,setItems]=useState<FriendshipList['items']>([]);
  const [issued,setIssued]=useState<FriendInviteIssued|null>(null);
  const [entered,setEntered]=useState('');
  const [feedback,setFeedback]=useState('');
  const tr=locale==='tr';
  const message=(a:string,b:string)=>tr?a:b;
  useEffect(()=>{
    const controller=new AbortController();
    setPhase('loading');
    void fetchOwnWebFriendships(origin,{signal:controller.signal}).then(list=>{
      if(controller.signal.aborted)return;
      setItems(list.items);setPhase('ready');
    }).catch(error=>{
      if(controller.signal.aborted)return;
      if(error instanceof WebSessionHttpError&&error.status===401){onSessionExpired();return;}
      setFeedback(message('Arkadaşlıklar yüklenemedi.','Could not load invitations.'));
      setPhase('error');
    });
    return ()=>controller.abort();
  },[origin]);
  function failed(error:unknown){
    if(error instanceof WebSessionHttpError&&error.status===401){
      onSessionExpired();return;
    }
    setFeedback(error instanceof WebSessionHttpError&&error.status===409
      ?message('İstek zaten var veya engellendi.','Request already exists or is blocked.')
      :message('İşlem gerçekleştirilemedi.','Request could not be completed.'));
    setPhase('error');
  }
  async function reload(){
    setPhase('busy');
    try{setItems((await fetchOwnWebFriendships(origin)).items);
      setFeedback('');setPhase('ready');
    }catch(e){failed(e);}
  }
  async function rotate(){
    setPhase('busy');setFeedback('');
    try{setIssued(await rotateOwnWebFriendInvite(origin));setPhase('ready');}
    catch(e){failed(e);}
  }
  async function request(){
    setPhase('busy');setFeedback('');
    try{
      await requestOwnWebFriendship(origin,{code:entered.trim().toUpperCase()});
      setEntered('');
      setItems((await fetchOwnWebFriendships(origin)).items);
      setFeedback(message('Arkadaşlık isteği gönderildi.','Friend request sent.'));
      setPhase('ready');
    }catch(e){failed(e);}
  }
  async function decision(requestId:string,action:FriendshipAction['action']){
    setPhase('busy');setFeedback('');
    try{
      await decideOwnWebFriendship(origin,{requestId,action});
      setItems((await fetchOwnWebFriendships(origin)).items);
      setFeedback(action==='accept'
        ?message('Arkadaşlık kabul edildi.','Friendship accepted.')
        :action==='block'
          ?message('Kullanıcı engellendi.','User blocked.')
          :message('İstek reddedildi.','Request rejected.'));
      setPhase('ready');
    }catch(e){failed(e);}
  }
  const button=(id:string,label:string,handler:()=>void)=><Pressable key={id}
    testID={id} accessibilityRole="button" accessibilityLabel={label}
    disabled={phase==='busy'||phase==='loading'} onPress={handler}
    style={{minHeight:44,borderWidth:1,borderColor:colors.line,borderRadius:8,
      paddingHorizontal:12,alignItems:'center',justifyContent:'center'}}>
    <Text style={{color:colors.ink,fontWeight:'600'}}>{label}</Text>
  </Pressable>;
  return <View testID="folio-friends" style={{borderWidth:1,borderColor:colors.line,
    borderRadius:12,backgroundColor:colors.surface2,padding:16,gap:12}}>
    <Text accessibilityRole="header" style={{fontSize:17,fontWeight:'700',color:colors.ink}}>
      {message('Davet kodlu arkadaşlık','Invite-only friendship')}
    </Text>
    <Text style={{color:colors.accessibleMuted,fontSize:13}}>
      {message('Kullanıcı araması yoktur. Kodunu yalnız güvendiğin kişilerle paylaş.',
        'There is no user search. Share your code only with someone you trust.')}
    </Text>
    <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
      {button('folio-friends-rotate',message('Yeni davet kodu üret','Create invite code'),
        ()=>{void rotate();})}
      {button('folio-friends-refresh',message('Listeyi yenile','Refresh list'),
        ()=>{void reload();})}
    </View>
    {issued&&<Text testID="folio-friends-code" selectable style={{
      color:colors.ink,fontSize:18,fontWeight:'700'}}>
      {issued.code}
    </Text>}
    <TextInput testID="folio-friends-code-input"
      accessibilityLabel={message('Arkadaş davet kodu','Friend invite code')}
      placeholder={message('16 karakterli davet kodu','16-character invite code')}
      placeholderTextColor={colors.accessibleMuted}
      autoCapitalize="characters" autoCorrect={false} maxLength={16}
      value={entered} onChangeText={setEntered}
      style={{minHeight:48,borderRadius:8,borderWidth:1,borderColor:colors.line,
        color:colors.ink,paddingHorizontal:12}}/>
    {button('folio-friends-request',message('Arkadaşlık isteği gönder','Send friend request'),
      ()=>{void request();})}
    {phase==='loading'&&<Text testID="folio-friends-loading" style={{
      color:colors.accessibleMuted}}>{message('Yükleniyor…','Loading…')}</Text>}
    {!!feedback&&<Text testID="folio-friends-feedback" accessibilityRole="alert"
      style={{color:colors.ink}}>{feedback}</Text>}
    <View testID="folio-friends-list" style={{gap:10}}>
      {items.map(item=><View key={item.requestId}
        testID={'folio-friends-item-'+item.requestId}
        style={{borderWidth:1,borderColor:colors.line,borderRadius:8,padding:10,gap:6}}>
        <Text style={{color:colors.ink}}>
          {item.displayName??message('Gizli kullanıcı','Private member')}
          {' · '}{item.direction==='incoming'
            ?message('Gelen','Incoming'):message('Giden','Outgoing')}
          {' · '}{item.state}
        </Text>
        <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
          {item.direction==='incoming'&&item.state==='pending'&&<>
            {button('folio-friend-accept-'+item.requestId,message('Kabul et','Accept'),
              ()=>{void decision(item.requestId,'accept');})}
            {button('folio-friend-reject-'+item.requestId,message('Reddet','Reject'),
              ()=>{void decision(item.requestId,'reject');})}
          </>}
          {item.state!=='blocked'&&button('folio-friend-block-'+item.requestId,
            message('Engelle','Block'),()=>{void decision(item.requestId,'block');})}
        </View>
      </View>)}
    </View>
  </View>;
}
