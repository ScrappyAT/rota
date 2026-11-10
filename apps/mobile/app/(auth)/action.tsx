import { postAuthDestination } from '../../src/services/invitationLinks';
import { authStorage } from '../../src/storage/authStorage';
import { useState } from 'react';
import { Alert,Text } from 'react-native';
import { useLocalSearchParams,router } from 'expo-router';
import { AuthResponse } from '@rota/shared';
import { Screen } from '../../src/components/ui/Screen';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
import { apiClient } from '../../src/api/client';
import { useAuth } from '../../src/context/AuthContext';
export default function AuthAction(){
  const {token,purpose}=useLocalSearchParams<{token?:string;purpose?:string}>();
  const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(false);
  const {login,logout}=useAuth();
  const valid=typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&(purpose==='RESET'||purpose==='MAGIC');
  const consume=async()=>{
    if(!valid||busy||done)return;
    setBusy(true);
    const response=await apiClient.request<AuthResponse>(purpose==='RESET'?'/auth/password-reset/confirm':'/auth/magic-link/consume',{
      method:'POST',body:JSON.stringify(purpose==='RESET'?{token,password}:{token})});
    setBusy(false);
    if(!response.success)return Alert.alert('Link unavailable',response.error?.message||'Request a new link.');
    setDone(true);
    if(purpose==='MAGIC'&&response.data){await login(response.data);router.replace(await postAuthDestination(authStorage));}
    else {await logout();Alert.alert('Password changed','Sign in with your new password.');router.replace('/(auth)/login');}
  };
  return <Screen><Text>{!valid?'Invalid account link':done?'Completed':purpose==='RESET'?'Choose a new password':'Confirm sign-in to Rota'}</Text>
    {purpose==='RESET'&&<Input label="New password" value={password} onChangeText={setPassword} secureTextEntry editable={!busy&&!done} />}
    <Button title={purpose==='RESET'?'Reset password':'Sign in'} loading={busy} disabled={!valid||busy||done} onPress={consume} />
  </Screen>;
}
