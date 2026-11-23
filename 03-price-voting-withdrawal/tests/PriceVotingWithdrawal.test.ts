import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

describe("PriceVotingWithdrawal", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", ["Vote Token", "VOTE", parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVotingWithdrawal", [token.address, votingEnd]);

    for (const w of [alice, bob, carol]) {
      await token.write.transfer([w.account.address, parseEther("1000")]);
      await token.write.approve([voting.address, parseEther("1000")], { account: w.account });
    }

    return { token, voting, votingEnd, deployer, alice, bob, carol };
  }

  describe("vote", function () {
    it("records votes and updates weightOf, lockedOf, and stakeOf", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.emitWithArgs(
        voting.write.vote([100n, parseEther("50")], { account: alice.account }),
        voting,
        "Voted",
        [getAddress(alice.account.address), 100n, parseEther("50")],
      );

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
      assert.equal(await voting.read.stakeOf([alice.account.address, 100n]), parseEther("50"));
    });

    it("stacks weight across multiple voters and allows splitting across prices", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: alice.account });
      await voting.write.vote([100n, parseEther("80")], { account: bob.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("120"));
      assert.equal(await voting.read.weightOf([200n]), parseEther("60"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("100"));
    });

    it("reverts when voting after votingEnd or with zero amount", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.revertWithCustomError(
        voting.write.vote([100n, 0n], { account: alice.account }),
        voting,
        "ZeroAmount",
      );

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.revertWithCustomError(
        voting.write.vote([100n, parseEther("10")], { account: alice.account }),
        voting,
        "VotingEnded",
      );
    });
  });

  describe("withdraw", function () {
    it("allows partial and full mid-voting withdrawals and re-voting for a new price", async function () {
      const { token, voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      const startBal = await token.read.balanceOf([alice.account.address]);

      // Alice initially puts 100 on price 100, Bob puts 60 on price 200
      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: bob.account });

      // Alice changes her mind mid-voting: withdraws 70 from price 100 and puts it on price 200
      await viem.assertions.emitWithArgs(
        voting.write.withdraw([100n, parseEther("70")], { account: alice.account }),
        voting,
        "Withdrawn",
        [getAddress(alice.account.address), 100n, parseEther("70")],
      );

      assert.equal(await voting.read.weightOf([100n]), parseEther("30"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("30"));
      assert.equal(await token.read.balanceOf([alice.account.address]), startBal - parseEther("30"));

      await voting.write.vote([200n, parseEther("70")], { account: alice.account });
      assert.equal(await voting.read.weightOf([200n]), parseEther("130"));
    });

    it("allows withdrawing remaining locked tokens after voting ends", async function () {
      const { token, voting, votingEnd, alice } = await networkHelpers.loadFixture(deployFixture);

      const startBal = await token.read.balanceOf([alice.account.address]);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd);

      await voting.write.withdraw([100n, parseEther("50")], { account: alice.account });
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await token.read.balanceOf([alice.account.address]), startBal);
    });

    it("reverts when withdrawing zero or more than staked on that price", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await viem.assertions.revertWithCustomError(
        voting.write.withdraw([100n, 0n], { account: alice.account }),
        voting,
        "ZeroAmount",
      );

      await viem.assertions.revertWithCustomError(
        voting.write.withdraw([100n, parseEther("51")], { account: alice.account }),
        voting,
        "InsufficientStake",
      );

      await viem.assertions.revertWithCustomError(
        voting.write.withdraw([100n, parseEther("10")], { account: bob.account }),
        voting,
        "InsufficientStake",
      );
    });
  });

  describe("finalize", function () {
    it("resolves the true winner after mid-voting withdrawals dethrone the early leader", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      // Price 100 starts ahead (100 vs 60)
      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: bob.account });

      // Alice withdraws 80 from price 100 -> price 100 drops to 20, price 200 is now ahead with 60
      await voting.write.withdraw([100n, parseEther("80")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.finalize([[100n, 200n]]),
        voting,
        "PriceFinalized",
        [200n, parseEther("60")],
      );

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 200n);
      assert.equal(await voting.read.winningPrice(), 200n);
    });

    it("leaves winning price at 0 when there are no votes or a tie", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize([[100n, 200n]]);

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("reverts if called early, twice, or with duplicate candidates", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await viem.assertions.revertWithCustomError(
        voting.write.finalize([[100n]]),
        voting,
        "VotingActive",
      );

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.revertWithCustomError(
        voting.write.finalize([[100n, 100n]]),
        voting,
        "DuplicateCandidate",
      );

      await voting.write.finalize([[100n]]);

      await viem.assertions.revertWithCustomError(
        voting.write.finalize([[100n]]),
        voting,
        "AlreadyFinalized",
      );
    });
  });
});
