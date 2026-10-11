import {useLocalSearchParams} from 'expo-router';
import {MobileShell} from '../../src/mobile-shell';

/** Route identity is untrusted; the real catalog API will authorize loading in #32. */
export default function BookDetails(){
  const {workId}=useLocalSearchParams<{workId:string}>();
  return <MobileShell section="catalog" route={{kind:'book',id:workId}}/>;
}
