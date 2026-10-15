/**
 * eth_call items whose calldata alone costs more gas than the call may use.
 *
 * Every node runs an eth_call as a transaction and charges the calldata before executing
 * anything. Since Pectra a transaction pays at least the EIP-7623 floor:
 *
 *   floor    = 21000 + 10 · zeroBytes + 40 · nonzeroBytes
 *   standard = 21000 +  4 · zeroBytes + 16 · nonzeroBytes   (always ≤ floor for plain calldata)
 *
 * A call whose floor is above its gas limit fails on every node, so the edge answers it
 * itself instead of sending megabytes downstream. Measured on the pool (2026-10-13): a
 * 1,980,228-byte Multicall3 call with gas 0x1c9c380 (30M); the nodes answered "want
 * 32947950", the floor this formula gives. Most of them said -32000 "intrinsic gas
 * too low", which is what the edge answers.
 *
 * Only what is certain to fail is refused: access-list and contract-creation costs are
 * left out (they only add gas), and anything unreadable (gas, calldata) is left to the node.
 */

import { jsonRpcError } from './errorMessages.js';
import { requestUnits } from './requestUnits.js';

const TX_BASE_GAS = 21000;
const FLOOR_ZERO_BYTE = 10;
const FLOOR_NONZERO_BYTE = 40;

const INTRINSIC_GAS_ERROR = { code: -32000, message: 'intrinsic gas too low' };

// Gas from a JSON-RPC quantity (hex string or number); null when unreadable.
function readGas(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(value)) {
    const n = Number.parseInt(value, 16);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * The EIP-7623 floor for a 0x-prefixed hex calldata string, or null if it isn't hex bytes.
 * One pass over the string; no Buffer copy of a body that can be 4 MB.
 */
function calldataFloorGas(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  let zero = 0;
  for (let i = 2; i < hex.length; i += 2) {
    if (hex.charCodeAt(i) === 48 && hex.charCodeAt(i + 1) === 48) zero++; // "00"
  }
  const nonzero = (hex.length - 2) / 2 - zero;
  return TX_BASE_GAS + FLOOR_ZERO_BYTE * zero + FLOOR_NONZERO_BYTE * nonzero;
}

/**
 * Why this item fails on every node before it runs, or null.
 * @param {object} request - one JSON-RPC item
 * @param {number} gasCap - the gas an eth_call without "gas" gets (the nodes' --rpc.gascap)
 * @returns {{ code: number, message: string, reason: string } | null}
 */
function callGasFloorProblem(request, gasCap) {
  if (request?.method !== 'eth_call') return null;
  const call = Array.isArray(request.params) ? request.params[0] : null;
  if (!call || typeof call !== 'object' || Array.isArray(call)) return null;

  // Nodes read "input", then "data"
  const input = typeof call.input === 'string' ? call.input : call.data;
  if (typeof input !== 'string') return null;

  let gas = gasCap;
  if (call.gas !== undefined && call.gas !== null) {
    gas = readGas(call.gas);
    if (gas === null) return null;
  }

  // Cheap bound first: even all-nonzero calldata can't reach the gas, so don't count bytes
  if (TX_BASE_GAS + FLOOR_NONZERO_BYTE * ((input.length - 2) / 2) <= gas) return null;

  const floor = calldataFloorGas(input);
  if (floor === null || floor <= gas) return null;
  return { ...INTRINSIC_GAS_ERROR, reason: `eth_call calldata floor ${floor} > gas ${gas} (${(input.length - 2) / 2} bytes)` };
}

/**
 * The items of a request (single or batch) the edge answers itself, each with its
 * position in the body, its error answer (the item's id echoed) and the units it is
 * charged: a refused call costs what a served one would (requestUnits).
 * @returns {{ index: number, response: object, units: number, reason: string }[]}
 */
function callGasFloorRejects(body, gasCap) {
  const items = Array.isArray(body) ? body : [body];
  const rejected = [];
  items.forEach((item, index) => {
    const problem = callGasFloorProblem(item, gasCap);
    if (!problem) return;
    rejected.push({
      index,
      response: jsonRpcError(item.id, problem.code, problem.message),
      units: requestUnits(item),
      reason: problem.reason
    });
  });
  return rejected;
}

export { callGasFloorProblem, callGasFloorRejects, calldataFloorGas };
