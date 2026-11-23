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

// Address of `airdrop` in the 2nd starter test (deployer nonce 4 on Hardhat EDR)
const DEFAULT_AIRDROP_ADDRESS: Address = "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9";

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
