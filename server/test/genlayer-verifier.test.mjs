import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGenLayerResolution, verifyMarketContract } from '../genlayer-verifier.mjs';

const resolver = '0x2222222222222222222222222222222222222222';
const txHash = `0x${'ab'.repeat(32)}`;
const binding = { marketId: 'market-1', resolutionSpecHash: `0x${'11'.repeat(32)}`, sourcesHash: `0x${'22'.repeat(32)}`, observationTime: '2026-08-04T12:00:00.000Z' };
const config = { contract: 'JudgmentResolver', question: 'Question?', sources: ['https://a','https://b','https://c'], interpretationRule: 'Explicit only' };
const market = { title:'Question?', resolverContractAddress: resolver, resolverNetwork: 'testnetBradbury', resolverBinding: binding, resolutionSpec:{resolver:{contract:'JudgmentResolver',args:{sources:config.sources,interpretationRule:'Explicit only'}}} };
function client(overrides={}) { return { getTransaction: async()=>({statusName:'FINALIZED',txExecutionResultName:'FINISHED_WITH_RETURN',recipient:resolver,txDataDecoded:{type:'call',callData:{method:'resolve'}}}), readContract:async({functionName})=>functionName==='market_binding'?(overrides.binding||binding):functionName==='resolver_config'?(overrides.config||config):(overrides.resolution||{outcome:'YES',resolvedAt:'2026-08-04T12:01:00.000Z',sourceDigests:[1,2,3].map(v=>String(v).repeat(64)).join(','),evidence:'median'}) }; }

test('verifier derives outcome only from finalized, market-bound GenLayer state', async()=>{const result=await verifyGenLayerResolution(market,{contractAddress:resolver,transactionHash:txHash},{client:client()});assert.equal(result.outcome,'YES');assert.equal(result.verified,true);assert.equal(result.contentHashes.length,3)});
test('verifier rejects a resolver bound to another market', async()=>{await assert.rejects(()=>verifyGenLayerResolution(market,{contractAddress:resolver,transactionHash:txHash},{client:client({binding:{...binding,marketId:'other'}})}),(e)=>e.code==='RESOLVER_BINDING_MISMATCH')});
test('verifier rejects a non-final transaction', async()=>{const pending=client();pending.getTransaction=async()=>({statusName:'PENDING',recipient:resolver});await assert.rejects(()=>verifyGenLayerResolution(market,{contractAddress:resolver,transactionHash:txHash},{client:pending}),(e)=>e.code==='RESOLUTION_NOT_FINALIZED')});
test('verifier rejects a resolver whose executable sources differ despite copied hashes', async()=>{await assert.rejects(()=>verifyGenLayerResolution(market,{contractAddress:resolver,transactionHash:txHash},{client:client({config:{...config,sources:['https://evil','https://b','https://c']}})}),(e)=>e.code==='RESOLVER_CONFIG_MISMATCH')});
test('verifier rejects a finalized transaction to the resolver that was not resolve()', async()=>{const wrong=client();wrong.getTransaction=async()=>({statusName:'FINALIZED',txExecutionResult:1,recipient:resolver,txDataDecoded:{type:'call',callData:new Map([['method','other']])}});await assert.rejects(()=>verifyGenLayerResolution(market,{contractAddress:resolver,transactionHash:txHash},{client:wrong}),(e)=>e.code==='WRONG_RESOLVER_TRANSACTION')});

const marketContract = '0x3333333333333333333333333333333333333333';
const contractState = { ...binding, resolver, feeBps: 200, collateral: 0n, finalOutcome: 'PENDING' };
function marketClient(overrides = {}) { return { readContract: async () => ({ ...contractState, ...overrides }) }; }

test('market-contract verifier accepts only a contract bound to this market and resolver', async () => { const result = await verifyMarketContract(market, marketContract, { client: marketClient(), transactionHash: txHash }); assert.equal(result.verified, true); assert.equal(result.transactionHash, txHash); });
test('market-contract verifier rejects a lookalike bound to another spec', async () => { await assert.rejects(() => verifyMarketContract(market, marketContract, { client: marketClient({ resolutionSpecHash: `0x${'99'.repeat(32)}` }) }), (e) => e.code === 'MARKET_CONTRACT_MISMATCH'); });
test('market-contract verifier rejects a contract that would settle from another resolver', async () => { await assert.rejects(() => verifyMarketContract(market, marketContract, { client: marketClient({ resolver: '0x9999999999999999999999999999999999999999' }) }), (e) => e.code === 'MARKET_RESOLVER_MISMATCH'); });

const asCalldataAddress = (hex) => ({ bytes: Uint8Array.from(Buffer.from(hex.slice(2), 'hex')) });

test('market-contract verifier reads a decoded Address wrapper, not its stringification', async () => {
  // genlayer-js hands back {bytes: Uint8Array}; String() on it is "[object Object]",
  // which would compare equal to nothing and unequal to everything.
  const result = await verifyMarketContract(market, marketContract, { client: marketClient({ resolver: asCalldataAddress(resolver) }) });
  assert.equal(result.verified, true);
  await assert.rejects(() => verifyMarketContract(market, marketContract, { client: marketClient({ resolver: asCalldataAddress('0x9999999999999999999999999999999999999999') }) }), (e) => e.code === 'MARKET_RESOLVER_MISMATCH');
});
