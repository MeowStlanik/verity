const creator = '0x320797a9938170961852a51b176eC6a410EBfdc8';
const closesAt = '2026-08-10T20:00:00.000Z';
const createdAt = '2026-08-05T20:00:00.000Z';

function market({ id, title, category, type, probability, resolverAddress, observationTime, resolutionSpecHash, sourcesHash, sources, resolver, summary, criteria, marketContractAddress = null, marketDeploymentTx = null, closes = closesAt }) {
  return {
    id, title, category, type, status: 'trading', outcome: null, preliminaryOutcome: null,
    probability, volume: 0, liquidity: 10, closesAt: closes, createdAt, feeBps: 200,
    challengeWindowClosesAt: null, voidReason: null,
    resolutionSpec: {
      summary, criteria, tieBreak: 'VOID',
      unavailableRule: 'VOID unless the locked resolver obtains sufficient matching evidence',
      observationTime, lockedAt: createdAt, version: 'v2.0', resolver,
    },
    sources: sources.map((source) => ({ ...source, fetchedAt: null, contentHash: null })),
    settlementStages: [], challenge: null, priceHistory: [probability],
    priceSeries: [{ t: createdAt, p: probability }], creator,
    resolverContractAddress: resolverAddress, resolverNetwork: 'testnetBradbury', disputeResolverContractAddress: null,
    resolutionSpecHash, sourcesHash,
    resolverBinding: { marketId: id, resolutionSpecHash, sourcesHash, observationTime },
    resolverBoundAt: createdAt, demo: true,
    // A market is ON-CHAIN only once a PredictionMarket holds GEN for it. The rest
    // exercise the API ledger and are labelled SIMULATION everywhere they appear.
    marketContractAddress, marketDeploymentTx, settlement: marketContractAddress ? 'onchain' : 'simulation',
  };
}

const numericSources = [
  { name: 'Coinbase BTC-USD candle', url: 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2026-08-04T23%3A55%3A00.000Z&end=2026-08-04T23%3A56%3A00.000Z', jsonPath: '1.4', timestampPath: '1.0', timestampValue: '1785887700' },
  { name: 'Kraken XBTUSD OHLC', url: 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=1785887700', jsonPath: 'result.XXBTZUSD.0.4', timestampPath: 'result.XXBTZUSD.0.0', timestampValue: '1785887700' },
  { name: 'Binance BTCUSDT kline', url: 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=1785887700000&endTime=1785887759999&limit=1', jsonPath: '0.4', timestampPath: '0.0', timestampValue: '1785887700000' },
];
const numericArgs = { sources: numericSources.map((source) => source.url), jsonPaths: numericSources.map((source) => source.jsonPath), timestampPaths: numericSources.map((source) => source.timestampPath), timestampValues: numericSources.map((source) => source.timestampValue), comparator: 'GT', scale: 100, thresholdUnits: 0, maxSourceSpreadUnits: 100000 };

const structuredSources = [
  { name: 'GenLayer website', url: 'https://www.genlayer.com/' },
  { name: 'GenLayer documentation', url: 'https://docs.genlayer.com/' },
  { name: 'GenLayer GitHub organization', url: 'https://github.com/genlayerlabs' },
];
const structuredCriterion = 'YES only if at least two sources explicitly identify the project as GenLayer; NO only if at least two explicitly contradict that; otherwise VOID.';

const judgmentSources = [
  { name: 'GenLayer website', url: 'https://www.genlayer.com/' },
  { name: 'GenLayer documentation', url: 'https://docs.genlayer.com/' },
  { name: 'GenLayer JS repository', url: 'https://github.com/genlayerlabs/genlayer-js' },
];
const interpretationRule = 'YES only when at least two sources unambiguously describe GenLayer as using AI or intelligent contracts for consensus or contract execution; ambiguity is VOID.';

const demoMarkets = [
    market({
      id: 'bradbury-v2-numeric-smoke', title: 'Is the locked BTC/USD median above zero?', category: 'Crypto', type: 'deterministic', probability: .5,
      resolverAddress: '0xa0bf8Abe38cDa8E1dB92040a3823C4b810Cdd2b7', observationTime: '2026-08-04T23:55:00.000Z',
      // Live on Bradbury: the PredictionMarket below custodies GEN for this market,
      // so the UI reads its reserves, positions and outcome from the contract and the
      // API refuses every value-moving call for it. Its observation time has passed,
      // so it opens on the "publish preliminary result" step rather than on trading.
      marketContractAddress: '0x13b407ddA155e733Fb42089f5D8E4f99CDD04eFB',
      marketDeploymentTx: '0xe0fe42d9b72a7bd1e0cf604915ed1f9d36dbc0c2c75d4f7bbe2cba5accbb5e97',
      closes: '2026-08-04T23:55:00.000Z',
      resolutionSpecHash: '0x76a53bcd0523bdaa53780946d53012b2eab73485b9bcb9e2e487fd70d55ac8b8', sourcesHash: '0xb225f3a4295bd362d7a7b7c20072a25bce8473c9b18f532b83c53da535b820f4',
      sources: numericSources, resolver: { contract: 'NumericResolver', args: numericArgs }, summary: 'Exact-integer median across three locked historical exchange candles.', criteria: ['All three candles must match the locked timestamp.', 'The scaled median must be greater than zero.'],
    }),
    market({
      id: 'bradbury-v2-structured-smoke', title: 'Do official project pages identify the project as GenLayer?', category: 'Technology', type: 'structured', probability: .5,
      resolverAddress: '0x6E5066c43D8F381fAb2a994f5F3433E6872d6fdc', observationTime: '2026-08-04T23:55:00.000Z',
      // Third live PredictionMarket on Bradbury, bound to the structured-fact resolver.
      marketContractAddress: '0xAC6F7B9c059Ad6190d74399c3311dFEEDe149C0b',
      marketDeploymentTx: '0x726690d4d63d53d1039ff2b086f60afa1aa280cb08419b52ca66de3f04d9867b',
      closes: '2026-08-04T23:55:00.000Z',
      resolutionSpecHash: '0x4083a0352f2fff63f5245a35469a8de9927cecb2377d0d57aaf9c22d84fdad76', sourcesHash: '0x2b83cc2eb3b27e99b32c0102d6109d534f66c214ff99675fb0f2899787b7d070',
      sources: structuredSources, resolver: { contract: 'StructuredFactResolver', args: { sources: structuredSources.map((source) => source.url), criterion: structuredCriterion } }, summary: 'Two-of-three fixed-source identity check.', criteria: [structuredCriterion],
    }),
    market({
      id: 'bradbury-v2-judgment-smoke', title: 'Is AI functionality central to GenLayer intelligent contracts?', category: 'AI', type: 'judgment', probability: .5,
      resolverAddress: '0xaC520A14258c8af8d6Edf3937280F6B183120E7e', observationTime: '2026-08-05T01:09:43.794Z',
      // Second live PredictionMarket on Bradbury, bound to the judgment resolver.
      marketContractAddress: '0xA073ff16703d166015614Aec6DB5A7E721C18F90',
      marketDeploymentTx: '0xa484b60e5025ad25ee21add60d4f2c05bbc876a079de538506da5846dbca4ffc',
      closes: '2026-08-05T01:09:43.794Z',
      resolutionSpecHash: '0x237d3f00a332758a393ff4982e7e857ca2c2c9f339a6fbf58ecc31aafa9bdb33', sourcesHash: '0x4bdb6d938964efad1e1a58e283f05f26eeca145d50f8baf4c9ba4f4d97fa19e2',
      sources: judgmentSources, resolver: { contract: 'JudgmentResolver', args: { sources: judgmentSources.map((source) => source.url), interpretationRule } }, summary: 'Conservative interpretation across fixed official sources.', criteria: [interpretationRule],
    }),
];

// A deliberately unbacked market, kept so the UI always has both kinds side by
// side: this one settles in the API ledger and moves no GEN, the three above are
// custodied by PredictionMarket contracts on Bradbury. Its close time is far out,
// so it is the one market on the list that can actually be traded without a wallet
// transaction — which is exactly what makes the ON-CHAIN badge mean something.
demoMarkets.push(market({
  id: 'simulation-ledger-demo', title: 'Simulation: will the API ledger price a fill the same way the contract does?',
  category: 'Demo', type: 'judgment', probability: .5,
  resolverAddress: null, observationTime: '2026-12-31T23:59:00.000Z',
  resolutionSpecHash: null, sourcesHash: null, closes: '2026-12-31T23:59:00.000Z',
  sources: structuredSources,
  resolver: { contract: 'StructuredFactResolver', args: { sources: structuredSources.map((source) => source.url), criterion: structuredCriterion } },
  summary: 'Not backed by a contract. Trades here update the API ledger only; no GEN moves and nothing is settled on GenLayer.',
  criteria: ['This market exists to show the difference between a simulation and an on-chain market.'],
}));

const pricePaths = {
  'bradbury-v2-numeric-smoke': [.5, .5377, .5247],
  'bradbury-v2-structured-smoke': [.5, .5681, .5518],
  'bradbury-v2-judgment-smoke': [.5, .4669, .4798],
};
for (const item of demoMarkets) {
  if (!pricePaths[item.id]) continue;
  item.priceHistory = pricePaths[item.id];
  item.priceSeries = pricePaths[item.id].map((p, index) => ({ t: index ? `2026-08-05T20:29:32.${index === 1 ? '634' : '703'}Z` : createdAt, p }));
}

const demoRuntime = {
  'bradbury-v2-numeric-smoke': { amm: { yesReserve: 9.517997032640949, noReserve: 10.50641218494403, collateral: 11.05, lpShares: 10, fees: .021, totalYesShares: 1.5110029673590504, totalNoShares: .5225878150559693, refundLiability: 1.05 }, timestamps: {}, wasDisputed: false },
  'bradbury-v2-structured-smoke': { amm: { yesReserve: 9.01239581517001, noReserve: 11.095828684274629, collateral: 11.8, lpShares: 10, fees: .036, totalYesShares: 2.751604184829991, totalNoShares: .6681713157253721, refundLiability: 1.8 }, timestamps: {}, wasDisputed: false },
  'bradbury-v2-judgment-smoke': { amm: { yesReserve: 10.413370666589227, noReserve: 9.603038555118847, collateral: 10.95, lpShares: 10, fees: .019, totalYesShares: .5176293334107727, totalNoShares: 1.3279614448811528, refundLiability: .95 }, timestamps: {}, wasDisputed: false },
};

function demoPortfolio(address, history) { return { address, totalValue: 0, totalPnl: 0, positions: [], history }; }
const demoPortfolios = {
  '0x69ffe99dae325ddb3c35f71b0bc851bee4a3752b': demoPortfolio('0x69ffe99dae325ddb3c35f71b0bc851bee4a3752b', [
    { id: 'demo-fill-structured-yes', marketId: 'bradbury-v2-structured-smoke', type: 'buy', side: 'YES', shares: 2.751604, price: .545137, total: 1.5, fee: .03, timestamp: '2026-08-05T20:29:32.680Z' },
    { id: 'demo-fill-numeric-yes', marketId: 'bradbury-v2-numeric-smoke', type: 'buy', side: 'YES', shares: 1.511003, price: .52945, total: .8, fee: .016, timestamp: '2026-08-05T20:29:32.634Z' },
  ]),
  '0xc32ac547f05a86e63d91dc2937d852e935fbc604': demoPortfolio('0xc32ac547f05a86e63d91dc2937d852e935fbc604', [
    { id: 'demo-fill-judgment-no', marketId: 'bradbury-v2-judgment-smoke', type: 'buy', side: 'NO', shares: 1.327961, price: .527124, total: .7, fee: .014, timestamp: '2026-08-05T20:29:32.697Z' },
    { id: 'demo-fill-numeric-no', marketId: 'bradbury-v2-numeric-smoke', type: 'buy', side: 'NO', shares: .522588, price: .478388, total: .25, fee: .005, timestamp: '2026-08-05T20:29:32.665Z' },
  ]),
  '0xe17c4f9b0ccec9d33a13a18376fddf85a98fd7ae': demoPortfolio('0xe17c4f9b0ccec9d33a13a18376fddf85a98fd7ae', [
    { id: 'demo-fill-judgment-yes', marketId: 'bradbury-v2-judgment-smoke', type: 'buy', side: 'YES', shares: .517629, price: .482971, total: .25, fee: .005, timestamp: '2026-08-05T20:29:32.703Z' },
    { id: 'demo-fill-structured-no', marketId: 'bradbury-v2-structured-smoke', type: 'buy', side: 'NO', shares: .668171, price: .448987, total: .3, fee: .006, timestamp: '2026-08-05T20:29:32.690Z' },
  ]),
};

export const seedState = {
  markets: demoMarkets,
  portfolios: demoPortfolios,
  marketRuntime: demoRuntime,
  challenges: [], liquidityPositions: {},
};
