import {
  type WalletClient,
  type Address,
  keccak256,
  encodeAbiParameters,
  parseSignature,
  getAddress,
} from "viem";

export interface ClaimSignatureParts {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

// Default Hardhat deployment address when Token is nonce 0 and MerkleAirdrop is nonce 1
const DEFAULT_AIRDROP_ADDRESS: Address = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

export async function signAirdropClaim(
  signerWallet: WalletClient,
  claimant: Address,
  amount: bigint,
  airdropAddress: Address = DEFAULT_AIRDROP_ADDRESS,
  chainId: bigint = 31337n,
): Promise<ClaimSignatureParts> {
  if (!signerWallet.account) {
    throw new Error("signerWallet has no account");
  }

  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [getAddress(airdropAddress), chainId, getAddress(claimant), amount],
    ),
  );

  const signature = await signerWallet.signMessage({
    account: signerWallet.account,
    message: { raw: structHash },
  });

  const { v, r, s } = parseSignature(signature);
  return {
    v: Number(v),
    r,
    s,
  };
}
