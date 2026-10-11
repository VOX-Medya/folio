import {Redirect} from 'expo-router';

/** Goals and analytics are AFTER-MVP (#42), not an active user flow. */
export default function DeferredGoals(){return <Redirect href="/"/>;}
