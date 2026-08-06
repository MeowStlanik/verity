import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

test('Solidity collateral contracts compile', async () => {
  const here = fileURLToPath(new URL('../', import.meta.url));
  const contracts = join(here, '../contracts');
  const sources = Object.fromEntries(await Promise.all(['BinaryMarket.sol', 'MarketFactory.sol'].map(async (name) => [name, { content: await readFile(join(contracts, name), 'utf8') }])));
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const errors = (output.errors || []).filter((error) => error.severity === 'error');
  assert.deepEqual(errors, [], errors.map((error) => error.formattedMessage).join('\n'));
  assert.ok(output.contracts['BinaryMarket.sol'].BinaryMarket.abi.length > 0);
  assert.ok(output.contracts['MarketFactory.sol'].MarketFactory.abi.length > 0);
  const market = output.contracts['BinaryMarket.sol'].BinaryMarket;
  const functions = new Set(market.abi.filter((item) => item.type === 'function').map((item) => item.name));
  for (const name of ['buy', 'sell', 'quote', 'quoteSell', 'challenge', 'finalize', 'claim', 'claimLiquidity', 'claimFees', 'emergencyVoid']) assert.ok(functions.has(name), `missing ${name}`);
  assert.ok(market.evm.bytecode.object.length > 1000, 'BinaryMarket bytecode should be emitted');
});
