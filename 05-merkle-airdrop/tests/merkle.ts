import { keccak256, encodeAbiParameters, concat, type Address, type Hex } from "viem";

export interface AirdropEntry {
  account: Address;
  amount: bigint;
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

// Double-hash leaf: keccak256(keccak256(abi.encode(account, amount)))
export function hashLeaf(entry: AirdropEntry): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [entry.account, entry.amount],
    ),
  );
  return keccak256(inner);
}

export class MerkleTree {
  layers: Hex[][];

  constructor(entries: AirdropEntry[]) {
    if (entries.length === 0) {
      this.layers = [[("0x" + "0".repeat(64)) as Hex]];
      return;
    }

    const leaves = entries.map(hashLeaf);
    this.layers = [leaves];

    let currentLayer = leaves;
    while (currentLayer.length > 1) {
      const nextLayer: Hex[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
        } else {
          // Odd-layer convention: promote lone trailing node unchanged
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  get root(): Hex {
    return this.layers[this.layers.length - 1][0];
  }

  getProof(index: number): Hex[] {
    if (index < 0 || index >= this.layers[0].length) {
      throw new Error("Leaf index out of bounds");
    }

    const proof: Hex[] = [];
    let idx = index;

    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level];
      const isRightNode = idx % 2 === 1;
      const siblingIndex = isRightNode ? idx - 1 : idx + 1;

      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }

      idx = Math.floor(idx / 2);
    }

    return proof;
  }
}
