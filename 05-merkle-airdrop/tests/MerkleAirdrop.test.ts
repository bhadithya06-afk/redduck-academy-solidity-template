import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, getAddress } from "viem";
import { MerkleTree, type AirdropEntry } from "./merkle.ts";
import { signAirdropClaim } from "./signatures.ts";

const { viem } = await network.connect();

// Two starter happy-path tests: one claim via the Merkle proof, one via an admin
// signature. Both fail until the contract and the matching off-chain code
// (merkle.ts, signatures.ts) are implemented. Add tests for the failure modes
// described in TASK.md (bad proofs, wrong signer/amount/recipient, replay across
// both paths via the shared hasClaimed).
describe("MerkleAirdrop", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol, signer, dave, eve] = await viem.getWalletClients();

    const entries: AirdropEntry[] = [
      { account: getAddress(alice.account.address), amount: parseEther("100") },
      { account: getAddress(bob.account.address), amount: parseEther("200") },
      { account: getAddress(carol.account.address), amount: parseEther("300") },
      { account: getAddress(eve.account.address), amount: parseEther("50") },
    ];
    const tree = new MerkleTree(entries);

    const token = await viem.deployContract("Token", [
      "Redduck Token",
      "RDDK",
      parseEther("100000000000000"),
    ]);
    const airdrop = await viem.deployContract("MerkleAirdrop", [
      token.address,
      tree.root,
      signer.account.address,
    ]);

    await token.write.transfer([airdrop.address, parseEther("100000000000000")], {
      account: deployer.account,
    });

    return { entries, tree, token, airdrop, deployer, alice, bob, carol, signer, dave, eve };
  }

  it("lets an eligible account claim its allocation with a Merkle proof", async function () {
    const { entries, tree, token, airdrop, alice } = await deployFixture();

    const proof = tree.getProof(0);
    const { account, amount } = entries[0];

    await airdrop.write.claim([amount, proof], { account: alice.account });

    assert.equal((await token.read.balanceOf([account])) as bigint, amount);
    assert.equal((await airdrop.read.hasClaimed([account])) as boolean, true);
  });

  it("lets an authorized account claim with an admin signature (not on the Merkle list)", async function () {
    const { token, airdrop, signer, dave } = await deployFixture();

    const daveAddr = getAddress(dave.account.address);
    const amount = parseEther("50");

    const { v, r, s } = await signAirdropClaim(signer, daveAddr, amount);

    await airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account });

    assert.equal((await token.read.balanceOf([daveAddr])) as bigint, amount);
    assert.equal((await airdrop.read.hasClaimed([daveAddr])) as boolean, true);
  });

  it("emits Claimed on claimWithSignature and rejects a second signature claim", async function () {
    const { airdrop, signer, dave } = await deployFixture();

    const daveAddr = getAddress(dave.account.address);
    const amount = parseEther("75");

    const { v, r, s } = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);

    await viem.assertions.emitWithArgs(
      airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
      airdrop,
      "Claimed",
      [daveAddr, amount],
    );

    await viem.assertions.revertWithCustomError(
      airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
      airdrop,
      "AlreadyClaimed",
    );
  });

  it("supports odd-sized Merkle trees and emits Claimed", async function () {
    const { signer, alice, bob, carol } = await deployFixture();

    const oddEntries: AirdropEntry[] = [
      { account: getAddress(alice.account.address), amount: parseEther("10") },
      { account: getAddress(bob.account.address), amount: parseEther("20") },
      { account: getAddress(carol.account.address), amount: parseEther("30") },
    ];
    const oddTree = new MerkleTree(oddEntries);

    const oddToken = await viem.deployContract("Token", ["Odd Token", "ODD", parseEther("1000")]);
    const oddAirdrop = await viem.deployContract("MerkleAirdrop", [
      oddToken.address,
      oddTree.root,
      signer.account.address,
    ]);
    await oddToken.write.transfer([oddAirdrop.address, parseEther("1000")]);

    const proof = oddTree.getProof(2);
    await viem.assertions.emitWithArgs(
      oddAirdrop.write.claim([parseEther("30"), proof], { account: carol.account }),
      oddAirdrop,
      "Claimed",
      [getAddress(carol.account.address), parseEther("30")],
    );
  });

  it("reverts on invalid Merkle proof, wrong amount, or wrong caller", async function () {
    const { entries, tree, airdrop, alice, bob, dave } = await deployFixture();

    const aliceProof = tree.getProof(0);

    await viem.assertions.revertWithCustomError(
      airdrop.write.claim([parseEther("200"), aliceProof], { account: alice.account }),
      airdrop,
      "InvalidProof",
    );

    await viem.assertions.revertWithCustomError(
      airdrop.write.claim([entries[0].amount, aliceProof], { account: bob.account }),
      airdrop,
      "InvalidProof",
    );

    await viem.assertions.revertWithCustomError(
      airdrop.write.claim([parseEther("100"), []], { account: dave.account }),
      airdrop,
      "InvalidProof",
    );
  });

  it("reverts when signature is from wrong signer, for wrong recipient, wrong amount, or wrong contract", async function () {
    const { tree, airdrop, signer, alice, dave, eve } = await deployFixture();

    const daveAddr = getAddress(dave.account.address);
    const amount = parseEther("50");

    const badSignerSig = await signAirdropClaim(alice, daveAddr, amount, airdrop.address);
    await viem.assertions.revertWithCustomError(
      airdrop.write.claimWithSignature([amount, badSignerSig.v, badSignerSig.r, badSignerSig.s], {
        account: dave.account,
      }),
      airdrop,
      "InvalidSignature",
    );

    const daveSig = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);
    await viem.assertions.revertWithCustomError(
      airdrop.write.claimWithSignature([amount, daveSig.v, daveSig.r, daveSig.s], {
        account: eve.account,
      }),
      airdrop,
      "InvalidSignature",
    );

    await viem.assertions.revertWithCustomError(
      airdrop.write.claimWithSignature([parseEther("500"), daveSig.v, daveSig.r, daveSig.s], {
        account: dave.account,
      }),
      airdrop,
      "InvalidSignature",
    );

    const token2 = await viem.deployContract("Token", ["Token 2", "TK2", parseEther("1000")]);
    const airdrop2 = await viem.deployContract("MerkleAirdrop", [
      token2.address,
      tree.root,
      signer.account.address,
    ]);
    await token2.write.transfer([airdrop2.address, parseEther("1000")]);

    await viem.assertions.revertWithCustomError(
      airdrop2.write.claimWithSignature([amount, daveSig.v, daveSig.r, daveSig.s], {
        account: dave.account,
      }),
      airdrop2,
      "InvalidSignature",
    );
  });

  it("enforces shared hasClaimed across both Merkle and signature claim paths", async function () {
    const { entries, tree, airdrop, signer, alice, bob } = await deployFixture();

    const aliceProof = tree.getProof(0);
    await airdrop.write.claim([entries[0].amount, aliceProof], { account: alice.account });

    await viem.assertions.revertWithCustomError(
      airdrop.write.claim([entries[0].amount, aliceProof], { account: alice.account }),
      airdrop,
      "AlreadyClaimed",
    );

    const aliceSig = await signAirdropClaim(
      signer,
      getAddress(alice.account.address),
      entries[0].amount,
      airdrop.address,
    );
    await viem.assertions.revertWithCustomError(
      airdrop.write.claimWithSignature(
        [entries[0].amount, aliceSig.v, aliceSig.r, aliceSig.s],
        { account: alice.account },
      ),
      airdrop,
      "AlreadyClaimed",
    );

    const bobSig = await signAirdropClaim(
      signer,
      getAddress(bob.account.address),
      entries[1].amount,
      airdrop.address,
    );
    await airdrop.write.claimWithSignature(
      [entries[1].amount, bobSig.v, bobSig.r, bobSig.s],
      { account: bob.account },
    );

    const bobProof = tree.getProof(1);
    await viem.assertions.revertWithCustomError(
      airdrop.write.claim([entries[1].amount, bobProof], { account: bob.account }),
      airdrop,
      "AlreadyClaimed",
    );
  });
});
