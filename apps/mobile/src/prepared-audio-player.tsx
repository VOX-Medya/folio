import {Text,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import type {FolioLocale} from './shell-data';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
/** Native device/codec playback must be independently certified in #48.
 * No web-only DOM is rendered on Android or iOS. */
export function PreparedAudioPlayer({locale,colors}:{
  origin:string;revisionId:string;chapterId:string;locale:FolioLocale;
  colors:Palette;hasNext:boolean;onNext:()=>void;
}){
  return <View testID="folio-audio-native-unavailable">
    <Text style={{color:colors.accessibleMuted}}>
      {locale==='tr'
        ?'Hazır ses oynatma şu anda yalnız HTTPS web okuyucusunda kullanılabilir. Mobil cihaz desteği henüz doğrulanmadı.'
        :'Prepared audio currently plays in the HTTPS web reader. Native device support has not been verified yet.'}
    </Text>
  </View>;
}
