import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const KEY_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const CALLBACK_GAS = 500_000;

// Starter test: the happy path end to end — two deposits, time travel to the
// deadline, a forced VRF response, and a claim. It fails until deposit,
// drawWinner, fulfillRandomWords, and claim work. Don't edit it. Add tests for
// the failure modes and the weighted-pick boundaries in a separate file.
describe("Raffle", function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await viem.getWalletClients();

    const btc = await viem.deployContract("Token", ["Bitcoin", "BTC", parseEther("1000000")]);
    const feed = await viem.deployContract("PriceFeedMock", [8, 60_000n * 10n ** 8n]);

    const coord = await viem.deployContract("VRFCoordinatorMock", [10n ** 17n, 10n ** 9n, 10n ** 15n]);

    await coord.write.createSubscription();
    const [created] = await coord.getEvents.SubscriptionCreated({}, { fromBlock: 0n });
    const subId = created.args.subId as bigint;
    await coord.write.fundSubscription([subId, parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const drawTime = BigInt(now + 600);

    const raffle = await viem.deployContract("Raffle", [
      btc.address,
      feed.address,
      drawTime,
      coord.address,
      subId,
      KEY_HASH,
      CALLBACK_GAS,
    ]);
    await coord.write.addConsumer([subId, raffle.address]);

    for (const w of [alice, bob]) {
      await btc.write.transfer([w.account.address, parseEther("100")]);
      await btc.write.approve([raffle.address, parseEther("100")], { account: w.account });
    }

    return { btc, feed, coord, raffle, subId, drawTime, deployer, alice, bob };
  }

  it("runs the full raffle: deposit, draw, weighted winner, claim", async function () {
    const { btc, coord, raffle, drawTime, alice, bob } = await deployFixture();

    // Entry 0: alice (weight 1 BTC). Entry 1: bob (weight 3 BTC).
    await raffle.write.deposit([parseEther("1")], { account: alice.account });
    await raffle.write.deposit([parseEther("3")], { account: bob.account });

    await networkHelpers.time.increaseTo(drawTime);
    await raffle.write.drawWinner();

    const requestId = (await raffle.read.requestId()) as bigint;
    const totalWeight = (await raffle.read.totalWeight()) as bigint;

    // A random word at the top of the range lands in bob's entry (index 1).
    await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [totalWeight - 1n]]);

    const before = (await btc.read.balanceOf([bob.account.address])) as bigint;
    await raffle.write.claim([1n], { account: bob.account });
    const after = (await btc.read.balanceOf([bob.account.address])) as bigint;

    assert.equal(after - before, parseEther("4"));
  });

  it("locks each deposit's USD weight at entry time even when the token price changes later", async function () {
    const { btc, feed, coord, raffle, drawTime, alice, bob } = await deployFixture();

    await raffle.write.deposit([parseEther("2")], { account: alice.account });
    await feed.write.updateAnswer([120_000n * 10n ** 8n]);
    await raffle.write.deposit([parseEther("1")], { account: bob.account });

    const entry0 = await raffle.read.entries([0n]);
    const entry1 = await raffle.read.entries([1n]);
    const aliceWeight = entry0[3] - entry0[2];
    const bobWeight = entry1[3] - entry1[2];

    assert.equal(aliceWeight, parseEther("120000"));
    assert.equal(bobWeight, parseEther("120000"));
    assert.equal(await raffle.read.totalWeight(), parseEther("240000"));

    await networkHelpers.time.increaseTo(drawTime);
    await raffle.write.drawWinner();
    const reqId = (await raffle.read.requestId()) as bigint;

    await coord.write.fulfillRandomWordsWithOverride([reqId, raffle.address, [aliceWeight - 1n]]);

    await viem.assertions.revertWithCustomError(
      raffle.write.claim([0n], { account: bob.account }),
      raffle,
      "InvalidClaim",
    );
    await viem.assertions.revertWithCustomError(
      raffle.write.claim([1n], { account: bob.account }),
      raffle,
      "InvalidClaim",
    );

    const aliceBefore = await btc.read.balanceOf([alice.account.address]);
    await raffle.write.claim([0n], { account: alice.account });
    const aliceAfter = await btc.read.balanceOf([alice.account.address]);
    assert.equal(aliceAfter - aliceBefore, parseEther("3"));
    assert.equal(await raffle.read.winner(), getAddress(alice.account.address));
  });

  it("picks the second entry at the exact startWeight boundary", async function () {
    const { btc, coord, raffle, drawTime, alice, bob } = await deployFixture();

    await raffle.write.deposit([parseEther("1")], { account: alice.account });
    await raffle.write.deposit([parseEther("2")], { account: bob.account });

    const entry0 = await raffle.read.entries([0n]);
    const aliceEnd = entry0[3];

    await networkHelpers.time.increaseTo(drawTime);
    await raffle.write.drawWinner();
    const reqId = (await raffle.read.requestId()) as bigint;

    await coord.write.fulfillRandomWordsWithOverride([reqId, raffle.address, [aliceEnd]]);

    await viem.assertions.revertWithCustomError(
      raffle.write.claim([0n], { account: alice.account }),
      raffle,
      "InvalidClaim",
    );

    const bobBefore = await btc.read.balanceOf([bob.account.address]);
    await raffle.write.claim([1n], { account: bob.account });
    assert.equal((await btc.read.balanceOf([bob.account.address])) - bobBefore, parseEther("3"));
  });

  it("rejects zero deposits, deposits after drawTime, and non-positive or stale prices", async function () {
    const { feed, raffle, alice } = await deployFixture();

    await viem.assertions.revertWithCustomError(
      raffle.write.deposit([0n], { account: alice.account }),
      raffle,
      "InvalidAmount",
    );

    await feed.write.updateAnswer([0n]);
    await viem.assertions.revertWithCustomError(
      raffle.write.deposit([parseEther("1")], { account: alice.account }),
      raffle,
      "InvalidPrice",
    );

    await feed.write.updateAnswer([-100n]);
    await viem.assertions.revertWithCustomError(
      raffle.write.deposit([parseEther("1")], { account: alice.account }),
      raffle,
      "InvalidPrice",
    );

    await feed.write.updateAnswer([60_000n * 10n ** 8n]);
    const now = await networkHelpers.time.latest();
    const staleRaffle = await viem.deployContract("Raffle", [
      await raffle.read.token(),
      feed.address,
      BigInt(now + 10_000),
      await raffle.read.s_vrfCoordinator(),
      await raffle.read.subscriptionId(),
      KEY_HASH,
      CALLBACK_GAS,
    ]);

    // Advancing 3601s makes the price stale for staleRaffle and also passes drawTime for raffle
    await networkHelpers.time.increase(3601);
    await viem.assertions.revertWithCustomError(
      staleRaffle.write.deposit([parseEther("1")], { account: alice.account }),
      staleRaffle,
      "StalePrice",
    );

    await viem.assertions.revertWithCustomError(
      raffle.write.deposit([parseEther("1")], { account: alice.account }),
      raffle,
      "RaffleClosed",
    );
  });

  it("enforces drawWinner and claim lifecycle rules", async function () {
    const { coord, raffle, drawTime, alice, bob } = await deployFixture();

    await viem.assertions.revertWithCustomError(
      raffle.write.drawWinner(),
      raffle,
      "DrawNotReady",
    );

    await raffle.write.deposit([parseEther("1")], { account: alice.account });
    await networkHelpers.time.increaseTo(drawTime);

    await viem.assertions.revertWithCustomError(
      raffle.write.claim([0n], { account: alice.account }),
      raffle,
      "InvalidClaim",
    );

    await raffle.write.drawWinner();

    await viem.assertions.revertWithCustomError(
      raffle.write.drawWinner(),
      raffle,
      "DrawAlreadyRequested",
    );

    await viem.assertions.revertWithCustomError(
      raffle.write.claim([0n], { account: alice.account }),
      raffle,
      "InvalidClaim",
    );

    const reqId = (await raffle.read.requestId()) as bigint;
    await coord.write.fulfillRandomWordsWithOverride([reqId, raffle.address, [0n]]);

    await viem.assertions.revertWithCustomError(
      raffle.write.claim([99n], { account: alice.account }),
      raffle,
      "InvalidClaim",
    );

    await viem.assertions.revertWithCustomError(
      raffle.write.claim([0n], { account: bob.account }),
      raffle,
      "InvalidClaim",
    );

    await raffle.write.claim([0n], { account: alice.account });
    await viem.assertions.revertWithCustomError(
      raffle.write.claim([0n], { account: alice.account }),
      raffle,
      "InvalidClaim",
    );
  });
});
