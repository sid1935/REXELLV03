// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Shared types. These mirror `packages/domain/src/event.ts` field for field —
 * if one side gains a dial, so does the other, or the UI starts promising
 * something the contract will not honour.
 */

/**
 * Two modes, and deliberately no third.
 *
 * `Bound`  — transfer reverts for every caller, forever.
 * `Capped` — transfer is permitted only through the ResaleController.
 *
 * There is no `Open`. A freely transferable ticket reaches a general NFT
 * marketplace, and "NFT ticketing" leaks straight back into scalping. The
 * absence of that third enum member is a product decision, not an oversight.
 */
enum ResaleMode {
    Bound,
    Capped
}

uint16 constant BPS_DENOMINATOR = 10_000;

/**
 * How a resale price is divided. Everything not allocated here is the seller's.
 *
 * The seller has no bps field on purpose: they take the remainder, which is what
 * makes the split sum exactly with no dust. See RoyaltySplitter.
 */
struct SplitTable {
    uint16 organizerBps;
    uint16 platformBps;
    uint16 rightsHolderBps;
}

struct TierPolicy {
    ResaleMode mode;
    /// Ceiling as a proportion of face value. 11_000 = 110%.
    uint16 maxPriceBps;
    /// Floor, so a ticket cannot be wash-traded to a colluding account for nothing.
    uint16 minPriceBps;
    uint64 opensAt;
    uint64 closesAt;
    /// Seconds a buyer must hold before relisting. Defeats buy-and-flip bots.
    uint32 cooldown;
    uint8 maxResales;
    uint96 faceValue;
    uint32 allocation;
    SplitTable splits;
}
