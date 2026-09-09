// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BPS_DENOMINATOR, SplitTable} from "./Types.sol";

/**
 * Divides a resale price between the parties.
 *
 * The invariant this library exists to guarantee:
 *
 *     organizer + platform + rightsHolder + seller == salePrice
 *
 * exactly, for every input, with no dust and no party quietly gaining from
 * rounding. Achieved by flooring the three fixed shares and giving the remainder
 * to the seller — so rounding error always favours the person selling rather
 * than the platform collecting.
 *
 * That direction is deliberate. A platform rounding in its own favour on every
 * transaction eventually has to explain itself to an organizer with a
 * spreadsheet.
 *
 * This is the same algorithm as `computeSplits` in `packages/domain/src/splits.ts`,
 * and the test suite checks the two against each other over a wide sweep of
 * prices rather than trusting that they look alike.
 */
library RoyaltySplit {
    error SplitsExceedTotal(uint16 allocated);

    struct Result {
        uint96 organizer;
        uint96 platform;
        uint96 rightsHolder;
        uint96 seller;
    }

    function totalAllocatedBps(SplitTable memory splits) internal pure returns (uint16) {
        return splits.organizerBps + splits.platformBps + splits.rightsHolderBps;
    }

    function compute(uint96 salePrice, SplitTable memory splits) internal pure returns (Result memory r) {
        uint16 allocated = totalAllocatedBps(splits);
        if (allocated > BPS_DENOMINATOR) revert SplitsExceedTotal(allocated);

        // uint96 * uint16 cannot overflow a uint256 intermediate, and the
        // division floors, which is the whole point.
        r.organizer = uint96((uint256(salePrice) * splits.organizerBps) / BPS_DENOMINATOR);
        r.platform = uint96((uint256(salePrice) * splits.platformBps) / BPS_DENOMINATOR);
        r.rightsHolder = uint96((uint256(salePrice) * splits.rightsHolderBps) / BPS_DENOMINATOR);
        // The remainder. Never computed from a percentage, so it cannot drift.
        r.seller = salePrice - r.organizer - r.platform - r.rightsHolder;
    }
}

/**
 * Records where the money went.
 *
 * Note what this contract does NOT do: it does not move funds. Fans pay in local
 * currency through a licensed aggregator, and this is the chain of record, not
 * the rail. The emitted `SplitRecorded` event is the instruction the off-chain
 * payout ledger reconciles against, which keeps the auditability — every
 * commission independently verifiable by the organizer — while avoiding
 * virtual-asset tax treatment and the requirement that a concertgoer hold crypto.
 *
 * The honest framing for a technical buyer: settlement here is trust-minimised,
 * not trustless. On-chain stablecoin settlement stays available as an opt-in for
 * organizers in jurisdictions where it is clean, and would be a second contract
 * rather than a change to this one.
 */
contract RoyaltySplitter {
    using RoyaltySplit for uint96;

    error NotAuthorised();
    error AlreadyRecorded(bytes32 saleId);
    error SplitDoesNotBalance();

    event SplitRecorded(
        bytes32 indexed saleId,
        address indexed ticketContract,
        uint256 indexed tokenId,
        uint96 salePrice,
        uint96 organizer,
        uint96 platform,
        uint96 rightsHolder,
        uint96 seller
    );

    address public immutable controller;
    mapping(bytes32 => bool) public recorded;

    constructor(address controller_) {
        controller = controller_;
    }

    function record(
        bytes32 saleId,
        address ticketContract,
        uint256 tokenId,
        uint96 salePrice,
        SplitTable calldata splits
    ) external returns (RoyaltySplit.Result memory r) {
        if (msg.sender != controller) revert NotAuthorised();
        if (recorded[saleId]) revert AlreadyRecorded(saleId);

        r = RoyaltySplit.compute(salePrice, splits);

        // Belt and braces. The library guarantees this arithmetically; asserting
        // it at the point money is recorded costs one comparison and means a
        // future edit to the library cannot silently start losing paise.
        if (r.organizer + r.platform + r.rightsHolder + r.seller != salePrice) revert SplitDoesNotBalance();

        recorded[saleId] = true;
        emit SplitRecorded(saleId, ticketContract, tokenId, salePrice, r.organizer, r.platform, r.rightsHolder, r.seller);
    }

    /** Read-only, for a UI that wants to show a seller their take before listing. */
    function preview(uint96 salePrice, SplitTable calldata splits) external pure returns (RoyaltySplit.Result memory) {
        return RoyaltySplit.compute(salePrice, splits);
    }
}
