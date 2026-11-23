import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

describe("PriceVoting", function () {
  async function deployVotingFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", ["Vote Token", "VOTE", parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVoting", [token.address, votingEnd]);

    // give voters some tokens and approve the voting contract
    for (const w of [alice, bob, carol]) {
      await token.write.transfer([w.account.address, parseEther("1000")]);
      await token.write.approve([voting.address, parseEther("1000")], { account: w.account });
    }

    return { token, voting, votingEnd, deployer, alice, bob, carol };
  }

  describe("vote", function () {
    it("1. sets the leading price and weight on a single vote", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("50"));
    });

    it("emits Voted", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await viem.assertions.emitWithArgs(
        voting.write.vote([100n, parseEther("50")], { account: alice.account }),
        voting,
        "Voted",
        [getAddress(alice.account.address), 100n, parseEther("50")],
      );
    });

    it("2. stacks weight when two voters vote for the same price", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([100n, parseEther("75")], { account: bob.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("125"));
      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("125"));
    });

    it("3. picks the price with more total weight when two voters vote for different prices", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("80")], { account: bob.account });

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 200n);
      assert.equal(leadWeight, parseEther("80"));
    });

    it("4. tracks lockedBalance and per-price weight when a voter votes twice for different prices", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([250n, parseEther("60")], { account: alice.account });

      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("100"));
      assert.equal(await voting.read.weightOf([100n]), parseEther("40"));
      assert.equal(await voting.read.weightOf([250n]), parseEther("60"));
    });

    it("5. updates the leading price when a new vote pushes a different price above the current leader", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("60")], { account: alice.account });
      await voting.write.vote([200n, parseEther("40")], { account: bob.account });
      await voting.write.vote([200n, parseEther("30")], { account: bob.account });

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 200n);
      assert.equal(leadWeight, parseEther("70"));
    });

    it("6. does NOT update the leading price on a tie", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("50"));
    });

    it("7. reverts when called after votingEnd", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.revertWithCustomError(
        voting.write.vote([100n, parseEther("10")], { account: alice.account }),
        voting,
        "VotingEnded",
      );
    });

    it("8. reverts when called with amount == 0", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await viem.assertions.revertWithCustomError(
        voting.write.vote([100n, 0n], { account: alice.account }),
        voting,
        "ZeroAmount",
      );
    });

    it("9. reverts when the voter has not approved enough tokens", async function () {
      const { voting, deployer } = await networkHelpers.loadFixture(deployVotingFixture);

      await assert.rejects(
        voting.write.vote([100n, parseEther("10")], { account: deployer.account }),
      );
    });
  });

  describe("finalize", function () {
    it("10. reverts when called before votingEnd", async function () {
      const { voting } = await networkHelpers.loadFixture(deployVotingFixture);

      await viem.assertions.revertWithCustomError(
        voting.write.finalize(),
        voting,
        "VotingActive",
      );
    });

    it("11. reverts when called twice", async function () {
      const { voting, votingEnd } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      await viem.assertions.revertWithCustomError(
        voting.write.finalize(),
        voting,
        "AlreadyFinalized",
      );
    });

    it("12. sets currentTokenPrice and finalized and emits PriceFinalized", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([250n, parseEther("90")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.finalize(),
        voting,
        "PriceFinalized",
        [250n, parseEther("90")],
      );

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 250n);
    });

    it("13. succeeds with no votes and leaves currentTokenPrice at 0", async function () {
      const { voting, votingEnd } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("14. succeeds with a tie and leaves currentTokenPrice at 0", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd);
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });
  });

  describe("claim", function () {
    it("15. reverts when called before votingEnd", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await viem.assertions.revertWithCustomError(
        voting.write.claim({ account: alice.account }),
        voting,
        "VotingActive",
      );
    });

    it("16. reverts when caller has nothing locked", async function () {
      const { voting, votingEnd, carol } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.revertWithCustomError(
        voting.write.claim({ account: carol.account }),
        voting,
        "NothingToClaim",
      );
    });

    it("17. returns locked tokens and zeros out locked balance", async function () {
      const { token, voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      const balanceBefore = await token.read.balanceOf([alice.account.address]);
      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: alice.account });

      assert.equal(await token.read.balanceOf([alice.account.address]), balanceBefore - parseEther("100"));

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.claim({ account: alice.account }),
        voting,
        "Claimed",
        [getAddress(alice.account.address), parseEther("100")],
      );

      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await token.read.balanceOf([alice.account.address]), balanceBefore);
    });

    it("18. prevents a voter from claiming twice", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await networkHelpers.time.increaseTo(votingEnd);

      await voting.write.claim({ account: alice.account });

      await viem.assertions.revertWithCustomError(
        voting.write.claim({ account: alice.account }),
        voting,
        "NothingToClaim",
      );
    });
  });
});
