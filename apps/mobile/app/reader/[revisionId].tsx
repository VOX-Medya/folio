import {useLocalSearchParams} from 'expo-router';
import {MobileShell} from '../../src/mobile-shell';

/** No private text is rendered until the reader's rights/session API is ready (#33). */
export default function Reader(){
  const {revisionId}=useLocalSearchParams<{revisionId:string}>();
  return <MobileShell section="catalog" route={{kind:'reader',id:revisionId}}/>;
}
