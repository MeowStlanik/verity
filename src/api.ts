import type { Market, Portfolio, Quote, Side } from './types';
// In development, keep requests on the UI origin. Vite proxies /v1 and /health
// to the local API, which also works through a forwarded Codespaces URL.
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
let token = sessionStorage.getItem('verity_token');
async function request<T>(path:string, init:RequestInit={}):Promise<T>{
  const response=await fetch(`${BASE}${path}`,{...init,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{}) ,...init.headers}});
  const data=await response.json(); if(!response.ok) throw new Error(data.error?.message||`Request failed (${response.status})`); return data;
}
export const api={
  markets:()=>request<{items:Market[]}>('/v1/markets'), market:(id:string)=>request<Market>(`/v1/markets/${encodeURIComponent(id)}`),
  portfolio:(address:string)=>request<Portfolio>(`/v1/portfolio/${address}`),
  quote:(id:string,side:Side,amount:number,action:'buy'|'sell')=>request<Quote>(`/v1/markets/${encodeURIComponent(id)}/quote?side=${side}&amount=${amount}&action=${action}`),
  trade:(payload:unknown)=>request('/v1/trades',{method:'POST',body:JSON.stringify(payload)}), claim:(marketId:string)=>request('/v1/claims',{method:'POST',body:JSON.stringify({marketId})}),
  challenge:(payload:unknown)=>request('/v1/challenges',{method:'POST',body:JSON.stringify(payload)}),
  liquidity:(payload:unknown)=>request('/v1/liquidity',{method:'POST',body:JSON.stringify(payload)}),
  claimLp:(marketId:string)=>request('/v1/liquidity/claims',{method:'POST',body:JSON.stringify({marketId})}), create:(payload:unknown)=>request<{market:Market}>('/v1/markets',{method:'POST',body:JSON.stringify(payload)}),
  bindResolver:(marketId:string,contractAddress:string)=>request<Market>(`/v1/markets/${encodeURIComponent(marketId)}/resolver`,{method:'POST',body:JSON.stringify({contractAddress})}),
  bindMarketContract:(marketId:string,contractAddress:string,transactionHash:string)=>request<Market>(`/v1/markets/${encodeURIComponent(marketId)}/contract`,{method:'POST',body:JSON.stringify({contractAddress,transactionHash})}),
  publishResolution:(marketId:string,payload:{contractAddress:string;transactionHash:string})=>request<Market>(`/v1/markets/${encodeURIComponent(marketId)}/resolution`,{method:'POST',body:JSON.stringify(payload)}),
  async connect(){ const eth=(window as Window & {ethereum?:{request:(v:{method:string;params?:unknown[]})=>Promise<unknown>}}).ethereum; if(!eth) throw new Error('Install an EIP-1193 wallet such as MetaMask'); const accounts=await eth.request({method:'eth_requestAccounts'}) as string[]; const address=accounts[0]; const {nonce}=await request<{nonce:string}>('/v1/auth/nonce',{method:'POST',body:JSON.stringify({address})}); const signature=await eth.request({method:'personal_sign',params:[nonce,address]}); const session=await request<{token:string,address:string}>('/v1/auth/verify',{method:'POST',body:JSON.stringify({address,signature})}); token=session.token; sessionStorage.setItem('verity_token',token); sessionStorage.setItem('verity_address',session.address); return session.address; },
  disconnect(){token=null;sessionStorage.removeItem('verity_token');sessionStorage.removeItem('verity_address')}, address:()=>sessionStorage.getItem('verity_address')
};
