import {Stack} from 'expo-router';
import {MobileShellProvider} from '../src/mobile-shell';
export default function Layout(){return <MobileShellProvider><Stack screenOptions={{headerShown:false}}/></MobileShellProvider>;}
