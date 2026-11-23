import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

describe("Pair", function () {
  async function deployPairFixture() {
    const [deployer, alice, bob] = await viem.getWalletClients();

    const token0 = await viem.deployContract("Token", ["Token A", "TKA", parseEther("1000000")]);
    const token1 = await viem.deployContract("Token", ["Token B", "TKB", parseEther("1000000")]);

    const pair = await viem.deployContract("Pair", [token0.address, token1.address]);

    for (const w of [alice, bob]) {
      await token0.write.transfer([w.account.address, parseEther("10000")]);
      await token1.write.transfer([w.account.address, parseEther("10000")]);
      await token0.write.approve([pair.address, parseEther("10000")], { account: w.account });
      await token1.write.approve([pair.address, parseEther("10000")], { account: w.account });
    }

    return { token0, token1, pair, deployer, alice, bob };
  }

  // Starter test — fails until addLiquidity, swap, and getAmountOut are
  // implemented. Keep this test intact and add tests covering the rest of the
  // spec (liquidity add/remove, slippage, invalid token, first-depositor lock,
  // edge cases).
  describe("swap", function () {
    it("swaps token0 for token1 along the constant-product curve", async function () {
      const { token0, token1, pair, alice, bob } = await networkHelpers.loadFixture(deployPairFixture);

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")], { account: alice.account });

      const expected = await pair.read.getAmountOut([parseEther("100"), parseEther("1000"), parseEther("1000")]);
      assert.equal(expected, 90661089388014913158n);

      await viem.assertions.emitWithArgs(
        pair.write.swap([token0.address, parseEther("100"), expected], { account: bob.account }),
        pair,
        "Swapped",
        [getAddress(bob.account.address), getAddress(token0.address), parseEther("100"), expected],
      );

      assert.equal(await pair.read.reserve0(), parseEther("1100"));
      assert.equal(await pair.read.reserve1(), parseEther("1000") - expected);
      assert.equal(await token1.read.balanceOf([bob.account.address]), parseEther("10000") + expected);
    });

    it("swaps token1 for token0 and increases k due to the 0.3% fee", async function () {
      const { token0, token1, pair, alice, bob } = await networkHelpers.loadFixture(deployPairFixture);

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")], { account: alice.account });
      const kBefore = (await pair.read.reserve0()) * (await pair.read.reserve1());

      const expectedOut = await pair.read.getAmountOut([parseEther("50"), parseEther("1000"), parseEther("1000")]);
      await pair.write.swap([token1.address, parseEther("50"), expectedOut], { account: bob.account });

      const r0After = await pair.read.reserve0();
      const r1After = await pair.read.reserve1();
      assert.equal(r0After, parseEther("1000") - expectedOut);
      assert.equal(r1After, parseEther("1050"));
      assert.equal(await token0.read.balanceOf([bob.account.address]), parseEther("10000") + expectedOut);
      assert.ok(r0After * r1After > kBefore);
    });

    it("reverts when minAmountOut is not met (slippage protection)", async function () {
      const { token0, pair, alice, bob } = await networkHelpers.loadFixture(deployPairFixture);

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")], { account: alice.account });
      const expected = await pair.read.getAmountOut([parseEther("100"), parseEther("1000"), parseEther("1000")]);

      await viem.assertions.revertWithCustomError(
        pair.write.swap([token0.address, parseEther("100"), expected + 1n], { account: bob.account }),
        pair,
        "InsufficientOutput",
      );
    });

    it("reverts on invalid tokenIn, zero amountIn, or empty reserves", async function () {
      const { token0, pair, alice, bob } = await networkHelpers.loadFixture(deployPairFixture);

      await viem.assertions.revertWithCustomError(
        pair.write.swap([bob.account.address, parseEther("10"), 0n], { account: bob.account }),
        pair,
        "InvalidToken",
      );

      await viem.assertions.revertWithCustomError(
        pair.write.swap([token0.address, parseEther("10"), 0n], { account: bob.account }),
        pair,
        "InsufficientLiquidity",
      );

      await pair.write.addLiquidity([parseEther("100"), parseEther("100")], { account: alice.account });

      await viem.assertions.revertWithCustomError(
        pair.write.swap([token0.address, 0n, 0n], { account: bob.account }),
        pair,
        "InsufficientAmount",
      );
    });
  });

  describe("addLiquidity", function () {
    it("permanently locks MINIMUM_LIQUIDITY to DEAD on first deposit", async function () {
      const { pair, alice } = await networkHelpers.loadFixture(deployPairFixture);

      const minLiq = await pair.read.MINIMUM_LIQUIDITY();
      const deadAddr = await pair.read.DEAD();
      const expectedUserLp = parseEther("100") - minLiq;

      await viem.assertions.emitWithArgs(
        pair.write.addLiquidity([parseEther("100"), parseEther("100")], { account: alice.account }),
        pair,
        "LiquidityAdded",
        [getAddress(alice.account.address), parseEther("100"), parseEther("100"), expectedUserLp],
      );

      assert.equal(await pair.read.balanceOf([deadAddr]), minLiq);
      assert.equal(await pair.read.balanceOf([alice.account.address]), expectedUserLp);
      assert.equal(await pair.read.totalSupply(), parseEther("100"));
    });

    it("mints proportional LP tokens on subsequent deposits and uses the smaller ratio when out of balance", async function () {
      const { pair, alice, bob } = await networkHelpers.loadFixture(deployPairFixture);

      // Initial pool: 100 token0, 200 token1 -> sqrt(20000e36) = 141.421356...e18
      await pair.write.addLiquidity([parseEther("100"), parseEther("200")], { account: alice.account });
      const supplyAfterFirst = await pair.read.totalSupply();

      // Bob deposits 50 token0 (50% of reserve0) and 150 token1 (75% of reserve1) -> gets 50% of supply
      await pair.write.addLiquidity([parseEther("50"), parseEther("150")], { account: bob.account });
      assert.equal(await pair.read.balanceOf([bob.account.address]), supplyAfterFirst / 2n);
      assert.equal(await pair.read.reserve0(), parseEther("150"));
      assert.equal(await pair.read.reserve1(), parseEther("350"));
    });

    it("reverts if either amount is 0 or initial liquidity is <= MINIMUM_LIQUIDITY", async function () {
      const { pair, alice } = await networkHelpers.loadFixture(deployPairFixture);

      await viem.assertions.revertWithCustomError(
        pair.write.addLiquidity([0n, parseEther("10")], { account: alice.account }),
        pair,
        "InsufficientAmount",
      );

      await viem.assertions.revertWithCustomError(
        pair.write.addLiquidity([parseEther("10"), 0n], { account: alice.account }),
        pair,
        "InsufficientAmount",
      );

      await viem.assertions.revertWithCustomError(
        pair.write.addLiquidity([1000n, 1000n], { account: alice.account }),
        pair,
        "InsufficientLiquidity",
      );
    });
  });

  describe("removeLiquidity", function () {
    it("burns LP tokens and returns proportional reserves including accrued swap fees", async function () {
      const { token0, token1, pair, alice, bob } = await networkHelpers.loadFixture(deployPairFixture);

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")], { account: alice.account });

      // Bob performs a swap, leaving 0.3% fee inside the pool
      await pair.write.swap([token0.address, parseEther("100"), 0n], { account: bob.account });

      const aliceLp = await pair.read.balanceOf([alice.account.address]);
      const supplyBefore = await pair.read.totalSupply();
      const res0Before = await pair.read.reserve0();
      const res1Before = await pair.read.reserve1();

      const expected0 = (aliceLp * res0Before) / supplyBefore;
      const expected1 = (aliceLp * res1Before) / supplyBefore;

      const bal0Before = await token0.read.balanceOf([alice.account.address]);
      const bal1Before = await token1.read.balanceOf([alice.account.address]);

      await viem.assertions.emitWithArgs(
        pair.write.removeLiquidity([aliceLp], { account: alice.account }),
        pair,
        "LiquidityRemoved",
        [getAddress(alice.account.address), expected0, expected1, aliceLp],
      );

      assert.equal(await pair.read.balanceOf([alice.account.address]), 0n);
      assert.equal(await token0.read.balanceOf([alice.account.address]), bal0Before + expected0);
      assert.equal(await token1.read.balanceOf([alice.account.address]), bal1Before + expected1);
      // Because of the swap fee, Alice withdraws more value in k than she deposited (minus DEAD lock)
      assert.ok(expected0 * expected1 > (parseEther("1000") - 1000n) * (parseEther("1000") - 1000n));
    });

    it("reverts when removing zero or more LP tokens than owned", async function () {
      const { pair, alice, bob } = await networkHelpers.loadFixture(deployPairFixture);

      await pair.write.addLiquidity([parseEther("100"), parseEther("100")], { account: alice.account });

      await viem.assertions.revertWithCustomError(
        pair.write.removeLiquidity([0n], { account: alice.account }),
        pair,
        "InsufficientAmount",
      );

      await viem.assertions.revertWithCustomError(
        pair.write.removeLiquidity([1n], { account: bob.account }),
        pair,
        "InsufficientLiquidity",
      );
    });
  });

  describe("getAmountOut", function () {
    it("reverts on zero amountIn or zero reserves", async function () {
      const { pair } = await networkHelpers.loadFixture(deployPairFixture);

      await viem.assertions.revertWithCustomError(
        pair.read.getAmountOut([0n, 1000n, 1000n]),
        pair,
        "InsufficientAmount",
      );

      await viem.assertions.revertWithCustomError(
        pair.read.getAmountOut([100n, 0n, 1000n]),
        pair,
        "InsufficientLiquidity",
      );

      await viem.assertions.revertWithCustomError(
        pair.read.getAmountOut([100n, 1000n, 0n]),
        pair,
        "InsufficientLiquidity",
      );
    });
  });
});
